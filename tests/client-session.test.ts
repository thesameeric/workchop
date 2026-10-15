import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JoinRequest, JoinResponse, Office, PlayerState, Spot } from '../shared/types';

// Coming back after a dropped connection, without a reload: the page joins again by itself (the
// server replaces its old connection, see JoinRequest.resume), keeps trying while it isn't let back
// in for a passing reason, and the calls come back with the new links. And one of you per office:
// a tab steps aside when you come in in another, and comes back only with Use here.

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
    /** Whether it's connected or trying to (Socket.IO's `active`). */
    active = false;
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
      this.active = true;
      return this;
    }
    disconnect() {
      this.disconnects++;
      this.active = false;
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
      // Socket.IO tries again by itself only after a dropped connection.
      if (reason !== 'transport close') this.active = false;
      this.fire('disconnect', reason);
    }
  }
  return {
    FakeSocket,
    socket: null as InstanceType<typeof FakeSocket> | null,
    connectPeer: vi.fn(),
    dropAll: vi.fn(),
    restartAll: vi.fn(),
    setMediaAllowed: vi.fn(),
    refreshMediaPermissions: vi.fn(),
    peerEvents: null as null | { canSendMedia(id: string): boolean; stream(id: string, stream: MediaStream | null): void },
    media: { micOn: false, camOn: false, start: vi.fn(async () => {}), stopAll: vi.fn() },
    /** What the account check does after the server ended this connection (see followAccount). */
    followAccount: vi.fn(async () => false),
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
  media: Object.assign(fake.media, { captureStatus: { microphone: 'idle', camera: 'idle' }, screenOn: false, version: 0, error: null, audioTrack: null, videoTrack: null, subscribe: () => () => {} }),
}));
vi.mock('../client/src/lib/peers', () => ({
  PeerManager: class {
    constructor(_media: unknown, _ice: unknown, events: NonNullable<typeof fake.peerEvents>) { fake.peerEvents = events; }
    connect = fake.connectPeer;
    dropAll = fake.dropAll;
    restartAll = fake.restartAll;
    setMediaAllowed = fake.setMediaAllowed;
    refreshMediaPermissions = fake.refreshMediaPermissions;
    async diagnostics() { return []; }
    disconnect() {}
    signal() {}
    close() {}
    stats() {
      return [];
    }
  },
}));
vi.mock('../client/src/lib/account', () => ({ accountUpdated: () => {}, followAccount: () => fake.followAccount(), saveCharacter: async () => {} }));
vi.mock('../client/src/lib/clock', () => ({ serverNow: () => 0, syncClock: async () => {} }));
vi.mock('../client/src/lib/router', () => ({ goHome: () => {} }));
vi.mock('../client/src/lib/upload', () => ({ postFile: async () => ({}) }));

const audioElements: ReturnType<typeof element>[] = [];
const element = () => ({ hidden: false, remove() {}, appendChild() {}, style: {}, autoplay: false, muted: false, volume: 1,
  src: '', pause: vi.fn(), removeAttribute() {},
  srcObject: null as MediaStream | null, onplaying: null as null | (() => void), play: vi.fn(async () => {}) });
vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) }));
vi.stubGlobal('document', { createElement: (tag: string) => { const el = element(); if (tag === 'audio') audioElements.push(el); return el; }, body: { appendChild() {} } });
vi.stubGlobal('MediaStream', class {
  constructor(private tracks: { kind: string }[] = []) {}
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
});
vi.stubGlobal('fetch', async () => ({}));

const { backToLobby, enterOffice, getSession, KEYFRAME_MS } = await import('../client/src/lib/session');
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

const welcome = (selfId: string, others: PlayerState[] = [], at?: Spot): JoinResponse => ({
  ok: true,
  selfId,
  office,
  players: [{ ...player(selfId), ...at }, ...others],
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
  fake.setMediaAllowed.mockClear();
  fake.refreshMediaPermissions.mockClear();
  audioElements.length = 0;
  fake.media.start.mockClear();
  fake.media.stopAll.mockClear();
  Object.assign(fake.media, { micOn: false, camOn: false });
  fake.followAccount.mockImplementation(async () => false);
  setState({ toasts: [], officeId: 'o1', phase: 'lobby', connection: 'online', connectionNote: null, elsewhere: false, audioBlocked: false,
    me: { ...getState().me, status: 'available' }, focus: false });
});

afterEach(() => {
  getSession()?.leave();
  vi.useRealTimers();
});

describe('prepared conversations and playback', () => {
  const addPeer = (x = 7) => socket().fire('player:joined', player('p2', x));
  const track = { kind: 'audio' } as MediaStreamTrack;

  it('prepares a bounded set of silent players during Join and reuses them for voices', async () => {
    const originalNavigator = navigator;
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    try {
      await enter();
      expect(audioElements).toHaveLength(4);
      expect(audioElements.every((el) => el.src.startsWith('data:audio/wav;base64,') && el.play.mock.calls.length === 1)).toBe(true);
      addPeer(); socket().fire('peer:connect', 'p2', 1, true);
      fake.peerEvents!.stream('p2', new MediaStream([track]));
      expect(audioElements).toHaveLength(4);
      expect(audioElements.filter((el) => el.srcObject)).toHaveLength(1);
      getSession()!.unblockAudio();
      expect(audioElements).toHaveLength(4);
      getSession()!.leave();
      expect(audioElements.every((el) => el.pause.mock.calls.length > 0 && el.srcObject === null)).toBe(true);
    } finally {
      vi.stubGlobal('navigator', originalNavigator);
    }
  });

  it('opts in to silent preparation without showing a call until it is authorized', async () => {
    await enter();
    expect(lastJoin().req.prepareAudio).toBe(true);
    addPeer(10.5);
    socket().fire('peer:connect', 'p2', 10, true, false);
    expect(fake.connectPeer).toHaveBeenLastCalledWith('p2', 10, true, false);
    expect(getState().linked.p2).toBeUndefined();
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(false);
    socket().fire('player:moved', ['p2', 7, 5, 0, 'walk']);
    socket().fire('peer:media', 'p2', 10, true);
    expect(getState().linked.p2).toBe(true);
    expect(fake.setMediaAllowed).toHaveBeenLastCalledWith('p2', 10, true);
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(true);
    // A stale permission update from an older transport cannot activate this call.
    socket().fire('peer:media', 'p2', 9, false);
    expect(getState().linked.p2).toBe(true);
    socket().fire('peer:media', 'p2', 10, false);
    expect(getState().linked.p2).toBeUndefined();
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(false);
  });

  it('revokes local media immediately on distance or Busy changes, including throttled movement', async () => {
    await enter(); addPeer();
    socket().fire('peer:connect', 'p2', 1, true);
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(true);
    getSession()!.sendMove(local.x, local.z, 0, 'idle', true);
    fake.refreshMediaPermissions.mockClear();
    local.x = 20;
    getSession()!.sendMove(local.x, local.z, 0, 'idle');
    expect(fake.refreshMediaPermissions).toHaveBeenCalledOnce();
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(false);
    local.x = 5;
    getSession()!.updateProfile({ status: 'busy' });
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(false);
  });

  it('gates private-area boundaries locally while preserving conversations inside the same room', async () => {
    await enter(); addPeer();
    socket().fire('peer:connect', 'p2', 1, true);
    setState({ office: { ...office, zones: [{ id: 'room', name: 'Private', x: 4, z: 4, w: 2, d: 2, color: '#fff' }] } });
    getSession()!.sendMove(local.x, local.z, 0, 'idle');
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(false);
    socket().fire('player:moved', ['p2', 5.5, 5, 0, 'idle']);
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(true);
    getSession()!.updateProfile({ status: 'busy' });
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(true);
    socket().fire('player:moved', ['p2', 7, 5, 0, 'idle']);
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(false);
  });

  it('preserves authorized support calls at a distance without granting media to warm links', async () => {
    await enter(); addPeer(20);
    getSession()!.setFullVolume(['p2']);
    socket().fire('peer:connect', 'p2', 1, true, false);
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(false);
    socket().fire('peer:media', 'p2', 1, true);
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(true);
    getSession()!.setFullVolume([]);
    expect(fake.peerEvents!.canSendMedia('p2')).toBe(false);
  });

  it('sets permission and volume before playback, and silences retained transports immediately', async () => {
    await enter(); addPeer();
    socket().fire('peer:connect', 'p2', 1, true);
    fake.peerEvents!.stream('p2', new MediaStream([track]));
    const el = audioElements[0];
    expect(el.muted).toBe(false);
    expect(el.volume).toBeGreaterThan(0.9);
    expect(el.play).toHaveBeenCalledOnce();
    socket().fire('peer:media', 'p2', 1, false);
    expect(el).toMatchObject({ volume: 0, muted: true });
    // Even an old callback cannot play a warm connection at default volume.
    fake.peerEvents!.stream('p2', new MediaStream([track]));
    expect(el).toMatchObject({ volume: 0, muted: true });
  });

  it('reuses accepted audio players across repeated proximity exits instead of exhausting preparation', async () => {
    await enter(); addPeer();
    socket().fire('peer:connect', 'p2', 1, true);
    for (let i = 0; i < 10; i++) {
      fake.peerEvents!.stream('p2', new MediaStream([track]));
      expect(audioElements).toHaveLength(1);
      expect(audioElements[0].srcObject).not.toBeNull();
      fake.peerEvents!.stream('p2', null);
      expect(audioElements[0]).toMatchObject({ srcObject: null, muted: true, volume: 0 });
    }
  });

  it('keeps the audio warning visible until a gesture retry actually succeeds', async () => {
    await enter(); addPeer();
    socket().fire('peer:connect', 'p2', 1, true);
    fake.peerEvents!.stream('p2', new MediaStream([track]));
    const el = audioElements[0];
    const blocked = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    el.play.mockRejectedValueOnce(blocked);
    getSession()!.unblockAudio();
    await flush();
    expect(getState().audioBlocked).toBe(true);
    let finish!: () => void;
    el.play.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    window.dispatchEvent(new Event('pointerdown'));
    expect(getState().audioBlocked).toBe(true);
    finish(); await flush();
    expect(getState().audioBlocked).toBe(false);
  });

  it('offers bounded local diagnostics without requesting media or uploading telemetry', async () => {
    await enter(); addPeer();
    socket().fire('peer:connect', 'p2', 1, true, false);
    const diagnostics = await getSession()!.audioDiagnostics();
    expect(diagnostics.capture.microphone).toBe('idle');
    expect(diagnostics.events).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'transport_prepared', peer: 'peer-1' })]));
    expect(fake.media.start).not.toHaveBeenCalled();
  });
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

    lastJoin().ack(null, welcome('s2', [player('p9')], lastJoin().req.at));
    expect(getState()).toMatchObject({ connection: 'online', connectionNote: null, selfId: 's2', phase: 'office' });
    expect(Object.keys(getState().players)).toEqual(['p9']);
    expect(rejoins).toEqual([true]);
    // Where you are, sent again at once.
    expect(socket().emitted.filter((e) => e.event === 'move').at(-1)!.args.slice(0, 4)).toEqual([12, 9, 1, 'sit']);
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
    expect(fake.connectPeer.mock.calls).toEqual([['p9', 6, false, true]]);
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

describe('authoritative seating', () => {
  it('accepts another free place on the same couch and keeps its movement snapshot in step', async () => {
    await enter();
    Object.assign(local, { x: 9.5, z: 9.95, ry: 0, anim: 'sit', seat: { x: 9.5, z: 9.95, ry: 0, itemId: 'sofa1' } });
    socket().fire('seat:resolved', { x: 9.5, z: 9.95 }, { x: 10.5, z: 9.95, ry: 0, anim: 'sit' }, 'sofa1');
    expect(local).toMatchObject({ x: 10.5, z: 9.95, anim: 'sit', seat: { x: 10.5, z: 9.95, itemId: 'sofa1' }, path: null, pathSeat: null });
    const before = socket().emitted.filter((e) => e.event === 'move').length;
    getSession()!.sendMove(local.x, local.z, local.ry, local.anim);
    expect(socket().emitted.filter((e) => e.event === 'move')).toHaveLength(before);
  });

  it('returns to the accepted standing position when a chair was taken first', async () => {
    await enter();
    Object.assign(local, { x: 10, z: 10, ry: 0, anim: 'sit', seat: { x: 10, z: 10, ry: 0, itemId: 'chair1' } });
    socket().fire('seat:resolved', { x: 10, z: 10 }, { x: 10, z: 11, ry: 0, anim: 'idle' }, null);
    expect(local).toMatchObject({ x: 10, z: 11, anim: 'idle', seat: null });
    expect(getState().toasts.at(-1)?.text).toBe('That seat is occupied.');
  });

  it('does not sit back down on a late response after standing up or choosing another seat', async () => {
    await enter();
    const accepted = { x: 10.5, z: 9.95, ry: 0, anim: 'sit' };
    Object.assign(local, { x: 9.5, z: 9.95, anim: 'idle', seat: null });
    socket().fire('seat:resolved', { x: 9.5, z: 9.95 }, accepted, 'sofa1');
    expect(local.anim).toBe('idle');
    Object.assign(local, { x: 15, z: 15, anim: 'sit', seat: { x: 15, z: 15, ry: 0, itemId: 'chair2' } });
    socket().fire('seat:resolved', { x: 9.5, z: 9.95 }, accepted, 'sofa1');
    expect(local).toMatchObject({ x: 15, z: 15, seat: { itemId: 'chair2' } });
  });

  it('ignores an earlier rejection after standing and sitting at that same spot again', async () => {
    await enter();
    const seat = { x: 10, z: 10, ry: 0, itemId: 'chair1' };
    Object.assign(local, { ...seat, anim: 'sit', seat });
    getSession()!.sendMove(10, 10, 0, 'sit');
    const first = socket().emitted.filter((e) => e.event === 'move').at(-1)!.args[4];
    Object.assign(local, { anim: 'idle', seat: null });
    getSession()!.sendMove(10, 10, 0, 'idle');
    Object.assign(local, { anim: 'sit', seat: { ...seat } });
    getSession()!.sendMove(10, 10, 0, 'sit');
    const current = socket().emitted.filter((e) => e.event === 'move').at(-1)!.args[4];
    expect(current).not.toBe(first);
    socket().fire('seat:resolved', { x: 10, z: 10 }, { x: 10, z: 11, ry: 0, anim: 'idle' }, null, first);
    expect(local.anim).toBe('sit');
    expect(local.seat?.itemId).toBe('chair1');
    socket().fire('seat:resolved', { x: 10, z: 10 }, { x: 10, z: 11, ry: 0, anim: 'idle' }, null, current);
    expect(local.anim).toBe('idle');
  });

  it('uses the server alternative after reconnecting instead of reclaiming an occupied couch spot', async () => {
    await enter();
    Object.assign(local, { x: 9.5, z: 9.95, ry: 0, anim: 'sit', seat: { x: 9.5, z: 9.95, ry: 0, itemId: 'sofa1' } });
    socket().down();
    socket().up('s2');
    const answer = welcome('s2', [], { x: 10.5, z: 9.95, ry: 0, anim: 'sit' });
    if (!answer.ok) throw new Error('Expected successful join');
    answer.office = { ...office, items: [{ id: 'sofa1', type: 'sofa', x: 10, z: 10, rot: 0 }] };
    lastJoin().ack(null, answer);
    expect(local.seat).toEqual({ x: 10.5, z: 9.95, ry: 0, itemId: 'sofa1' });
    expect(socket().emitted.filter((e) => e.event === 'move').at(-1)!.args.slice(0, 4)).toEqual([10.5, 9.95, 0, 'sit']);
  });

  it('resumes standing when a single seat was occupied while disconnected', async () => {
    await enter();
    Object.assign(local, { x: 10, z: 10, ry: 0, anim: 'sit', seat: { x: 10, z: 10, ry: 0, itemId: 'chair1' } });
    socket().down();
    socket().up('s2');
    lastJoin().ack(null, welcome('s2', [], { x: 6, z: 6, ry: 0, anim: 'idle' }));
    expect(local).toMatchObject({ x: 6, z: 6, anim: 'idle', seat: null });
    expect(socket().emitted.filter((e) => e.event === 'move').at(-1)!.args).toEqual([6, 6, 0, 'idle']);
  });

  it('does not replace a newer sit at the same spot with an earlier join correction', async () => {
    await enter();
    const seat = { x: 9.5, z: 9.95, ry: 0, itemId: 'sofa1' };
    Object.assign(local, { ...seat, anim: 'sit', seat });
    socket().down();
    socket().up('s2');
    // A different seating action happened while the join acknowledgement was in flight.
    Object.assign(local, { anim: 'idle', seat: null });
    Object.assign(local, { anim: 'sit', seat: { ...seat } });
    lastJoin().ack(null, welcome('s2', [], { x: 6, z: 6, ry: 0, anim: 'idle' }));
    expect(local).toMatchObject({ x: 9.5, z: 9.95, anim: 'sit', seat: { itemId: 'sofa1' } });
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

describe('in another tab', () => {
  const BROWSER = /^[A-Za-z0-9_-]{32}$/;

  it('joins first as the newest tab, then comes back by itself without taking over', async () => {
    await enter();
    expect(socket().joins[0].req).toMatchObject({ browser: expect.stringMatching(BROWSER) });
    expect(socket().joins[0].req.rejoin).toBeUndefined();
    socket().down();
    socket().up('s2');
    expect(lastJoin().req).toMatchObject({ browser: socket().joins[0].req.browser, rejoin: true });
  });

  it('steps aside when you come in elsewhere: out of the office, and nothing joins by itself', async () => {
    await enter();
    fake.media.micOn = true;
    const s = socket();
    s.fire('office:removed', 'elsewhere');
    expect(getState()).toMatchObject({ elsewhere: true, phase: 'office', connection: 'online', selfId: null, players: {}, toasts: [] });
    expect(s).toMatchObject({ connected: false, active: false, disconnects: 1 });
    expect(fake.media.stopAll).toHaveBeenCalledOnce();
    expect(getSession()!.isParked()).toBe(true);
    // Not on a new connection, the network coming back, or a sign-in elsewhere.
    s.up('s2');
    window.dispatchEvent(new Event('online'));
    getSession()!.reconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.joins).toHaveLength(1);
    expect(s.connects).toBe(1);
  });

  it('comes back with Use here: where you were, mic as it was, and your other tab steps aside', async () => {
    const rejoins = await enter();
    Object.assign(local, { x: 12, z: 9, ry: 1, anim: 'sit' });
    fake.media.micOn = true;
    socket().fire('office:removed', 'elsewhere');

    await getSession()!.useHere();
    expect(fake.media.start).toHaveBeenCalledWith(true, false);
    socket().up('s2');
    expect(lastJoin().req).toMatchObject({ at: { x: 12, z: 9, ry: 1, anim: 'sit' }, browser: expect.stringMatching(BROWSER) });
    expect(lastJoin().req.rejoin).toBeUndefined();
    // Not let in for now: Use here keeps trying, still taking over.
    lastJoin().ack(null, { ok: false, error: 'This office is full.' });
    expect(getState()).toMatchObject({ elsewhere: true, connectionNote: 'This office is full.' });
    await vi.advanceTimersByTimeAsync(1300);
    expect(lastJoin().req.rejoin).toBeUndefined();
    lastJoin().ack(null, welcome('s2'));
    expect(getState()).toMatchObject({ elsewhere: false, phase: 'office', selfId: 's2', connection: 'online' });
    expect(rejoins).toEqual([true]);

    // Later, back by itself again.
    socket().down();
    socket().up('s3');
    expect(lastJoin().req.rejoin).toBe(true);
  });

  it('steps aside when coming back by itself finds you in another tab, and doesn’t try again', async () => {
    await enter();
    socket().down();
    socket().up('s2');
    lastJoin().ack(null, { ok: false, error: 'Homeoffice is open in another tab.', reason: 'elsewhere' });
    expect(getState()).toMatchObject({ elsewhere: true, phase: 'office', toasts: [] });
    expect(getSession()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket().joins).toHaveLength(2);
  });

  it('takes over after signing in in this tab, not after signing in or out in another', async () => {
    await enter();
    getSession()!.reconnect(true);
    socket().up('s2');
    expect(lastJoin().req.rejoin).toBeUndefined();
    lastJoin().ack(null, welcome('s2'));
    getSession()!.reconnect();
    socket().up('s3');
    expect(lastJoin().req.rejoin).toBe(true);
  });

  it('when the server ends the connection: in again while signed in, the lobby once signed out', async () => {
    await enter();
    let s = socket();
    s.down('io server disconnect');
    await flush();
    expect(fake.followAccount).toHaveBeenCalledOnce();
    expect(s.connects).toBe(2);

    s.up('s2');
    lastJoin().ack(null, welcome('s2'));
    fake.followAccount.mockImplementation(async () => {
      backToLobby();
      return true;
    });
    s = socket();
    s.down('io server disconnect');
    await flush();
    expect(getState().phase).toBe('lobby');
    expect(getSession()).toBeNull();
    expect(s.connects).toBe(2);
  });
});
