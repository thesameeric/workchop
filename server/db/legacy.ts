import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isValidId, sanitizeOffice } from '../../shared/office';
import type { Office } from '../../shared/types';
import { jsonb, type Db } from './index';

interface LegacyFile {
  file: string;
  id: string;
  ownerKey: string;
  office: Office;
}

async function readOffices(dir: string): Promise<{ offices: LegacyFile[]; skipped: string[] }> {
  const offices: LegacyFile[] = [];
  const skipped: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { offices, skipped };
  }
  for (const name of names.sort()) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!isValidId(id)) continue;
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { office?: unknown; ownerKey?: unknown };
      const office = sanitizeOffice(raw?.office);
      if (!office || typeof raw.ownerKey !== 'string') throw new Error('not an office');
      offices.push({ file, id, ownerKey: raw.ownerKey, office: { ...office, id } });
    } catch {
      skipped.push(file);
    }
  }
  return { offices, skipped };
}

/** A name next to `target` that doesn't exist yet. */
async function freePath(target: string): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? target : `${target}-${i}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * Earlier versions kept each office in a JSON file: DATA_DIR/offices/<id>.json, or DATA_DIR/<id>.json
 * when DATA_DIR pointed at that folder. Copy them into the database once (offices already there are
 * kept), then move the files aside to "offices.imported" so this doesn't run again.
 */
export async function importLegacyOffices(db: Db, dataDir: string): Promise<string[]> {
  const nested = path.join(dataDir, 'offices');
  const fromNested = await readOffices(nested);
  const fromTop = await readOffices(dataDir);
  const all = [...fromNested.offices, ...fromTop.offices];
  if (!all.length && !fromNested.skipped.length) return [];

  const imported: string[] = [];
  const failed: string[] = [];
  // One at a time, so an office the database refuses doesn't stop the others (or the server).
  for (const o of all) {
    try {
      const res = await db.query('INSERT INTO offices (id, owner_key, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING', [
        o.id,
        o.ownerKey,
        jsonb(o.office),
      ]);
      if (res.rowCount) imported.push(`${o.id} (${o.office.settings.name})`);
    } catch (err) {
      failed.push(o.file);
      console.error(`[db] could not import ${o.file}: ${(err as Error).message}`);
    }
  }
  if (failed.length) {
    // Left where they are, to be tried again on the next start (imported ones are skipped then).
    console.warn(`[db] imported ${imported.length} of ${all.length} office files; the files stay in place until all of them can be imported`);
    return imported;
  }

  const done = await freePath(path.join(dataDir, 'offices.imported'));
  try {
    if (fromNested.offices.length || fromNested.skipped.length) await fs.rename(nested, done);
    if (fromTop.offices.length) {
      await fs.mkdir(done, { recursive: true });
      for (const o of fromTop.offices) await fs.rename(o.file, path.join(done, path.basename(o.file)));
    }
  } catch (err) {
    // Importing again next time is harmless: offices already in the database are left alone.
    console.warn(`[db] imported the old office files but could not move them to ${done}: ${(err as Error).message}`);
  }
  for (const file of fromNested.skipped) console.warn(`[db] skipped ${file}: not a valid office`);
  console.log(
    `[db] imported ${imported.length} of ${all.length} office files into the database` +
      (imported.length ? `: ${imported.join(', ')}` : '') +
      `. The files were moved to ${done}.`,
  );
  return imported;
}
