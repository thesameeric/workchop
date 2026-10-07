import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isValidId, sanitizeOffice } from '../shared/office';
import { createFromTemplate, type TemplateId } from '../shared/templates';
import type { Office } from '../shared/types';

export interface StoredOffice {
  office: Office;
  /** Secret handed to whoever created the office; grants owner rights. Never sent to other clients. */
  ownerKey: string;
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomId(length = 10): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Offices persisted as one JSON file each, cached in memory and written back with a short debounce. */
export class OfficeStore {
  private cache = new Map<string, StoredOffice>();
  private loading = new Map<string, Promise<StoredOffice | null>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private writes = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    // Remove temp files left behind if a previous run was killed mid-write.
    for (const name of await fs.readdir(this.dir)) {
      if (/\.json\.\d+\.tmp$/.test(name)) await fs.rm(path.join(this.dir, name), { force: true });
    }
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<StoredOffice | null> {
    if (!isValidId(id)) return null;
    const cached = this.cache.get(id);
    if (cached) return cached;
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.load(id).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  /** Synchronous access for offices already in memory (i.e. with people in them). */
  peek(id: string): StoredOffice | undefined {
    return this.cache.get(id);
  }

  private async load(id: string): Promise<StoredOffice | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(id), 'utf8');
    } catch {
      return null;
    }
    try {
      const json = JSON.parse(raw) as { office?: unknown; ownerKey?: unknown };
      const office = sanitizeOffice(json.office);
      if (!office || typeof json.ownerKey !== 'string') return null;
      const stored: StoredOffice = { office: { ...office, id }, ownerKey: json.ownerKey };
      this.cache.set(id, stored);
      return stored;
    } catch (err) {
      console.error(`[store] could not parse office ${id}:`, err);
      return null;
    }
  }

  async create(name: string, template: TemplateId): Promise<StoredOffice> {
    let id = randomId();
    while (this.cache.has(id) || (await this.exists(id))) id = randomId();
    const stored: StoredOffice = {
      office: createFromTemplate(template, id, name),
      ownerKey: crypto.randomBytes(18).toString('base64url'),
    };
    this.cache.set(id, stored);
    await this.write(id);
    return stored;
  }

  private async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  update(id: string, office: Office): void {
    const stored = this.cache.get(id);
    if (!stored) return;
    stored.office = office;
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.write(id);
      }, 400),
    );
  }

  /** Serialised, atomic write (temp file + rename) so a crash never leaves half a file. */
  private write(id: string): Promise<void> {
    const prev = this.writes.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const stored = this.cache.get(id);
      if (!stored) return;
      const tmp = `${this.file(id)}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(stored, null, 1));
      await fs.rename(tmp, this.file(id));
    });
    const tracked = next.catch((err) => console.error(`[store] failed to save office ${id}:`, err));
    this.writes.set(id, tracked);
    return tracked;
  }

  /** Write pending changes now and wait for every save, including ones already in progress. */
  async flush(id?: string): Promise<void> {
    const ids = id ? [id] : [...new Set([...this.timers.keys(), ...this.writes.keys()])];
    await Promise.all(
      ids.map((key) => {
        const timer = this.timers.get(key);
        if (!timer) return this.writes.get(key);
        clearTimeout(timer);
        this.timers.delete(key);
        return this.write(key);
      }),
    );
  }

  /** Flush an office to disk and drop it from memory, unless `inUse()` says someone came back meanwhile. */
  async evict(id: string, inUse: () => boolean): Promise<void> {
    await this.flush(id);
    if (!inUse() && !this.timers.has(id)) this.cache.delete(id);
  }
}
