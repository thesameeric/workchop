import type { RtcSignal } from '../../../shared/types';
import type { MediaManager } from './media';

interface Peer {
  id: string;
  sid: number;
  initiator: boolean;
  pc: RTCPeerConnection;
  stream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  /** Signals are processed strictly in order per peer. */
  queue: Promise<void>;
  restartTimer?: ReturnType<typeof setTimeout>;
}

export interface PeerEvents {
  send(to: string, sid: number, data: RtcSignal): void;
  stream(id: string, stream: MediaStream | null): void;
  state?(id: string, state: RTCPeerConnectionState): void;
}

/**
 * One RTCPeerConnection per nearby person (a mesh). The server decides who is
 * linked and which side makes the offer; each side always has one audio and one
 * video transceiver so turning the camera on/off is just a replaceTrack().
 */
export class PeerManager {
  private peers = new Map<string, Peer>();
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

  connect(id: string, sid: number, initiator: boolean): void {
    this.disconnect(id);
    const peer = this.create(id, sid, initiator);
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

  disconnect(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.restartTimer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.events.stream(id, null);
  }

  signal(from: string, sid: number, data: RtcSignal): void {
    const peer = this.peers.get(from);
    // Ignore anything from an older connection with the same person.
    if (!peer || peer.sid !== sid) return;
    this.enqueue(peer, () => this.handle(peer, data));
  }

  close(): void {
    this.unsubscribe();
    for (const id of [...this.peers.keys()]) this.disconnect(id);
  }

  private create(id: string, sid: number, initiator: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { id, sid, initiator, pc, stream: new MediaStream(), pendingCandidates: [], queue: Promise.resolve() };
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
      if (pc.connectionState === 'failed' && initiator) {
        clearTimeout(peer.restartTimer);
        peer.restartTimer = setTimeout(() => {
          if (this.peers.get(id) === peer) this.enqueue(peer, () => this.offer(peer, true));
        }, 1000);
      }
    };
    return peer;
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

  stats(): { id: string; state: RTCPeerConnectionState }[] {
    return [...this.peers.values()].map((p) => ({ id: p.id, state: p.pc.connectionState }));
  }
}
