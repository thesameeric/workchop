import { io, type Socket } from 'socket.io-client';
import { buildColliders, findFreeSpot, isBlocked, proximityVolume } from '../../../shared/geometry';
import { applyOp } from '../../../shared/office';
import type {
  AnimState,
  ClientToServerEvents,
  JoinResponse,
  OfficeOp,
  PlayerPatch,
  PlayerState,
  ServerToClientEvents,
} from '../../../shared/types';
import { getState, initialBuild, setState, toast, type ChatTarget, type RemotePlayer } from '../state/store';
import { audibleJukebox, musicVolumeAt, type MusicLink, type MusicOp } from '../../../shared/music';
import { fetchConfig } from './api';
import { serverNow, syncClock } from './clock';
import { LoungeRadio } from './radio';
import { SpotifyListenAlong } from './spotify';
import { SpeakingDetector } from './levels';
import { media } from './media';
import { PeerManager } from './peers';
import { local, remoteTargets } from './positions';
import { getOwnerKey, saveProfile } from './storage';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function toRemote(p: PlayerState): RemotePlayer {
  const { x: _x, z: _z, ry: _ry, anim: _anim, ...rest } = p;
  return rest;
}

/** Everything that happens while you're inside an office: socket, calls, audio. */
export class OfficeSession {
  private socket: AppSocket;
  private peers: PeerManager | null = null;
  private speaking = new SpeakingDetector((id, on) =>
    setState((s) => ({ speaking: { ...s.speaking, [id]: on } })),
  );
  private audio = new Map<string, HTMLAudioElement>();
  private audioRoot: HTMLDivElement;
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubs: (() => void)[] = [];
  private lastSent = { x: NaN, z: NaN, ry: NaN, anim: 'idle' as AnimState, at: 0 };
  private hasJoined = false;
  private closed = false;
  readonly radio = new LoungeRadio((itemId, url, durationMs) => this.music({ t: 'track:duration', itemId, url, durationMs }));
  readonly spotify = new SpotifyListenAlong((itemId, update, start) => this.socket.emit('spotify:session', itemId, update, start));
  private spotifyClientId: string | null = null;

  constructor(readonly officeId: string) {
    this.socket = io({ autoConnect: false });
    this.audioRoot = document.createElement('div');
    this.audioRoot.hidden = true;
    document.body.appendChild(this.audioRoot);
  }

  async join(): Promise<void> {
    const { iceServers, spotifyClientId } = await fetchConfig();
    this.spotifyClientId = spotifyClientId;
    this.peers = new PeerManager(media, iceServers, {
      send: (to, sid, data) => this.socket.emit('rtc:signal', to, sid, data),
      stream: (id, stream) => this.onStream(id, stream),
    });
    this.wireSocket();
    this.unsubs.push(media.subscribe(() => this.onMediaChange()));
    this.onMediaChange();
    this.timers.push(setInterval(() => this.updateVolumes(), 120));

    await new Promise<void>((resolve, reject) => {
      const onFirst = (res: JoinResponse) => {
        if (res.ok) resolve();
        else reject(new Error(res.error));
      };
      this.socket.on('connect', () => this.sendJoin(onFirst));
      this.socket.on('connect_error', () => {
        if (!this.hasJoined) reject(new Error('Could not reach the server.'));
      });
      this.socket.connect();
    });
  }

  private sendJoin(onFirst: (res: JoinResponse) => void): void {
    const { me } = getState();
    this.socket.emit(
      'join',
      {
        officeId: this.officeId,
        name: me.name,
        avatar: me.avatar,
        status: me.status,
        ownerKey: getOwnerKey(this.officeId),
        mic: media.micOn,
        cam: media.camOn || media.screenOn,
      },
      (res) => {
        if (!res.ok) {
          if (!this.hasJoined) onFirst(res);
          else toast(res.error, 'error');
          return;
        }
        const rejoin = this.hasJoined;
        this.hasJoined = true;
        remoteTargets.clear();
        const players: Record<string, RemotePlayer> = {};
        for (const p of res.players) {
          if (p.id === res.selfId) continue;
          players[p.id] = toRemote(p);
          remoteTargets.set(p.id, { x: p.x, z: p.z, ry: p.ry, anim: p.anim });
        }
        const self = res.players.find((p) => p.id === res.selfId)!;
        if (!rejoin) {
          local.x = self.x;
          local.z = self.z;
          local.ry = 0;
          local.anim = 'idle';
          local.seat = local.path = local.pathSeat = null;
        }
        setState({
          phase: 'office',
          connection: 'online',
          selfId: res.selfId,
          isOwner: res.isOwner,
          office: res.office,
          players,
          chat: rejoin ? getState().chat : res.chat,
          linked: {},
          streams: {},
          spotifySessions: Object.fromEntries(res.spotify.map((s) => [s.itemId, s])),
        });
        void syncClock(() => this.socket.timeout(5000).emitWithAck('time'));
        if (rejoin) {
          this.lastSent.at = 0;
          this.sendMove(local.x, local.z, local.ry, local.anim, true);
          this.socket.emit('profile', { screen: media.screenOn });
        } else {
          this.startMusic();
          onFirst(res);
        }
      },
    );
  }

  private startMusic(): void {
    this.radio.start();
    this.spotify.configure(this.spotifyClientId);
    // Keep Spotify listen-along in step with the session at the jukebox we can hear.
    this.timers.push(
      setInterval(() => {
        const st = getState();
        if (!st.office) return;
        const personal = st.music.muted ? 0 : st.music.volume;
        // A DJ hears their own session as loud as the jukebox it plays on; everyone else follows
        // the session at the jukebox they can hear.
        const djItem = st.office.items.find((i) => i.id === this.spotify.djJukebox);
        if (djItem) {
          void this.spotify.follow(st.spotifySessions[djItem.id] ?? null, musicVolumeAt(st.office, djItem, local.x, local.z) * personal * personal);
          return;
        }
        const heard = audibleJukebox(st.office, local.x, local.z);
        const session = heard ? st.spotifySessions[heard.item.id] ?? null : null;
        void this.spotify.follow(session, heard ? heard.volume * personal * personal : 0);
      }, 1000),
      // Clocks drift a little; re-sync now and then.
      setInterval(() => void syncClock(() => this.socket.timeout(5000).emitWithAck('time'), 3), 60_000),
    );
  }

  /** Change a jukebox (station, tracks, shared links). */
  music(op: MusicOp): void {
    this.socket.emit('music', op);
  }

  async playForEveryone(itemId: string, link: MusicLink): Promise<void> {
    await this.spotify.playForEveryone(itemId, link);
  }

  stopSpotify(itemId: string): void {
    this.spotify.stopForEveryone(itemId);
  }

  /** For tests and debugging. */
  debugMusic() {
    return { serverNow: serverNow(), at: { x: local.x, z: local.z }, radio: this.radio.debug(), spotify: getState().spotify };
  }

  private wireSocket(): void {
    const s = this.socket;
    s.on('disconnect', () => {
      if (this.closed) return;
      setState({ connection: 'reconnecting' });
      this.dropAllPeers();
    });
    s.on('player:joined', (p) => {
      remoteTargets.set(p.id, { x: p.x, z: p.z, ry: p.ry, anim: p.anim });
      setState((st) => ({ players: { ...st.players, [p.id]: toRemote(p) } }));
      toast(`${p.name} joined`);
    });
    s.on('player:left', (id) => {
      const name = getState().players[id]?.name;
      remoteTargets.delete(id);
      this.peers?.disconnect(id);
      setState((st) => {
        const players = { ...st.players };
        delete players[id];
        const linked = { ...st.linked };
        delete linked[id];
        return { players, linked, spotlight: st.spotlight === id ? null : st.spotlight };
      });
      if (name) toast(`${name} left`);
    });
    s.on('player:moved', ([id, x, z, ry, anim]) => {
      const t = remoteTargets.get(id);
      if (t) Object.assign(t, { x, z, ry, anim });
      else remoteTargets.set(id, { x, z, ry, anim });
    });
    s.on('player:updated', (id, patch) => {
      if (id === getState().selfId) return;
      setState((st) => (st.players[id] ? { players: { ...st.players, [id]: { ...st.players[id], ...patch } } } : {}));
    });
    s.on('peer:connect', (id, sid, initiator) => {
      setState((st) => ({ linked: { ...st.linked, [id]: true } }));
      this.peers?.connect(id, sid, initiator);
    });
    s.on('peer:disconnect', (id) => {
      this.peers?.disconnect(id);
      setState((st) => {
        const linked = { ...st.linked };
        delete linked[id];
        return { linked, spotlight: st.spotlight === id ? null : st.spotlight };
      });
    });
    s.on('rtc:signal', (from, sid, data) => this.peers?.signal(from, sid, data));
    s.on('chat', (msg) => {
      setState((st) => ({
        chat: [...st.chat.slice(-199), msg],
        unread: st.panel === 'chat' || msg.from === st.selfId ? st.unread : st.unread + 1,
      }));
    });
    s.on('emote', (id, emoji) => {
      const at = Date.now();
      setState((st) => ({ emotes: { ...st.emotes, [id]: { emoji, at } } }));
      setTimeout(() => {
        setState((st) => {
          if (st.emotes[id]?.at !== at) return {};
          const emotes = { ...st.emotes };
          delete emotes[id];
          return { emotes };
        });
      }, 3200);
    });
    s.on('office:op', (op) => {
      const { office } = getState();
      if (!office) return;
      try {
        this.setOffice(applyOp(office, op));
      } catch {
        // Already applied locally (our own echo) or no longer applicable.
      }
    });
    s.on('office:sync', (office, reason) => {
      this.setOffice(office);
      if (reason) toast(reason, 'error');
    });
    s.on('notice', (text) => toast(text, 'error'));
    s.on('spotify:session', (itemId, session) => {
      setState((st) => {
        const spotifySessions = { ...st.spotifySessions };
        if (session) spotifySessions[itemId] = session;
        else delete spotifySessions[itemId];
        return { spotifySessions };
      });
    });
  }

  private setOffice(office: NonNullable<ReturnType<typeof getState>['office']>): void {
    setState((st) => {
      const build = { ...st.build };
      if (build.selectedId && !office.items.some((i) => i.id === build.selectedId)) build.selectedId = null;
      if (build.selectedZoneId && !office.zones.some((z) => z.id === build.selectedZoneId)) build.selectedZoneId = null;
      const allowed = office.settings.buildPolicy === 'everyone' || st.isOwner;
      return allowed ? { office, build } : { office, build: initialBuild, mode: 'play', panel: st.panel === 'build' ? 'none' : st.panel };
    });
    // Make sure edits didn't leave us stuck inside furniture or outside the floor.
    if (!local.seat && isBlocked(local.x, local.z, buildColliders(office), office.settings)) {
      const spot = findFreeSpot(local.x, local.z, buildColliders(office), office.settings);
      local.x = spot.x;
      local.z = spot.z;
      local.path = null;
    }
  }

  /** Apply an edit locally right away and send it to the server. */
  edit(op: OfficeOp): boolean {
    const { office } = getState();
    if (!office) return false;
    try {
      this.setOffice(applyOp(office, op));
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    }
    this.socket.emit('office:op', op);
    return true;
  }

  sendMove(x: number, z: number, ry: number, anim: AnimState, force = false): void {
    const now = performance.now();
    const l = this.lastSent;
    const changed = Math.abs(l.x - x) > 0.01 || Math.abs(l.z - z) > 0.01 || Math.abs(l.ry - ry) > 0.05 || l.anim !== anim;
    if (!force && (!changed || (now - l.at < 66 && l.anim === anim))) return;
    if (!this.socket.connected) return;
    Object.assign(l, { x, z, ry, anim, at: now });
    this.socket.emit('move', x, z, ry, anim);
  }

  chat(text: string, target: ChatTarget): void {
    this.socket.emit('chat', text, target.scope, target.to);
  }

  emote(emoji: string): void {
    this.socket.emit('emote', emoji);
  }

  updateProfile(patch: PlayerPatch): void {
    const st = getState();
    const me = { ...st.me };
    if (patch.name !== undefined) me.name = patch.name;
    if (patch.avatar) me.avatar = patch.avatar;
    if (patch.status) me.status = patch.status;
    setState({ me });
    saveProfile({ name: me.name, avatar: me.avatar });
    this.socket.emit('profile', patch);
  }

  private onMediaChange(): void {
    setState({
      media: { mic: media.micOn, cam: media.camOn, screen: media.screenOn, version: media.version, error: media.error },
    });
    if (media.error) toast(media.error, 'error');
    media.error = null;
    this.speaking.watch('self', media.micOn ? media.audioTrack : null);
    if (this.socket.connected) {
      this.socket.emit('profile', { mic: media.micOn, cam: media.camOn || media.screenOn, screen: media.screenOn });
    }
  }

  private onStream(id: string, stream: MediaStream | null): void {
    setState((st) => {
      const streams = { ...st.streams };
      if (stream) streams[id] = stream;
      else delete streams[id];
      return { streams };
    });
    let el = this.audio.get(id);
    if (!stream) {
      if (el) {
        el.srcObject = null;
        el.remove();
        this.audio.delete(id);
      }
      this.speaking.unwatch(id);
      return;
    }
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      this.audioRoot.appendChild(el);
      this.audio.set(id, el);
      this.applySink(el);
    }
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    const current = (el.srcObject as MediaStream | null)?.getAudioTracks()[0] ?? null;
    if (current !== audioTrack) {
      el.srcObject = audioTrack ? new MediaStream([audioTrack]) : null;
      void el.play().catch(() => {});
    }
    this.speaking.watch(id, audioTrack);
  }

  private applySink(el: HTMLAudioElement): void {
    const sink = media.audioOutputId;
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (sink && withSink.setSinkId) withSink.setSinkId(sink).catch(() => {});
  }

  refreshAudioOutput(): void {
    for (const el of this.audio.values()) this.applySink(el);
  }

  /** Remote audio gets quieter with distance (and silent across private-zone walls). */
  private updateVolumes(): void {
    const zones = getState().office?.zones ?? [];
    for (const [id, el] of this.audio) {
      const t = remoteTargets.get(id);
      const v = t ? proximityVolume(local, t, zones) : 0;
      if (Math.abs(el.volume - v) > 0.01) el.volume = v;
    }
  }

  private dropAllPeers(): void {
    for (const id of Object.keys(getState().linked)) this.peers?.disconnect(id);
    setState({ linked: {}, streams: {}, spotlight: null });
  }

  /** Jump next to someone. */
  goTo(id: string): void {
    const t = remoteTargets.get(id);
    const office = getState().office;
    if (!t || !office) return;
    const spot = findFreeSpot(t.x + Math.sin(t.ry) * 1.2, t.z + Math.cos(t.ry) * 1.2, buildColliders(office), office.settings);
    local.x = spot.x;
    local.z = spot.z;
    local.seat = local.path = local.pathSeat = null;
    local.ry = Math.atan2(t.x - spot.x, t.z - spot.z);
    local.anim = 'idle';
    this.sendMove(local.x, local.z, local.ry, local.anim, true);
  }

  leave(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.radio.stop();
    this.spotify.close();
    for (const u of this.unsubs) u();
    this.peers?.close();
    this.speaking.close();
    for (const el of this.audio.values()) el.srcObject = null;
    this.audio.clear();
    this.audioRoot.remove();
    this.socket.removeAllListeners();
    this.socket.disconnect();
    remoteTargets.clear();
  }
}

let current: OfficeSession | null = null;

export function getSession(): OfficeSession | null {
  return current;
}

// Read-only hook for automated tests and debugging in the browser console.
(window as unknown as { __workchop?: unknown }).__workchop = { music: () => current?.debugMusic() ?? null };

export async function enterOffice(officeId: string): Promise<void> {
  current?.leave();
  current = new OfficeSession(officeId);
  try {
    await current.join();
  } catch (err) {
    current.leave();
    current = null;
    throw err;
  }
}

export function leaveOffice(): void {
  current?.leave();
  current = null;
  media.stopAll();
  setState({
    phase: 'landing',
    officeId: null,
    office: null,
    players: {},
    linked: {},
    streams: {},
    speaking: {},
    chat: [],
    unread: 0,
    emotes: {},
    panel: 'none',
    modal: 'none',
    mode: 'play',
    build: initialBuild,
    spotlight: null,
    selfId: null,
  });
}
