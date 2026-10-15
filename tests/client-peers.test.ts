import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RtcSignal } from '../shared/types';

type Handler = (() => void) | null;

class FakeTrack {
  clones: FakeTrack[] = [];
  enabled = true;
  readyState = 'live';
  stopped = false;
  constructor(readonly kind: 'audio' | 'video') {}
  clone() { const clone = new FakeTrack(this.kind); clone.enabled = this.enabled; this.clones.push(clone); return clone; }
  stop() { this.stopped = true; this.readyState = 'ended'; }
}

class FakeSender {
  track: FakeTrack | null = null;
  replacements: (FakeTrack | null)[] = [];
  replaceTrack = async (track: FakeTrack | null) => { this.replacements.push(track); this.track = track; };
}

class FakePC {
  static all: FakePC[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  offers: RTCOfferOptions[] = [];
  closed = false;
  transceivers: { sender: FakeSender; receiver: { track: { kind: string } }; direction: string; currentDirection: null }[] = [];
  onicecandidate: ((event: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ontrack: ((event: { track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: Handler = null;
  oniceconnectionstatechange: Handler = null;
  onicegatheringstatechange: Handler = null;
  statsEntries: Record<string, unknown>[] = [];
  constructor(readonly configuration = {}) { FakePC.all.push(this); }
  addTransceiver(kind: string) {
    const t = { sender: new FakeSender(), receiver: { track: { kind } }, direction: 'sendrecv', currentDirection: null };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() { return this.transceivers; }
  async createOffer(opts: RTCOfferOptions = {}) { this.offers.push(opts); return { type: 'offer', sdp: `offer ${this.offers.length}` }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === 'offer' && !this.transceivers.length) { this.addTransceiver('audio'); this.addTransceiver('video'); }
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  getConfiguration() { return this.configuration; }
  setConfiguration() {}
  async getStats() { return new Map(this.statsEntries.map((entry, index) => [String(index), entry])); }
  close() { this.closed = true; }
  set(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.iceConnectionState = state === 'connecting' ? 'checking' : (state as RTCIceConnectionState);
    this.onconnectionstatechange?.(); this.oniceconnectionstatechange?.();
  }
  candidate() { this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'candidate:test' }) } }); }
  track(track = new FakeTrack('audio')) { this.ontrack?.({ track }); return track; }
}

class FakeStream {
  constructor(private tracks: unknown[] = []) { this.tracks = [...tracks]; }
  getTracks() { return this.tracks; }
  addTrack(t: unknown) { this.tracks.push(t); }
}

vi.stubGlobal('RTCPeerConnection', FakePC);
vi.stubGlobal('MediaStream', FakeStream);
const { CONNECT_TIMEOUT_MS, CONNECT_PROGRESS_TIMEOUT_MS, DISCONNECTED_GRACE_MS, PeerManager, RESTART_GAP_MS } = await import('../client/src/lib/peers');

function manager(options: { mic?: FakeTrack; video?: FakeTrack; eligible?: () => boolean } = {}) {
  const sent: { to: string; sid: number; data: RtcSignal }[] = [];
  const relinks: [string, number][] = [];
  const streams: [string, unknown][] = [];
  let notify = () => {};
  const media = { audioTrack: options.mic ?? null, videoTrack: options.video ?? null, subscribe: (listener: () => void) => { notify = listener; return () => {}; } };
  const pm = new PeerManager(media as never, [], {
    send: (to, sid, data) => sent.push({ to, sid, data }),
    stream: (id, stream) => streams.push([id, stream]),
    relink: (id, sid) => relinks.push([id, sid]),
    canSendMedia: options.eligible,
  });
  return { pm, sent, relinks, streams, media, changed: () => notify() };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const pc = (n = -1) => FakePC.all.at(n)!;
const restartOffers = () => pc().offers.filter((o) => o.iceRestart).length;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => { vi.useFakeTimers(); FakePC.all = []; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('bounded recovery', () => {
  it('restarts a stalled initial call after 6s, relinks after one restart and backs off repeated failures', async () => {
    const { pm, sent, relinks } = manager();
    pm.connect('b', 1, true); await flush();
    expect(pc().offers).toEqual([{ iceRestart: false }]);
    expect(sent.map((s) => s.data.sdp?.type)).toEqual(['offer']);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1); expect(restartOffers()).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(restartOffers()).toBe(1);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS); expect(relinks).toEqual([['b', 1]]);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS); expect(relinks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS); expect(relinks).toHaveLength(2);
    const old = pc();
    pm.connect('b', 2, true); await flush(); expect(old.closed).toBe(true);
    // Two unanswered fresh-link requests make the next initial attempt wait 24s.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 4 - 1); expect(restartOffers()).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(restartOffers()).toBe(1);
    pc().set('connected');
    await vi.advanceTimersByTimeAsync(20 * CONNECT_TIMEOUT_MS);
    expect(restartOffers()).toBe(1); expect(relinks).toHaveLength(2);
    pm.close();
  });

  it('extends genuine setup progress once, never past 12s, even with continuing candidates', async () => {
    const { pm, relinks } = manager();
    pm.connect('b', 1, true); await flush();
    await vi.advanceTimersByTimeAsync(2_000); pc().candidate(); pc().set('connecting');
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 2_000); expect(restartOffers()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_999); pc().candidate(); expect(restartOffers()).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(restartOffers()).toBe(1);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS); expect(relinks).toEqual([['b', 1]]);
    expect(CONNECT_PROGRESS_TIMEOUT_MS).toBe(12_000);
    pm.close();
  });

  it('lets a slow but progressing transport connect without a premature restart', async () => {
    const { pm } = manager(); pm.connect('b', 1, true); await flush();
    pc().set('connecting');
    await vi.advanceTimersByTimeAsync(8_000); pc().set('connected');
    await vi.advanceTimersByTimeAsync(20_000); expect(restartOffers()).toBe(0); pm.close();
  });

  it('requests one restart from the answering side, then asks for a fresh link', async () => {
    const { pm, sent, relinks } = manager(); pm.connect('a', 4, false);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(sent).toEqual([{ to: 'a', sid: 4, data: { restart: true } }]);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(sent).toHaveLength(1); expect(relinks).toEqual([['a', 4]]); pm.close();
  });

  it('uses a 1.5s established disconnect grace, with immediate recovery on true failure', async () => {
    const { pm, relinks } = manager(); pm.connect('b', 1, true); await flush(); pc().set('connected');
    pc().set('disconnected'); await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS - 1);
    pc().set('connected'); await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS); expect(restartOffers()).toBe(0);
    pc().set('disconnected'); await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS); expect(restartOffers()).toBe(1);
    pc().set('connected'); await vi.advanceTimersByTimeAsync(RESTART_GAP_MS);
    pc().set('failed'); await flush(); expect(restartOffers()).toBe(2);
    // Both browser state callbacks describe the same failure, not a second recovery attempt.
    expect(relinks).toEqual([]); pm.close();
  });

  it('coalesces restart requests without scheduling an extra restart 2s later', async () => {
    const { pm, relinks } = manager(); pm.connect('b', 7, true); await flush();
    pc().set('failed'); await flush(); expect(restartOffers()).toBe(1);
    pm.signal('b', 7, { restart: true }); pm.signal('b', 7, { restart: true }); pm.signal('b', 6, { restart: true });
    await vi.advanceTimersByTimeAsync(RESTART_GAP_MS); expect(restartOffers()).toBe(1); expect(relinks).toEqual([]);
    pm.close();
  });

  it('restarts each transport on network return', async () => {
    const { pm, sent } = manager(); pm.connect('b', 1, true); pm.connect('c', 2, false); await flush();
    for (const p of FakePC.all) p.set('connected');
    pm.restartAll(); await flush();
    expect(FakePC.all[0].offers.filter((o) => o.iceRestart)).toHaveLength(1);
    expect(sent.filter((s) => s.data.restart)).toEqual([{ to: 'c', sid: 2, data: { restart: true } }]); pm.close();
  });
});

describe('warm transport privacy and reuse', () => {
  it('negotiates a warm initiator with null tracks, including later media changes', async () => {
    const mic = new FakeTrack('audio'); const video = new FakeTrack('video');
    const { pm, media, changed, sent } = manager({ mic, video }); pm.connect('b', 1, true, false); await flush();
    expect(pc().transceivers.map((t) => t.sender.track)).toEqual([null, null]);
    expect(mic.clones).toHaveLength(0); expect(video.clones).toHaveLength(0);
    expect(sent[0].data.sdp?.type).toBe('offer');
    media.audioTrack = new FakeTrack('audio'); changed(); await flush();
    expect(pc().transceivers.map((t) => t.sender.track)).toEqual([null, null]); pm.close();
  });

  it('answers warm offers without sending or publishing media; activates the same connection', async () => {
    const mic = new FakeTrack('audio'); const video = new FakeTrack('video');
    const { pm, streams } = manager({ mic, video }); pm.connect('b', 1, false, false);
    pm.signal('b', 1, { sdp: { type: 'offer', sdp: 'warm offer' } }); await flush();
    expect(pc().transceivers.map((t) => t.sender.track)).toEqual([null, null]);
    pc().track(); expect(streams).toEqual([]);
    pm.setMediaAllowed('b', 1, true); await flush();
    expect(FakePC.all).toHaveLength(1); expect(streams).toHaveLength(1);
    expect(pc().transceivers[0].sender.track).toBe(mic.clones[0]);
    expect(pc().transceivers[1].sender.track).toBe(video.clones[0]);
    pm.setMediaAllowed('b', 1, false);
    expect(mic.clones[0].enabled).toBe(false); expect(video.clones[0].enabled).toBe(false);
    expect(streams.at(-1)).toEqual(['b', null]);
    await flush(); expect(mic.clones[0].stopped).toBe(true);
    expect(pc().transceivers.map((t) => t.sender.track)).toEqual([null, null]);
    pm.setMediaAllowed('b', 1, true); await flush();
    expect(FakePC.all).toHaveLength(1); expect(pc().transceivers[0].sender.track?.enabled).toBe(true); pm.close();
  });

  it('requires both server permission and immediate local eligibility', async () => {
    let eligible = false; const mic = new FakeTrack('audio');
    const { pm, streams } = manager({ mic, eligible: () => eligible }); pm.connect('b', 1, true, true); await flush();
    expect(mic.clones).toHaveLength(0); pc().track(); expect(streams).toEqual([]);
    eligible = true; pm.refreshMediaPermissions(); await flush(); const clone = mic.clones[0];
    expect(clone.enabled).toBe(true); expect(streams).toHaveLength(1);
    eligible = false; pm.refreshMediaPermissions();
    expect(clone.enabled).toBe(false); expect(streams.at(-1)).toEqual(['b', null]); await flush();
    eligible = true; pm.setMediaAllowed('b', 1, false); pm.refreshMediaPermissions(); await flush();
    expect(pc().transceivers[0].sender.track).toBeNull(); pm.close();
  });

  it('clones tracks separately for each peer and mirrors mute without mutating the shared capture', async () => {
    const mic = new FakeTrack('audio'); const { pm, changed } = manager({ mic });
    pm.connect('b', 1, true); pm.connect('c', 2, true); await flush();
    expect(mic.clones).toHaveLength(2); expect(mic.clones[0]).not.toBe(mic.clones[1]);
    pm.setMediaAllowed('b', 1, false);
    expect(mic.clones[0].enabled).toBe(false); expect(mic.clones[1].enabled).toBe(true); expect(mic.enabled).toBe(true);
    await flush(); mic.enabled = false; changed();
    expect(mic.clones[1].enabled).toBe(false);
    mic.enabled = true; changed(); expect(mic.clones[1].enabled).toBe(true);
    pm.close(); expect(mic.stopped).toBe(false); expect(mic.clones.every((c) => c.stopped)).toBe(true);
  });

  it('rechecks local eligibility when a queued attachment runs and permits a later safe retry', async () => {
    let eligible = true;
    const mic = new FakeTrack('audio'); const { pm } = manager({ mic, eligible: () => eligible });
    pm.connect('b', 1, true, false); await flush();
    pm.setMediaAllowed('b', 1, true);
    eligible = false;
    await flush();
    expect(mic.clones).toHaveLength(0); expect(pc().transceivers[0].sender.track).toBeNull();
    eligible = true; pm.refreshMediaPermissions(); await flush();
    expect(pc().transceivers[0].sender.track).toBe(mic.clones[0]); pm.close();
  });

  it('disables pending replacements synchronously and never resurrects an obsolete clone', async () => {
    const mic = new FakeTrack('audio'); const { pm } = manager({ mic }); pm.connect('b', 1, true, false); await flush();
    const sender = pc().transceivers[0].sender; const blocked = deferred();
    sender.replaceTrack = async (track) => { sender.replacements.push(track); await blocked.promise; sender.track = track; };
    pm.setMediaAllowed('b', 1, true); await flush(); const obsolete = mic.clones[0];
    expect(obsolete.enabled).toBe(true);
    pm.setMediaAllowed('b', 1, false); expect(obsolete.enabled).toBe(false);
    pm.setMediaAllowed('b', 1, true); expect(obsolete.enabled).toBe(false);
    blocked.resolve(); await flush();
    expect(obsolete.stopped).toBe(true); expect(sender.track).toBe(mic.clones[1]); expect(sender.track?.enabled).toBe(true);
    pm.setMediaAllowed('b', 1, false); expect(sender.track?.enabled).toBe(false); await flush(); expect(sender.track).toBeNull(); pm.close();
  });

  it('keeps revoked media disabled while a browser replacement is stalled', async () => {
    const mic = new FakeTrack('audio'); const { pm } = manager({ mic }); pm.connect('b', 1, true); await flush();
    const sender = pc().transceivers[0].sender; const clone = sender.track!; const blocked = deferred();
    sender.replaceTrack = async (track) => { await blocked.promise; sender.track = track; };
    pm.setMediaAllowed('b', 1, false); expect(clone.enabled).toBe(false); await flush();
    expect(sender.track).toBe(clone); expect(clone.enabled).toBe(false);
    pm.close(); expect(clone.stopped).toBe(true); blocked.resolve(); await flush();
  });

  it('stops superseded capture clones immediately and publishes the new microphone', async () => {
    const first = new FakeTrack('audio'); const { pm, media, changed } = manager({ mic: first }); pm.connect('b', 1, true); await flush();
    const old = pc().transceivers[0].sender.track!; const next = new FakeTrack('audio'); media.audioTrack = next; changed();
    expect(old.enabled).toBe(false); await flush(); expect(old.stopped).toBe(true); expect(pc().transceivers[0].sender.track).toBe(next.clones[0]); pm.close();
  });

  it('ignores stale permission events and never publishes late track callbacks after drop', async () => {
    const mic = new FakeTrack('audio'); const { pm, streams } = manager({ mic }); pm.connect('b', 1, true, false); await flush();
    const oldTrack = pc().ontrack!; pm.connect('b', 2, true, false); await flush();
    pm.setMediaAllowed('b', 1, true); await flush(); expect(mic.clones).toHaveLength(0);
    oldTrack({ track: new FakeTrack('audio') }); expect(streams).toEqual([['b', null]]);
    pm.close();
  });
});

describe('stale signalling and diagnostics', () => {
  it('replaces old links and ignores their signals, including tasks already queued before drop', async () => {
    const { pm, streams, sent } = manager(); pm.connect('b', 1, false);
    pm.signal('b', 1, { sdp: { type: 'offer', sdp: 'queued old' } });
    pm.connect('b', 2, false); await flush(); expect(FakePC.all[0].closed).toBe(true); expect(FakePC.all[0].remoteDescription).toBeNull();
    expect(streams).toEqual([['b', null]]);
    pm.signal('b', 1, { sdp: { type: 'offer', sdp: 'old' } }); await flush(); expect(pc().remoteDescription).toBeNull();
    pm.signal('b', 2, { sdp: { type: 'offer', sdp: 'new' } }); await flush(); expect(pc().remoteDescription?.sdp).toBe('new');
    expect(sent).toHaveLength(1);
    pm.connect('c', 3, true); pm.dropAll(); await flush(); expect(FakePC.all.every((p) => p.closed)).toBe(true); expect(pm.stats()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * CONNECT_TIMEOUT_MS); expect(FakePC.all.flatMap((p) => p.offers).filter((o) => o.iceRestart)).toEqual([]); pm.close();
  });

  it('does not send an answer or attach clones after an awaited old offer is dropped', async () => {
    const mic = new FakeTrack('audio'); const { pm, sent } = manager({ mic }); pm.connect('b', 1, false);
    const old = pc(); const blocked = deferred(); old.setRemoteDescription = async () => { await blocked.promise; old.addTransceiver('audio'); };
    pm.signal('b', 1, { sdp: { type: 'offer', sdp: 'old' } }); await flush(); pm.disconnect('b'); blocked.resolve(); await flush();
    expect(sent).toEqual([]); expect(mic.clones).toHaveLength(0); pm.close();
  });

  it('exposes bounded timings and safe candidate/media counters without addresses or SDP', async () => {
    const { pm } = manager(); pm.connect('b', 1, true); await flush();
    await vi.advanceTimersByTimeAsync(50); pc().track(); pc().set('connected');
    pc().statsEntries = [
      { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
      { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.05 },
      { id: 'local', type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.0.1', usernameFragment: 'secret' },
      { id: 'remote', type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.1' },
      { id: 'audio', type: 'inbound-rtp', kind: 'audio', bytesReceived: 1200, packetsReceived: 10, jitter: 0.006 },
    ];
    const result = await pm.diagnostics(); expect(result).toEqual([expect.objectContaining({
      connectedMs: 50, firstRemoteTrackMs: 50, firstObservedInboundAudioMs: 50,
      localCandidateType: 'host', remoteCandidateType: 'srflx', protocol: 'udp',
      roundTripTimeMs: 50, inboundAudioBytes: 1200, inboundAudioPackets: 10, jitterMs: 6,
    })]);
    expect(JSON.stringify(result)).not.toMatch(/192\.168|203\.0|secret|candidate:test/);
    for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(RESTART_GAP_MS); pm.restartAll(); await flush(); pc().set('connected'); }
    expect(pm.stats()[0].timings.length).toBeLessThanOrEqual(12); pm.close();
  });
});
