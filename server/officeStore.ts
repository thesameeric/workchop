import crypto from 'node:crypto';
import { isValidId, sanitizeOffice } from '../shared/office';
import { createFromTemplate, type TemplateId } from '../shared/templates';
import type { Office } from '../shared/types';
import type { OfficeRepo, StoredOffice } from './repos';

export type { StoredOffice } from './repos';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomId(length = 10): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Offices in use are cached in memory; edits are written back to the repo (the database)
 * after a short debounce, one save at a time per office.
 */
export class OfficeStore {
  private cache = new Map<string, StoredOffice>();
  private loading = new Map<string, Promise<StoredOffice | null>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private writes = new Map<string, Promise<void>>();

  constructor(private readonly repo: OfficeRepo) {}

  get description(): string {
    return this.repo.description;
  }

  init(): Promise<void> {
    return this.repo.init();
  }

  /** The office, or null if it doesn't exist. Throws if storage is unavailable. */
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
    const raw = await this.repo.load(id);
    if (!raw) return null;
    const office = sanitizeOffice(raw.office);
    if (!office || typeof raw.ownerKey !== 'string') {
      console.error(`[store] office ${id} is malformed; ignoring it`);
      return null;
    }
    const stored: StoredOffice = { office: { ...office, id }, ownerKey: raw.ownerKey };
    this.cache.set(id, stored);
    return stored;
  }

  /** Create and immediately persist a new office. Throws if it can't be saved. */
  async create(name: string, template: TemplateId): Promise<StoredOffice> {
    let id = randomId();
    while (this.cache.has(id) || (await this.repo.exists(id))) id = randomId();
    const stored: StoredOffice = {
      office: createFromTemplate(template, id, name),
      ownerKey: crypto.randomBytes(18).toString('base64url'),
    };
    await this.repo.save(stored);
    this.cache.set(id, stored);
    return stored;
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

  /** Save the latest state of an office, after any save of it that is already running. */
  private write(id: string): Promise<void> {
    const prev = this.writes.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const stored = this.cache.get(id);
      if (stored) await this.repo.save(stored);
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

  /** Flush an office and drop it from memory, unless `inUse()` says someone came back meanwhile. */
  async evict(id: string, inUse: () => boolean): Promise<void> {
    await this.flush(id);
    if (!inUse() && !this.timers.has(id)) this.cache.delete(id);
  }

  /** Save everything and release the storage connection. */
  async close(): Promise<void> {
    await this.flush();
    await this.repo.close();
  }
}
