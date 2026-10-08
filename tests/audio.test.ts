import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TAP_INTERVAL_MS } from '../shared/audio';
import { EMOTES, isEmote, reactionForKey, REACTIONS, sanitizeProfile } from '../shared/avatar';
import { TAPS_PER_PERSON, WindowLimiter } from '../server/features/audio';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, json, type Client } from './helpers/http';

describe('reactions', () => {
  it('have one number key each, 1–9 then 0, keeping the first six where they were', () => {
    expect(REACTIONS.map((r) => r.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(EMOTES.slice(0, 6)).toEqual(['👋', '❤️', '😂', '👍', '🎉', '✋']);
    expect(EMOTES).toEqual(expect.arrayContaining(['💃', '👏', '🔥', '🙌']));
    expect(new Set(EMOTES).size).toBe(EMOTES.length);
  });

  it('are looked up by key or key code', () => {
    expect(reactionForKey('Digit5')?.emoji).toBe('🎉');
    expect(reactionForKey('7')?.name).toBe('Dance');
    expect(reactionForKey('Numpad0')?.emoji).toBe('🙌');
    expect(reactionForKey('KeyH')).toBeUndefined();
    expect(reactionForKey('Digit10')).toBeUndefined();
  });

  it('are validated', () => {
    for (const e of EMOTES) expect(isEmote(e)).toBe(true);
    for (const bad of ['🍕', '', '👋👋', '❤', 42, null, undefined, { emoji: '👋' }]) expect(isEmote(bad)).toBe(false);
  });
});

describe('profile changes', () => {
  it('take focus (headphones) only as a real boolean', () => {
    expect(sanitizeProfile({ focus: true }, 'Ann')).toEqual({ focus: true });
    expect(sanitizeProfile({ focus: false }, 'Ann')).toEqual({ focus: false });
    for (const v of ['true', 1, 'yes', null, {}]) expect(sanitizeProfile({ focus: v }, 'Ann')).toEqual({ focus: false });
    expect(sanitizeProfile({ mic: true }, 'Ann')).not.toHaveProperty('focus');
  });

  it('ignore what only the server sets, and clean the rest', () => {
    expect(sanitizeProfile({ focus: true, app: 'vscode', x: 3, id: 'someone' }, 'Ann')).toEqual({ focus: true });
    expect(sanitizeProfile({ name: '  \u0007 ', status: 'partying', mic: 'on' }, 'Ann')).toEqual({ name: 'Ann', status: 'available', mic: false });
    expect(sanitizeProfile(null, 'Ann')).toEqual({});
    expect(sanitizeProfile('focus', 'Ann')).toEqual({});
  });
});

describe('WindowLimiter', () => {
  it('allows one tap per pair per interval, in each direction separately', () => {
    let now = 1_000_000;
    const taps = new WindowLimiter(30_000, 1, () => now);
    expect(taps.take('a\nb')).toBe(0);
    expect(taps.take('b\na')).toBe(0);
    expect(taps.take('a\nc')).toBe(0);
    now += 10_000;
    expect(taps.wait('a\nb')).toBe(20_000);
    expect(taps.take('a\nb')).toBe(20_000);
    now += 19_999;
    expect(taps.take('a\nb')).toBe(1);
    now += 1;
    expect(taps.wait('a\nb')).toBe(0);
    expect(taps.take('a\nb')).toBe(0);
  });

  it('allows a few per interval, counting only the ones it allowed', () => {
    let now = 0;
    const taps = new WindowLimiter(30_000, 3, () => now);
    expect(taps.take('bob')).toBe(0);
    now = 5_000;
    expect(taps.take('bob')).toBe(0);
    expect(taps.take('bob')).toBe(0);
    expect(taps.take('bob')).toBe(25_000);
    now = 29_000;
    expect(taps.take('bob')).toBe(1_000);
    // The first one is 30 s old: one more fits, then it waits for the second.
    now = 30_000;
    expect(taps.take('bob')).toBe(0);
    expect(taps.wait('bob')).toBe(5_000);
  });

  it('forgets old keys once it holds many', () => {
    let now = 0;
    const taps = new WindowLimiter(1000, 1, () => now);
    for (let i = 0; i < 1000; i++) taps.take(`p${i}`);
    now = 5000;
    taps.take('new');
    expect(taps.size).toBe(1);
  });
});

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-audio-'));
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    db: await createTestDb(),
    dataDir,
    quiet: true,
    iceServers: [],
    auth: { google: null, apple: null, devLogin: true },
  });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function next<E extends 'emote' | 'focus:tapped' | 'player:updated'>(socket: Client, event: E, ms = 2000) {
  return new Promise<unknown[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, ((...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    }) as never);
  });
}

/** Resolves true when `event` doesn't arrive within `ms`. */
function nothing(socket: Client, event: 'emote' | 'focus:tapped', ms = 300) {
  return new Promise<boolean>((resolve) => {
    const handler = () => resolve(false);
    socket.once(event, handler as never);
    setTimeout(() => {
      socket.off(event, handler as never);
      resolve(true);
    }, ms);
  });
}

const tap = (socket: Client, to: string) => socket.timeout(2000).emitWithAck('focus:tap', to);

describe('emotes', () => {
  it('broadcast the new reactions and drop anything else', async () => {
    const { id } = await createOffice(base);
    const a = await join(base, id, 'Ann');
    const b = await join(base, id, 'Bob');
    for (const emoji of ['💃', '🎉']) {
      const got = next(b.socket, 'emote');
      a.socket.emit('emote', emoji);
      expect(await got).toEqual([a.socket.id, emoji]);
    }
    const quiet = nothing(b.socket, 'emote');
    a.socket.emit('emote', '🍕');
    expect(await quiet).toBe(true);
  });
});

describe('shoulder taps', () => {
  it('reach people wearing headphones, once per 30 s from each person', async () => {
    const { id } = await createOffice(base);
    const ann = await join(base, id, 'Ann');
    const bob = await join(base, id, 'Bob');
    const cat = await join(base, id, 'Cat');
    const bobId = bob.socket.id!;

    expect(await tap(ann.socket, bobId)).toEqual({ ok: false, error: 'Bob took their headphones off. Just say hi!' });

    const updated = next(ann.socket, 'player:updated');
    bob.socket.emit('profile', { focus: true });
    expect(await updated).toEqual([bobId, { focus: true }]);

    const tapped = next(bob.socket, 'focus:tapped');
    expect(await tap(ann.socket, bobId)).toEqual({ ok: true });
    expect(await tapped).toEqual([ann.socket.id, 'Ann']);

    // Again too soon: refused, and Bob hears nothing.
    const quiet = nothing(bob.socket, 'focus:tapped');
    const again = await tap(ann.socket, bobId);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.error).toMatch(/^You tapped Bob a moment ago\. Try again in (29|30) s\.$/);
    expect(await quiet).toBe(true);
    expect(TAP_INTERVAL_MS).toBe(30_000);

    // Someone else still can.
    const fromCat = next(bob.socket, 'focus:tapped');
    expect(await tap(cat.socket, bobId)).toEqual({ ok: true });
    expect(await fromCat).toEqual([cat.socket.id, 'Cat']);

    expect((await tap(ann.socket, ann.socket.id!)).ok).toBe(false);
    expect(await tap(ann.socket, 'nobody')).toEqual({ ok: false, error: 'They’re no longer here.' });
  });

  it('count a signed-in person once across tabs, and need the office joined', async () => {
    const jar = new Jar();
    await jar.fetch(`${base}/api/auth/dev`, json({ name: 'Pat', email: 'pat@example.com' }));
    const { id } = await createOffice(base);
    const tab1 = await join(base, id, 'Pat', { jar });
    const tab2 = await join(base, id, 'Pat', { jar });
    const dee = await join(base, id, 'Dee');
    const updated = next(tab1.socket, 'player:updated');
    dee.socket.emit('profile', { focus: true });
    await updated;
    expect(await tap(tab1.socket, dee.socket.id!)).toEqual({ ok: true });
    expect((await tap(tab2.socket, dee.socket.id!)).ok).toBe(false);

    // A socket that hasn't joined an office.
    const loose: Client = connect(base, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => loose.on('connect', () => r(null)));
    expect((await tap(loose, dee.socket.id!)).ok).toBe(false);
    loose.disconnect();
  });

  it('reach one person only a few times in 30 s, even from new guests', async () => {
    const { id } = await createOffice(base);
    const tia = await join(base, id, 'Tia');
    const guests: Awaited<ReturnType<typeof join>>[] = [];
    for (let i = 0; i <= TAPS_PER_PERSON; i++) guests.push(await join(base, id, `G${i}`));
    const updated = next(guests[0].socket, 'player:updated');
    tia.socket.emit('profile', { focus: true });
    await updated;
    let knocks = 0;
    tia.socket.on('focus:tapped', () => knocks++);
    const tiaId = tia.socket.id!;

    expect(await tap(guests[0].socket, tiaId)).toEqual({ ok: true });
    // A refused tap doesn't use up Tia's taps.
    expect((await tap(guests[0].socket, tiaId)).ok).toBe(false);
    for (const g of guests.slice(1, TAPS_PER_PERSON)) expect(await tap(g.socket, tiaId)).toEqual({ ok: true });
    const last = await tap(guests[TAPS_PER_PERSON].socket, tiaId);
    expect(last.ok).toBe(false);
    expect(!last.ok && last.error).toMatch(/^Tia was tapped a few times just now\. Try again in (29|30) s\.$/);
    await new Promise((r) => setTimeout(r, 200));
    expect(knocks).toBe(TAPS_PER_PERSON);
  });
});
