import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR } from '../shared/avatar';
import type { ClientToServerEvents, JoinResponse, ServerToClientEvents } from '../shared/types';
import { startServer } from '../server/index';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let base: string;
const clients: Client[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-test-'));
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true, iceServers: [] });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function createOffice(template = 'blank') {
  const res = await fetch(`${base}/api/offices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test HQ', template }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; ownerKey: string };
}

async function join(officeId: string, name: string, ownerKey?: string) {
  const socket: Client = connect(base, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  const res = await new Promise<JoinResponse>((resolve) => {
    socket.on('connect', () => socket.emit('join', { officeId, name, avatar: DEFAULT_AVATAR, ownerKey }, resolve));
  });
  if (!res.ok) throw new Error(res.error);
  return { socket, res };
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
    const { id, ownerKey } = await createOffice();
    expect(id).toMatch(/^[a-z0-9]{10}$/);
    expect(ownerKey.length).toBeGreaterThan(16);
    const info = await (await fetch(`${base}/api/offices/${id}`)).json();
    expect(info).toMatchObject({ id, name: 'Test HQ', online: 0 });
    expect((await fetch(`${base}/api/offices/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${base}/api/offices/..%2F..%2Fetc`)).status).toBe(404);
  });

  it('serves ICE configuration', async () => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    expect(cfg).toEqual({ iceServers: [] });
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

    // Nearby chat only reaches linked people; everyone-chat reaches all.
    const quiet = nothing(b.socket, 'chat');
    a.socket.emit('chat', 'psst', 'nearby');
    expect(await quiet).toBe(true);
    const loud = next(b.socket, 'chat');
    a.socket.emit('chat', 'hello all', 'all');
    expect((await loud)[0]).toMatchObject({ text: 'hello all', name: 'Ann', scope: 'all' });
  });

  it('private zones only link the people inside them', async () => {
    const { id, ownerKey } = await createOffice();
    const a = await join(id, 'Ann', ownerKey);
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

  it('broadcasts and persists office edits, and enforces owner-only building', async () => {
    const { id, ownerKey } = await createOffice();
    const owner = await join(id, 'Owner', ownerKey);
    const guest = await join(id, 'Guest');
    expect(owner.res.ok && owner.res.isOwner).toBe(true);
    expect(guest.res.ok && guest.res.isOwner).toBe(false);

    // Guests can build by default; edits are normalised (snapped) and echoed to everybody.
    const seen = next(owner.socket, 'office:op');
    guest.socket.emit('office:op', { t: 'add', item: { id: 'sofa1', type: 'sofa', x: 5.2, z: 5.1, rot: 0 } });
    const [op, by] = await seen;
    expect(op).toEqual({ t: 'add', item: { id: 'sofa1', type: 'sofa', x: 5, z: 5, rot: 0 } });
    expect(by).toBe(guest.res.ok && guest.res.selfId);

    // Guests can't change the build policy.
    const refused = next(guest.socket, 'office:sync');
    guest.socket.emit('office:op', { t: 'settings', settings: { buildPolicy: 'owner' } });
    expect((await refused)[1]).toMatch(/owner/i);

    // The owner can, after which guest edits bounce.
    const policy = next(guest.socket, 'office:op');
    owner.socket.emit('office:op', { t: 'settings', settings: { buildPolicy: 'owner' } });
    expect((await policy)[0]).toMatchObject({ t: 'settings', settings: { buildPolicy: 'owner' } });
    const bounced = next(guest.socket, 'office:sync');
    guest.socket.emit('office:op', { t: 'remove', id: 'sofa1' });
    const [office, reason] = await bounced;
    expect(reason).toMatch(/only the owner/i);
    expect(office.items.some((i) => i.id === 'sofa1')).toBe(true);

    // Invalid edits are rejected with a resync rather than corrupting state.
    const invalid = next(owner.socket, 'office:sync');
    owner.socket.emit('office:op', { t: 'add', item: { id: 'x', type: 'death-star', x: 1, z: 1, rot: 0 } });
    expect((await invalid)[1]).toMatch(/invalid/i);

    // Everything is written to disk, and the owner key is never sent to clients.
    await server.store.flush();
    const saved = JSON.parse(readFileSync(path.join(dataDir, `${id}.json`), 'utf8'));
    expect(saved.office.items.some((i: { id: string }) => i.id === 'sofa1')).toBe(true);
    expect(saved.office.settings.buildPolicy).toBe('owner');
    expect(JSON.stringify(guest.res)).not.toContain(ownerKey);
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
