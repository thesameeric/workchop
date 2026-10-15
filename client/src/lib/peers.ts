import type { RtcSignal } from '../../../shared/types';
import type { MediaManager } from './media';

/** A stalled handshake gets one ICE restart before requesting a fresh link. */
export const CONNECT_TIMEOUT_MS = 6_000;
/** Genuine ICE/signalling progress can extend a handshake once, up to this ceiling. */
export const CONNECT_PROGRESS_TIMEOUT_MS = 12_000;
/** Short interruptions often heal without a new handshake. */
export const DISCONNECTED_GRACE_MS = 1_500;
export const RESTARTS_BEFORE_RELINK = 1;
export const RESTART_GAP_MS = 2_000;
const MAX_BACKOFF_MS = 120_000;

interface Outgoing {
  sender: RTCRtpSender;
  kind: string;
  desired: MediaStreamTrack | null | undefined;
  revision: number;
  clone: MediaStreamTrack | null;
  queue: Promise<void>;
}

interface Peer {
  id: string;
  sid: number;
  initiator: boolean;
  pc: RTCPeerConnection;
  stream: MediaStream;
  published: MediaStream | null;
  mediaAllowed: boolean;
  localMediaAllowed: boolean;
  outgoing: Map<RTCRtpSender, Outgoing>;
  clones: Map<MediaStreamTrack, { source: MediaStreamTrack; outgoing: Outgoing; revision: number }>;
  pendingCandidates: RTCIceCandidateInit[];
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  due: number;
  restarts: number;
  lastRestart: number;
  failureHandled: boolean;
  awaitingRelink: boolean;
  progress: number;
  setupProgress: number;
  setupStarted: number;
  setupDelay: number;
  extended: boolean;
  lastIce: RTCIceConnectionState;
  lastGathering: RTCIceGatheringState;
  createdAt: number;
  connectedAt: number | null;
  firstRemoteTrackAt: number | null;
  /** First on-demand diagnostics sample with inbound bytes; not a measured audible start time. */
  firstObservedInboundAudioAt: number | null;
  stage: string;
  timings: { stage: string; elapsedMs: number }[];
  sendTrackErrors: number;
}

export interface PeerEvents {
  send(to: string, sid: number, data: RtcSignal): void;
  stream(id: string, stream: MediaStream | null): void;
  state?(id: string, state: RTCPeerConnectionState): void;
  relink?(id: string, sid: number): void;
  /** Local eligibility is checked as well as the server's permission, including before async sends. */
  canSendMedia?(id: string): boolean;
}

/**
 * A limited nearby mesh may negotiate before people enter conversation range. Warm transports
 * carry no local tracks and publish no remote stream. Server permission AND local eligibility
 * are required. Each sender owns a clone so revocation disables it synchronously, even while a
 * browser's replaceTrack promise is pending; the shared microphone itself is never altered here.
 */
export class PeerManager {
  private peers = new Map<string, Peer>();
  private failures = new Map<string, number>();
  private unsubscribe: () => void;

  constructor(
    private readonly media: MediaManager,
    private iceServers: RTCIceServer[],
    private readonly events: PeerEvents,
  ) {
    this.unsubscribe = media.subscribe(() => this.refreshMediaPermissions());
  }

  has(id: string): boolean { return this.peers.has(id); }

  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers;
    for (const peer of this.peers.values()) {
      try { peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers: servers }); } catch { /* Closed. */ }
    }
  }

  connect(id: string, sid: number, initiator: boolean, mediaAllowed = true): void {
    this.drop(id);
    const peer = this.create(id, sid, initiator, mediaAllowed);
    this.watchSetup(peer, this.backoff(id));
    if (initiator) this.enqueue(peer, async () => {
      peer.pc.addTransceiver('audio', { direction: 'sendrecv' });
      peer.pc.addTransceiver('video', { direction: 'sendrecv' });
      await this.syncPeerTracks(peer);
      if (this.live(peer)) await this.offer(peer);
    });
  }

  setMediaAllowed(id: string, sid: number, allowed: boolean): void {
    const peer = this.peers.get(id);
    if (!peer || peer.sid !== sid) return;
    peer.mediaAllowed = allowed;
    void this.syncPeerTracks(peer);
  }

  /** Also called immediately after movement/status changes, before the next server round trip. */
  refreshMediaPermissions(): void {
    for (const peer of this.peers.values()) void this.syncPeerTracks(peer);
  }

  disconnect(id: string): void { this.failures.delete(id); this.drop(id); }

  dropAll(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.failures.clear();
  }

  restartAll(): void { for (const peer of this.peers.values()) this.restart(peer); }

  signal(from: string, sid: number, data: RtcSignal): void {
    const peer = this.peers.get(from);
    if (!peer || peer.sid !== sid) return;
    if (data.restart) { if (peer.initiator) this.restart(peer); return; }
    this.enqueue(peer, () => this.handle(peer, data));
  }

  close(): void { this.unsubscribe(); this.dropAll(); }

  private live(peer: Peer): boolean { return this.peers.get(peer.id) === peer; }

  private allowed(peer: Peer): boolean {
    if (!this.live(peer) || !peer.mediaAllowed) return false;
    try { return this.events.canSendMedia?.(peer.id) ?? true; } catch { return false; }
  }

  private drop(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timer);
    for (const track of peer.clones.keys()) { track.enabled = false; track.stop(); }
    peer.clones.clear();
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.onicegatheringstatechange = null;
    peer.pc.close();
    this.events.stream(id, null);
  }

  private create(id: string, sid: number, initiator: boolean, mediaAllowed: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 1 });
    const now = Date.now();
    const peer: Peer = {
      id, sid, initiator, pc, stream: new MediaStream(), published: null, mediaAllowed,
      localMediaAllowed: false, outgoing: new Map(), clones: new Map(), pendingCandidates: [],
      queue: Promise.resolve(), due: 0, restarts: 0, lastRestart: -Infinity,
      failureHandled: false, awaitingRelink: false, progress: 0, setupProgress: 0,
      setupStarted: now, setupDelay: CONNECT_TIMEOUT_MS, extended: false,
      lastIce: pc.iceConnectionState, lastGathering: pc.iceGatheringState,
      createdAt: now, connectedAt: null, firstRemoteTrackAt: null, firstObservedInboundAudioAt: null,
      stage: 'created', timings: [{ stage: 'created', elapsedMs: 0 }], sendTrackErrors: 0,
    };
    this.peers.set(id, peer);
    peer.localMediaAllowed = this.allowed(peer);
    pc.onicecandidate = (e) => {
      if (!this.live(peer) || !e.candidate) return;
      peer.progress++;
      this.events.send(id, sid, { candidate: e.candidate.toJSON() as RtcSignal['candidate'] });
    };
    pc.ontrack = (e) => {
      if (!this.live(peer)) return;
      peer.firstRemoteTrackAt ??= Date.now();
      if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
      peer.stream = new MediaStream(peer.stream.getTracks());
      this.publish(peer);
    };
    pc.onconnectionstatechange = () => {
      if (!this.live(peer)) return;
      this.events.state?.(id, pc.connectionState);
      this.check(peer);
    };
    pc.oniceconnectionstatechange = () => this.check(peer);
    pc.onicegatheringstatechange = () => {
      if (this.live(peer) && pc.iceGatheringState !== peer.lastGathering) {
        peer.lastGathering = pc.iceGatheringState;
        peer.progress++;
      }
    };
    return peer;
  }

  private stage(peer: Peer, stage: string): void {
    peer.stage = stage;
    peer.timings.push({ stage, elapsedMs: Date.now() - peer.createdAt });
    if (peer.timings.length > 12) peer.timings.splice(0, peer.timings.length - 12);
  }

  private publish(peer: Peer): void {
    if (!this.live(peer)) return;
    const stream = this.allowed(peer) && peer.stream.getTracks().length ? peer.stream : null;
    if (peer.published === stream) return;
    peer.published = stream;
    this.events.stream(peer.id, stream);
  }

  private up(pc: RTCPeerConnection): boolean {
    return pc.connectionState ? pc.connectionState === 'connected'
      : pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
  }

  private check(peer: Peer): void {
    if (!this.live(peer)) return;
    const { connectionState, iceConnectionState } = peer.pc;
    if (peer.lastIce !== iceConnectionState) { peer.lastIce = iceConnectionState; peer.progress++; }
    const failed = connectionState === 'failed' || iceConnectionState === 'failed';
    if (!failed) peer.failureHandled = false;
    if (this.up(peer.pc)) {
      clearTimeout(peer.timer);
      peer.timer = undefined;
      peer.restarts = 0;
      peer.awaitingRelink = false;
      peer.connectedAt ??= Date.now();
      if (peer.stage !== 'connected') this.stage(peer, 'connected');
      this.failures.delete(peer.id);
    } else if (failed && !peer.failureHandled) {
      peer.failureHandled = true;
      this.recover(peer);
    } else if (connectionState === 'disconnected' || iceConnectionState === 'disconnected') {
      this.arm(peer, DISCONNECTED_GRACE_MS, () => this.recover(peer));
    }
  }

  private arm(peer: Peer, ms: number, task: () => void, exactly = false): void {
    if (!this.live(peer)) return;
    const due = Date.now() + ms;
    if (peer.timer !== undefined && !exactly && peer.due <= due) return;
    clearTimeout(peer.timer);
    peer.due = due;
    peer.timer = setTimeout(() => {
      peer.timer = undefined;
      if (this.live(peer) && !this.up(peer.pc)) task();
    }, ms);
  }

  private watchSetup(peer: Peer, delay: number): void {
    peer.setupStarted = Date.now();
    peer.setupProgress = peer.progress;
    peer.setupDelay = delay;
    peer.extended = false;
    this.arm(peer, delay, () => this.setupExpired(peer), true);
  }

  private setupExpired(peer: Peer): void {
    if (!peer.extended && peer.setupDelay === CONNECT_TIMEOUT_MS && peer.progress > peer.setupProgress) {
      const remaining = CONNECT_PROGRESS_TIMEOUT_MS - (Date.now() - peer.setupStarted);
      if (remaining > 0) {
        peer.extended = true;
        this.stage(peer, 'setup-progress');
        this.arm(peer, remaining, () => this.recover(peer), true);
        return;
      }
    }
    this.recover(peer);
  }

  private recover(peer: Peer): void {
    if (!this.live(peer) || peer.awaitingRelink) return;
    if (peer.restarts < RESTARTS_BEFORE_RELINK || !this.events.relink) { this.restart(peer); return; }
    peer.awaitingRelink = true;
    this.failures.set(peer.id, (this.failures.get(peer.id) ?? 0) + 1);
    this.stage(peer, 'relink-requested');
    this.events.relink(peer.id, peer.sid);
    this.arm(peer, this.backoff(peer.id), () => {
      peer.awaitingRelink = false;
      this.recover(peer);
    }, true);
  }

  private restart(peer: Peer): void {
    if (!this.live(peer) || peer.awaitingRelink || Date.now() - peer.lastRestart < RESTART_GAP_MS) return;
    peer.lastRestart = Date.now();
    peer.restarts++;
    this.stage(peer, 'ice-restart');
    if (peer.initiator) this.enqueue(peer, () => this.offer(peer, true));
    else this.events.send(peer.id, peer.sid, { restart: true });
    this.watchSetup(peer, CONNECT_TIMEOUT_MS);
  }

  private backoff(id: string): number {
    return Math.min(MAX_BACKOFF_MS, CONNECT_TIMEOUT_MS * 2 ** Math.min(8, this.failures.get(id) ?? 0));
  }

  private enqueue(peer: Peer, task: () => Promise<void>): void {
    peer.queue = peer.queue.then(() => this.live(peer) ? task() : undefined).catch(() => {
      // Full SDP and browser errors can contain connection details: diagnostics expose only counters.
      if (this.live(peer)) this.stage(peer, 'signalling-error');
    });
  }

  private async offer(peer: Peer, iceRestart = false): Promise<void> {
    if (!this.live(peer)) return;
    const offer = await peer.pc.createOffer({ iceRestart });
    if (!this.live(peer)) return;
    await peer.pc.setLocalDescription(offer);
    if (!this.live(peer)) return;
    const desc = peer.pc.localDescription;
    if (desc) {
      this.stage(peer, 'offer-sent');
      this.events.send(peer.id, peer.sid, { sdp: { type: 'offer', sdp: desc.sdp } });
    }
  }

  private async handle(peer: Peer, data: RtcSignal): Promise<void> {
    if (!this.live(peer)) return;
    const { pc } = peer;
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (peer.initiator) return;
        this.stage(peer, 'offer-received');
        await pc.setRemoteDescription(data.sdp);
        if (!this.live(peer)) return;
        peer.progress++;
        for (const t of pc.getTransceivers()) t.direction = 'sendrecv';
        await this.syncPeerTracks(peer);
        if (!this.live(peer)) return;
        await this.flushCandidates(peer);
        if (!this.live(peer)) return;
        const answer = await pc.createAnswer();
        if (!this.live(peer)) return;
        await pc.setLocalDescription(answer);
        if (!this.live(peer)) return;
        if (pc.localDescription) {
          this.stage(peer, 'answer-sent');
          this.events.send(peer.id, peer.sid, { sdp: { type: 'answer', sdp: pc.localDescription.sdp } });
        }
      } else if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(data.sdp);
        if (!this.live(peer)) return;
        this.stage(peer, 'answer-received');
        peer.progress++;
        await this.flushCandidates(peer);
      }
    } else if (data.candidate) {
      peer.progress++;
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else if (peer.pendingCandidates.length < 128) peer.pendingCandidates.push(data.candidate);
    }
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    for (const candidate of peer.pendingCandidates.splice(0)) {
      if (!this.live(peer)) return;
      await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  /** Synchronous disabling precedes queued browser operations, including during permission races. */
  private syncPeerTracks(peer: Peer): Promise<void> {
    if (!this.live(peer)) return Promise.resolve();
    const allowed = this.allowed(peer);
    peer.localMediaAllowed = allowed;
    for (const t of peer.pc.getTransceivers()) {
      if (!t.receiver.track || t.currentDirection === 'stopped') continue;
      let outgoing = peer.outgoing.get(t.sender);
      if (!outgoing) {
        outgoing = { sender: t.sender, kind: t.receiver.track.kind, desired: undefined, revision: 0, clone: null, queue: Promise.resolve() };
        peer.outgoing.set(t.sender, outgoing);
      }
      const source = outgoing.kind === 'audio' ? this.media.audioTrack : this.media.videoTrack;
      const desired = allowed && source?.readyState !== 'ended' ? source : null;
      if (outgoing.desired !== desired) {
        outgoing.desired = desired;
        outgoing.revision++;
        const revision = outgoing.revision;
        const current = outgoing;
        current.queue = current.queue.then(() => this.replace(peer, current, desired, revision));
      }
    }
    for (const [clone, data] of peer.clones) {
      clone.enabled = allowed && data.source.enabled && data.outgoing.desired === data.source && data.outgoing.revision === data.revision;
    }
    this.publish(peer);
    return Promise.all([...peer.outgoing.values()].map((s) => s.queue)).then(() => {});
  }

  private async replace(peer: Peer, outgoing: Outgoing, desired: MediaStreamTrack | null, revision: number): Promise<void> {
    if (!this.live(peer) || outgoing.revision !== revision) return;
    let clone: MediaStreamTrack | null = null;
    try {
      // Local movement may have invalidated eligibility since this task was queued, before its
      // next refresh. Leave a retry marker so returning to range still attaches the same source.
      if (desired && !this.allowed(peer)) {
        outgoing.desired = undefined;
        for (const track of peer.clones.keys()) track.enabled = false;
      }
      if (desired && this.allowed(peer)) {
        clone = desired.clone();
        clone.enabled = desired.enabled;
        peer.clones.set(clone, { source: desired, outgoing, revision });
      }
      const previous = outgoing.clone;
      await outgoing.sender.replaceTrack(clone);
      // Revocation can occur while replaceTrack is pending: these clones were disabled already.
      if (previous && previous !== clone) { previous.enabled = false; previous.stop(); peer.clones.delete(previous); }
      const valid = this.live(peer) && outgoing.revision === revision && (!clone || this.allowed(peer));
      if (!valid && clone) { clone.enabled = false; clone.stop(); peer.clones.delete(clone); }
      outgoing.clone = valid ? clone : null;
      if (!valid && this.live(peer) && outgoing.revision === revision) outgoing.desired = undefined;
      if (valid && clone && desired) clone.enabled = desired.enabled;
    } catch {
      if (clone) { clone.enabled = false; clone.stop(); peer.clones.delete(clone); }
      if (this.live(peer)) {
        peer.sendTrackErrors++;
        // A later refresh retries without an unhandled rejection or a tight retry loop here.
        if (outgoing.revision === revision) outgoing.desired = undefined;
      }
    }
  }

  /** Small, bounded timings, with no SDP, addresses, credentials or voice samples. */
  stats() {
    return [...this.peers.values()].map((p) => ({
      id: p.id, sid: p.sid, initiator: p.initiator, state: p.pc.connectionState,
      ice: p.pc.iceConnectionState, signaling: p.pc.signalingState, restarts: p.restarts,
      mediaAllowed: p.mediaAllowed, localMediaAllowed: p.localMediaAllowed,
      elapsedMs: Date.now() - p.createdAt, connectedMs: p.connectedAt === null ? null : p.connectedAt - p.createdAt,
      firstRemoteTrackMs: p.firstRemoteTrackAt === null ? null : p.firstRemoteTrackAt - p.createdAt,
      firstObservedInboundAudioMs: p.firstObservedInboundAudioAt === null ? null : p.firstObservedInboundAudioAt - p.createdAt,
      stage: p.stage, timings: p.timings.map((t) => ({ ...t })), sendTrackErrors: p.sendTrackErrors,
    }));
  }

  /** Browser network measurements are collected on demand, never containing candidate addresses. */
  async diagnostics() {
    return Promise.all([...this.peers.values()].map(async (peer) => {
      const safe: { localCandidateType?: string; remoteCandidateType?: string; protocol?: string; roundTripTimeMs?: number; inboundAudioBytes?: number; inboundAudioPackets?: number; jitterMs?: number } = {};
      try {
        const report = await peer.pc.getStats();
        if (!this.live(peer)) return null;
        const entries: Record<string, unknown>[] = [];
        report.forEach((s) => entries.push(s as Record<string, unknown>));
        const transport = entries.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
        const pair = entries.find((s) => s.type === 'candidate-pair' && (s.id === transport?.selectedCandidatePairId || (s.nominated && s.state === 'succeeded')));
        const local = entries.find((s) => s.id === pair?.localCandidateId);
        const remote = entries.find((s) => s.id === pair?.remoteCandidateId);
        const candidateTypes = ['host', 'srflx', 'prflx', 'relay'];
        if (candidateTypes.includes(String(local?.candidateType))) safe.localCandidateType = String(local?.candidateType);
        if (candidateTypes.includes(String(remote?.candidateType))) safe.remoteCandidateType = String(remote?.candidateType);
        if (['udp', 'tcp'].includes(String(local?.protocol))) safe.protocol = String(local?.protocol);
        const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
        if (finite(pair?.currentRoundTripTime)) safe.roundTripTimeMs = pair.currentRoundTripTime * 1_000;
        const audio = entries.filter((s) => s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio'));
        if (audio.length) {
          safe.inboundAudioBytes = audio.reduce((sum, s) => sum + (finite(s.bytesReceived) ? s.bytesReceived : 0), 0);
          safe.inboundAudioPackets = audio.reduce((sum, s) => sum + (finite(s.packetsReceived) ? s.packetsReceived : 0), 0);
          const jitter = audio.find((s) => finite(s.jitter))?.jitter;
          if (finite(jitter)) safe.jitterMs = jitter * 1_000;
          if (safe.inboundAudioBytes > 0) peer.firstObservedInboundAudioAt ??= Date.now();
        }
      } catch { /* Older browsers or closing transports may not expose stats. */ }
      if (!this.live(peer)) return null;
      const summary = this.stats().find((p) => p.id === peer.id && p.sid === peer.sid);
      return summary ? { ...summary, ...safe } : null;
    })).then((all) => all.filter((entry) => entry !== null));
  }
}
