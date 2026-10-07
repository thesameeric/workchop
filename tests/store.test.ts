import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOp } from '../shared/office';
import { OfficeStore } from '../server/officeStore';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'workchop-store-'));
  dirs.push(dir);
  const store = new OfficeStore(dir);
  await store.init();
  const stored = await store.create('Before', 'blank');
  const rename = (name: string) => store.update(stored.office.id, applyOp(stored.office, { t: 'settings', settings: { name } }));
  const onDisk = () => JSON.parse(readFileSync(path.join(dir, `${stored.office.id}.json`), 'utf8')).office.settings.name;
  return { store, rename, onDisk };
}

describe('OfficeStore', () => {
  it('flush() writes edits that are still waiting for their save timer', async () => {
    const { store, rename, onDisk } = await setup();
    rename('After');
    await store.flush();
    expect(onDisk()).toBe('After');
  });

  it('flush() also waits for a save that has already started (shutdown race)', async () => {
    const { store, rename, onDisk } = await setup();
    rename('After');
    // Let the 400ms debounce fire so the write is in flight, then flush in the same tick.
    await new Promise((r) => setTimeout(r, 401));
    await store.flush();
    expect(onDisk()).toBe('After');
  });
});
