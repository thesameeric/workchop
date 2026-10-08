import type { Office } from '../shared/types';
import { jsonb, type Db } from './db';

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

/**
 * One row per office in the `offices` table, with the office itself stored as JSONB. The database
 * is shared with the rest of the server, which opens, migrates and closes it.
 */
export class SqlOfficeRepo implements OfficeRepo {
  constructor(private readonly db: Db) {}

  get description(): string {
    return this.db.description;
  }

  async init(): Promise<void> {}

  async load(id: string): Promise<RawOffice | null> {
    const res = await this.db.query<{ data: unknown; owner_key: string }>('SELECT data, owner_key FROM offices WHERE id = $1', [id]);
    if (!res.rowCount) return null;
    return { office: res.rows[0].data, ownerKey: res.rows[0].owner_key };
  }

  async exists(id: string): Promise<boolean> {
    const res = await this.db.query('SELECT 1 FROM offices WHERE id = $1', [id]);
    return res.rowCount > 0;
  }

  async save(stored: StoredOffice): Promise<void> {
    await this.db.query(
      `INSERT INTO offices (id, owner_key, data) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, owner_key = EXCLUDED.owner_key, updated_at = now()`,
      [stored.office.id, stored.ownerKey, jsonb(stored.office)],
    );
  }

  async close(): Promise<void> {}
}
