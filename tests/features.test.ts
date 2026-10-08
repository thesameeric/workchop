import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUser } from '../shared/account';
import type { Feature } from '../server/features';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, json, until } from './helpers/http';

// A feature declares its socket events by augmenting the shared event maps, like a shared/<feature>.ts would.
declare module '../shared/types' {
  interface ClientToServerEvents {
    'test:ping': (text: string, ack: (reply: { from: string; user: string | null; office: string | null; mayEdit: boolean }) => void) => void;
  }
  interface ServerToClientEvents {
    'test:pong': (text: string) => void;
  }
  interface PlayerState {
    pinged?: boolean;
  }
}

const seen: string[] = [];

/** A tiny feature that uses every hook, to show the mechanism works. Only used here. */
const ping: Feature = {
  name: 'ping',
  migrations: [{ id: 950, name: 'test_pings', sql: 'CREATE TABLE test_pings (id serial PRIMARY KEY, text text NOT NULL)' }],
  register(ctx) {
    ctx.app.get('/test/pings', async (_req, res) => {
      res.json((await ctx.db.query<{ text: string }>('SELECT text FROM test_pings ORDER BY id')).rows.map((r) => r.text));
    });
    ctx.app.post('/test/echo', (req, res) => {
      res.json(req.body);
    });
    ctx.app.get('/test/whoami', ctx.auth.requireUser, (_req, res) => {
      res.json({ id: (res.locals.user as AccountUser).id });
    });
    ctx.realtime.onJoin((s) => seen.push(`join ${s.me()?.name}`));
    ctx.realtime.onLeave((_s, left) => seen.push(`leave ${left.player.name}`));
    ctx.realtime.onSocket((s) => {
      const canPing = s.limiter(1, 2);
      s.socket.on('test:ping', async (text, ack) => {
        if (typeof ack !== 'function' || typeof text !== 'string' || !canPing()) return;
        await ctx.db.query('INSERT INTO test_pings (text) VALUES ($1)', [text]);
        const room = s.room();
        if (room) {
          ctx.realtime.emitToOffice(room.officeId, 'test:pong', text);
          ctx.realtime.updatePlayer(room.officeId, s.socket.id, { pinged: true });
        }
        if (s.user) ctx.realtime.emitToUser(s.user.id, 'test:pong', `just for you: ${text}`);
        ack({ from: s.me()?.name ?? '', user: s.user?.id ?? null, office: room?.officeId ?? null, mayEdit: s.mayEdit() });
      });
    });
  },
};

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-features-'));
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    db: await createTestDb(),
    dataDir,
    quiet: true,
    iceServers: [],
    features: [ping],
    auth: { google: null, apple: null, devLogin: true },
  });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('features', () => {
  it('add tables and routes under /api, before its 404', async () => {
    expect(await (await fetch(`${base}/api/test/pings`)).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/test/echo`, json({ a: [1] }))).json()).toEqual({ a: [1] });
    expect((await fetch(`${base}/api/test/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/test/whoami`)).status).toBe(401);
    const jar = new Jar();
    const login = (await (await jar.fetch(`${base}/api/auth/dev`, json({ name: 'Pat' }))).json()) as { user: AccountUser };
    expect(await (await jar.fetch(`${base}/api/test/whoami`)).json()).toEqual({ id: login.user.id });
  });

  it('handle socket events with the connection context and reach offices and users', async () => {
    const jar = new Jar();
    const pat = ((await (await jar.fetch(`${base}/api/auth/dev`, json({ name: 'Pat', email: 'pat@example.com' }))).json()) as { user: AccountUser }).user;
    const { id, ownerKey } = await createOffice(base);
    const a = await join(base, id, 'Pat', { jar, ownerKey });
    const b = await join(base, id, 'Bea');
    // Pat also has a tab open elsewhere.
    const elsewhere = await join(base, (await createOffice(base)).id, 'Pat 2', { jar });

    const pongs: string[] = [];
    const updates: unknown[] = [];
    b.socket.on('test:pong', (text) => pongs.push(`b ${text}`));
    b.socket.on('player:updated', (pid, patch) => updates.push([pid, patch]));
    elsewhere.socket.on('test:pong', (text) => pongs.push(`elsewhere ${text}`));

    const reply = await a.socket.timeout(2000).emitWithAck('test:ping', 'hello');
    expect(reply).toEqual({ from: 'Pat', user: pat.id, office: id, mayEdit: true });
    await until(() => pongs.length === 2 && updates.length === 1);
    expect(pongs.sort()).toEqual(['b hello', 'elsewhere just for you: hello']);
    expect(updates).toEqual([[a.socket.id, { pinged: true }]]);
    expect(server.realtime.playersOfUser(pat.id).map((p) => p.player.name).sort()).toEqual(['Pat', 'Pat 2']);
    expect(await (await fetch(`${base}/api/test/pings`)).json()).toEqual(['hello']);

    // Guests get a context too, and per-socket limiters work.
    expect(await b.socket.timeout(2000).emitWithAck('test:ping', 'from b')).toMatchObject({ from: 'Bea', user: null });
    await b.socket.timeout(2000).emitWithAck('test:ping', 'again');
    await expect(b.socket.timeout(300).emitWithAck('test:ping', 'too fast')).rejects.toThrow();

    b.socket.disconnect();
    await until(() => seen.includes('leave Bea'));
    expect(seen).toEqual(expect.arrayContaining(['join Pat', 'join Bea', 'join Pat 2', 'leave Bea']));
  });

  it('stop the server from starting when one fails', async () => {
    const broken: Feature = {
      name: 'broken',
      register() {
        throw new Error('missing setting');
      },
    };
    await expect(startServer({ port: 0, host: '127.0.0.1', db: server.db, quiet: true, iceServers: [], features: [broken] })).rejects.toThrow(
      'Feature "broken" failed to start: missing setting',
    );
  });
});
