import { io, type Socket } from 'socket.io-client';
import { buildColliders, findFreeSpot, isBlocked, proximityVolume } from '../../../shared/geometry';
import { applyOp } from '../../../shared/office';
import { wellFormed } from '../../../shared/text';
import type {
  AnimState,
  ClientToServerEvents,
  JoinResponse,
  OfficeOp,
  PlayerState,
  ProfilePatch,
  ServerToClientEvents,
} from '../../../shared/types';
import type { UploadedFile } from '../../../shared/uploads';
import type { AccessDenied, Role } from '../../../shared/workspace';
import { canBuild, getState, initialBuild, personalMusicVolume, setState, toast, type RemotePlayer } from '../state/store';
import { audibleJukebox, musicVolumeAt, type MusicLink, type MusicOp } from '../../../shared/music';
import { accountUpdated, refreshAccount, saveCharacter } from './account';
import { fetchConfig } from './api';
import { serverNow, syncClock } from './clock';
import { LoungeRadio } from './radio';
import { SpotifyListenAlong } from './spotify';
import { SpeakingDetector } from './levels';
import { media } from './media';
import { PeerManager } from './peers';
import { local, remoteTargets } from './positions';
import { goHome } from './router';
import { forgetGuestToken, getGuestToken, getOwnerKey } from './storage';
import { postFile, type UploadOptions } from './upload';

/** The office connection, typed with every event (features add theirs to the shared event maps). */
export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function toRemote(p: PlayerState): RemotePlayer {
  const { x: _x, z: _z, ry: _ry, anim: _anim, ...rest } = p;
  return rest;
}

/** The server didn't let you in; `reason` says why when it's about access (sign in, members only, an old guest link). */
export class JoinRefused extends Error {
  constructor(
    message: string,
    readonly reason: AccessDenied | null,
  ) {
    super(message);
  }
}

const ROLE_NAMES: Record<Role, string> = { owner: 'the owner', admin: 'an admin', member: 'a member', guest: 'a guest' };

/** Everything that happens while you're inside an office: socket, calls, audio. */
export class OfficeSession {
  /** Created before connecting; add `socket.on(…)` handlers from an onSession hook. */
  readonly socket: AppSocket;
  private peers: PeerManager | null = null;
  private speaking = new SpeakingDetector((id, on) =>
    setState((s) => ({ speaking: { ...s.speaking, [id]: on } })),
  );
  private audio = new Map<string, HTMLAudioElement>();
  private audioRoot: HTMLDivElement;
  private timers: ReturnType<typeof setInterval>[] = [];
  private iceTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubs: (() => void)[] = [];
  private lastSent = { x: NaN, z: NaN, ry: NaN, anim: 'idle' as AnimState, at: 0 };
  private hasJoined = false;
  /** The current connection's id and upload key, while joined. */
  private joined: { selfId: string; uploadKey: string } | null = null;
  private joinedHandlers = new Set<(rejoin: boolean) => void>();
  private leaveHandlers = new Set<() => void>();
  private uploadMaxBytes: number | undefined;
  private closed = false;
  /** You're leaving the workspace yourself: being removed from it needs no message. */
  leaving = false;
  readonly radio = new LoungeRadio((itemId, durations) => this.music({ t: 'track:durations', itemId, durations }));
  readonly spotify = new SpotifyListenAlong((itemId, update, start) => this.socket.emit('spotify:session', itemId, update, start));
  private spotifyClientId: string | null = null;

  constructor(readonly officeId: string) {
    this.socket = io({ autoConnect: false });
    // The app's own handlers come first, so features' handlers for the same event see its effect.
    this.wireSocket();
    this.audioRoot = document.createElement('div');
    this.audioRoot.hidden = true;
    document.body.appendChild(this.audioRoot);
  }

  async join(): Promise<void> {
    const { iceServers, iceTtl, turn, spotifyClientId, uploadMaxBytes } = await fetchConfig();
    this.spotifyClientId = spotifyClientId;
    this.uploadMaxBytes = uploadMaxBytes;
    this.peers = new PeerManager(media, iceServers, {
      send: (to, sid, data) => this.socket.emit('rtc:signal', to, sid, data),
      stream: (id, stream) => this.onStream(id, stream),
    });
    if (turn) this.scheduleIceRefresh(iceTtl);
    // On Cloudflare Containers the server stops some minutes after its last ordinary request, and
    // realtime traffic doesn't count: check in now and then so it keeps running while people are here.
    this.timers.push(setInterval(() => void fetch('/api/health', { cache: 'no-store' }).catch(() => {}), 4 * 60_000));
    this.unsubs.push(media.subscribe(() => this.onMediaChange()));
    this.onMediaChange();
    this.timers.push(setInterval(() => this.updateVolumes(), 120));

    await new Promise<void>((resolve, reject) => {
      const onFirst = (res: JoinResponse) => {
        if (res.ok) resolve();
        else reject(new JoinRefused(res.error, res.reason ?? null));
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
        guest: getGuestToken(this.officeId),
        mic: media.micOn,
        cam: media.camOn || media.screenOn,
      },
      (res) => {
        if (!res.ok) {
          if (res.reason === 'link') forgetGuestToken(this.officeId);
          if (!this.hasJoined) onFirst(res);
          else toast(res.error, 'error');
          // Let in no longer (say, removed or the guest link reset while away): the lobby says why.
          if (this.hasJoined && res.reason) backToLobby();
          return;
        }
        const rejoin = this.hasJoined;
        this.hasJoined = true;
        this.joined = { selfId: res.selfId, uploadKey: res.uploadKey };
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
          role: res.role,
          kind: res.kind,
          guests: res.guests,
          office: res.office,
          players,
          linked: {},
          streams: {},
          spotifySessions: Object.fromEntries(res.spotify.map((s) => [s.itemId, s])),
        });
        const synced = syncClock(() => this.socket.timeout(5000).emitWithAck('time'));
        if (rejoin) {
          this.lastSent.at = 0;
          this.sendMove(local.x, local.z, local.ry, local.anim, true);
          this.socket.emit('profile', { screen: media.screenOn });
          this.spotify.rejoined();
        } else {
          // Music waits for the clock, so it starts in step with everyone else.
          void synced.then(() => !this.closed && this.startMusic());
          onFirst(res);
        }
        for (const handler of this.joinedHandlers) guard(() => handler(rejoin));
      },
    );
  }

  /**
   * Connects again, so the server sees who is signed in now (the session cookie goes with each new
   * connection): after signing in here you rejoin as your account, as after any reconnect.
   */
  reconnect(): void {
    if (this.closed) return;
    this.socket.disconnect();
    this.socket.connect();
  }

  /** Your player id in the office (the socket id), while joined; it changes when you reconnect. */
  selfId(): string | null {
    return this.joined?.selfId ?? null;
  }

  /**
   * Runs `handler` after every successful join: the first one, and each rejoin after a reconnect
   * (the server then has a fresh player for you, so resend anything it should know). Added while
   * already in the office, it also runs right away (with `false`). Returns an unsubscribe function.
   */
  onJoined(handler: (rejoin: boolean) => void): () => void {
    this.joinedHandlers.add(handler);
    if (this.joined) guard(() => handler(false));
    return () => void this.joinedHandlers.delete(handler);
  }

  /** Runs `handler` when you leave the office (before the socket closes). Returns an unsubscribe function. */
  onLeave(handler: () => void): () => void {
    this.leaveHandlers.add(handler);
    return () => void this.leaveHandlers.delete(handler);
  }

  /**
   * Uploads a file into this office (POST /api/offices/:id/uploads) and returns the server's answer:
   * `{ id, url, name, contentType, size }`, where `url` downloads it. Throws an Error with a message
   * to show ("File too large (max 10 MB)", "Join the office before uploading files."…); with
   * `signal` aborted it rejects with an AbortError.
   */
  upload(file: Blob, opts: UploadOptions = {}): Promise<UploadedFile> {
    const joined = this.joined;
    if (!joined) return Promise.reject(new Error('Not connected to the office right now. Please try again in a moment.'));
    const name = wellFormed(opts.name ?? (file instanceof File ? file.name : 'file'));
    const headers = { 'X-Workchop-Socket': joined.selfId, 'X-Workchop-Upload-Key': joined.uploadKey, 'X-Filename': encodeURIComponent(name) };
    return postFile(`/api/offices/${encodeURIComponent(this.officeId)}/uploads`, file, headers, { ...opts, maxBytes: this.uploadMaxBytes });
  }

  private startMusic(): void {
    this.radio.start();
    this.spotify.configure(this.spotifyClientId);
    // Keep Spotify listen-along in step with the session at the jukebox we can hear.
    this.timers.push(
      setInterval(() => {
        const st = getState();
        if (!st.office) return;
        const personal = personalMusicVolume(st);
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

  debugDropConnection(): void {
    this.socket.io.engine?.close();
  }

  /** For tests and debugging. */
  debugMusic() {
    return { serverNow: serverNow(), at: { x: local.x, z: local.z }, radio: this.radio.debug(), spotify: getState().spotify };
  }

  private wireSocket(): void {
    const s = this.socket;
    s.on('disconnect', (reason) => {
      if (this.closed) return;
      this.joined = null;
      setState({ connection: 'reconnecting' });
      this.dropAllPeers();
      // The server ends a session's connections when it signs out (in another tab): stay, as a guest.
      if (reason === 'io server disconnect') {
        void refreshAccount();
        s.connect();
      }
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
    s.on('account:updated', (user) => accountUpdated(user));
    s.on('office:role', (role, guests) => {
      const before = getState().role;
      // As the server has it: owner rights go with the role from now on.
      setState({ role, guests, isOwner: role === 'owner' });
      // Out of build mode if you may no longer edit.
      this.setOffice(getState().office);
      if (role !== before) toast(`You’re now ${ROLE_NAMES[role]} here.`);
    });
    s.on('office:removed', (reason) => {
      if (this.leaving) return;
      const name = getState().office?.settings.name || 'this office';
      leaveOffice();
      toast(reason === 'guests-off' ? `Guests can no longer come into ${name}.` : `You were removed from ${name}.`, 'error');
    });
    s.on('spotify:session', (itemId, session) => {
      setState((st) => {
        const spotifySessions = { ...st.spotifySessions };
        if (session) spotifySessions[itemId] = session;
        else delete spotifySessions[itemId];
        return { spotifySessions };
      });
    });
  }

  private setOffice(office: ReturnType<typeof getState>['office']): void {
    if (!office) return;
    setState((st) => {
      const build = { ...st.build };
      if (build.selectedId && !office.items.some((i) => i.id === build.selectedId)) build.selectedId = null;
      if (build.selectedZoneId && !office.zones.some((z) => z.id === build.selectedZoneId)) build.selectedZoneId = null;
      return canBuild({ ...st, office }) ? { office, build } : { office, build: initialBuild, mode: 'play', panel: st.panel === 'build' ? 'none' : st.panel };
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

  emote(emoji: string): void {
    this.socket.emit('emote', emoji);
  }

  /** Changes you for everyone in the office; your name, character and status are also saved. */
  updateProfile(patch: ProfilePatch): void {
    const st = getState();
    const me = { ...st.me };
    if (patch.name !== undefined) me.name = patch.name;
    if (patch.avatar) me.avatar = patch.avatar;
    if (patch.status) me.status = patch.status;
    setState({ me });
    if (patch.name !== undefined || patch.avatar || patch.status) void saveCharacter({ name: patch.name, avatar: patch.avatar, status: patch.status });
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
      el.muted = getState().focus;
      this.audioRoot.appendChild(el);
      this.audio.set(id, el);
      this.applySink(el);
    }
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    const current = (el.srcObject as MediaStream | null)?.getAudioTracks()[0] ?? null;
    if (current !== audioTrack) {
      el.srcObject = audioTrack ? new MediaStream([audioTrack]) : null;
      void el.play().catch(this.playFailed);
    }
    this.speaking.watch(id, audioTrack);
  }

  /** The browser wants a click before playing sound (you came straight in, without the lobby's). */
  private playFailed = (err: unknown) => {
    if ((err as { name?: string })?.name !== 'NotAllowedError' || this.closed) return;
    setState({ audioBlocked: true });
    // Any click or key press lets it play.
    window.addEventListener('pointerdown', this.unblockAudio, true);
    window.addEventListener('keydown', this.unblockAudio, true);
  };

  /** Plays people's voices again after the browser blocked them; call it from a click. */
  readonly unblockAudio = (): void => {
    window.removeEventListener('pointerdown', this.unblockAudio, true);
    window.removeEventListener('keydown', this.unblockAudio, true);
    setState({ audioBlocked: false });
    for (const el of this.audio.values()) if (el.srcObject) void el.play().catch(this.playFailed);
  };

  private applySink(el: HTMLAudioElement): void {
    const sink = media.audioOutputId;
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (sink && withSink.setSinkId) withSink.setSinkId(sink).catch(() => {});
  }

  refreshAudioOutput(): void {
    for (const el of this.audio.values()) this.applySink(el);
  }

  /**
   * Remote audio gets quieter with distance (and silent across private-zone walls). Headphones mute
   * it (iOS ignores volume, and the calls stay up so taking them off brings everyone back at once).
   */
  private updateVolumes(): void {
    const st = getState();
    const zones = st.office?.zones ?? [];
    for (const [id, el] of this.audio) {
      const t = remoteTargets.get(id);
      const v = t ? proximityVolume(local, t, zones) : 0;
      if (Math.abs(el.volume - v) > 0.01) el.volume = v;
      if (el.muted !== st.focus) el.muted = st.focus;
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

  /**
   * Short-lived TURN credentials (Cloudflare TURN): fetch fresh ones well before they expire, as
   * offices often stay open all day. Without any (the TURN service didn't answer), try again soon.
   */
  private scheduleIceRefresh(ttl: number | undefined, failures = 0): void {
    const delay = ttl ? ttl * 800 : Math.min(60_000 * 2 ** failures, 15 * 60_000);
    this.iceTimer = setTimeout(async () => {
      const cfg = await fetchConfig();
      if (this.closed) return;
      if (cfg.iceTtl) {
        this.peers?.setIceServers(cfg.iceServers);
        this.scheduleIceRefresh(cfg.iceTtl);
      } else {
        this.scheduleIceRefresh(undefined, failures + 1);
      }
    }, Math.max(delay, 30_000));
  }

  leave(): void {
    this.closed = true;
    window.removeEventListener('pointerdown', this.unblockAudio, true);
    window.removeEventListener('keydown', this.unblockAudio, true);
    const leaving = [...this.leaveHandlers];
    this.leaveHandlers.clear();
    for (const handler of leaving) guard(handler);
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.iceTimer);
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

/** Runs a feature's callback; one that throws is logged and doesn't break the others. */
function guard(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[session] a feature handler failed:', err);
  }
}

let current: OfficeSession | null = null;

export function getSession(): OfficeSession | null {
  return current;
}

/**
 * What a feature does with each office session. It may return a cleanup, which runs when you leave,
 * or on the spot when the hook is replaced (a hot reload) or unregistered while you're in an office.
 */
export type SessionHook = (session: OfficeSession) => void | (() => void);
const sessionHooks = new Map<string, SessionHook>();
/** The cleanups of the hooks that ran for the current session, by hook id. */
const cleanups = new Map<string, () => void>();

function runHook(session: OfficeSession, id: string, hook: SessionHook): void {
  guard(() => {
    const cleanup = hook(session);
    if (typeof cleanup === 'function') cleanups.set(id, cleanup);
  });
}

function stopHook(id: string): void {
  const cleanup = cleanups.get(id);
  cleanups.delete(id);
  if (cleanup) guard(cleanup);
}

/**
 * Runs `hook` for every office session as it is created: its socket exists but isn't connected yet,
 * so handlers added with `session.socket.on(…)` see everything from the join on. Use
 * `session.onJoined` to act once in the office. Registering an `id` again replaces that hook (the
 * old one's cleanup runs first, so undo there what it added, e.g. with `socket.off`). Returns a
 * function that unregisters the hook.
 */
export function onSession(id: string, hook: SessionHook): () => void {
  stopHook(id);
  sessionHooks.set(id, hook);
  if (current) runHook(current, id, hook);
  return () => {
    if (sessionHooks.get(id) !== hook) return;
    sessionHooks.delete(id);
    stopHook(id);
  };
}

// For automated tests and debugging in the browser console.
(window as unknown as { __workchop?: unknown }).__workchop = {
  music: () => current?.debugMusic() ?? null,
  /** Simulate a dropped connection (it reconnects by itself), for testing. */
  dropConnection: () => current?.debugDropConnection(),
  session: () => current,
};

export async function enterOffice(officeId: string): Promise<void> {
  current?.leave();
  const session = (current = new OfficeSession(officeId));
  session.onLeave(() => [...cleanups.keys()].forEach(stopHook));
  for (const [id, hook] of sessionHooks) runHook(session, id, hook);
  try {
    await session.join();
  } catch (err) {
    session.leave();
    if (current === session) current = null;
    throw err;
  }
}

/** Ends the office session (on the way to another page; the caller goes there). */
export function closeOffice(): void {
  current?.leave();
  current = null;
  media.stopAll();
  setState({
    phase: 'landing',
    officeId: null,
    office: null,
    role: null,
    players: {},
    linked: {},
    streams: {},
    speaking: {},
    audioBlocked: false,
    chatWith: null,
    focus: false,
    emotes: {},
    panel: 'none',
    modal: 'none',
    mode: 'play',
    build: initialBuild,
    spotlight: null,
    selfId: null,
  });
}

/** "Leave office": home, where you stay (it no longer goes on to your default workspace in this tab). */
export function leaveOffice(): void {
  closeOffice();
  goHome();
}

/** Back to this office's lobby: to sign in, or to come in again as who you are now. */
export function backToLobby(): void {
  const { officeId } = getState();
  closeOffice();
  if (officeId) setState({ phase: 'lobby', officeId });
}
