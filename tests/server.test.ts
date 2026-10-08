import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jukeboxData, type SpotifySession } from '../shared/music';
import type { ServerToClientEvents } from '../shared/types';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { createOffice as newOffice, disconnectAll, Jar, join as joinAs, json, member, type Client } from './helpers/http';

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let base: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-test-'));
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir, db: await createTestDb(), quiet: true, iceServers: [], auth: { google: null, apple: null, devLogin: true } });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** An office owned by `owner` (an account of that name), with its guest link on. */
const createOffice = (template = 'blank', owner = 'Owner') => newOffice(base, owner, 'Test HQ', template);

/** Joins as a guest, or with a browser (the owner's, a member's). */
const join = (officeId: string, name: string, jar?: Jar) => joinAs(base, officeId, name, { jar });

/** The office as saved in the database. */
async function saved(id: string) {
  const res = await server.db.query<{ data: { items: { id: string; data?: { station: string; links: { url: string }[] } }[]; settings: { buildPolicy: string } } }>(
    'SELECT data FROM offices WHERE id = $1',
    [id],
  );
  return { office: res.rows[0].data };
}

function next<E extends keyof ServerToClientEvents>(socket: Client, event: E, ms = 2000): Promise<Parameters<ServerToClientEvents[E]>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, ((...args: Parameters<ServerToClientEvents[E]>) => {
      clearTimeout(timer);
      resolve(args);
    }) as never);
  });
}

function nothing<E extends keyof ServerToClientEvents>(socket: Client, event: E, ms = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => resolve(false);
    socket.once(event, handler as never);
    setTimeout(() => {
      socket.off(event, handler as never);
      resolve(true);
    }, ms);
  });
}

describe('REST API', () => {
  it('creates offices and reports them', async () => {
    const { id, owner, guest } = await createOffice();
    expect(id).toMatch(/^[a-z0-9]{10}$/);
    const info = await (await owner.fetch(`${base}/api/offices/${id}`)).json();
    expect(info).toEqual({ id, name: 'Test HQ', kind: 'team', role: 'owner', online: 0 });
    const asGuest = await fetch(`${base}/api/offices/${id}`, { headers: { 'X-Workchop-Guest': guest } });
    expect(await asGuest.json()).toEqual({ id, name: 'Test HQ', kind: 'team', role: 'guest', online: 0 });
    expect((await fetch(`${base}/api/offices/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${base}/api/offices/..%2F..%2Fetc`)).status).toBe(404);
    // Only people signed in make offices, and no owner key comes back.
    expect((await fetch(`${base}/api/offices`, json({ name: 'Nope' }))).status).toBe(401);
    const made = await owner.fetch(`${base}/api/offices`, json({ name: 'Two', kind: 'team', template: 'startup' }));
    expect(made.status).toBe(201);
    expect(Object.keys(await made.json())).toEqual(['id']);
    for (const body of [{ template: 'castle' }, { kind: 'support' }, { kind: 'shop' }, { kind: 'support', template: 'blank' }]) {
      expect((await owner.fetch(`${base}/api/offices`, json(body))).status).toBe(400);
    }
  });

  it('saves names cut in the middle of an emoji', async () => {
    // Names are cut at a length limit; half an emoji left at the end can't be stored as JSON in Postgres.
    const { owner: jar } = await createOffice();
    const res = await jar.fetch(`${base}/api/offices`, json({ name: 'a'.repeat(47) + '😀 party' }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(((await (await jar.fetch(`${base}/api/offices/${id}`)).json()) as { name: string }).name).toBe('a'.repeat(47));
    const owner = await join(id, 'Owner', jar);
    const renamed = next(owner.socket, 'office:op');
    owner.socket.emit('office:op', { t: 'settings', settings: { name: 'b'.repeat(47) + '🎉 x' } });
    await renamed;
    owner.socket.emit('office:op', { t: 'add', item: { id: 'sofa1', type: 'sofa', x: 5, z: 5, rot: 0 } });
    await next(owner.socket, 'office:op');
    await server.store.flush();
    const stored = (await saved(id)).office as unknown as { settings: { name: string }; items: { id: string }[] };
    expect(stored.settings.name).toBe('b'.repeat(47));
    expect(stored.items.some((i) => i.id === 'sofa1')).toBe(true);
  });

  it('serves ICE configuration', async () => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    expect(cfg).toEqual({ iceServers: [], turn: false, spotifyClientId: null, uploadMaxBytes: 10 * 1024 * 1024 });
  });
});

describe('the built client', () => {
  it('serves the page for app addresses, and 404 for files an older build had', async () => {
    const clientDir = mkdtempSync(path.join(tmpdir(), 'workchop-client-'));
    mkdirSync(path.join(clientDir, 'assets'));
    writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Workchop</title>');
    writeFileSync(path.join(clientDir, 'assets', 'World-new.js'), 'export {};');
    const app = await startServer({ port: 0, host: '127.0.0.1', dataDir, db: await createTestDb(), quiet: true, iceServers: [], clientDir });
    try {
      const at = (p: string) => fetch(`http://127.0.0.1:${app.port}${p}`);
      const page = await at('/o/abc');
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>Workchop</title>');
      expect((await at('/assets/World-new.js')).headers.get('content-type')).toContain('javascript');
      // A page left open over an update asks for its old chunks: they're gone, not the page.
      const old = await at('/assets/World-old.js');
      expect(old.status).toBe(404);
      expect(old.headers.get('content-type')).toContain('text/plain');
    } finally {
      await app.close();
      rmSync(clientDir, { recursive: true, force: true });
    }
  });
});

describe('realtime', () => {
  it('rejects unknown offices', async () => {
    await expect(join('nope-nope', 'Ann')).rejects.toThrow(/does not exist/);
  });

  it('links nearby people, relays signalling, and unlinks them when they walk apart', async () => {
    const { id } = await createOffice();
    const a = await join(id, 'Ann');
    const bJoined = next(a.socket, 'player:joined');
    const aLinked = next(a.socket, 'peer:connect');
    const b = await join(id, 'Bob');
    expect(b.res.ok && b.res.players.map((p) => p.name).sort()).toEqual(['Ann', 'Bob']);
    // New arrivals don't spawn on top of each other.
    const [p1, p2] = b.res.ok ? b.res.players : [];
    expect(Math.hypot(p1.x - p2.x, p1.z - p2.z)).toBeGreaterThan(0.9);
    expect((await bJoined)[0].name).toBe('Bob');

    // Both spawn near the spawn point, so they're linked straight away.
    const [peerOfA, sid, aInitiates] = await aLinked;
    const bId = b.res.ok ? b.res.selfId : '';
    const aId = a.res.ok ? a.res.selfId : '';
    expect(peerOfA).toBe(bId);
    expect(aInitiates).toBe(aId < bId);

    // Signals are relayed only for the current link id.
    const relayed = next(b.socket, 'rtc:signal');
    a.socket.emit('rtc:signal', bId, sid, { sdp: { type: 'offer', sdp: 'v=0' } });
    expect(await relayed).toEqual([aId, sid, { sdp: { type: 'offer', sdp: 'v=0' } }]);
    const stale = nothing(b.socket, 'rtc:signal');
    a.socket.emit('rtc:signal', bId, sid + 1000, { sdp: { type: 'offer', sdp: 'v=0' } });
    expect(await stale).toBe(true);

    // Walking far away ends the call.
    const unlinked = next(b.socket, 'peer:disconnect');
    a.socket.emit('move', 1, 1, 0, 'walk');
    b.socket.emit('move', 19, 15, 0, 'walk');
    expect((await unlinked)[0]).toBe(aId);

    // ...and nothing is relayed any more.
    const blocked = nothing(b.socket, 'rtc:signal');
    a.socket.emit('rtc:signal', bId, sid, { candidate: { candidate: 'x' } });
    expect(await blocked).toBe(true);

    // Nearby chat only reaches linked people; a channel reaches everyone.
    const quiet = nothing(b.socket, 'chat:message');
    a.socket.emit('chat:send', { conv: 'nearby', text: 'psst' }, () => {});
    expect(await quiet).toBe(true);
    const list = await a.socket.timeout(2000).emitWithAck('chat:channels');
    const general = list.ok ? list.channels[0].id : '';
    const loud = next(b.socket, 'chat:message');
    a.socket.emit('chat:send', { conv: `c:${general}`, text: 'hello all' }, () => {});
    expect((await loud)[0]).toMatchObject({ text: 'hello all', name: 'Ann', channelId: general });
  });

  it('private zones only link the people inside them', async () => {
    const { id, owner } = await createOffice();
    const a = await join(id, 'Ann', owner);
    const b = await join(id, 'Bob');
    const c = await join(id, 'Cat');
    // Spread everybody out, then draw a room around Ann and Bob.
    a.socket.emit('move', 2, 2, 0, 'idle');
    b.socket.emit('move', 6, 6, 0, 'idle');
    c.socket.emit('move', 18, 14, 0, 'idle');
    await new Promise((r) => setTimeout(r, 150));

    const abLinked = next(a.socket, 'peer:connect');
    a.socket.emit('office:op', { t: 'zone:add', zone: { id: 'room', name: 'Room', x: 0, z: 0, w: 8, d: 8, color: '#6c8cff' } });
    const [peer] = await abLinked;
    expect(peer).toBe(b.res.ok && b.res.selfId);

    // Cat walks right next to the room's wall but outside it: no link with anyone inside.
    const noLink = nothing(c.socket, 'peer:connect', 400);
    c.socket.emit('move', 8.6, 6, 0, 'idle');
    expect(await noLink).toBe(true);
  });

  it('broadcasts and persists office edits, and enforces who may build', async () => {
    const { id, owner: ownerJar } = await createOffice();
    const owner = await join(id, 'Owner', ownerJar);
    const builder = await join(id, 'Mo', await member(base, server.db, id, 'Mo'));
    const admin = await join(id, 'Ada', await member(base, server.db, id, 'Ada', 'admin'));
    const guest = await join(id, 'Guest');
    expect(owner.res.ok && [owner.res.isOwner, owner.res.role]).toEqual([true, 'owner']);
    expect(builder.res.ok && [builder.res.isOwner, builder.res.role]).toEqual([false, 'member']);
    expect(guest.res.ok && [guest.res.isOwner, guest.res.role, guest.res.kind, guest.res.guests]).toEqual([false, 'guest', 'team', 'link']);

    // Members build by default; edits are normalised (snapped) and echoed to everybody.
    const seen = next(owner.socket, 'office:op');
    builder.socket.emit('office:op', { t: 'add', item: { id: 'sofa1', type: 'sofa', x: 5.2, z: 5.1, rot: 0 } });
    const [op, by] = await seen;
    expect(op).toEqual({ t: 'add', item: { id: 'sofa1', type: 'sofa', x: 5, z: 5, rot: 0 } });
    expect(by).toBe(builder.res.ok && builder.res.selfId);

    // Guests with the guest link don't build.
    const notGuests = next(guest.socket, 'office:sync');
    guest.socket.emit('office:op', { t: 'remove', id: 'sofa1' });
    expect((await notGuests)[1]).toMatch(/only members/i);

    // Members can't change the build policy.
    const refused = next(builder.socket, 'office:sync');
    builder.socket.emit('office:op', { t: 'settings', settings: { buildPolicy: 'owner' } });
    expect((await refused)[1]).toMatch(/owner/i);

    // The owner can, after which members' edits bounce, and admins still build.
    const policy = next(builder.socket, 'office:op');
    owner.socket.emit('office:op', { t: 'settings', settings: { buildPolicy: 'owner' } });
    expect((await policy)[0]).toMatchObject({ t: 'settings', settings: { buildPolicy: 'owner' } });
    const bounced = next(builder.socket, 'office:sync');
    builder.socket.emit('office:op', { t: 'remove', id: 'sofa1' });
    const [office, reason] = await bounced;
    expect(reason).toMatch(/only the owner/i);
    expect(office.items.some((i) => i.id === 'sofa1')).toBe(true);
    const byAdmin = next(owner.socket, 'office:op');
    admin.socket.emit('office:op', { t: 'add', item: { id: 'lamp1', type: 'floor-lamp', x: 7, z: 7, rot: 0 } });
    expect((await byAdmin)[0]).toMatchObject({ t: 'add', item: { id: 'lamp1' } });

    // Invalid edits are rejected with a resync rather than corrupting state.
    const invalid = next(owner.socket, 'office:sync');
    owner.socket.emit('office:op', { t: 'add', item: { id: 'x', type: 'death-star', x: 1, z: 1, rot: 0 } });
    expect((await invalid)[1]).toMatch(/invalid/i);

    // Everything is saved, and the owner key and guest token are never sent to clients.
    await server.store.flush();
    const stored = await saved(id);
    expect(stored.office.items.some((i) => i.id === 'sofa1')).toBe(true);
    expect(stored.office.settings.buildPolicy).toBe('owner');
    const secrets = server.store.peek(id)!;
    for (const res of [owner.res, guest.res]) {
      expect(JSON.stringify(res)).not.toContain(secrets.ownerKey);
      expect(JSON.stringify(res)).not.toContain(secrets.guestToken);
    }
  });

  it('jukebox changes are shared, saved, and protected from build edits', async () => {
    const { id, owner: ownerJar } = await createOffice('startup');
    const owner = await join(id, 'Owner', ownerJar);
    const guest = await join(id, 'Guest', await member(base, server.db, id, 'Guest'));
    const office = owner.res.ok ? owner.res.office : null;
    const jukebox = office!.items.find((i) => i.type === 'jukebox')!;
    expect(jukeboxData(jukebox).station).toBe('lofi');

    // Anyone can change the station; everyone gets the update.
    const seen = next(owner.socket, 'office:op');
    guest.socket.emit('music', { t: 'station', itemId: jukebox.id, station: 'ambient' });
    const [op] = await seen;
    expect(op).toMatchObject({ t: 'update', item: { id: jukebox.id, data: { station: 'ambient' } } });

    // Members can't set up a custom stream when only the owner may edit.
    owner.socket.emit('office:op', { t: 'settings', settings: { buildPolicy: 'owner' } });
    await next(guest.socket, 'office:op');
    const refused = next(guest.socket, 'notice');
    guest.socket.emit('music', { t: 'station', itemId: jukebox.id, station: 'stream', stream: 'https://radio.example/live' });
    expect((await refused)[0]).toMatch(/edit/i);

    // Share a link, then try to wipe it with a stale build edit: the board survives.
    const shared = Promise.all([next(owner.socket, 'office:op'), next(guest.socket, 'office:op')]);
    guest.socket.emit('music', { t: 'link:add', itemId: jukebox.id, url: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3' });
    await shared;
    const moved = next(guest.socket, 'office:op');
    owner.socket.emit('office:op', { t: 'update', item: { ...jukebox, x: jukebox.x - 1, data: { station: null, links: [] } } });
    const [moveOp] = await moved;
    expect(moveOp).toMatchObject({ t: 'update', item: { x: jukebox.x - 1, data: { station: 'ambient' } } });
    expect(moveOp.t === 'update' && jukeboxData(moveOp.item).links).toHaveLength(1);

    // Turning some other item into a jukebox can't smuggle in a forged board or stream.
    const desk = office!.items.find((i) => i.type === 'desk')!;
    const retyped = next(guest.socket, 'office:op');
    const forged = { station: 'stream' as const, stream: 'https://evil.example/s', links: [{ id: 'x1', url: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3', kind: 'album' as const, title: 'Spoofed', by: 'Owner', byId: 'nobody', at: 1 }] };
    owner.socket.emit('office:op', { t: 'update', item: { ...desk, type: 'jukebox', data: forged } });
    const [retypeOp] = await retyped;
    expect(retypeOp).toMatchObject({ t: 'update', item: { id: desk.id, type: 'jukebox', data: { station: null, links: [] } } });
    expect(retypeOp.t === 'update' && jukeboxData(retypeOp.item).stream).toBeUndefined();

    await server.store.flush();
    const savedBox = (await saved(id)).office.items.find((i) => i.id === jukebox.id)!;
    expect(savedBox.data?.station).toBe('ambient');
    expect(savedBox.data?.links[0].url).toBe('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3');
  });

  it('runs Spotify listen-along sessions: start, take over, stop, and end when the DJ leaves', async () => {
    const { id, owner } = await createOffice('startup', 'Ann');
    const a = await join(id, 'Ann', owner);
    const b = await join(id, 'Bob');
    const jukebox = (a.res.ok ? a.res.office : null)!.items.find((i) => i.type === 'jukebox')!;
    const track = (n: number) => ({ uri: `spotify:track:4uLU6hMCjMI75M1A2tKUQ${n}`, name: `Song ${n}`, artists: 'Band', durationMs: 180_000, positionMs: 0, paused: false });

    // Record every session event per person, then wait for the expected number to arrive.
    const record = (socket: Client) => {
      const events: (SpotifySession | null)[] = [];
      socket.on('spotify:session', (itemId, session) => {
        expect(itemId).toBe(jukebox.id);
        events.push(session);
      });
      return events;
    };
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };
    const evA = record(a.socket);
    const evB = record(b.socket);

    // Server clock for syncing.
    const now = await a.socket.timeout(2000).emitWithAck('time');
    expect(Math.abs(now - Date.now())).toBeLessThan(1000);

    a.socket.emit('spotify:session', jukebox.id, track(1), true);
    await until(() => evB.length === 1);
    expect(evB[0]).toMatchObject({ djName: 'Ann', uri: track(1).uri, itemId: jukebox.id });

    // Someone joining late learns about it.
    const c = await join(id, 'Cat');
    const evC = record(c.socket);
    expect(c.res.ok && c.res.spotify.map((s) => s.uri)).toEqual([track(1).uri]);

    // Bob can't push updates into Ann's session without taking over...
    b.socket.emit('spotify:session', jukebox.id, track(2));
    await new Promise((r) => setTimeout(r, 200));
    expect(evA).toHaveLength(1);
    // ...but can take over explicitly.
    b.socket.emit('spotify:session', jukebox.id, track(3), true);
    await until(() => evA.length === 2 && evC.length === 1);
    expect(evA[1]).toMatchObject({ djName: 'Bob', uri: track(3).uri });

    // When the DJ leaves, the session ends for everyone.
    b.socket.disconnect();
    await until(() => evA.length === 3 && evC.length === 2);
    expect([evA[2], evC[1]]).toEqual([null, null]);

    // Anyone can stop a session.
    a.socket.emit('spotify:session', jukebox.id, track(4), true);
    await until(() => evC.length === 3);
    c.socket.emit('spotify:session', jukebox.id, null);
    await until(() => evA.length === 5 && evC.length === 4);
    expect([evA[4], evC[3]]).toEqual([null, null]);

    // Deleting the jukebox stops it too.
    a.socket.emit('spotify:session', jukebox.id, track(5), true);
    await until(() => evC.length === 5);
    a.socket.emit('office:op', { t: 'remove', id: jukebox.id });
    await until(() => evC.length === 6);
    expect(evC[5]).toBeNull();
  });

  it('ends listen-along sessions whose jukebox is re-typed or cut off by a smaller floor', async () => {
    const { id, owner } = await createOffice('startup', 'Ann');
    const a = await join(id, 'Ann', owner);
    const b = await join(id, 'Bob');
    const office = (a.res.ok ? a.res.office : null)!;
    const jukebox = office.items.find((i) => i.type === 'jukebox')!;
    const events: [string, SpotifySession | null][] = [];
    b.socket.on('spotify:session', (itemId, session) => events.push([itemId, session]));
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };
    const track = { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', name: 'Song', artists: 'Band', durationMs: 180_000, positionMs: 0, paused: false };

    a.socket.emit('spotify:session', jukebox.id, track, true);
    await until(() => events.length === 1);
    a.socket.emit('office:op', { t: 'update', item: { ...jukebox, type: 'plant' } });
    await until(() => events.length === 2);
    expect(events[1]).toEqual([jukebox.id, null]);

    // A second jukebox far out on the floor, then the floor shrinks under it.
    const far = { ...jukebox, id: 'farbox', type: 'jukebox', x: office.settings.width - 1.5, z: office.settings.depth - 1.5 };
    a.socket.emit('office:op', { t: 'add', item: far });
    await new Promise((r) => setTimeout(r, 100));
    a.socket.emit('spotify:session', 'farbox', track, true);
    await until(() => events.length === 3);
    a.socket.emit('office:op', { t: 'settings', settings: { width: office.settings.width - 6 } });
    await until(() => events.length === 4);
    expect(events[3]).toEqual(['farbox', null]);
    const late = await join(id, 'Cat');
    expect(late.res.ok && late.res.spotify).toEqual([]);
  });

  it('takes focus from profile changes as a boolean, and never the app', async () => {
    const { id } = await createOffice();
    const a = await join(id, 'Ann');
    const b = await join(id, 'Bob');
    const aId = a.res.ok && a.res.selfId;
    let updated = next(b.socket, 'player:updated');
    a.socket.emit('profile', { focus: true });
    expect(await updated).toEqual([aId, { focus: true }]);
    updated = next(b.socket, 'player:updated');
    a.socket.emit('profile', { focus: 'yes' as never, app: 'vscode' } as never);
    expect(await updated).toEqual([aId, { focus: false }]);
    updated = next(b.socket, 'player:updated');
    a.socket.emit('profile', { app: 'figma', mic: true } as never);
    expect(await updated).toEqual([aId, { mic: true }]);
    expect(server.realtime.rooms.get(id)?.players.get(aId as string)).toMatchObject({ focus: false });
    expect(server.realtime.rooms.get(id)?.players.get(aId as string)?.app).toBeUndefined();
  });

  it('keeps item data through moves, and drops it when an item is re-typed', async () => {
    const { id, owner: jar } = await createOffice('startup');
    const owner = await join(id, 'Olive', jar);
    const office = owner.res.ok ? owner.res.office : null;
    const jukebox = office!.items.find((i) => i.type === 'jukebox')!;
    const moved = next(owner.socket, 'office:op');
    owner.socket.emit('office:op', { t: 'update', item: { ...jukebox, x: jukebox.x - 1, data: undefined } });
    const [op] = await moved;
    expect(op.t === 'update' && op.item.data).toEqual(jukebox.data);
    const retyped = next(owner.socket, 'office:op');
    owner.socket.emit('office:op', { t: 'update', item: { ...jukebox, type: 'plant' } });
    const [op2] = await retyped;
    expect(op2.t === 'update' && op2.item).toMatchObject({ type: 'plant' });
    expect(op2.t === 'update' && 'data' in op2.item).toBe(false);
  });

  it('tells others when someone leaves', async () => {
    const { id } = await createOffice();
    const a = await join(id, 'Ann');
    const b = await join(id, 'Bob');
    const left = next(a.socket, 'player:left');
    b.socket.disconnect();
    expect((await left)[0]).toBe(b.res.ok && b.res.selfId);
  });
});
