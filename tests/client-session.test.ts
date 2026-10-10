import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JoinRequest, JoinResponse, Office, PlayerState } from '../shared/types';

// Coming back after a dropped connection, without a reload: the page joins again by itself (the
// server replaces its old connection, see JoinRequest.resume), keeps trying while it isn't let back
// in for a passing reason, and the calls come back with the new links.

type Listener = (...args: unknown[]) => void;
interface Join {
  req: JoinRequest;
  ack: (err: Error | null, res?: JoinResponse) => void;
  timeout: number;
}

const fake = vi.hoisted(() => {
  class FakeSocket {
    connected = false;
    id: string | undefined;
    handlers = new Map<string, Listener[]>();
    emitted: { event: string; args: unknown[] }[] = [];
    joins: Join[] = [];
    connects = 0;
    disconnects = 0;
    io = { engine: { close() {} } };
    on(event: string, fn: Listener) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    off(event: string, fn: Listener) {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((f) => f !== fn));
      return this;
    }
    removeAllListeners() {
      this.handlers.clear();
      return this;
    }
    fire(event: string, ...args: unknown[]) {
      for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
    }
    emit(event: string, ...args: unknown[]) {
      this.emitted.push({ event, args });
      return this;
    }
    timeout(ms: number) {
      return {
        emit: (event: string, ...args: unknown[]) => {
          const ack = args.pop() as Join['ack'];
          if (event === 'join') this.joins.push({ req: args[0] as JoinRequest, ack, timeout: ms });
        },
        emitWithAck: async () => Date.now(),
      };
    }
    connect() {
      this.connects++;
      return this;
    }
    disconnect() {
      this.disconnects++;
      if (this.connected) this.down('io client disconnect');
      return this;
    }
    /** The connection is up (as `id`). */
    up(id: string) {
      this.connected = true;
      this.id = id;
      this.fire('connect');
    }
    down(reason = 'transport close') {
      this.connected = false;
      this.id = undefined;
      this.fire('disconnect', reason);
    }
  }
  return {
    FakeSocket,
    socket: null as InstanceType<typeof FakeSocket> | null,
    connectPeer: vi.fn(),
    dropAll: vi.fn(),
    restartAll: vi.fn(),
  };
});

vi.mock('socket.io-client', () => ({ io: () => (fake.socket = new fake.FakeSocket()) }));
vi.mock('../client/src/lib/api', () => ({
  fetchConfig: async () => ({ iceServers: [], turn: false, spotifyClientId: null, uploadMaxBytes: 1000 }),
}));
vi.mock('../client/src/lib/radio', () => ({ LoungeRadio: class { start() {} stop() {} debug() {} } }));
vi.mock('../client/src/lib/spotify', () => ({
  SpotifyListenAlong: class {
    djJukebox = null;
    configure() {}
    rejoined() {}
    close() {}
    follow() {}
  },
}));
vi.mock('../client/src/lib/levels', () => ({ SpeakingDetector: class { watch() {} unwatch() {} close() {} } }));
vi.mock('../client/src/lib/media', () => ({
  media: { micOn: false, camOn: false, screenOn: false, version: 0, error: null, audioTrack: null, videoTrack: null, subscribe: () => () => {}, stopAll: () => {} },
}));
vi.mock('../client/src/lib/peers', () => ({
  PeerManager: class {
    connect = fake.connectPeer;
    dropAll = fake.dropAll;
    restartAll = fake.restartAll;
    disconnect() {}
    signal() {}
    close() {}
    stats() {
      return [];
    }
  },
}));
vi.mock('../client/src/lib/account', () => ({ accountUpdated: () => {}, refreshAccount: async () => {}, saveCharacter: async () => {} }));
vi.mock('../client/src/lib/clock', () => ({ serverNow: () => 0, syncClock: async () => {} }));
vi.mock('../client/src/lib/router', () => ({ goHome: () => {} }));
vi.mock('../client/src/lib/upload', () => ({ postFile: async () => ({}) }));

const element = () => ({ hidden: false, remove() {}, appendChild() {}, style: {} });
vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) }));
vi.stubGlobal('document', { createElement: element, body: { appendChild() {} } });
vi.stubGlobal('fetch', async () => ({}));

const { enterOffice, getSession, KEYFRAME_MS } = await import('../client/src/lib/session');
const { getState, setState } = await import('../client/src/state/store');
const { local } = await import('../client/src/lib/positions');

const office = {
  id: 'o1',
  settings: { name: 'HQ', width: 30, depth: 30, floor: 'wood', floorColor: '#000', wallColor: '#000', spawn: { x: 5, z: 5 }, buildPolicy: 'members' },
  items: [],
  zones: [],
  createdAt: 0,
  updatedAt: 0,
} as unknown as Office;

const player = (id: string, x = 5): PlayerState =>
  ({ id, name: id, avatar: {}, status: 'available', x, z: 5, ry: 0, anim: 'idle', mic: false, cam: false, screen: false }) as unknown as PlayerState;

const welcome = (selfId: string, others: PlayerState[] = []): JoinResponse => ({
  ok: true,
  selfId,
  office,
  players: [player(selfId), ...others],
  isOwner: false,
  role: 'member',
  kind: 'team',
  guests: 'off',
  spotify: [],
  uploadKey: `key-${selfId}`,
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const socket = () => fake.socket!;
const lastJoin = () => socket().joins.at(-1)!;

/** In the office as `s1`; returns the rejoins seen by a feature (onJoined). */
async function enter(): Promise<boolean[]> {
  const entering = enterOffice('o1');
  await flush();
  socket().up('s1');
  lastJoin().ack(null, welcome('s1'));
  await entering;
  const rejoins: boolean[] = [];
  getSession()!.onJoined((rejoin) => rejoins.push(rejoin));
  rejoins.length = 0;
  return rejoins;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  fake.connectPeer.mockClear();
  fake.dropAll.mockClear();
  fake.restartAll.mockClear();
  setState({ toasts: [], officeId: 'o1', phase: 'lobby', connection: 'online', connectionNote: null });
});

afterEach(() => {
  getSession()?.leave();
  vi.useRealTimers();
});

describe('after a dropped connection', () => {
  it('joins again by itself, as the same page and where you are, and keeps trying while it isn’t let back in', async () => {
    const rejoins = await enter();
    expect(socket().joins[0].req.resume).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(socket().joins[0].req.at).toBeUndefined();

    Object.assign(local, { x: 12, z: 9, ry: 1, anim: 'sit' });
    socket().down();
    expect(getState().connection).toBe('reconnecting');
    expect(fake.dropAll).toHaveBeenCalledOnce();

    socket().up('s2');
    expect(lastJoin().req).toMatchObject({ resume: socket().joins[0].req.resume, at: { x: 12, z: 9, ry: 1, anim: 'sit' } });
    expect(lastJoin().timeout).toBe(15_000);
    // Not let in for now: said on the banner (not in a toast each time), and tried again.
    lastJoin().ack(null, { ok: false, error: 'This office is full.' });
    expect(getState()).toMatchObject({ connection: 'reconnecting', connectionNote: 'This office is full.', toasts: [] });
    await vi.advanceTimersByTimeAsync(1300);
    expect(socket().joins).toHaveLength(3);
    lastJoin().ack(null, { ok: false, error: 'There are a few visitors from your network here already. Please try again later.' });
    await vi.advanceTimersByTimeAsync(1400);
    expect(socket().joins).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1200);
    expect(socket().joins).toHaveLength(4);

    lastJoin().ack(null, welcome('s2', [player('p9')]));
    expect(getState()).toMatchObject({ connection: 'online', connectionNote: null, selfId: 's2', phase: 'office' });
    expect(Object.keys(getState().players)).toEqual(['p9']);
    expect(rejoins).toEqual([true]);
    // Where you are, sent again at once.
    expect(socket().emitted.filter((e) => e.event === 'move').at(-1)!.args).toEqual([12, 9, 1, 'sit']);
  });

  it('tries again when a join goes unanswered, and after a few on a new connection', async () => {
    await enter();
    socket().down();
    socket().up('s2');
    lastJoin().ack(new Error('operation has timed out'));
    expect(getState().connectionNote).toBe('The server didn’t answer.');
    await vi.advanceTimersByTimeAsync(1300);
    lastJoin().ack(new Error('operation has timed out'));
    await vi.advanceTimersByTimeAsync(2600);
    expect(socket().joins).toHaveLength(4);
    const before = { connects: socket().connects, disconnects: socket().disconnects };
    lastJoin().ack(new Error('operation has timed out'));
    expect(socket()).toMatchObject({ connects: before.connects + 1, disconnects: before.disconnects + 1 });
    socket().up('s3');
    lastJoin().ack(null, welcome('s3'));
    expect(getState().connection).toBe('online');
  });

  it('goes back to the lobby when no longer let in', async () => {
    await enter();
    socket().down();
    socket().up('s2');
    lastJoin().ack(null, { ok: false, error: 'Only members can come in.', reason: 'members-only' });
    expect(getState().phase).toBe('lobby');
    expect(getState().toasts.at(-1)?.text).toBe('Only members can come in.');
    expect(getSession()).toBeNull();
  });

  it('ignores the answer to a join on an older connection, and never calls its own old connection', async () => {
    await enter();
    socket().down();
    socket().up('s2');
    const stale = lastJoin();
    socket().down();
    socket().up('s3');
    stale.ack(null, welcome('s2'));
    expect(getState().connection).toBe('reconnecting');
    // The server still had the first connection (before it noticed): not someone to see or call.
    lastJoin().ack(null, welcome('s3', [player('s1'), player('p9')]));
    expect(getState()).toMatchObject({ connection: 'online', selfId: 's3' });
    expect(Object.keys(getState().players)).toEqual(['p9']);
    socket().fire('peer:connect', 's1', 5, true);
    socket().fire('peer:connect', 'p9', 6, false);
    expect(fake.connectPeer.mock.calls).toEqual([['p9', 6, false]]);
  });

  it('stops trying once you leave', async () => {
    await enter();
    socket().down();
    socket().up('s2');
    lastJoin().ack(null, { ok: false, error: 'This office is full.' });
    const s = socket();
    getSession()!.leave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.joins).toHaveLength(2);
  });

  it('connects again at once when the network is back, or has the calls look for their new way', async () => {
    await enter();
    window.dispatchEvent(new Event('online'));
    expect(fake.restartAll).toHaveBeenCalledOnce();
    socket().down();
    const before = { connects: socket().connects, disconnects: socket().disconnects };
    window.dispatchEvent(new Event('online'));
    expect(socket()).toMatchObject({ connects: before.connects + 1, disconnects: before.disconnects + 1 });
    expect(fake.restartAll).toHaveBeenCalledOnce();
  });
});

describe('where you are', () => {
  it('is sent again now and then, standing when a tab in the background stopped mid-step', async () => {
    await enter();
    const moves = () => socket().emitted.filter((e) => e.event === 'move').map((e) => e.args);
    Object.assign(local, { x: 7, z: 8, ry: 0.5, anim: 'walk' });
    getSession()!.sendMove(7, 8, 0.5, 'walk');
    expect(moves()).toEqual([[7, 8, 0.5, 'walk']]);
    await vi.advanceTimersByTimeAsync(KEYFRAME_MS - 1000);
    expect(moves()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(moves()).toEqual([
      [7, 8, 0.5, 'walk'],
      [7, 8, 0.5, 'idle'],
    ]);
    // Not while disconnected.
    socket().down();
    await vi.advanceTimersByTimeAsync(2 * KEYFRAME_MS);
    expect(moves()).toHaveLength(2);
  });
});
