import type { RtcSignal } from '../../../shared/types';
import type { MediaManager } from './media';

/** How long a new (or restarted) connection gets to come up before it's tried again. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** 'disconnected' often heals by itself (a moment of packet loss): it gets this long first. */
export const DISCONNECTED_GRACE_MS = 4_000;
/** ICE restarts tried before the call is started over on a new connection (rtc:relink). */
export const RESTARTS_BEFORE_RELINK = 2;
/** Restarts closer together than this are one (both sides noticing, or the network coming back). */
export const RESTART_GAP_MS = 2_000;
/** The longest wait before trying again a call with someone that keeps failing. */
const MAX_BACKOFF_MS = 120_000;

interface Peer {
  id: string;
  sid: number;
  initiator: boolean;
  pc: RTCPeerConnection;
  stream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  /** Signals are processed strictly in order per peer. */
  queue: Promise<void>;
  /** The next look at the connection (whether it came up, or healed), and when it's due. */
  timer?: ReturnType<typeof setTimeout>;
  due: number;
  /** ICE restarts tried (or asked for) since it was last connected. */
  restarts: number;
  lastRestart: number;
}

export interface PeerEvents {
  send(to: string, sid: number, data: RtcSignal): void;
  stream(id: string, stream: MediaStream | null): void;
  state?(id: string, state: RTCPeerConnectionState): void;
  /** Asks the server to start the call with `id` (on link `sid`) over: a new peer:connect follows. */
  relink?(id: string, sid: number): void;
}

/**
 * One RTCPeerConnection per nearby person (a mesh). The server decides who is
 * linked and which side makes the offer; each side always has one audio and one
 * video transceiver so turning the camera on/off is just a replaceTrack().
 *
 * A call that doesn't come up, or breaks while the office connection stays (the network changed,
 * a relay went away), is repaired: the side making offers restarts ICE (the other side asks it to),
 * and after RESTARTS_BEFORE_RELINK tries either side asks the server to start the call over.
 */
export class PeerManager {
  private peers = new Map<string, Peer>();
  /** Calls started over without coming up, by person (across connections): they're tried less often. */
  private failures = new Map<string, number>();
  private unsubscribe: () => void;

  constructor(
    private readonly media: MediaManager,
    private iceServers: RTCIceServer[],
    private readonly events: PeerEvents,
  ) {
    this.unsubscribe = media.subscribe(() => this.syncTracks());
  }

  has(id: string): boolean {
    return this.peers.has(id);
  }

  /** New (e.g. refreshed TURN) servers: used for new connections and the next ICE restart of current ones. */
  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers;
    for (const peer of this.peers.values()) {
      try {
        peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers: servers });
      } catch {
        // A closed connection; it'll be replaced anyway.
      }
    }
  }

  /** Starts the call with `id` on link `sid` (replacing one on an older link). */
  connect(id: string, sid: number, initiator: boolean): void {
    this.drop(id);
    const peer = this.create(id, sid, initiator);
    this.watch(peer, this.backoff(id), true);
    if (initiator) {
      this.enqueue(peer, async () => {
        const audio = peer.pc.addTransceiver('audio', { direction: 'sendrecv' });
        const video = peer.pc.addTransceiver('video', { direction: 'sendrecv' });
        await audio.sender.replaceTrack(this.media.audioTrack);
        await video.sender.replaceTrack(this.media.videoTrack);
        await this.offer(peer);
      });
    }
  }

  /** The call with `id` is over (they walked away, or left). */
  disconnect(id: string): void {
    this.failures.delete(id);
    this.drop(id);
  }

  /** Ends every call: the office connection dropped, and they come back with the new links (afresh). */
  dropAll(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.failures.clear();
  }

  /** The network changed (back online): every call looks for the new way through. */
  restartAll(): void {
    for (const peer of this.peers.values()) this.restart(peer);
  }

  signal(from: string, sid: number, data: RtcSignal): void {
    const peer = this.peers.get(from);
    // Ignore anything from an older connection with the same person.
    if (!peer || peer.sid !== sid) return;
    if (data.restart) {
      // Their side broke: only the side making offers can restart.
      if (peer.initiator) this.restart(peer);
      return;
    }
    this.enqueue(peer, () => this.handle(peer, data));
  }

  close(): void {
    this.unsubscribe();
    this.dropAll();
  }

  private drop(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.close();
    this.events.stream(id, null);
  }

  private create(id: string, sid: number, initiator: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { id, sid, initiator, pc, stream: new MediaStream(), pendingCandidates: [], queue: Promise.resolve(), due: 0, restarts: 0, lastRestart: 0 };
    this.peers.set(id, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.events.send(id, sid, { candidate: e.candidate.toJSON() as RtcSignal['candidate'] });
    };
    pc.ontrack = (e) => {
      if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
      // A fresh MediaStream object makes React notice the change.
      peer.stream = new MediaStream(peer.stream.getTracks());
      this.events.stream(id, peer.stream);
    };
    pc.onconnectionstatechange = () => {
      this.events.state?.(id, pc.connectionState);
      this.check(peer);
    };
    // Some browsers say more (or only) here.
    pc.oniceconnectionstatechange = () => this.check(peer);
    return peer;
  }

  /** Media flows. */
  private up(pc: RTCPeerConnection): boolean {
    // Browsers without connectionState (older Firefox) have ICE's.
    if (pc.connectionState) return pc.connectionState === 'connected';
    return pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
  }

  private check(peer: Peer): void {
    if (this.peers.get(peer.id) !== peer) return;
    const { connectionState, iceConnectionState } = peer.pc;
    if (this.up(peer.pc)) {
      clearTimeout(peer.timer);
      peer.timer = undefined;
      peer.restarts = 0;
      this.failures.delete(peer.id);
    } else if (connectionState === 'failed' || iceConnectionState === 'failed') {
      this.recover(peer);
    } else if (connectionState === 'disconnected' || iceConnectionState === 'disconnected') {
      this.watch(peer, DISCONNECTED_GRACE_MS);
    }
  }

  /** Looks at the call again in `ms` (or sooner, if a look is due sooner; `exactly` moves it either way). */
  private watch(peer: Peer, ms: number, exactly = false): void {
    const due = Date.now() + ms;
    if (peer.timer !== undefined && !exactly && peer.due <= due) return;
    clearTimeout(peer.timer);
    peer.due = due;
    peer.timer = setTimeout(() => {
      peer.timer = undefined;
      if (this.peers.get(peer.id) === peer && !this.up(peer.pc)) this.recover(peer);
    }, ms);
  }

  /** The call is down, or never came up: restart ICE a few times, then start it over. */
  private recover(peer: Peer): void {
    if (peer.restarts < RESTARTS_BEFORE_RELINK || !this.events.relink) {
      this.restart(peer);
      return;
    }
    this.failures.set(peer.id, (this.failures.get(peer.id) ?? 0) + 1);
    this.events.relink(peer.id, peer.sid);
    // Asked again later if nothing comes of it (the server takes only so many at once).
    this.watch(peer, this.backoff(peer.id), true);
  }

  /** An ICE restart: made by the side making offers, asked for by the other. */
  private restart(peer: Peer): void {
    const wait = peer.lastRestart + RESTART_GAP_MS - Date.now();
    if (wait > 0) {
      this.watch(peer, wait);
      return;
    }
    peer.lastRestart = Date.now();
    peer.restarts++;
    if (peer.initiator) this.enqueue(peer, () => this.offer(peer, true));
    else this.events.send(peer.id, peer.sid, { restart: true });
    this.watch(peer, CONNECT_TIMEOUT_MS, true);
  }

  /** How long a new call with `id` gets: longer each time it was started over without coming up. */
  private backoff(id: string): number {
    return Math.min(MAX_BACKOFF_MS, CONNECT_TIMEOUT_MS * 2 ** (this.failures.get(id) ?? 0));
  }

  private enqueue(peer: Peer, task: () => Promise<void>): void {
    peer.queue = peer.queue.then(task).catch((err) => {
      if (this.peers.get(peer.id) === peer) console.warn(`[rtc] ${peer.id}:`, err);
    });
  }

  private async offer(peer: Peer, iceRestart = false): Promise<void> {
    const offer = await peer.pc.createOffer({ iceRestart });
    await peer.pc.setLocalDescription(offer);
    const desc = peer.pc.localDescription!;
    this.events.send(peer.id, peer.sid, { sdp: { type: 'offer', sdp: desc.sdp } });
  }

  private async handle(peer: Peer, data: RtcSignal): Promise<void> {
    const { pc } = peer;
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (peer.initiator) return; // Only the designated side offers.
        await pc.setRemoteDescription(data.sdp);
        for (const t of pc.getTransceivers()) {
          t.direction = 'sendrecv';
          await t.sender.replaceTrack(t.receiver.track.kind === 'audio' ? this.media.audioTrack : this.media.videoTrack);
        }
        await this.flushCandidates(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.events.send(peer.id, peer.sid, { sdp: { type: 'answer', sdp: pc.localDescription!.sdp } });
      } else if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(data.sdp);
        await this.flushCandidates(peer);
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pendingCandidates.push(data.candidate);
    }
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    const list = peer.pendingCandidates.splice(0);
    for (const c of list) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  /** Push the current mic/camera/screen tracks to every connection. */
  private syncTracks(): void {
    for (const peer of this.peers.values()) {
      for (const t of peer.pc.getTransceivers()) {
        if (!t.receiver.track || t.currentDirection === 'stopped') continue;
        const track = t.receiver.track.kind === 'audio' ? this.media.audioTrack : this.media.videoTrack;
        if (t.sender.track !== track) t.sender.replaceTrack(track).catch(() => {});
      }
    }
  }

  /** For debugging (window.__workchop.session().peerStats()). */
  stats(): { id: string; sid: number; initiator: boolean; state: RTCPeerConnectionState; ice: RTCIceConnectionState; signaling: RTCSignalingState; restarts: number }[] {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      sid: p.sid,
      initiator: p.initiator,
      state: p.pc.connectionState,
      ice: p.pc.iceConnectionState,
      signaling: p.pc.signalingState,
      restarts: p.restarts,
    }));
  }
}
