import pg from 'pg';
import type { Db, QueryResult, Tx } from './index';
import { assertOutsideTransaction, inTransactionScope } from './scope';

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

function clientTx(client: pg.PoolClient): Tx {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await client.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
  };
}

/** Postgres through a small connection pool. */
export class PgDb implements Db {
  readonly kind = 'postgres';
  readonly description: string;
  private readonly pool: pg.Pool;

  constructor(connectionString: string, ssl?: DatabaseSsl, options?: string) {
    this.pool = new pg.Pool({
      connectionString: withoutSystemRootCert(connectionString),
      max: 5,
      connectionTimeoutMillis: 10_000,
      ssl: ssl === 'no-verify' ? { rejectUnauthorized: false } : ssl === 'require' ? true : undefined,
      options,
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

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    assertOutsideTransaction(this);
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    assertOutsideTransaction(this);
    await this.pool.query(sql);
  }

  /** BEGIN/COMMIT must all go through one checked-out connection, never through the pool. */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    assertOutsideTransaction(this);
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await inTransactionScope(this, () => fn(clientTx(client)));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
