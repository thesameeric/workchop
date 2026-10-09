import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountUser } from '../shared/account';
import {
  compactCoins,
  DAILY_COINS,
  parseTip,
  PRESENCE_COINS,
  PRESENCE_DAILY_CAP,
  WELCOME_COINS,
  type BalanceEvent,
  type TipAnswer,
  type TipEvent,
  type WalletHistoryResponse,
  type WalletResponse,
} from '../shared/coins';
import type { Db } from '../server/db';
import { collectMigrations, migrate } from '../server/db/migrations';
import type { Feature } from '../server/features';
import { feature as chat } from '../server/features/chat';
import { createCoins } from '../server/features/coins';
import { CoinsError, Wallets } from '../server/features/coins/wallets';
import { serverFeatures } from '../server/features/index';
import { startServer } from '../server/index';
import { freshDb, TEST_DATABASE_URL } from './helpers/db';
import { io as connect } from 'socket.io-client';
import { DEFAULT_AVATAR } from '../shared/avatar';
import type { JoinResponse, Status } from '../shared/types';
import type { MembersAnswer } from '../shared/workspace';
import { createOffice, disconnectAll, Jar, json, until, type Client } from './helpers/http';

const DB = TEST_DATABASE_URL ? 'Postgres' : 'PGlite';
const coins = createCoins();

describe('tip requests', () => {
  const key = crypto.randomUUID();
  it('are checked for amount, recipient, key and note', () => {
    expect(parseTip({ toPlayerId: 'p', amount: 5, key, note: '  thanks\n!  ' })).toEqual({
      ok: true,
      tip: { toPlayerId: 'p', toUserId: undefined, amount: 5, note: 'thanks !', key },
    });
    for (const amount of [0, -1, 501, 2.5, '5', NaN]) expect(parseTip({ toPlayerId: 'p', amount, key }).ok).toBe(false);
    expect(parseTip({ amount: 5, key }).ok).toBe(false);
    expect(parseTip({ toUserId: 'u', amount: 5, key: 'nope' }).ok).toBe(false);
    expect(parseTip({ toUserId: 'u', amount: 5, key, note: 7 }).ok).toBe(false);
    const long = parseTip({ toUserId: 'u', amount: 1, key, note: 'x'.repeat(139) + '😀' });
    expect(long.ok && long.tip.note).toBe('x'.repeat(139));
    expect(parseTip(null).ok).toBe(false);
  });

  it('show balances compactly', () => {
    expect([0, 999, 1000, 1250, 9999, 12_345, 999_999, 1_250_000].map(compactCoins)).toEqual(['0', '999', '1k', '1.2k', '9.9k', '12k', '999k', '1.2M']);
  });
});

describe(`the coin ledger on ${DB}`, () => {
  let db: Db;
  let clock = Date.parse('2026-03-01T10:00:00Z');
  let wallets: Wallets;
  const users: string[] = [];

  const addUser = async () => {
    const id = `u${crypto.randomBytes(6).toString('hex')}`;
    await db.query('INSERT INTO users (id, name) VALUES ($1, $2)', [id, `User ${users.length}`]);
    users.push(id);
    return id;
  };

  beforeAll(async () => {
    db = await freshDb();
    await migrate(db, collectMigrations([coins]));
    wallets = new Wallets(db, () => clock);
  }, 60_000);

  beforeEach(() => {
    clock = Date.parse('2026-03-01T10:00:00Z');
  });

  /** Every wallet equals the sum of its ledger, and each row's balance_after follows from the one before. */
  async function expectConsistent() {
    const { rows } = await db.query<{ user_id: string; delta: number; balance_after: number }>(
      'SELECT user_id, delta, balance_after FROM coin_ledger ORDER BY user_id, id',
    );
    const running = new Map<string, number>();
    for (const r of rows) {
      const next = (running.get(r.user_id) ?? 0) + r.delta;
      expect(r.balance_after).toBe(next);
      expect(next).toBeGreaterThanOrEqual(0);
      running.set(r.user_id, next);
    }
    const { rows: w } = await db.query<{ user_id: string; balance: number }>('SELECT user_id, balance FROM wallets');
    for (const r of w) expect(r.balance).toBe(running.get(r.user_id) ?? 0);
  }

  it('gives a welcome bonus once', async () => {
    const a = await addUser();
    const results = await Promise.all([wallets.ensure(a), wallets.ensure(a), wallets.ensure(a)]);
    expect(results.filter(Boolean)).toEqual([{ balance: WELCOME_COINS, delta: WELCOME_COINS, kind: 'welcome' }]);
    expect(await wallets.balance(a)).toBe(WELCOME_COINS);
    await expectConsistent();
  });

  it('never overdraws with many tips at once, and both sides stay consistent', async () => {
    const [a, b] = [await addUser(), await addUser()];
    await wallets.ensure(a);
    const tries = Array.from({ length: 12 }, () =>
      wallets.tip({ from: a, to: b, amount: 30, note: 'hi', key: crypto.randomUUID(), officeId: null }).then(
        () => 'ok',
        (err: Error) => (err instanceof CoinsError ? err.message : `unexpected: ${err.message}`),
      ),
    );
    const outcomes = await Promise.all(tries);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(3);
    expect(outcomes.filter((o) => o !== 'ok').every((o) => o === 'Not enough coins')).toBe(true);
    expect(await wallets.balance(a)).toBe(10);
    expect(await wallets.balance(b)).toBe(WELCOME_COINS + 90);
    await expectConsistent();
  });

  it('moves coins both ways at once without deadlocks or lost updates', async () => {
    const [a, b] = [await addUser(), await addUser()];
    const tips = [];
    for (let i = 0; i < 10; i++) {
      tips.push(wallets.tip({ from: a, to: b, amount: 7, note: '', key: crypto.randomUUID(), officeId: null }));
      tips.push(wallets.tip({ from: b, to: a, amount: 3, note: '', key: crypto.randomUUID(), officeId: null }));
    }
    await Promise.all(tips);
    expect(await wallets.balance(a)).toBe(WELCOME_COINS - 40);
    expect(await wallets.balance(b)).toBe(WELCOME_COINS + 40);
    await expectConsistent();
  });

  it('makes a tip once per key, even when retried at the same time', async () => {
    const [a, b] = [await addUser(), await addUser()];
    const key = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => wallets.tip({ from: a, to: b, amount: 25, note: '', key, officeId: null })));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.every((r) => r.fromBalance === WELCOME_COINS - 25)).toBe(true);
    expect(await wallets.balance(b)).toBe(WELCOME_COINS + 25);
    // Another sender may use the same uuid without clashing.
    const c = await addUser();
    expect((await wallets.tip({ from: c, to: b, amount: 1, note: '', key, officeId: null })).duplicate).toBe(false);
    // The same key for a different tip is refused, not reported as sent.
    await expect(wallets.tip({ from: a, to: b, amount: 26, note: '', key, officeId: null })).rejects.toThrow(/other details/);
    await expect(wallets.tip({ from: a, to: c, amount: 25, note: '', key, officeId: null })).rejects.toThrow(/other details/);
    const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM coin_ledger WHERE kind IN ('tip_in', 'tip_out') AND user_id = $1", [a]);
    expect(Number(rows[0].n)).toBe(1);
    await expectConsistent();
  });

  it('rejects tips to yourself, bad amounts and more than the balance', async () => {
    const [a, b] = [await addUser(), await addUser()];
    await wallets.ensure(a);
    await expect(wallets.tip({ from: a, to: a, amount: 1, note: '', key: crypto.randomUUID(), officeId: null })).rejects.toThrow(/yourself/);
    await expect(wallets.tip({ from: a, to: b, amount: 0, note: '', key: crypto.randomUUID(), officeId: null })).rejects.toThrow(CoinsError);
    await expect(wallets.tip({ from: a, to: b, amount: WELCOME_COINS + 1, note: '', key: crypto.randomUUID(), officeId: null })).rejects.toThrow(
      'Not enough coins',
    );
    await expect(db.query('UPDATE wallets SET balance = -1 WHERE user_id = $1', [a])).rejects.toThrow();
    expect(await wallets.balance(a)).toBe(WELCOME_COINS);
    await expectConsistent();
  });

  it('gives the daily bonus once per UTC day', async () => {
    const a = await addUser();
    clock = Date.parse('2026-03-01T23:59:00Z');
    const first = await Promise.all([wallets.daily(a, null), wallets.daily(a, null), wallets.daily(a, null)]);
    expect(first.filter(Boolean)).toEqual([{ balance: WELCOME_COINS + DAILY_COINS, delta: DAILY_COINS, kind: 'daily' }]);
    clock = Date.parse('2026-03-02T00:01:00Z');
    expect(await wallets.daily(a, null)).toEqual({ balance: WELCOME_COINS + 2 * DAILY_COINS, delta: DAILY_COINS, kind: 'daily' });
    expect(await wallets.daily(a, null)).toBeNull();
    await expectConsistent();
  });

  it('caps presence coins per UTC day', async () => {
    const a = await addUser();
    const awards = await Promise.all(Array.from({ length: 12 }, () => wallets.presence(a, null)));
    expect(awards.filter(Boolean)).toHaveLength(PRESENCE_DAILY_CAP / PRESENCE_COINS);
    expect(await wallets.balance(a)).toBe(WELCOME_COINS + PRESENCE_DAILY_CAP);
    clock = Date.parse('2026-03-02T08:00:00Z');
    expect(await wallets.presence(a, null)).toEqual({ balance: WELCOME_COINS + PRESENCE_DAILY_CAP + PRESENCE_COINS, delta: PRESENCE_COINS, kind: 'presence' });
    await expectConsistent();
  });

  it('pages through the history, newest first', async () => {
    const [a, b] = [await addUser(), await addUser()];
    for (let i = 0; i < 5; i++) await wallets.tip({ from: a, to: b, amount: i + 1, note: `n${i}`, key: crypto.randomUUID(), officeId: null });
    const page = await wallets.history(a, 3);
    expect(page.map((e) => e.delta)).toEqual([-5, -4, -3]);
    expect(page[0]).toMatchObject({ kind: 'tip_out', note: 'n4', counterparty: { id: b, name: expect.any(String) }, balanceAfter: WELCOME_COINS - 15 });
    const rest = await wallets.history(a, 10, page[2].id);
    expect(rest.map((e) => e.kind)).toEqual(['tip_out', 'tip_out', 'welcome']);
  });
});

describe(`coins in the office on ${DB}`, () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-coins-'));
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      db: await freshDb(),
      dataDir,
      quiet: true,
      iceServers: [],
      features: [createCoins({ tickMs: 20, presenceMs: 40, idleMs: 60_000 })],
      auth: { google: null, apple: null, devLogin: true },
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    disconnectAll();
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function signIn(name: string) {
    const jar = new Jar();
    const res = await jar.fetch(`${base}/api/auth/dev`, json({ name, email: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com` }));
    return { jar, user: ((await res.json()) as { user: AccountUser }).user };
  }

  const wallet = async (jar: Jar) => (await (await jar.fetch(`${base}/api/me/wallet`)).json()) as WalletResponse;
  const tip = (socket: Client, req: Record<string, unknown>) =>
    socket.timeout(3000).emitWithAck('coins:tip', { key: crypto.randomUUID(), ...req } as never) as Promise<TipAnswer>;

  const sockets: Client[] = [];
  afterAll(() => sockets.forEach((s) => s.disconnect()));

  /** Joins an office (away by default, so no presence coins), noting the office's coin state. */
  async function join(officeId: string, name: string, opts: { jar?: Jar; guest?: string; status?: Status } = {}) {
    const cookie = opts.jar?.header();
    const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: cookie ? { cookie } : {} });
    sockets.push(socket);
    const office: boolean[] = [];
    socket.on('coins:office', (s) => office.push(s.enabled));
    const res = await new Promise<JoinResponse>((resolve) => {
      socket.on('connect', () =>
        socket.emit('join', { officeId, name, avatar: DEFAULT_AVATAR, guest: opts.guest, status: opts.status ?? 'away' }, resolve),
      );
    });
    if (!res.ok) throw new Error(res.error);
    return { socket, id: res.selfId, office };
  }

  /** Two signed-in people (with the daily bonus), Ada the owner, and a guest in a fresh office. */
  async function setup() {
    const ada = await signIn('Ada');
    const bo = await signIn('Bo');
    const { id, guest } = await createOffice(base, ada.jar);
    const a = await join(id, 'Ada', { jar: ada.jar });
    const b = await join(id, 'Bo', { jar: bo.jar, guest });
    const g = await join(id, 'Guest', { guest });
    await until(async () => (await wallet(ada.jar)).balance === WELCOME_COINS + DAILY_COINS && (await wallet(bo.jar)).balance === WELCOME_COINS + DAILY_COINS);
    return { ada, bo, a, b, g, officeId: id, guest };
  }

  it('has wallets only for members', async () => {
    expect((await fetch(`${base}/api/me/wallet`)).status).toBe(401);
    expect((await fetch(`${base}/api/me/wallet/history`)).status).toBe(401);
    const { jar } = await signIn('Cy');
    const w = await wallet(jar);
    expect(w).toMatchObject({ balance: WELCOME_COINS, recent: [{ kind: 'welcome', delta: WELCOME_COINS }] });
    expect((await jar.fetch(`${base}/api/me/wallet/history?before=abc`)).status).toBe(400);
    const h = (await (await jar.fetch(`${base}/api/me/wallet/history?before=${w.recent[0].id + 1}`)).json()) as WalletHistoryResponse;
    expect(h).toMatchObject({ entries: [{ kind: 'welcome' }], more: false });
  });

  it('sends tips live to both people and the office, once per key', async () => {
    const { ada, bo, a, b, g } = await setup();
    const balances: BalanceEvent[] = [];
    const tipped: TipEvent[] = [];
    b.socket.on('coins:balance', (e) => balances.push(e));
    g.socket.on('coins:tipped', (e) => tipped.push(e));
    const key = crypto.randomUUID();
    // Names in the office can be anything; the shout-out uses account names.
    a.socket.emit('profile', { name: 'The CEO' });
    const answer = await tip(a.socket, { toPlayerId: b.id, amount: 25, note: 'thanks for the review!', key });
    expect(answer).toEqual({ ok: true, balance: WELCOME_COINS + DAILY_COINS - 25 });
    // A retry of the same tip changes nothing.
    expect(await tip(a.socket, { toUserId: bo.user.id, amount: 25, key })).toEqual(answer);
    await until(() => balances.length > 0 && tipped.length > 0);
    expect(balances).toEqual([{ balance: WELCOME_COINS + DAILY_COINS + 25, delta: 25, kind: 'tip_in' }]);
    expect(tipped[0]).toMatchObject({ from: { userId: ada.user.id, name: 'Ada' }, to: { userId: bo.user.id, name: 'Bo' }, amount: 25, note: 'thanks for the review!' });
    const w = await wallet(bo.jar);
    expect(w.balance).toBe(WELCOME_COINS + DAILY_COINS + 25);
    expect(w.recent[0]).toMatchObject({ kind: 'tip_in', delta: 25, counterparty: { id: ada.user.id, name: 'Ada' }, note: 'thanks for the review!' });
    await new Promise((r) => setTimeout(r, 100));
    expect(tipped).toHaveLength(1);
  });

  it('rejects guests, self-tips, guests as recipients, people elsewhere and overdrafts', async () => {
    const { ada, a, g } = await setup();
    const gid = g.id;
    expect(await tip(g.socket, { toPlayerId: a.id, amount: 5 })).toEqual({ ok: false, error: 'Sign in to send coins' });
    expect(await tip(a.socket, { toUserId: ada.user.id, amount: 5 })).toEqual({ ok: false, error: 'You can’t send coins to yourself' });
    expect(await tip(a.socket, { toPlayerId: gid, amount: 5 })).toEqual({ ok: false, error: 'They need to sign in to get coins' });
    const other = await signIn('Dee');
    expect(await tip(a.socket, { toUserId: other.user.id, amount: 5 })).toEqual({ ok: false, error: 'They’re not in this office' });
    expect(await tip(a.socket, { toUserId: other.user.id, amount: 501 })).toMatchObject({ ok: false });
    expect((await wallet(ada.jar)).balance).toBe(WELCOME_COINS + DAILY_COINS);
  });

  it('leaves support workspaces’ customers out of tips', async () => {
    const ada = await signIn('Ada');
    const bo = await signIn('Bo');
    const made = await ada.jar.fetch(`${base}/api/offices`, json({ name: 'Help', kind: 'support', template: 'support' }));
    const { id } = (await made.json()) as { id: string };
    const { access } = (await (await ada.jar.fetch(`${base}/api/offices/${id}/members`)).json()) as MembersAnswer;
    const guest = access!.link!.split('#guest=')[1];
    const a = await join(id, 'Ada', { jar: ada.jar });
    // Bo, signed in, comes in as a customer.
    const b = await join(id, 'Bo', { jar: bo.jar, guest });
    await until(async () => (await wallet(ada.jar)).balance > 0 && (await wallet(bo.jar)).balance > 0);
    expect(await tip(a.socket, { toPlayerId: b.id, amount: 5 })).toEqual({ ok: false, error: 'Visitors can’t send or get coins' });
    expect(await tip(b.socket, { toPlayerId: a.id, amount: 5 })).toEqual({ ok: false, error: 'Visitors can’t send or get coins' });
  });

  it('limits tips to 10 a minute and refuses overdrafts', async () => {
    const { ada, a, b, officeId } = await setup();
    const to = b.id;
    const answers = [];
    for (let i = 0; i < 11; i++) answers.push(await tip(a.socket, { toPlayerId: to, amount: 1 }));
    expect(answers.slice(0, 10).every((r) => r.ok)).toBe(true);
    expect(answers[10]).toMatchObject({ ok: false, error: expect.stringMatching(/minute/) });
    // Coming in again doesn't reset the limit.
    const again = await join(officeId, 'Ada', { jar: ada.jar });
    expect(await tip(again.socket, { toPlayerId: to, amount: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/minute/) });
    expect((await wallet(ada.jar)).balance).toBe(WELCOME_COINS + DAILY_COINS - 10);
    const { a: a2, b: b2, ada: ada2 } = await setup();
    expect(await tip(a2.socket, { toPlayerId: b2.id, amount: 500 })).toEqual({ ok: false, error: 'Not enough coins' });
    expect((await wallet(ada2.jar)).balance).toBe(WELCOME_COINS + DAILY_COINS);
  });

  it('lets only the owner turn coins off for the office, which stops tips there', async () => {
    const { a, b } = await setup();
    const states: boolean[] = [];
    b.socket.on('coins:office', (s) => states.push(s.enabled));
    expect(await b.socket.timeout(3000).emitWithAck('coins:office', false)).toEqual({ ok: false, error: 'Only the owner can change this' });
    expect(await a.socket.timeout(3000).emitWithAck('coins:office', false)).toEqual({ ok: true });
    await until(() => states.length === 1);
    expect(states).toEqual([false]);
    expect(await tip(a.socket, { toPlayerId: b.id, amount: 5 })).toEqual({ ok: false, error: 'Coins are off in this office' });
    expect(await a.socket.timeout(3000).emitWithAck('coins:office', true)).toEqual({ ok: true });
    expect((await tip(a.socket, { toPlayerId: b.id, amount: 5 })).ok).toBe(true);
  });

  it('tells people joining whether coins are on', async () => {
    const { a, officeId, guest } = await setup();
    expect(await a.socket.timeout(3000).emitWithAck('coins:office', false)).toEqual({ ok: true });
    const eve = await join(officeId, 'Eve', { guest });
    await until(() => eve.office.length > 0);
    expect(eve.office).toEqual([false]);
    expect(a.office).toEqual([true, false]);
  });

  it('pays presence coins to active members, up to the daily cap, and not while away', async () => {
    const { ada, bo, officeId } = await setup();
    await join(officeId, 'Ada', { jar: ada.jar, status: 'available' });
    await until(async () => (await wallet(ada.jar)).balance === WELCOME_COINS + DAILY_COINS + PRESENCE_DAILY_CAP, 5000);
    await new Promise((r) => setTimeout(r, 300));
    const w = await wallet(ada.jar);
    expect(w.balance).toBe(WELCOME_COINS + DAILY_COINS + PRESENCE_DAILY_CAP);
    expect(w.recent.filter((e) => e.kind === 'presence')).toHaveLength(PRESENCE_DAILY_CAP / PRESENCE_COINS);
    expect((await wallet(bo.jar)).balance).toBe(WELCOME_COINS + DAILY_COINS);
  });
});

describe(`presence coins and idleness on ${DB}`, () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let dataDir: string;
  // Idleness follows this clock; presence time grows with each (real) tick.
  let clock = Date.parse('2026-03-02T10:00:00Z');
  const IDLE_MS = 60_000;
  // Stands in for the desktop helper: sets the app others see you in.
  const apps: Feature = {
    name: 'test-apps',
    register(ctx) {
      ctx.realtime.onSocket((s) =>
        s.socket.on('test:app' as never, ((app: string) => {
          const room = s.room();
          const me = s.me();
          if (room && me) ctx.realtime.updatePlayer(room.officeId, me.id, { app });
        }) as never),
      );
    },
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-coins-idle-'));
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      db: await freshDb(),
      dataDir,
      quiet: true,
      iceServers: [],
      features: [chat, createCoins({ now: () => clock, tickMs: 20, presenceMs: 40, idleMs: IDLE_MS }), apps],
      auth: { google: null, apple: null, devLogin: true },
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  const sockets: Client[] = [];
  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const balance = async (jar: Jar) => ((await (await jar.fetch(`${base}/api/me/wallet`)).json()) as WalletResponse).balance;

  /** Someone signed in (a new account, or that browser's), available in the office. */
  async function member(officeId: string, name: string, opts: { jar?: Jar; guest?: string } = {}) {
    const jar = opts.jar ?? new Jar();
    if (!opts.jar) await jar.fetch(`${base}/api/auth/dev`, json({ name, email: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com` }));
    const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: jar.header() } });
    sockets.push(socket);
    const res = await new Promise<JoinResponse>((resolve) => {
      socket.on('connect', () => socket.emit('join', { officeId, name, avatar: DEFAULT_AVATAR, guest: opts.guest, status: 'available' }, resolve));
    });
    if (!res.ok) throw new Error(res.error);
    return { jar, socket };
  }

  it('stops paying idle members, and counts chat, status changes and switching apps as activity', async () => {
    const { id, guest } = await createOffice(base);
    const activities: [string, (socket: Client) => void][] = [
      ['chat', (socket) => socket.emit('chat:send', { conv: 'c:none', text: 'hi' } as never, () => {})],
      ['status', (socket) => socket.emit('profile', { status: 'busy' })],
      ['app', (socket) => (socket as unknown as { emit(event: string, app: string): void }).emit('test:app', 'figma')],
    ];
    for (const [name, act] of activities) {
      const { jar, socket } = await member(id, name, { guest });
      await until(async () => (await balance(jar)) >= WELCOME_COINS + DAILY_COINS);
      // Nothing for a while (and no mic, camera or screen): idle, so no presence coins.
      clock += IDLE_MS + 1000;
      await sleep(100);
      const idle = await balance(jar);
      await sleep(200);
      expect(await balance(jar), name).toBe(idle);
      act(socket);
      await until(async () => (await balance(jar)) > idle);
    }
  });

  it('pays no presence coins (and no daily bonus) in an office with coins off', async () => {
    const { id, owner: ownerJar, guest } = await createOffice(base);
    const owner = await member(id, 'Owner', { jar: ownerJar });
    expect(await owner.socket.timeout(3000).emitWithAck('coins:office', false)).toEqual({ ok: true });
    const { jar, socket } = await member(id, 'Active', { guest });
    for (let i = 0; i < 10; i++) {
      socket.emit('move', 5 + i * 0.1, 5, 0, 'walk');
      await sleep(30);
    }
    expect(await balance(jar)).toBe(WELCOME_COINS);
  });
});

// Coins are off until they're redesigned: only COINS=on (for development) brings them back. The
// tests above turn them on by passing the feature in.
describe(`coins switched off (the default) on ${DB}`, () => {
  const names = (env: NodeJS.ProcessEnv) => serverFeatures(env).map((f) => f.name);

  it('are part of the server only with COINS=on', () => {
    for (const COINS of [undefined, '', 'off', 'yes', 'true']) expect(names({ COINS })).not.toContain('coins');
    expect(names({ COINS: 'on' })).toContain('coins');
    expect(names({ COINS: ' ON ' })).toContain('coins');
    // Everything else is the same either way.
    expect(names({})).toEqual(names({ COINS: 'on' }).filter((n) => n !== 'coins'));
  });

  it('have no tables, routes, socket events or timers', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-coins-off-'));
    const start = async (env: NodeJS.ProcessEnv) =>
      startServer({ port: 0, host: '127.0.0.1', db: await freshDb(), dataDir, quiet: true, iceServers: [], features: serverFeatures(env), auth: { google: null, apple: null, devLogin: true } });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const on = await start({ COINS: 'on' });
    const withCoins = intervals.mock.calls.length;
    await on.close();
    intervals.mockClear();
    const server = await start({});
    // The coins' presence timer is the only difference.
    expect(intervals.mock.calls.length).toBe(withCoins - 1);
    intervals.mockRestore();
    try {
      const base = `http://127.0.0.1:${server.port}`;
      for (const table of ['wallets', 'coin_ledger']) {
        expect((await server.db.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [table])).rows[0].t).toBeNull();
      }
      const jar = new Jar();
      await jar.fetch(`${base}/api/auth/dev`, json({ name: 'Ada', email: `ada-${crypto.randomUUID()}@example.com` }));
      for (const route of ['/api/me/wallet', '/api/me/wallet/history']) expect((await jar.fetch(`${base}${route}`)).status).toBe(404);

      const { id } = await createOffice(base, jar);
      const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: jar.header() } });
      const heard: string[] = [];
      socket.onAny((event: string) => heard.push(event));
      const res = await new Promise<JoinResponse>((resolve) => {
        socket.on('connect', () => socket.emit('join', { officeId: id, name: 'Ada', avatar: DEFAULT_AVATAR }, resolve));
      });
      expect(res.ok).toBe(true);
      // Nobody answers coin requests.
      await expect(socket.timeout(300).emitWithAck('coins:tip', { toUserId: 'someone', amount: 5, key: crypto.randomUUID() })).rejects.toThrow();
      await expect(socket.timeout(300).emitWithAck('coins:office', false)).rejects.toThrow();
      expect(heard.filter((e) => e.startsWith('coins:'))).toEqual([]);
      socket.disconnect();
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
