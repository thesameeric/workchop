import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite, Results, Transaction } from '@electric-sql/pglite';
import type { Db, QueryResult, Tx } from './index';
import { assertOutsideTransaction, inTransactionScope } from './scope';

const LOCK_FILE = '.workchop.lock';
/** The lock file's mtime is refreshed this often, so servers on other hosts can tell it's in use. */
const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;
/** Lock files this process holds: a second open of the same directory must fail, not take over. */
const lockedHere = new Set<string>();

function toResult<T>(res: Results<T>): QueryResult<T> {
  // PGlite reports affectedRows only for writes; pg's rowCount also counts selected rows.
  return { rows: res.rows, rowCount: Math.max(res.affectedRows ?? 0, res.rows.length) };
}

function wrap(tx: Transaction): Tx {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      return toResult(await tx.query<T>(sql, params));
    },
    async exec(sql: string): Promise<void> {
      await tx.exec(sql);
    },
  };
}

/**
 * PGlite: Postgres in WebAssembly, in this process. Queries block the event loop while they run,
 * so keep them small (big files go to the "fs" upload store, not into the database).
 */
export class PGliteDb implements Db {
  readonly kind = 'pglite';

  constructor(
    private readonly pg: PGlite,
    readonly description: string,
    private readonly release?: () => Promise<void>,
  ) {}

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    assertOutsideTransaction(this);
    return toResult(await this.pg.query<T>(sql, params));
  }

  async exec(sql: string): Promise<void> {
    assertOutsideTransaction(this);
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    // In PGlite the outer handle waits for the transaction to finish, so using it inside one hangs forever.
    assertOutsideTransaction(this);
    return this.pg.transaction((tx) => inTransactionScope(this, () => fn(wrap(tx))));
  }

  async close(): Promise<void> {
    await this.pg.close();
    await this.release?.();
  }
}

/** Opens PGlite stored in `dir`, or in memory when `dir` is null (tests). */
export async function openPGlite(dir: string | null): Promise<PGliteDb> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  // Return the same types as node-postgres: int8 as a string, bytea as a Buffer.
  const options = {
    parsers: {
      [types.INT8]: (v: string) => v,
      [types.BYTEA]: (v: string) => Buffer.from(v.slice(2), 'hex'),
    },
    serializers: {
      [types.BYTEA]: (x: Uint8Array) => '\\x' + Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('hex'),
    },
  };
  if (!dir) return new PGliteDb(await PGlite.create(options), 'PGlite (in memory)');

  // PGlite doesn't create missing parent directories, and two processes using the same
  // directory corrupt it, so take a lock first.
  await fs.mkdir(dir, { recursive: true });
  const release = await lock(dir);
  try {
    const pg = await PGlite.create({ ...options, dataDir: dir });
    const relative = path.relative(process.cwd(), dir);
    return new PGliteDb(pg, `PGlite (${relative && !relative.startsWith('..') ? relative : dir})`, release);
  } catch (err) {
    await release();
    throw err;
  }
}

interface LockHolder {
  /** Missing when the file can't be read (e.g. another server is writing it right now). */
  pid?: number;
  hostname?: string;
  mtimeMs: number;
}

async function readLock(file: string): Promise<LockHolder | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<LockHolder>;
    if (typeof data.pid === 'number' && typeof data.hostname === 'string') return { pid: data.pid, hostname: data.hostname, mtimeMs };
  } catch {
    // Unreadable: its age decides.
  }
  return { mtimeMs };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Why the lock's holder can't be running any more, or null if it may be. */
function staleReason(holder: LockHolder): string | null {
  if (holder.pid === undefined || holder.hostname === undefined) {
    return Date.now() - holder.mtimeMs > 5000 ? 'unreadable' : null;
  }
  if (holder.hostname === os.hostname()) {
    // In Docker the server is PID 1 in every run, so our own pid in the file means a previous run.
    if (holder.pid === process.pid) return 'left by a previous run';
    return processAlive(holder.pid) ? null : `process ${holder.pid} is gone`;
  }
  // Another host (e.g. a replaced container): only its heartbeat tells whether it still runs.
  return Date.now() - holder.mtimeMs > STALE_MS ? `${holder.hostname} stopped updating it` : null;
}

/** Takes the directory's lock file; resolves to a function that releases it. */
async function lock(dir: string): Promise<() => Promise<void>> {
  const file = path.join(dir, LOCK_FILE);
  if (lockedHere.has(file)) throw new Error(`The database in ${dir} is already open in this process`);
  const started = Date.now();
  let waiting = false;
  for (;;) {
    try {
      const me = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
      await fs.writeFile(file, JSON.stringify(me), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = await readLock(file);
    if (!holder) continue;
    const stale = staleReason(holder);
    if (stale) {
      console.warn(`[db] removing a stale lock on ${dir} (${stale})`);
      await fs.rm(file, { force: true });
      continue;
    }
    const who = holder.pid === undefined ? 'another process' : `process ${holder.pid} on ${holder.hostname}`;
    // A server that is still shutting down, or one on another host whose heartbeat may be about to
    // stop, may let go soon: wait a little (longer for the heartbeat) before giving up.
    const patience = holder.hostname === os.hostname() ? 5000 : STALE_MS + HEARTBEAT_MS;
    if (Date.now() - started < patience) {
      if (!waiting) console.log(`[db] waiting for ${who} to release ${dir}`);
      waiting = true;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    throw new Error(
      `Another Workchop server (${who}) is using the database in ${dir}. Stop it first, or set DATA_DIR to another ` +
        `directory. If no other server is running, delete ${file}.`,
    );
  }
  lockedHere.add(file);
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(file, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    lockedHere.delete(file);
    await fs.rm(file, { force: true });
  };
}
