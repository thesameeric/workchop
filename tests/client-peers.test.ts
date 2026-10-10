import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RtcSignal } from '../shared/types';

// Calls repair themselves: one that doesn't come up, or breaks while the office connection stays
// (the network changed, a relay went away), gets an ICE restart from the side making offers (the
// other side asks for one), and is started over (rtc:relink) when that doesn't help.

type Handler = (() => void) | null;

class FakePC {
  static all: FakePC[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  offers: RTCOfferOptions[] = [];
  closed = false;
  transceivers: { sender: { track: unknown; replaceTrack(t: unknown): Promise<void> }; receiver: { track: { kind: string } }; direction: string; currentDirection: null }[] = [];
  onicecandidate: Handler = null;
  ontrack: Handler = null;
  onconnectionstatechange: Handler = null;
  oniceconnectionstatechange: Handler = null;
  constructor() {
    FakePC.all.push(this);
  }
  addTransceiver(kind: string) {
    const t = { sender: { track: null as unknown, replaceTrack: async (track: unknown) => void (t.sender.track = track) }, receiver: { track: { kind } }, direction: 'sendrecv', currentDirection: null };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer(opts: RTCOfferOptions = {}) {
    this.offers.push(opts);
    return { type: 'offer', sdp: `offer ${this.offers.length}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === 'offer' && !this.transceivers.length) {
      this.addTransceiver('audio');
      this.addTransceiver('video');
    }
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  getConfiguration() {
    return {};
  }
  setConfiguration() {}
  close() {
    this.closed = true;
  }
  /** The browser says how the connection is doing. */
  set(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.iceConnectionState = state === 'connecting' ? 'checking' : (state as RTCIceConnectionState);
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }
}

class FakeStream {
  private tracks: unknown[];
  constructor(tracks: unknown[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return this.tracks;
  }
  addTrack(t: unknown) {
    this.tracks.push(t);
  }
}

vi.stubGlobal('RTCPeerConnection', FakePC);
vi.stubGlobal('MediaStream', FakeStream);

const { CONNECT_TIMEOUT_MS, DISCONNECTED_GRACE_MS, PeerManager, RESTART_GAP_MS } = await import('../client/src/lib/peers');

const media = { audioTrack: null, videoTrack: null, subscribe: () => () => {} };

function manager() {
  const sent: { to: string; sid: number; data: RtcSignal }[] = [];
  const relinks: [string, number][] = [];
  const streams: [string, unknown][] = [];
  const pm = new PeerManager(media as never, [], {
    send: (to, sid, data) => sent.push({ to, sid, data }),
    stream: (id, stream) => streams.push([id, stream]),
    relink: (id, sid) => relinks.push([id, sid]),
  });
  return { pm, sent, relinks, streams };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const pc = (n = -1) => FakePC.all.at(n)!;
const restartOffers = () => pc().offers.filter((o) => o.iceRestart).length;

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.all = [];
});
afterEach(() => vi.useRealTimers());

describe('a call that doesn’t come up', () => {
  it('gets ICE restarts from the side making offers, then is started over, less often each time', async () => {
    const { pm, sent, relinks } = manager();
    pm.connect('b', 1, true);
    await flush();
    expect(pc().offers).toEqual([{ iceRestart: false }]);
    expect(sent.map((s) => s.data.sdp?.type)).toEqual(['offer']);

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(restartOffers()).toBe(1);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(restartOffers()).toBe(2);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(restartOffers()).toBe(2);
    expect(relinks).toEqual([['b', 1]]);
    // Nothing came of it (the server takes only so many): asked again later.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(relinks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(relinks).toEqual([
      ['b', 1],
      ['b', 1],
    ]);

    // Started over on a new link: the old connection goes; this one gets longer before it's tried again.
    const old = pc();
    pm.connect('b', 2, true);
    await flush();
    expect(old.closed).toBe(true);
    expect(pm.stats()).toEqual([expect.objectContaining({ id: 'b', sid: 2, restarts: 0 })]);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(restartOffers()).toBe(0);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(restartOffers()).toBe(1);

    // Up at last: no more tries.
    pc().set('connected');
    await vi.advanceTimersByTimeAsync(10 * CONNECT_TIMEOUT_MS);
    expect(restartOffers()).toBe(1);
    expect(relinks).toHaveLength(2);
    pm.close();
  });

  it('on the other side, asks for the restarts, then for it to start over', async () => {
    const { pm, sent, relinks } = manager();
    pm.connect('a', 4, false);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(sent).toEqual([{ to: 'a', sid: 4, data: { restart: true } }]);
    expect(pc().offers).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * CONNECT_TIMEOUT_MS);
    expect(sent).toHaveLength(2);
    expect(relinks).toEqual([['a', 4]]);
    pm.close();
  });
});

describe('a call that breaks', () => {
  it('waits a moment when disconnected (it often heals), and restarts at once when it failed', async () => {
    const { pm } = manager();
    pm.connect('b', 1, true);
    await flush();
    pc().set('connected');
    pc().set('disconnected');
    await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS - 500);
    pc().set('connected');
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(restartOffers()).toBe(0);

    pc().set('disconnected');
    await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS);
    expect(restartOffers()).toBe(1);
    await vi.advanceTimersByTimeAsync(RESTART_GAP_MS);
    pc().set('failed');
    await flush();
    expect(restartOffers()).toBe(2);
    pm.close();
  });

  it('the other side asks for the restart; the side making offers restarts once for requests close together', async () => {
    const other = manager();
    other.pm.connect('a', 7, false);
    await flush();
    pc().set('failed');
    expect(other.sent).toEqual([{ to: 'a', sid: 7, data: { restart: true } }]);

    const { pm } = manager();
    pm.connect('b', 7, true);
    await flush();
    pc().set('failed');
    await flush();
    expect(restartOffers()).toBe(1);
    // Its own restart just now and the other side's request are one.
    pm.signal('b', 7, { restart: true });
    pm.signal('b', 6, { restart: true });
    await flush();
    expect(restartOffers()).toBe(1);
    await vi.advanceTimersByTimeAsync(RESTART_GAP_MS);
    pm.signal('b', 7, { restart: true });
    await flush();
    expect(restartOffers()).toBe(2);
    other.pm.close();
    pm.close();
  });

  it('on getting back online, every call looks for its new way through', async () => {
    const { pm, sent } = manager();
    pm.connect('b', 1, true);
    pm.connect('c', 2, false);
    await flush();
    for (const p of FakePC.all) p.set('connected');
    pm.restartAll();
    await flush();
    expect(FakePC.all[0].offers.filter((o) => o.iceRestart)).toHaveLength(1);
    expect(sent.filter((s) => s.data.restart)).toEqual([{ to: 'c', sid: 2, data: { restart: true } }]);
    pm.close();
  });
});

describe('connections', () => {
  it('are one per person: a new link replaces the old one, whose signals are ignored', async () => {
    const { pm, streams } = manager();
    pm.connect('b', 1, false);
    pm.connect('b', 2, false);
    expect(FakePC.all[0].closed).toBe(true);
    expect(streams).toEqual([['b', null]]);
    pm.signal('b', 1, { sdp: { type: 'offer', sdp: 'old' } });
    await flush();
    expect(pc().remoteDescription).toBeNull();
    pm.signal('b', 2, { sdp: { type: 'offer', sdp: 'new' } });
    await flush();
    expect(pc().remoteDescription).toEqual({ type: 'offer', sdp: 'new' });
    expect(pm.stats()).toHaveLength(1);

    // The office connection dropped: every call ends (they come back with the new links), and none is tried again.
    pm.connect('c', 3, true);
    pm.dropAll();
    expect(FakePC.all.every((p) => p.closed)).toBe(true);
    expect(pm.stats()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * CONNECT_TIMEOUT_MS);
    expect(FakePC.all.flatMap((p) => p.offers).filter((o) => o.iceRestart)).toEqual([]);
    pm.close();
  });
});
