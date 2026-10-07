import { promises as fs } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { Office } from '../shared/types';

export interface StoredOffice {
  office: Office;
  /** Secret handed to whoever created the office; grants owner rights. Never sent to other clients. */
  ownerKey: string;
}

/** Raw record as persisted; validated by the store before use. */
export interface RawOffice {
  office: unknown;
  ownerKey: unknown;
}

/** Where offices are kept. `load` returns null when the office doesn't exist and throws when storage fails. */
export interface OfficeRepo {
  readonly description: string;
  init(): Promise<void>;
  load(id: string): Promise<RawOffice | null>;
  exists(id: string): Promise<boolean>;
  save(stored: StoredOffice): Promise<void>;
  close(): Promise<void>;
}

/** One JSON file per office. Zero setup; fine for a single server with a persistent disk. */
export class FileRepo implements OfficeRepo {
  readonly description: string;

  constructor(private readonly dir: string) {
    this.description = `files in ${dir}`;
  }

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

  async load(id: string): Promise<RawOffice | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as RawOffice;
    } catch (err) {
      console.error(`[store] could not parse ${this.file(id)}:`, err);
      return null;
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Atomic write (temp file + rename) so a crash never leaves half a file. */
  async save(stored: StoredOffice): Promise<void> {
    const file = this.file(stored.office.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(stored, null, 1));
    await fs.rename(tmp, file);
  }

  async close(): Promise<void> {}
}

export type DatabaseSsl = 'require' | 'no-verify' | undefined;

/**
 * `sslrootcert=system` (libpq 16+, used in Neon/Supabase/Prisma Postgres URLs) means "trust the
 * system's CAs", but node-postgres reads it as a file named "system" and fails to connect. Node
 * already verifies against its bundled CAs, so dropping the parameter keeps the same behavior.
 */
export function withoutSystemRootCert(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslrootcert') !== 'system') return connectionString;
    url.searchParams.delete('sslrootcert');
    return url.toString();
  } catch {
    return connectionString;
  }
}

/** One row per office in Postgres, with the office itself stored as JSONB. */
export class PostgresRepo implements OfficeRepo {
  readonly description: string;
  private readonly pool: pg.Pool;

  constructor(connectionString: string, ssl?: DatabaseSsl) {
    this.pool = new pg.Pool({
      connectionString: withoutSystemRootCert(connectionString),
      max: 5,
      ssl: ssl === 'no-verify' ? { rejectUnauthorized: false } : ssl === 'require' ? true : undefined,
    });
    // An idle connection dropping (e.g. a database restart) must not crash the server.
    this.pool.on('error', (err) => console.error('[db] connection error:', err.message));
    const host = (() => {
      try {
        const u = new URL(connectionString);
        return `${u.hostname}${u.pathname}`;
      } catch {
        return 'the configured database';
      }
    })();
    this.description = `Postgres (${host})`;
  }

  async init(): Promise<void> {
    // The database may still be starting (e.g. in docker compose); keep trying for a while.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS offices (
            id         text PRIMARY KEY,
            owner_key  text NOT NULL,
            data       jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )`);
        return;
      } catch (err) {
        if (attempt >= 15) throw err;
        console.log(`[db] waiting for the database (${(err as Error).message})`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async load(id: string): Promise<RawOffice | null> {
    const res = await this.pool.query<{ data: unknown; owner_key: string }>('SELECT data, owner_key FROM offices WHERE id = $1', [id]);
    if (!res.rowCount) return null;
    return { office: res.rows[0].data, ownerKey: res.rows[0].owner_key };
  }

  async exists(id: string): Promise<boolean> {
    const res = await this.pool.query('SELECT 1 FROM offices WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async save(stored: StoredOffice): Promise<void> {
    await this.pool.query(
      `INSERT INTO offices (id, owner_key, data) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, owner_key = EXCLUDED.owner_key, updated_at = now()`,
      [stored.office.id, stored.ownerKey, JSON.stringify(stored.office)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
