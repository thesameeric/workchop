import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyOp } from '../shared/office';
import { OfficeStore } from '../server/officeStore';
import { FileRepo, PostgresRepo, type OfficeRepo } from '../server/repos';
import { startServer } from '../server/index';

// Postgres tests run when TEST_DATABASE_URL points at a database they may write to,
// e.g. TEST_DATABASE_URL=postgres://workchop:workchop@localhost:5432/workchop_test npm test
const DATABASE_URL = process.env.TEST_DATABASE_URL;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workchop-store-'));
  dirs.push(dir);
  return dir;
}

const backends: { name: string; make: () => OfficeRepo; skip: boolean }[] = [
  { name: 'files', make: () => new FileRepo(tempDir()), skip: false },
  { name: 'postgres', make: () => new PostgresRepo(DATABASE_URL ?? ''), skip: !DATABASE_URL },
];

for (const backend of backends) {
  describe.skipIf(backend.skip)(`OfficeStore with ${backend.name}`, () => {
    async function setup(repo = backend.make()) {
      const store = new OfficeStore(repo);
      await store.init();
      const stored = await store.create('Before', 'blank');
      const rename = (name: string) => store.update(stored.office.id, applyOp(stored.office, { t: 'settings', settings: { name } }));
      return { store, repo, id: stored.office.id, ownerKey: stored.ownerKey, rename };
    }

    /** Read what is actually persisted, through a fresh store with an empty cache. */
    async function persistedName(repo: OfficeRepo, id: string) {
      const raw = await repo.load(id);
      return (raw?.office as { settings: { name: string } } | undefined)?.settings.name;
    }

    it('persists new offices and loads them back in a fresh store', async () => {
      const { store, repo, id, ownerKey } = await setup();
      await store.close();
      const again = new OfficeStore(backend.name === 'files' ? repo : backend.make());
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
}

describe.skipIf(!DATABASE_URL)('server with Postgres', () => {
  it('keeps offices across restarts', async () => {
    const first = await startServer({ port: 0, host: '127.0.0.1', databaseUrl: DATABASE_URL, quiet: true, iceServers: [] });
    const res = await fetch(`http://127.0.0.1:${first.port}/api/offices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Persistent HQ', template: 'startup' }),
    });
    const { id } = (await res.json()) as { id: string };
    await first.close();

    const second = await startServer({ port: 0, host: '127.0.0.1', databaseUrl: DATABASE_URL, quiet: true, iceServers: [] });
    const info = await (await fetch(`http://127.0.0.1:${second.port}/api/offices/${id}`)).json();
    expect(info).toMatchObject({ id, name: 'Persistent HQ' });
    await second.close();
  });

  it('reports storage outages instead of "not found"', async () => {
    const broken = new OfficeStore(new PostgresRepo('postgres://nobody:wrong@127.0.0.1:1/none'));
    await expect(broken.get('someoffice')).rejects.toThrow();
    await broken.close();
  });
});
