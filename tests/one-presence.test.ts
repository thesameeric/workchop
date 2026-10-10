import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR } from '../shared/avatar';
import type { JoinRequest, JoinResponse, ServerToClientEvents } from '../shared/types';
import { startServer } from '../server/index';
import { MAX_GUESTS_PER_ROOM, MAX_PLAYERS_PER_ROOM } from '../server/realtime';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, join, member, signIn, until, type Client, type Jar, type TestOffice } from './helpers/http';

// One presence per person per office: the same account, or the same browser (JoinRequest.browser),
// joining again takes their other connection there out ('elsewhere'); a page coming back by itself
// (JoinRequest.rejoin) doesn't, and is turned away instead.

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let base: string;
const loose: Client[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-presence-'));
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir, db: await createTestDb(), quiet: true, iceServers: [], auth: { google: null, apple: null, devLogin: true } });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  for (const s of loose) s.disconnect();
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A browser's or a page's secret (JoinRequest.browser, JoinRequest.resume). */
const secret = () => crypto.randomBytes(24).toString('base64url');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Everything a socket hears of one event, from now on. */
function heard<E extends keyof ServerToClientEvents>(socket: Client, event: E): Parameters<ServerToClientEvents[E]>[] {
  const got: Parameters<ServerToClientEvents[E]>[] = [];
  socket.on(event, ((...args: Parameters<ServerToClientEvents[E]>) => got.push(args)) as never);
  return got;
}

/**
 * Connects and joins with the office's guest link, and answers with whatever the server said
 * (refusals too) and the office:removed it hears from the start.
 */
async function attempt(office: TestOffice, request: Partial<JoinRequest> = {}, jar?: Jar) {
  const cookie = jar?.header();
  const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: cookie ? { cookie } : {} });
  loose.push(socket);
  const removed = heard(socket, 'office:removed');
  const res = await new Promise<JoinResponse>((resolve, reject) => {
    socket.on('connect_error', reject);
    socket.on('connect', () => socket.emit('join', { officeId: office.id, name: 'Someone', avatar: DEFAULT_AVATAR, guest: office.guest, ...request }, resolve));
  });
  return { socket, res, removed };
}

const userIdOf = async (jar: Jar) => ((await (await jar.fetch(`${base}/api/me`)).json()) as { user: { id: string } }).user.id;

const here = (officeId: string) => server.realtime.players(officeId).map((p) => p.id);

describe('one of you per office', () => {
  it('takes a signed-in person’s other tab out when they come in again; another office keeps them', async () => {
    const { id } = await createOffice(base, 'Olive');
    const other = await createOffice(base, 'Oscar');
    const pat = await signIn(base, 'Pat');
    const bob = await join(base, id, 'Bob');
    const tab1 = await join(base, id, 'Pat', { jar: pat });
    const elsewhere = await join(base, other.id, 'Pat', { jar: pat });
    const removed = heard(tab1.socket, 'office:removed');
    const left = heard(bob.socket, 'player:left');
    const joined = heard(bob.socket, 'player:joined');

    const tab2 = await join(base, id, 'Pat', { jar: pat });
    await until(() => removed.length === 1);
    expect(removed[0]).toEqual(['elsewhere']);
    // The older tab stays connected (it shows "open in another tab"), out of the office.
    await until(() => left.length === 1 && joined.length === 1);
    expect([left[0][0], joined[0][0].id]).toEqual([tab1.socket.id, tab2.socket.id]);
    expect(tab1.socket.connected).toBe(true);
    expect(here(id).sort()).toEqual([bob.socket.id, tab2.socket.id].sort());
    expect(tab2.res.ok && tab2.res.players.map((p) => p.id).sort()).toEqual([bob.socket.id, tab2.socket.id].sort());
    // One entry per office.
    expect(server.realtime.playersOfUser(await userIdOf(pat)).map((p) => p.player.id).sort()).toEqual([elsewhere.socket.id, tab2.socket.id].sort());
    expect(here(other.id)).toEqual([elsewhere.socket.id]);
    // Its own requests no longer reach the office.
    const moves = heard(bob.socket, 'player:moved');
    tab1.socket.emit('move', 3, 3, 0, 'idle');
    await wait(100);
    expect(moves).toEqual([]);
  });

  it('counts guests with the same browser as one person, and a browser shared with an account too', async () => {
    const office = await createOffice(base, 'Olive');
    const { id } = office;
    const browser = secret();
    const g1 = await attempt(office, { browser });
    // Another browser, no browser, or one that isn't a secret: both stay.
    const other = await attempt(office, { browser: secret() });
    const none = await attempt(office);
    const none2 = await attempt(office);
    const bad = await attempt(office, { browser: 'short' });
    const bad2 = await attempt(office, { browser: 'short' });
    expect([other, none, none2, bad, bad2].map((t) => t.res.ok)).toEqual([true, true, true, true, true]);
    await wait(100);
    expect([g1, other, none, none2, bad, bad2].flatMap((t) => t.removed)).toEqual([]);

    const g2 = await attempt(office, { browser });
    expect(g2.res.ok).toBe(true);
    await until(() => g1.removed.length === 1);
    expect(g1.removed[0]).toEqual(['elsewhere']);
    expect(here(id)).not.toContain(g1.socket.id);

    // The same browser, signed in now (in another tab): the guest steps aside, and the other way round.
    const jar = await signIn(base, 'Gail');
    const signedIn = await attempt(office, { browser }, jar);
    expect(signedIn.res.ok).toBe(true);
    await until(() => g2.removed.length === 1);
    const g3 = await attempt(office, { browser });
    expect(g3.res.ok).toBe(true);
    await until(() => signedIn.removed.length === 1);
    expect(here(id).sort()).toEqual([other, none, none2, bad, bad2, g3].map((t) => t.socket.id).sort());
  });

  it('lets a page back on a new connection replace its own, without “another tab”', async () => {
    const office = await createOffice(base, 'Olive');
    const pat = await signIn(base, 'Pat');
    const resume = secret();
    const browser = secret();
    const old = await attempt(office, { resume, browser }, pat);
    const dropped = new Promise<string>((resolve) => old.socket.on('disconnect', resolve));
    // Its network dropped (the server still has it); back by itself, or with Use here.
    const back = await attempt(office, { resume, browser, rejoin: true, at: { x: 4, z: 4, ry: 0, anim: 'idle' } }, pat);
    expect(back.res.ok).toBe(true);
    expect(await dropped).toBe('io server disconnect');
    const again = await attempt(office, { resume, browser }, pat);
    expect(again.res.ok).toBe(true);
    await until(() => back.socket.disconnected);
    expect([old.removed, back.removed]).toEqual([[], []]);
    expect(here(office.id)).toEqual([again.socket.id]);

    // Signed out in another tab: the page comes back as a guest of the same browser, its old
    // connection (signed in) not gone yet. Still the same page, not another tab.
    const page = secret();
    const other = await createOffice(base, 'Una');
    const signedIn = await attempt(other, { resume: page, browser }, pat);
    const asGuest = await attempt(other, { resume: page, browser, rejoin: true });
    expect(asGuest.res.ok).toBe(true);
    await wait(100);
    expect(signedIn.removed).toEqual([]);
  });

  it('turns a page coming back by itself away while the person is in on another connection', async () => {
    const office = await createOffice(base, 'Olive');
    const { id } = office;
    const pat = await signIn(base, 'Pat');
    const [a, b] = [secret(), secret()];
    // Tab A dropped; tab B opened meanwhile (and took A's stale connection over, unheard).
    const tabA = await attempt(office, { resume: a }, pat);
    const tabB = await attempt(office, { resume: b }, pat);
    await until(() => tabA.removed.length === 1);
    const late = await attempt(office, { resume: a, rejoin: true }, pat);
    expect(late.res).toEqual({ ok: false, error: 'Homeoffice is open in another tab.', reason: 'elsewhere' });
    await wait(100);
    expect([tabB.removed, here(id)]).toEqual([[], [tabB.socket.id]]);
    // Guests of one browser too.
    const browser = secret();
    const g1 = await attempt(office, { browser });
    expect((await attempt(office, { browser, rejoin: true })).res).toMatchObject({ ok: false, reason: 'elsewhere' });
    expect(here(id)).toContain(g1.socket.id);

    // Once B has left, A is let back in.
    tabB.socket.disconnect();
    await until(() => !here(id).includes(tabB.socket.id!));
    expect((await attempt(office, { resume: a, rejoin: true }, pat)).res.ok).toBe(true);
  });

  it('lets the newest tab in when the office is full', { timeout: 60_000 }, async () => {
    const office = await createOffice(base, 'Olive');
    const { id, owner } = office;
    const browser = secret();
    const ownerTab = await join(base, id, 'Olive', { jar: owner, guest: '' });
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM - MAX_GUESTS_PER_ROOM - 1; i++) {
      const jar = await member(base, server.db, id, `Member ${i}`);
      await join(base, id, `Member ${i}`, { jar, guest: '' });
    }
    const firstGuest = await attempt(office, { browser });
    for (let i = 1; i < MAX_GUESTS_PER_ROOM; i += 10) {
      const batch = await Promise.all(Array.from({ length: Math.min(10, MAX_GUESTS_PER_ROOM - i) }, () => attempt(office)));
      expect(batch.every((g) => g.res.ok)).toBe(true);
    }
    expect(here(id)).toHaveLength(MAX_PLAYERS_PER_ROOM);
    expect((await attempt(office)).res).toEqual({ ok: false, error: 'This office is full.' });

    const ownerRemoved = heard(ownerTab.socket, 'office:removed');
    expect((await join(base, id, 'Olive', { jar: owner, guest: '' })).res.ok).toBe(true);
    await until(() => ownerRemoved.length === 1);
    // A guest's newest tab too (guests' places are full as well).
    expect((await attempt(office, { browser })).res.ok).toBe(true);
    await until(() => firstGuest.removed.length === 1);
    expect(here(id)).toHaveLength(MAX_PLAYERS_PER_ROOM);
    for (const s of loose.splice(0)) s.disconnect();
    disconnectAll();
    await until(() => here(id).length === 0);
  });

  it('keeps exactly one of two joins sent at once', async () => {
    const office = await createOffice(base, 'Olive');
    const { id } = office;
    const pat = await signIn(base, 'Pat');
    for (let round = 0; round < 5; round++) {
      const tabs = await Promise.all([attempt(office, {}, pat), attempt(office, {}, pat)]);
      expect(tabs.every((t) => t.res.ok)).toBe(true);
      await until(() => tabs.flatMap((t) => t.removed).length === 1);
      await wait(50);
      const out = tabs.findIndex((t) => t.removed.length === 1);
      expect(tabs.flatMap((t) => t.removed)).toEqual([['elsewhere']]);
      expect(here(id)).toEqual([tabs[1 - out].socket.id]);
      for (const t of tabs) t.socket.disconnect();
      await until(() => here(id).length === 0);
    }
  });

  it('lets in the first of two pages coming back at once, and the one asking to be used here', async () => {
    const office = await createOffice(base, 'Olive');
    const { id } = office;
    const pat = await signIn(base, 'Pat');
    const [a, b] = [secret(), secret()];
    for (let round = 0; round < 3; round++) {
      // Both back from a sleep at once: one is let in, the other turned away.
      const both = await Promise.all([attempt(office, { resume: a, rejoin: true }, pat), attempt(office, { resume: b, rejoin: true }, pat)]);
      expect(both.map((t) => (t.res.ok ? 'in' : t.res.reason)).sort()).toEqual(['elsewhere', 'in']);
      const parked = both.findIndex((t) => !t.res.ok);
      both[parked].socket.disconnect();

      // The parked page's Use here (no rejoin) while the other comes back by itself: whichever
      // lands first, the one asking ends up in, and the other is turned away or taken out.
      const [useHere, auto] = await Promise.all([attempt(office, { resume: parked ? b : a }, pat), attempt(office, { resume: parked ? a : b, rejoin: true }, pat)]);
      expect(useHere.res.ok).toBe(true);
      await until(() => here(id).length === 1 && (!auto.res.ok || auto.removed.length === 1));
      expect(here(id)).toEqual([useHere.socket.id]);
      expect(auto.res.ok ? auto.removed : auto.res).toEqual(auto.res.ok ? [['elsewhere']] : { ok: false, error: 'Homeoffice is open in another tab.', reason: 'elsewhere' });
      expect(useHere.removed).toEqual([]);
      for (const t of [...both, useHere, auto]) t.socket.disconnect();
      await until(() => here(id).length === 0);
    }
  });
});
