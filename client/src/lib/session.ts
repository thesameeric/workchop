import { io, type Socket } from 'socket.io-client';
import { buildColliders, findFreeSpot, isBlocked, proximityVolume } from '../../../shared/geometry';
import { applyOp } from '../../../shared/office';
import { wellFormed } from '../../../shared/text';
import type {
  AnimState,
  ClientToServerEvents,
  JoinRequest,
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
import { accountUpdated, followAccount, saveCharacter } from './account';
import { fetchConfig } from './api';
import { serverNow, syncClock } from './clock';
import { LoungeRadio } from './radio';
import { SpotifyListenAlong } from './spotify';
import { SpeakingDetector } from './levels';
import { media } from './media';
import { PeerManager } from './peers';
import { local, remoteTargets, setRemoteTarget } from './positions';
import { goHome } from './router';
import { browserId, forgetGuestToken, getGuestToken, getOwnerKey, randomSecret } from './storage';
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

/** How long a join may go unanswered before it counts as failed. */
const JOIN_TIMEOUT_MS = 15_000;
/** The longest wait between tries to get back in after a rejoin failed. */
const MAX_REJOIN_DELAY_MS = 15_000;
/** Unanswered first joins before giving up (the server may still be starting: up to a minute on Cloudflare). */
const FIRST_JOIN_TRIES = 4;
/** Where you are is sent again this long after the last time (when nothing changed), for anyone who missed it. */
export const KEYFRAME_MS = 5_000;

type Refusal = Extract<JoinResponse, { ok: false }>;

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
  /** Sent with every join of this visit: a rejoin replaces our earlier connection if the server still has it. */
  private readonly resume = randomSecret();
  /**
   * Whether the next join may take you out of your other tab (or device) in this office: a page's
   * first join and Use here do; coming back by itself (after a dropped connection, or after signing
   * in or out in another tab) doesn't, so two tabs never take turns.
   */
  private takeover = true;
  /** You came into this office in another tab or on another device: this one stepped aside until Use here. */
  private parked = false;
  /** The mic and camera as they were when this tab stepped aside, for Use here. */
  private parkedMedia = { mic: false, cam: false };
  /** The music started (after the first join); it stops while this tab steps aside. */
  private musicStarted = false;
  /** Counts joins sent (and connections dropped): an answer to an older join is ignored. */
  private joinTry = 0;
  private firstJoinTimeouts = 0;
  /** Rejoins refused or unanswered in a row. */
  private joinFailures = 0;
  private joinRetry: ReturnType<typeof setTimeout> | undefined;
  private onFirstJoin: ((res: JoinResponse) => void) | null = null;
  /** Our own player ids on earlier connections: never anyone to see or call. */
  private pastIds = new Set<string>();
  private joinedHandlers = new Set<(rejoin: boolean) => void>();
  private leaveHandlers = new Set<() => void>();
  /** Heard at full volume wherever they are (a support agent, their customer and colleagues helping). */
  private fullVolume = new Set<string>();
  private uploadMaxBytes: number | undefined;
  private closed = false;
  /** You're leaving the workspace yourself: being removed from it needs no message. */
  leaving = false;
  readonly radio = new LoungeRadio((itemId, durations) => this.music({ t: 'track:durations', itemId, durations }));
  readonly spotify = new SpotifyListenAlong((itemId, update, start) => this.socket.emit('spotify:session', itemId, update, start));
  private spotifyClientId: string | null = null;

  constructor(readonly officeId: string) {
    // Socket.IO tries again by itself after a dropped connection; at most 3 s apart.
    this.socket = io({ autoConnect: false, reconnectionDelayMax: 3000 });
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
      relink: (id, sid) => this.socket.emit('rtc:relink', id, sid),
    });
    if (turn) this.scheduleIceRefresh(iceTtl);
    // On Cloudflare Containers the server stops some minutes after its last ordinary request, and
    // realtime traffic doesn't count: check in now and then so it keeps running while people are here.
    this.timers.push(setInterval(() => void fetch('/api/health', { cache: 'no-store' }).catch(() => {}), 4 * 60_000));
    this.unsubs.push(media.subscribe(() => this.onMediaChange()));
    this.onMediaChange();
    this.timers.push(setInterval(() => this.updateVolumes(), 120));
    this.timers.push(setInterval(() => this.keyframe(), 1000));
    window.addEventListener('online', this.onOnline);

    await new Promise<void>((resolve, reject) => {
      this.onFirstJoin = (res: JoinResponse) => {
        if (res.ok) resolve();
        else reject(new JoinRefused(res.error, res.reason === 'elsewhere' ? null : (res.reason ?? null)));
      };
      this.socket.on('connect', () => this.sendJoin());
      this.socket.on('connect_error', () => {
        if (!this.hasJoined) reject(new Error('Could not reach the server.'));
      });
      this.socket.connect();
    });
  }

  /** Joins (again, after a reconnect) on the current connection. */
  private sendJoin(): void {
    clearTimeout(this.joinRetry);
    if (this.closed || this.parked || !this.socket.connected) return;
    const attempt = ++this.joinTry;
    const { me } = getState();
    const req: JoinRequest = {
      officeId: this.officeId,
      name: me.name,
      avatar: me.avatar,
      status: me.status,
      ownerKey: getOwnerKey(this.officeId),
      guest: getGuestToken(this.officeId),
      mic: media.micOn,
      cam: media.camOn || media.screenOn,
      resume: this.resume,
      browser: browserId(),
    };
    // Back after a dropped connection: where you are, not at the entrance.
    if (this.hasJoined) req.at = { x: local.x, z: local.z, ry: local.ry, anim: local.anim };
    // Coming back by itself: while you're here in another tab, this one steps aside.
    if (this.hasJoined && !this.takeover) req.rejoin = true;
    this.socket.timeout(JOIN_TIMEOUT_MS).emit('join', req, (err, res) => {
      // Answers to an older join (or on a connection that has since dropped) don't count.
      if (attempt !== this.joinTry || this.closed) return;
      if (err) this.joinFailed({ ok: false, error: 'The server didn’t answer.' }, true);
      else if (!res.ok) this.joinFailed(res, false);
      else this.joinedOk(res);
    });
  }

  /** A join was refused, or went unanswered. */
  private joinFailed(res: Refusal, timedOut: boolean): void {
    if (res.reason === 'link') forgetGuestToken(this.officeId);
    if (!this.hasJoined) {
      if (timedOut && ++this.firstJoinTimeouts < FIRST_JOIN_TRIES) {
        this.sendJoin();
        return;
      }
      this.onFirstJoin?.(res);
      return;
    }
    // You're here in another tab now: this one steps aside (and doesn't try again by itself).
    if (res.reason === 'elsewhere') {
      this.park();
      return;
    }
    // Let in no longer (say, removed or the guest link reset while away): the lobby says why.
    if (res.reason) {
      toast(res.error, 'error');
      backToLobby();
      return;
    }
    // Anything else passes (the office full for now, the server busy or just restarted): try again in
    // a moment, with the reason on the connection banner meanwhile.
    this.joinFailures++;
    setState({ connection: 'reconnecting', connectionNote: res.error });
    if (timedOut && this.joinFailures % 3 === 0) {
      // A connection that answers nothing: start a new one (which joins when it's up).
      this.socket.disconnect();
      this.socket.connect();
      return;
    }
    const delay = Math.min(MAX_REJOIN_DELAY_MS, 1000 * 2 ** (this.joinFailures - 1)) * (0.75 + Math.random() * 0.5);
    this.joinRetry = setTimeout(() => {
      if (!this.joined) this.sendJoin();
    }, delay);
  }

  private joinedOk(res: Extract<JoinResponse, { ok: true }>): void {
    const rejoin = this.hasJoined;
    this.hasJoined = true;
    this.takeover = false;
    this.joinFailures = 0;
    this.joined = { selfId: res.selfId, uploadKey: res.uploadKey };
    remoteTargets.clear();
    const players: Record<string, RemotePlayer> = {};
    for (const p of res.players) {
      if (p.id === res.selfId || this.pastIds.has(p.id)) continue;
      players[p.id] = toRemote(p);
      setRemoteTarget(p.id, p.x, p.z, p.ry, p.anim);
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
      elsewhere: false,
      connection: 'online',
      connectionNote: null,
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
      this.onFirstJoin?.(res);
    }
    for (const handler of this.joinedHandlers) guard(() => handler(rejoin));
  }

  /**
   * Connects again, so the server sees who is signed in now (the session cookie goes with each new
   * connection): after signing in you rejoin as your account, as after any reconnect. With
   * `takeover` (signed in in this tab) your other tab in this office steps aside; without (signed
   * in or out in another tab), this one does if you're there. Nothing while this tab stepped aside.
   */
  reconnect(takeover = false): void {
    if (this.closed || this.parked) return;
    this.takeover = takeover;
    this.socket.disconnect();
    this.socket.connect();
  }

  /** Whether this tab stepped aside for another (see useHere). */
  isParked(): boolean {
    return this.parked;
  }

  /**
   * You came into this office in another tab or on another device: this one steps aside. It leaves
   * the office (calls, music, mic and camera off, so the other tab can have them) and stays out until
   * Use here; what features know is kept, as after a long dropped connection.
   */
  private park(): void {
    if (this.parked || this.closed) return;
    this.parked = true;
    this.joinTry++;
    clearTimeout(this.joinRetry);
    if (this.joined) this.pastIds.add(this.joined.selfId);
    this.joined = null;
    this.dropAllPeers();
    remoteTargets.clear();
    this.parkedMedia = { mic: media.micOn, cam: media.camOn };
    media.stopAll();
    this.radio.stop();
    setState({
      elsewhere: true,
      connection: 'online',
      connectionNote: null,
      selfId: null,
      players: {},
      linked: {},
      streams: {},
      speaking: {},
      spotlight: null,
      spotifySessions: {},
      mode: 'play',
    });
    // Socket.IO doesn't connect again by itself after this.
    this.socket.disconnect();
  }

  /** Use here (from a click): back into the office in this tab, and your other one steps aside. */
  async useHere(): Promise<void> {
    if (!this.parked || this.closed) return;
    this.parked = false;
    this.takeover = true;
    const { mic, cam } = this.parkedMedia;
    if (mic || cam) await media.start(mic, cam);
    if (this.closed) return;
    if (this.musicStarted) this.radio.start();
    // Joins where you were once connected (see sendJoin).
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
    this.musicStarted = true;
    if (!this.parked) this.radio.start();
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

  /** The calls and their WebRTC state, for debugging. */
  peerStats() {
    return this.peers?.stats() ?? [];
  }

  /**
   * Back online (the network changed): connect again at once rather than after Socket.IO's wait, and
   * have every call look for its new way through.
   */
  private onOnline = (): void => {
    if (this.closed || this.parked) return;
    if (this.socket.connected) {
      this.peers?.restartAll();
    } else {
      this.socket.disconnect();
      this.socket.connect();
    }
  };

  /** For tests and debugging. */
  debugMusic() {
    return { serverNow: serverNow(), at: { x: local.x, z: local.z }, radio: this.radio.debug(), spotify: getState().spotify };
  }

  private wireSocket(): void {
    const s = this.socket;
    s.on('disconnect', (reason) => {
      if (this.closed || this.parked) return;
      // Answers to joins sent on that connection no longer count: the next connection joins anew.
      this.joinTry++;
      clearTimeout(this.joinRetry);
      if (this.joined) this.pastIds.add(this.joined.selfId);
      this.joined = null;
      setState({ connection: 'reconnecting' });
      // Every call comes back on the new connection, with new links (our player id changes).
      this.dropAllPeers();
      // The server ends a session's connections when it ends (signed out in another tab or from
      // another device, or expired): signed out now, back to the lobby; otherwise (still or newly
      // signed in) back in as who you are.
      if (reason === 'io server disconnect') {
        void followAccount().then(() => {
          if (!this.closed && !this.parked && !s.active) s.connect();
        });
      }
    });
    s.on('player:joined', (p) => {
      if (this.pastIds.has(p.id)) return;
      setRemoteTarget(p.id, p.x, p.z, p.ry, p.anim);
      setState((st) => ({ players: { ...st.players, [p.id]: toRemote(p) } }));
      if (announceVisits()) toast(`${p.name} joined`);
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
      if (name && announceVisits()) toast(`${name} left`);
    });
    s.on('player:moved', ([id, x, z, ry, anim]) => setRemoteTarget(id, x, z, ry, anim));
    s.on('player:updated', (id, patch) => {
      if (id === getState().selfId) return;
      setState((st) => (st.players[id] ? { players: { ...st.players, [id]: { ...st.players[id], ...patch } } } : {}));
    });
    s.on('peer:connect', (id, sid, initiator) => {
      // Our own earlier connection, still in the office for a moment: nobody to call.
      if (this.pastIds.has(id)) return;
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
      // You came in in another tab or on another device: this one steps aside.
      if (reason === 'elsewhere') {
        this.park();
        return;
      }
      const name = getState().office?.settings.name || 'this office';
      // A support customer there a long while without a question: back to the lobby, to ask one.
      if (reason === 'idle') {
        backToLobby();
        toast(`You were in ${name} a while without a question. Come back in when you have one.`);
        return;
      }
      // Its plan lapsed: back to the lobby, which says it's closed. Only members are told why.
      if (reason === 'locked') {
        const { role } = getState();
        const member = !!role && role !== 'guest';
        backToLobby();
        toast(member ? `${name} is paused until its owner pays for it.` : `${name} isn’t open right now.`, 'error');
        return;
      }
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
    if (!this.socket.connected || !this.joined) return;
    Object.assign(l, { x, z, ry, anim, at: now });
    this.socket.emit('move', x, z, ry, anim);
  }

  /**
   * Sends where you are again when nothing was sent for KEYFRAME_MS, so anyone who missed a move
   * (sitting down, stopping) catches up. Runs on a timer, so it also works in a tab in the background.
   */
  private keyframe(): void {
    const l = this.lastSent;
    if (performance.now() - l.at < KEYFRAME_MS) return;
    // Still "walking" without having moved since (a tab in the background stops mid-step) is standing.
    const still = Math.abs(l.x - local.x) <= 0.01 && Math.abs(l.z - local.z) <= 0.01;
    this.sendMove(local.x, local.z, local.ry, local.anim === 'walk' && still ? 'idle' : local.anim, true);
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
   * Hear these people (player ids) at full volume wherever they are, or nobody ([]): a support agent,
   * the customer they're serving and the colleagues helping, who are linked from across the office.
   */
  setFullVolume(playerIds: string[]): void {
    this.fullVolume = new Set(playerIds);
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
      const v = this.fullVolume.has(id) ? 1 : t ? proximityVolume(local, t, zones) : 0;
      if (Math.abs(el.volume - v) > 0.01) el.volume = v;
      if (el.muted !== st.focus) el.muted = st.focus;
    }
  }

  private dropAllPeers(): void {
    this.peers?.dropAll();
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
    clearTimeout(this.joinRetry);
    window.removeEventListener('online', this.onOnline);
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

/** Who comes and goes is news in a team's office, not in a support workspace's lobby. */
const announceVisits = () => getState().kind !== 'support';

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
    elsewhere: false,
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
