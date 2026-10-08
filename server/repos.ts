import type { Office } from '../shared/types';
import type { GuestAccess, OfficeKind } from '../shared/workspace';
import { jsonb, type Db } from './db';

export interface StoredOffice {
  office: Office;
  /** Secret handed to whoever created the office before accounts; never sent to other clients. */
  ownerKey: string;
  /** Fixed when the office is made. */
  kind: OfficeKind;
  /** Who besides members may come in. */
  guests: GuestAccess;
  /** The guest link's secret while it is on; never sent to guests. */
  guestToken: string | null;
}

/** Raw record as persisted; validated by the store before use. */
export interface RawOffice {
  office: unknown;
  ownerKey: unknown;
  kind: unknown;
  guests: unknown;
  guestToken: unknown;
}

/** Where offices are kept. `load` returns null when the office doesn't exist and throws when storage fails. */
export interface OfficeRepo {
  readonly description: string;
  init(): Promise<void>;
  load(id: string): Promise<RawOffice | null>;
  exists(id: string): Promise<boolean>;
  /** Saves a new office, with `ownerId` (an account) as its owner. */
  create(stored: StoredOffice, ownerId: string | null): Promise<void>;
  /** Saves the office's layout and settings. */
  save(stored: StoredOffice): Promise<void>;
  setAccess(id: string, guests: GuestAccess, guestToken: string | null): Promise<void>;
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
    const res = await this.db.query<{ data: unknown; owner_key: string; kind: string; guest_access: string; guest_token: string | null }>(
      'SELECT data, owner_key, kind, guest_access, guest_token FROM offices WHERE id = $1',
      [id],
    );
    if (!res.rowCount) return null;
    const row = res.rows[0];
    return { office: row.data, ownerKey: row.owner_key, kind: row.kind, guests: row.guest_access, guestToken: row.guest_token };
  }

  async exists(id: string): Promise<boolean> {
    const res = await this.db.query('SELECT 1 FROM offices WHERE id = $1', [id]);
    return res.rowCount > 0;
  }

  async create(stored: StoredOffice, ownerId: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO offices (id, owner_key, data, kind, guest_access, guest_token) VALUES ($1, $2, $3::jsonb, $4, $5, $6)', [
        stored.office.id,
        stored.ownerKey,
        jsonb(stored.office),
        stored.kind,
        stored.guests,
        stored.guestToken,
      ]);
      // Making it counts as using it.
      if (ownerId) await tx.query("INSERT INTO memberships (user_id, office_id, role, last_visit_at) VALUES ($1, $2, 'owner', now())", [ownerId, stored.office.id]);
    });
  }

  async save(stored: StoredOffice): Promise<void> {
    await this.db.query(
      `INSERT INTO offices (id, owner_key, data, kind) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, owner_key = EXCLUDED.owner_key, updated_at = now()`,
      [stored.office.id, stored.ownerKey, jsonb(stored.office), stored.kind],
    );
  }

  async setAccess(id: string, guests: GuestAccess, guestToken: string | null): Promise<void> {
    await this.db.query('UPDATE offices SET guest_access = $2, guest_token = $3 WHERE id = $1', [id, guests, guestToken]);
  }

  async close(): Promise<void> {}
}
