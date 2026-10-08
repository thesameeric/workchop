import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOp } from '../shared/office';
import { PgDb } from '../server/db/pg';
import { OfficeStore } from '../server/officeStore';
import { SqlOfficeRepo, type OfficeRepo } from '../server/repos';
import { startServer } from '../server/index';
import { createTestDb, TEST_DATABASE_URL } from './helpers/db';
import { createOffice } from './helpers/http';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workchop-store-'));
  dirs.push(dir);
  return dir;
}

describe(`OfficeStore on ${TEST_DATABASE_URL ? 'Postgres' : 'PGlite'}`, () => {
  // Starting PGlite takes a few seconds.
  beforeAll(() => createTestDb(), 60_000);

  async function setup() {
    const repo = new SqlOfficeRepo(await createTestDb());
    const store = new OfficeStore(repo);
    await store.init();
    const stored = await store.create('Before', 'blank');
    const rename = (name: string) => store.update(stored.office.id, applyOp(stored.office, { t: 'settings', settings: { name } }));
    return { store, repo, id: stored.office.id, ownerKey: stored.ownerKey, rename };
  }

  /** Read what is actually persisted, bypassing the store's cache. */
  async function persistedName(repo: OfficeRepo, id: string) {
    const raw = await repo.load(id);
    return (raw?.office as { settings: { name: string } } | undefined)?.settings.name;
  }

  it('persists new offices and loads them back in a fresh store', async () => {
    const { store, id, ownerKey } = await setup();
    await store.close();
    const again = new OfficeStore(new SqlOfficeRepo(await createTestDb()));
    await again.init();
    const loaded = await again.get(id);
    expect(loaded?.office.settings.name).toBe('Before');
    expect(loaded?.ownerKey).toBe(ownerKey);
    expect(await again.get('missing-office')).toBeNull();
    await again.close();
  });

  it('flush() writes edits that are still waiting for their save timer', async () => {
    const { store, repo, id, rename } = await setup();
    rename('After');
    await store.flush();
    expect(await persistedName(repo, id)).toBe('After');
    await store.close();
  });

  it('flush() also waits for a save that has already started (shutdown race)', async () => {
    const { store, repo, id, rename } = await setup();
    rename('After');
    // Let the 400ms debounce fire so the save is in flight, then flush in the same tick.
    await new Promise((r) => setTimeout(r, 401));
    await store.flush();
    expect(await persistedName(repo, id)).toBe('After');
    await store.close();
  });

  it('the last of several quick edits wins', async () => {
    const { store, repo, id, rename } = await setup();
    for (let i = 1; i <= 5; i++) rename(`Edit ${i}`);
    await store.flush();
    expect(await persistedName(repo, id)).toBe('Edit 5');
    await store.close();
  });
});

describe('server storage', () => {
  // PGlite on disk in a data directory, or the Postgres test database.
  const options = () => (TEST_DATABASE_URL ? { databaseUrl: TEST_DATABASE_URL } : { dataDir: tempDir() });

  it('keeps offices, their owner and guest link across restarts', { timeout: 60_000 }, async () => {
    const storage = { ...options(), quiet: true, iceServers: [], auth: { google: null, apple: null, devLogin: true } };
    const first = await startServer({ port: 0, host: '127.0.0.1', ...storage });
    const office = await createOffice(`http://127.0.0.1:${first.port}`, 'Pat', 'Persistent HQ', 'startup');
    await first.close();

    const second = await startServer({ port: 0, host: '127.0.0.1', ...storage });
    const at = `http://127.0.0.1:${second.port}/api/offices/${office.id}`;
    expect(await (await office.owner.fetch(at)).json()).toEqual({ id: office.id, name: 'Persistent HQ', kind: 'team', role: 'owner', online: 0 });
    expect(await (await fetch(at, { headers: { 'X-Workchop-Guest': office.guest } })).json()).toMatchObject({ role: 'guest' });
    expect((await fetch(at)).status).toBe(403);
    await second.close();
  });

  it('reports storage outages instead of "not found"', async () => {
    const db = new PgDb('postgres://nobody:wrong@127.0.0.1:1/none');
    const broken = new OfficeStore(new SqlOfficeRepo(db));
    await expect(broken.get('someoffice')).rejects.toThrow();
    await broken.close();
    await db.close();
  });
});
