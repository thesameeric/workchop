import crypto from 'node:crypto';
import { afterAll } from 'vitest';
import type { Db } from '../../server/db';
import { collectMigrations, migrate } from '../../server/db/migrations';
import { PgDb } from '../../server/db/pg';
import { openPGlite } from '../../server/db/pglite';

// Tests run on in-memory PGlite, or on Postgres when TEST_DATABASE_URL points at a database they may
// write to, e.g. TEST_DATABASE_URL=postgres://workchop:pw@127.0.0.1:5432/workchop_test npm test
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || undefined;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/**
 * An empty database (no tables): in-memory PGlite, or a schema of its own in the Postgres test
 * database, since test files run in parallel. Closed (and dropped) after the file's tests.
 */
export async function freshDb(): Promise<Db> {
  let db: Db;
  if (TEST_DATABASE_URL) {
    const schema = `test_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new PgDb(TEST_DATABASE_URL);
    await admin.exec(`CREATE SCHEMA ${schema}`);
    db = new PgDb(TEST_DATABASE_URL, undefined, `-c search_path=${schema}`);
    cleanups.push(async () => {
      await db.close();
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    });
  } else {
    db = await openPGlite(null);
    cleanups.push(() => db.close());
  }
  return db;
}

let shared: Promise<Db> | null = null;

/** One migrated database shared by a test file's tests (PGlite takes a few seconds to start). */
export function createTestDb(): Promise<Db> {
  shared ??= freshDb().then(async (db) => {
    await migrate(db, collectMigrations());
    return db;
  });
  return shared;
}

/** Empties every table (keeping the schema), for tests that need a clean slate. */
export async function resetTestDb(db: Db): Promise<void> {
  const { rows } = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations'",
  );
  if (rows.length) await db.exec(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
}
