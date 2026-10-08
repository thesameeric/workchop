import path from 'node:path';
import { PgDb, type DatabaseSsl } from './pg';

export type { DatabaseSsl } from './pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** What both a database and an open transaction can do. */
export interface Tx {
  /** One statement with $1, $2… parameters. Pass jsonb as JSON.stringify(value) with a $n::jsonb cast. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
}

/**
 * The app's SQL database: Postgres when DATABASE_URL is set, otherwise PGlite (Postgres compiled to
 * WebAssembly, stored in DATA_DIR/db). Write SQL that runs on both PostgreSQL 16 and PGlite (PG 18).
 */
export interface Db extends Tx {
  /**
   * Runs `fn` in a transaction, committed when it resolves and rolled back when it throws. Use only
   * `tx` inside: using the outer handle there would deadlock PGlite, so it throws instead.
   */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'postgres' | 'pglite';
  readonly description: string;
}

export interface DbOptions {
  /** Postgres connection string; without one, PGlite stores the data in `dataDir`/db. */
  databaseUrl?: string;
  databaseSsl?: DatabaseSsl;
  dataDir: string;
}

export async function openDb(opts: DbOptions): Promise<Db> {
  if (opts.databaseUrl) {
    const db = new PgDb(opts.databaseUrl, opts.databaseSsl);
    try {
      await waitForDatabase(db);
    } catch (err) {
      await db.close();
      throw err;
    }
    return db;
  }
  // Loaded only when needed: it's big, and production setups with Postgres never use it.
  const { openPGlite } = await import('./pglite');
  return openPGlite(path.join(opts.dataDir, 'db'));
}

/** The database may still be starting (e.g. in docker compose); keep trying for a while. */
async function waitForDatabase(db: Db): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= 15) throw err;
      console.log(`[db] waiting for the database (${(err as Error).message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
