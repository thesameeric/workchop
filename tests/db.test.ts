import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFromTemplate } from '../shared/templates';
import { jsonb } from '../server/db';
import { importLegacyOffices } from '../server/db/legacy';
import { collectMigrations, coreMigrations, migrate, type Migration } from '../server/db/migrations';
import { openPGlite } from '../server/db/pglite';
import { createTestDb, freshDb, resetTestDb, TEST_DATABASE_URL } from './helpers/db';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workchop-db-'));
  dirs.push(dir);
  return dir;
}

beforeAll(() => createTestDb(), 60_000);

describe(`migrations on ${TEST_DATABASE_URL ? 'Postgres' : 'PGlite'}`, () => {
  it('apply once, keep an offices table made by earlier versions, then do nothing', { timeout: 60_000 }, async () => {
    const db = await freshDb();
    // What earlier versions created on their own.
    await db.exec(`
      CREATE TABLE offices (
        id text PRIMARY KEY, owner_key text NOT NULL, data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await db.query('INSERT INTO offices (id, owner_key, data) VALUES ($1, $2, $3::jsonb)', ['old1', 'key', JSON.stringify({ hello: [1, 2] })]);
    expect(await migrate(db)).toEqual(coreMigrations.map((m) => `${m.id} ${m.name}`));
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ id: number }>('SELECT id FROM schema_migrations ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(coreMigrations.map((m) => m.id));
    const office = await db.query<{ data: unknown }>('SELECT data FROM offices WHERE id = $1', ['old1']);
    expect(office.rows[0].data).toEqual({ hello: [1, 2] });
  });

  it('verify the emails accounts signed in with, the oldest account keeping a shared one', { timeout: 60_000 }, async () => {
    const db = await freshDb();
    await migrate(db, coreMigrations.filter((m) => m.id < 4));
    const user = (id: string, email: string | null, days: number) =>
      db.query(`INSERT INTO users (id, name, email, created_at) VALUES ($1, $1, $2, now() - $3::int * interval '1 day')`, [id, email, days]);
    const identity = (userId: string, provider: string, email: string | null, verified: boolean, days: number) =>
      db.query(
        `INSERT INTO auth_identities (provider, subject, user_id, email, email_verified, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - $6::int * interval '1 day')`,
        [provider, `${provider}-${userId}`, userId, email, verified, days],
      );
    await user('older', 'Same@Example.com', 30);
    await identity('older', 'google', 'same@example.com', true, 20);
    await identity('older', 'github', 'same@example.com', true, 25);
    await user('newer', 'same@example.com', 10);
    await identity('newer', 'apple', 'Same@Example.com', true, 10);
    await user('unverified', 'other@example.com', 5);
    await identity('unverified', 'github', 'other@example.com', false, 5);
    // Verified, but not the address the account has.
    await user('elsewhere', 'mine@example.com', 5);
    await identity('elsewhere', 'google', 'theirs@example.com', true, 5);
    await user('none', null, 5);
    await identity('none', 'dev', null, false, 5);

    expect(await migrate(db, coreMigrations.filter((m) => m.id < 5))).toEqual(['4 email_sign_in']);
    const { rows } = await db.query<{ id: string; email: string | null; verified_days: number | null }>(
      `SELECT id, email, round(extract(epoch FROM now() - email_verified_at) / 86400)::int AS verified_days FROM users ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'elsewhere', email: 'mine@example.com', verified_days: null },
      { id: 'newer', email: 'same@example.com', verified_days: null },
      { id: 'none', email: null, verified_days: null },
      // Verified since its first identity that verified it.
      { id: 'older', email: 'same@example.com', verified_days: 25 },
      { id: 'unverified', email: 'other@example.com', verified_days: null },
    ]);
    // Addresses stay lower-case, and only one account can have each one verified.
    await expect(user('upper', 'Upper@Example.com', 0)).rejects.toThrow(/users_email_lower/);
    await expect(db.query("UPDATE users SET email_verified_at = now() WHERE id = 'newer'")).rejects.toThrow(/users_verified_email_idx/);
    await db.query("UPDATE users SET email_verified_at = now() WHERE id = 'unverified'");
    await db.query("INSERT INTO email_tokens (token_hash, purpose, email, user_id, expires_at) VALUES ('h', 'reset', 'same@example.com', 'older', now())");
    await expect(db.query("INSERT INTO email_tokens (token_hash, purpose, email, expires_at) VALUES ('h2', 'other', 'x@example.com', now())")).rejects.toThrow();
    const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_tx' AND table_schema = current_schema() AND column_name = 'link_user_id'");
    expect(columns.rowCount).toBe(1);
  });

  it('keep offices from before workspaces open, and leave each office one owner', { timeout: 60_000 }, async () => {
    const db = await freshDb();
    await migrate(db, coreMigrations.filter((m) => m.id < 5));
    const office = (id: string) =>
      db.query('INSERT INTO offices (id, owner_key, data) VALUES ($1, $2, $3::jsonb)', [id, `key-${id}`, JSON.stringify(createFromTemplate('blank', id, id))]);
    const member = (userId: string, officeId: string, role: string, days: number) =>
      db.query(`INSERT INTO memberships (user_id, office_id, role, joined_at) VALUES ($1, $2, $3, now() - $4::int * interval '1 day')`, [userId, officeId, role, days]);
    for (const id of ['shared1', 'solo1', 'nobody1']) await office(id);
    for (const id of ['first', 'second', 'third', 'visitor']) await db.query('INSERT INTO users (id, name) VALUES ($1, $1)', [id]);
    // Everyone who opened it with the owner key became an owner; signed-in visitors, members.
    await member('second', 'shared1', 'owner', 10);
    await member('first', 'shared1', 'owner', 20);
    await member('third', 'shared1', 'owner', 5);
    await member('visitor', 'shared1', 'member', 30);
    await member('first', 'solo1', 'owner', 1);

    expect(await migrate(db)).toEqual(['5 workspaces']);
    const { rows } = await db.query('SELECT office_id, user_id, role FROM memberships ORDER BY office_id, user_id');
    expect(rows).toEqual([
      // The earliest owner keeps the office; the others become admins.
      { office_id: 'shared1', user_id: 'first', role: 'owner' },
      { office_id: 'shared1', user_id: 'second', role: 'admin' },
      { office_id: 'shared1', user_id: 'third', role: 'admin' },
      { office_id: 'shared1', user_id: 'visitor', role: 'member' },
      { office_id: 'solo1', user_id: 'first', role: 'owner' },
    ]);
    const offices = await db.query('SELECT id, kind, guest_access, guest_token FROM offices ORDER BY id');
    expect(offices.rows).toEqual(['nobody1', 'shared1', 'solo1'].map((id) => ({ id, kind: 'team', guest_access: 'open', guest_token: null })));

    // Existing members have been there; new ones haven't, until they come in.
    expect((await db.query('SELECT 1 FROM memberships WHERE last_visit_at IS NULL')).rowCount).toBe(0);
    await member('visitor', 'solo1', 'member', 0);
    expect((await db.query("SELECT last_visit_at FROM memberships WHERE user_id = 'visitor' AND office_id = 'solo1'")).rows).toEqual([{ last_visit_at: null }]);

    // New offices let in members only; one owner each; only the known roles, kinds and access.
    await office('new1');
    expect((await db.query("SELECT kind, guest_access FROM offices WHERE id = 'new1'")).rows).toEqual([{ kind: 'team', guest_access: 'off' }]);
    await expect(db.query("UPDATE memberships SET role = 'owner' WHERE user_id = 'second'")).rejects.toThrow(/memberships_one_owner_idx/);
    await expect(member('visitor', 'nobody1', 'guest', 0)).rejects.toThrow(/memberships_role_check/);
    await expect(db.query("UPDATE offices SET kind = 'shop' WHERE id = 'new1'")).rejects.toThrow(/offices_kind_check/);
    await expect(db.query("UPDATE offices SET guest_access = 'everyone' WHERE id = 'new1'")).rejects.toThrow(/offices_guest_access_check/);

    // Invitations: one per address and office, in lower case, gone with their office.
    const invite = (id: string, email: string, tokenHash: string) =>
      db.query(
        `INSERT INTO office_invites (id, office_id, email, role, invited_by, token_hash, expires_at)
         VALUES ($1, 'new1', $2, 'member', 'first', $3, now() + interval '14 days')`,
        [id, email, tokenHash],
      );
    await invite('i1', 'pat@example.com', 'h1');
    await expect(invite('i2', 'pat@example.com', 'h2')).rejects.toThrow(/office_invites_office_id_email_key/);
    await expect(invite('i3', 'Sam@Example.com', 'h3')).rejects.toThrow(/office_invites_email_check/);
    await expect(invite('i4', 'sam@example.com', 'h1')).rejects.toThrow(/office_invites_token_hash_key/);
    await db.query("DELETE FROM offices WHERE id = 'new1'");
    expect((await db.query('SELECT 1 FROM office_invites')).rowCount).toBe(0);
  });

  it('warn about edited migrations and apply new feature migrations in id order', async () => {
    const db = await createTestDb();
    const feature: Migration[] = [{ id: 901, name: 'test_things', sql: 'CREATE TABLE test_things (id int PRIMARY KEY)' }];
    expect(await migrate(db, collectMigrations([{ name: 'things', migrations: feature }]))).toEqual(['901 test_things']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const edited = coreMigrations.map((m) => (m.id === 2 ? { ...m, sql: m.sql + ' -- edited' } : m));
    expect(await migrate(db, [...edited, ...feature])).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/migration 2 \(accounts\) changed/);
    warn.mockRestore();
    expect(() => collectMigrations([{ name: 'clash', migrations: [{ id: 2, name: 'again', sql: '' }] }])).toThrow(/id 2/);
    await db.exec('DROP TABLE test_things');
    await db.query('DELETE FROM schema_migrations WHERE id = 901');
  });

  it('know the migrations of a feature that is off, without running them', async () => {
    const db = await createTestDb();
    const feature: Migration[] = [{ id: 902, name: 'test_off', sql: 'CREATE TABLE test_off (id int PRIMARY KEY)' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Turned on once, then off: nothing to run, nothing to warn about.
      expect(await migrate(db, collectMigrations([{ name: 'off', migrations: feature }]))).toEqual(['902 test_off']);
      expect(await migrate(db, collectMigrations(), feature)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      // A migration this version really doesn't know is worth a warning.
      expect(await migrate(db, collectMigrations())).toEqual([]);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/migration 902 \(test_off\), which this version doesn't know/);
      // And a feature that's off doesn't get its tables.
      await db.exec('DROP TABLE test_off');
      await db.query('DELETE FROM schema_migrations WHERE id = 902');
      expect(await migrate(db, collectMigrations(), feature)).toEqual([]);
      expect((await db.query<{ t: string | null }>("SELECT to_regclass('test_off')::text AS t")).rows[0].t).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe(`the Db layer on ${TEST_DATABASE_URL ? 'Postgres' : 'PGlite'}`, () => {
  it('returns the same types as node-postgres', async () => {
    const db = await createTestDb();
    const { rows } = await db.query<{ big: string; bytes: Buffer; when: Date; json: unknown; n: number }>(
      "SELECT 9007199254740993::int8 AS big, $1::bytea AS bytes, now() AS when, $2::jsonb AS json, count(*)::int AS n FROM (VALUES (1), (2)) v(x)",
      [Buffer.from([0, 1, 254, 255]), JSON.stringify([1, { a: 'b' }])],
    );
    expect(rows[0].big).toBe('9007199254740993');
    expect(Buffer.isBuffer(rows[0].bytes) && [...rows[0].bytes]).toEqual([0, 1, 254, 255]);
    expect(rows[0].when).toBeInstanceOf(Date);
    expect(rows[0].json).toEqual([1, { a: 'b' }]);
    expect(rows[0].n).toBe(2);
    expect((await db.query('SELECT 1 UNION SELECT 2')).rowCount).toBe(2);
  });

  it('commits or rolls back transactions, and refuses the outer handle inside one', async () => {
    const db = await createTestDb();
    await db.exec('CREATE TABLE tx_test (id int)');
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO tx_test VALUES (1)');
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO tx_test VALUES (2)');
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await expect(db.transaction(() => db.query('SELECT 1'))).rejects.toThrow(/transaction handle/);
    const { rows } = await db.query<{ id: number }>('SELECT id FROM tx_test ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual([1]);
    // Still usable afterwards (PGlite would hang here after a deadlock).
    expect((await db.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    await db.exec('DROP TABLE tx_test');
  });
});

describe('importing office JSON files from earlier versions', () => {
  function writeOffice(dir: string, id: string, name: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ office: createFromTemplate('blank', id, name), ownerKey: `key-${id}` }));
  }

  it('copies DATA_DIR/offices/*.json and DATA_DIR/*.json once, then moves them aside', async () => {
    const db = await createTestDb();
    await resetTestDb(db);
    const dataDir = tempDir();
    writeOffice(path.join(dataDir, 'offices'), 'nested1', 'Nested');
    writeFileSync(path.join(dataDir, 'offices', 'broken.json'), '{not json');
    writeOffice(dataDir, 'toplevel1', 'Top');
    writeFileSync(path.join(dataDir, 'notes.json'), '{"unrelated": true}');
    // An office already in the database is kept as it is.
    writeOffice(path.join(dataDir, 'offices'), 'existing1', 'From file');
    await db.query('INSERT INTO offices (id, owner_key, data) VALUES ($1, $2, $3::jsonb)', ['existing1', 'db-key', JSON.stringify(createFromTemplate('blank', 'existing1', 'From DB'))]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const imported = await importLegacyOffices(db, dataDir);
    expect(imported.sort()).toEqual(['nested1 (Nested)', 'toplevel1 (Top)']);
    expect(log.mock.calls.flat().join(' ')).toMatch(/imported 2 of 3 office files/);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/broken\.json/);

    const { rows } = await db.query<{ id: string; owner_key: string; name: string; guest_access: string }>(
      "SELECT id, owner_key, data->'settings'->>'name' AS name, guest_access FROM offices ORDER BY id",
    );
    // Imported offices, made before workspaces, are open to anyone with the address.
    expect(rows).toEqual([
      { id: 'existing1', owner_key: 'db-key', name: 'From DB', guest_access: 'off' },
      { id: 'nested1', owner_key: 'key-nested1', name: 'Nested', guest_access: 'open' },
      { id: 'toplevel1', owner_key: 'key-toplevel1', name: 'Top', guest_access: 'open' },
    ]);
    expect(existsSync(path.join(dataDir, 'offices'))).toBe(false);
    expect(readdirSync(path.join(dataDir, 'offices.imported')).sort()).toEqual(['broken.json', 'existing1.json', 'nested1.json', 'toplevel1.json']);
    expect(readFileSync(path.join(dataDir, 'notes.json'), 'utf8')).toContain('unrelated');

    // Nothing left to import the second time.
    expect(await importLegacyOffices(db, dataDir)).toEqual([]);
    log.mockRestore();
    warn.mockRestore();
  });

  it('imports offices with text Postgres refuses in JSON, cleaned up', async () => {
    const db = await createTestDb();
    await resetTestDb(db);
    const dataDir = tempDir();
    // Earlier versions cut names at 48 UTF-16 units, which can leave half an emoji; JSON files kept it.
    const office = createFromTemplate('blank', 'halfemoji1', 'x');
    office.settings.name = 'a'.repeat(47) + '\ud83d';
    writeFileSync(path.join(dataDir, 'halfemoji1.json'), JSON.stringify({ office: { ...office, notes: 'nul \u0000 here' }, ownerKey: 'k' }));
    writeOffice(dataDir, 'fine1', 'Fine');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await importLegacyOffices(db, dataDir)).sort()).toEqual([`fine1 (Fine)`, `halfemoji1 (${'a'.repeat(47)})`]);
    log.mockRestore();
    const { rows } = await db.query<{ name: string }>("SELECT data->'settings'->>'name' AS name FROM offices WHERE id = 'halfemoji1'");
    expect(rows[0].name).toBe('a'.repeat(47));
  });
});

describe('jsonb()', () => {
  it('drops what Postgres refuses in jsonb and keeps the rest', async () => {
    const db = await createTestDb();
    const value = { name: 'cut \ud83d', ok: '😀 fine', nul: 'a\u0000b', list: ['\udc00x', 1, null], ['key\ud800']: true };
    const res = await db.query<{ v: unknown }>('SELECT $1::jsonb AS v', [jsonb(value)]);
    expect(res.rows[0].v).toEqual({ name: 'cut ', ok: '😀 fine', nul: 'ab', list: ['x', 1, null], key: true });
  });
});

describe('PGlite data directory lock', () => {
  it('refuses a second open, and takes over locks left by processes that are gone', { timeout: 60_000 }, async () => {
    const dir = path.join(tempDir(), 'db');
    const db = await openPGlite(dir);
    await expect(openPGlite(dir)).rejects.toThrow(/already open in this process/);
    // Also by another path to the same folder.
    const link = path.join(tempDir(), 'link');
    symlinkSync(dir, link);
    await expect(openPGlite(link)).rejects.toThrow(/already open in this process/);
    await db.close();
    expect(existsSync(path.join(dir, '.workchop.lock'))).toBe(false);

    // A crashed server on this machine (a pid that no longer exists)…
    writeFileSync(path.join(dir, '.workchop.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, hostname: hostname() }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const again = await openPGlite(dir);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/stale lock/);
    await again.close();

    // …but a live one (this test's parent process) keeps it.
    writeFileSync(path.join(dir, '.workchop.lock'), JSON.stringify({ pid: process.ppid, hostname: hostname() }));
    await expect(openPGlite(dir)).rejects.toThrow(/Another Workchop server/);
    warn.mockRestore();
  });
});
