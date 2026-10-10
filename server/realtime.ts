import crypto from 'node:crypto';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import type { AccountUser } from '../shared/account';
import { isEmote, sanitizeAvatar, sanitizeName, sanitizeProfile, sanitizeStatus } from '../shared/avatar';
import { getEntry } from '../shared/catalog';
import { buildColliders, findFreeSpot } from '../shared/geometry';
import { isJukebox, sanitizeSessionUpdate, type MusicLink, type SpotifySession } from '../shared/music';
import { applyOp, OpError } from '../shared/office';
import type {
  AnimState,
  ClientToServerEvents,
  JoinRequest,
  JoinResponse,
  Office,
  OfficeOp,
  PlayerPatch,
  PlayerState,
  ServerToClientEvents,
  Spot,
} from '../shared/types';
import { isCustomer, may, type GuestAccess, type MemberRole, type RemovedReason, type Role } from '../shared/workspace';
import type { Accounts } from './accounts';
import { applyMusicOp, fetchLinkMeta } from './music';
import type { OfficeStore } from './officeStore';
import { type LinkChanges, type LinkRule, Room } from './room';
import { deniedMessage, refusal, welcomesGuests, type Admission, type Workspaces } from './workspaces';

export const MAX_PLAYERS_PER_ROOM = 100;
/**
 * Guests take at most this many of an office's places, so its members can always come in (fewer when
 * the workspace policy says so: billing's Free plan).
 */
export const MAX_GUESTS_PER_ROOM = 90;
const ANIMS: AnimState[] = ['idle', 'walk', 'sit'];
/**
 * How often the server checks that each connection is alive, and how long it waits for the answer.
 * A connection that went quiet (a laptop closed, a network gone) is noticed by both sides within
 * about 20 s: its player leaves, and the page connects again by itself.
 */
export const PING_INTERVAL_MS = 10_000;
export const PING_TIMEOUT_MS = 10_000;
/** JoinRequest.resume (a page's secret for its visit) and JoinRequest.browser (its browser's). */
const RESUME = /^[A-Za-z0-9_-]{22,128}$/;
/** What customers (guests of a support workspace) are called until they open a ticket. */
export const CUSTOMER_NAME = 'Visitor';

export type { LinkRule, PairRule } from './room';

/** The signed-in person behind a socket (set from the session cookie when it connects). */
export interface SocketUser {
  id: string;
  name: string;
}

export interface SocketData {
  user: SocketUser | null;
  /** SHA-256 of the session token, for disconnecting the session's sockets on logout. */
  sessionHash?: string;
  /**
   * A secret sent only to this socket (in its join answer) that it shows when uploading files.
   * Socket ids can't serve for that: everyone in the office sees them.
   */
  uploadKey?: string;
  /** SHA-256 of the JoinRequest.resume this connection joined with: its page's other connections have the same. */
  resume?: string;
  /** SHA-256 of the JoinRequest.browser this connection joined with: the same browser's other connections have the same. */
  browser?: string;
}

export type IO = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
export type ClientSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
type ServerEvent = keyof ServerToClientEvents;

/** One connection, as features see it. */
export interface SocketContext {
  socket: ClientSocket;
  /** Null for guests. */
  user: SocketUser | null;
  /** The office this socket is in, if it has joined one. */
  room(): { officeId: string; players: ReadonlyMap<string, PlayerState> } | null;
  me(): PlayerState | undefined;
  office(): Office | undefined;
  /** Their role in the office they're in (null before joining): a member's, or 'guest'. */
  role(): Role | null;
  /** The owner, or whoever came in with the owner key of an office nobody has claimed yet. */
  isOwner(): boolean;
  /** May change the office (build mode, settings): see may(role, 'build') in shared/workspace.ts. */
  mayEdit(): boolean;
  /**
   * May change what everyone shares in the office (lights, music, desk notes): false for customers
   * (isCustomer in shared/workspace.ts) and before joining.
   */
  mayChangeWorld(): boolean;
  /** A token bucket for this socket: `rate` actions per second, bursts up to `burst`. */
  limiter(rate: number, burst: number): () => boolean;
}

/**
 * Handlers may be async; a handler that throws or rejects is logged and the others still run. Errors
 * in your own `socket.on(…)` handlers are yours to catch: an async one that rejects stops the server.
 */
export interface RealtimeApi {
  /** Called for every new connection, after the core handlers are set up: add `socket.on(…)` handlers here. */
  onSocket(handler: (s: SocketContext) => void): void;
  /** After someone joined an office (everyone has been told). */
  onJoin(handler: (s: SocketContext) => void): void;
  /** After someone left an office (by joining another, or disconnecting). */
  onLeave(handler: (s: SocketContext, left: { officeId: string; player: PlayerState }) => void): void;
  emitToOffice<E extends ServerEvent>(officeId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void;
  emitToUser<E extends ServerEvent>(userId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void;
  /** Where a signed-in person currently is (at most one per office: one presence per person). */
  playersOfUser(userId: string): { officeId: string; player: PlayerState }[];
  /** Changes a player and tells everyone in the office (player:updated). */
  updatePlayer(officeId: string, playerId: string, patch: PlayerPatch): void;
  /** The connection with this socket id, if it is still connected. */
  contextOf(socketId: string): SocketContext | undefined;
  onlineCount(officeId: string): number;
  /** Who is in the office right now. */
  players(officeId: string): PlayerState[];
  /** The players this one is in a call with right now. */
  linkedPeers(officeId: string, playerId: string): string[];
  /**
   * Adds a rule for who is in a call with whom. Each time an office's calls are checked, the rule is
   * asked for that office's pair rule (look up what it needs once, there), which is asked about every
   * pair before the usual rules: any saying false keeps them apart, otherwise any saying true links
   * them (whatever the distance or private areas), otherwise distance and areas decide. Call relink()
   * when its answers change.
   */
  addLinkRule(rule: LinkRule): void;
  /** Checks the calls of these players (or everyone) in the office again, after a link rule's answers changed. */
  relink(officeId: string, playerIds?: string[]): void;
  /**
   * Adds a check for people coming into an office, run at the end of a join (nothing waits after
   * it): why they may not come in (they're told), or null. A check that throws is logged and ignored.
   */
  addJoinCheck(check: (officeId: string, s: SocketContext, role: Role) => string | null): void;
  /** Takes someone (a player id) out of the office (office:removed with `reason`). */
  removePlayer(officeId: string, playerId: string, reason: RemovedReason): void;
  /**
   * After someone's role in the office they're in changed (setRole), with the role they had. A
   * customer made a member is already shown as themselves (userId, name, `customer: false`).
   */
  onRoleChange(handler: (s: SocketContext, before: Role) => void): void;
  /** After the office's layout or settings changed (an office:op), with the office as it is now. */
  onOfficeChange(handler: (officeId: string, office: Office) => void): void;
  /**
   * After a member's role changed: tells them (office:role) wherever they are in that office, or,
   * with null (no longer a member), takes them out of it (office:removed).
   */
  setRole(officeId: string, userId: string, role: MemberRole | null): void;
  /** Takes the guests out of an office (office:removed). */
  removeGuests(officeId: string): void;
  /**
   * After the office's guest access changed to `guests`: tells everyone in it (office:role), and
   * takes the guests out when it was turned off.
   */
  accessChanged(officeId: string, guests: GuestAccess): void;
  /**
   * After the office was locked (only its owner and admins may be in it, at most `staffCap` at once
   * when given) or unlocked, or someone in a locked office became a member: when locked, takes
   * everyone else out of it (office:removed 'locked'), then the admins who came in last until
   * `staffCap` people are left (never the owner).
   */
  lockChanged(officeId: string, locked: boolean, staffCap?: number | null): void;
}

/** Token bucket: `rate` actions per second with bursts up to `burst`. */
function limiter(rate: number, burst: number) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export const roomName = (officeId: string) => `office:${officeId}`;
export const userRoom = (userId: string) => `user:${userId}`;
export const sessionRoom = (tokenHash: string) => `session:${tokenHash}`;

/** A free spot near the office's spawn point that isn't on top of someone else. */
export function spawnSpot(office: Office, others: Iterable<PlayerState>): { x: number; z: number } {
  const colliders = buildColliders(office);
  const { spawn } = office.settings;
  const taken = [...others];
  for (let i = 0; i < 30; i++) {
    const radius = 1 + Math.floor(i / 8);
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * radius;
    const p = findFreeSpot(spawn.x + Math.cos(angle) * r, spawn.z + Math.sin(angle) * r, colliders, office.settings);
    if (taken.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > 0.9)) return p;
  }
  return findFreeSpot(spawn.x, spawn.z, colliders, office.settings);
}

/** A position someone sends (a move, or where they are when they come back), kept on the floor; null if it isn't one. */
function spotOn(office: Office, x: unknown, z: unknown, ry: unknown, anim: unknown): Spot | null {
  if (![x, z, ry].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return {
    x: Math.max(0, Math.min(office.settings.width, x as number)),
    z: Math.max(0, Math.min(office.settings.depth, z as number)),
    ry: ry as number,
    anim: ANIMS.includes(anim as AnimState) ? (anim as AnimState) : 'idle',
  };
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('base64url');

/** Runs feature callbacks (async ones too) so that one failing doesn't break the others or the core. */
function each<A extends unknown[]>(handlers: ((...args: A) => void)[], ...args: A) {
  const failed = (err: unknown) => console.error('[realtime] a feature handler failed:', err);
  for (const handler of handlers) {
    try {
      // An async handler's promise (typed as void, as TypeScript allows).
      const result = handler(...args) as unknown;
      if (result instanceof Promise) result.catch(failed);
    } catch (err) {
      failed(err);
    }
  }
}

export function attachRealtime(io: IO, store: OfficeStore, opts: { accounts: Accounts; workspaces: Workspaces }) {
  const rooms = new Map<string, Room>();
  const contexts = new Map<string, SocketContext>();
  /** What the server may do to each connection besides its own handlers. */
  const controls = new Map<string, { setRole(role: Role, guests: GuestAccess): void; remove(reason: RemovedReason): void }>();
  /** Counts changes to who may be in an office, so joins in progress check again. */
  let admissions = 0;
  const socketHandlers: ((s: SocketContext) => void)[] = [];
  const joinHandlers: ((s: SocketContext) => void)[] = [];
  const leaveHandlers: ((s: SocketContext, left: { officeId: string; player: PlayerState }) => void)[] = [];
  const linkRules: LinkRule[] = [];
  const joinChecks: ((officeId: string, s: SocketContext, role: Role) => string | null)[] = [];
  const roleHandlers: ((s: SocketContext, before: Role) => void)[] = [];
  const officeHandlers: ((officeId: string, office: Office) => void)[] = [];

  // Typed emits for a generic event name are beyond Socket.IO's types; the signatures above check them.
  const emit = (to: string | string[], event: ServerEvent, args: unknown[]) => {
    const target = io.to(to) as unknown as { emit(event: string, ...args: unknown[]): boolean };
    target.emit(event, ...args);
  };

  const emitLinks = (changes: LinkChanges) => {
    for (const { a, b, sid } of changes.added) {
      io.to(a).emit('peer:connect', b, sid, a < b);
      io.to(b).emit('peer:connect', a, sid, b < a);
    }
    for (const { a, b } of changes.removed) {
      io.to(a).emit('peer:disconnect', b);
      io.to(b).emit('peer:disconnect', a);
    }
  };

  const api: RealtimeApi = {
    onSocket: (handler) => void socketHandlers.push(handler),
    onJoin: (handler) => void joinHandlers.push(handler),
    onLeave: (handler) => void leaveHandlers.push(handler),
    emitToOffice: (officeId, event, ...args) => emit(roomName(officeId), event, args),
    emitToUser: (userId, event, ...args) => emit(userRoom(userId), event, args),
    playersOfUser(userId) {
      const out: { officeId: string; player: PlayerState }[] = [];
      for (const socketId of io.sockets.adapter.rooms.get(userRoom(userId)) ?? []) {
        const ctx = contexts.get(socketId);
        const room = ctx?.room();
        const player = ctx?.me();
        if (room && player) out.push({ officeId: room.officeId, player });
      }
      return out;
    },
    updatePlayer(officeId, playerId, patch) {
      const room = rooms.get(officeId);
      const p = room?.players.get(playerId);
      if (!room || !p) return;
      Object.assign(p, patch);
      io.to(roomName(officeId)).emit('player:updated', p.id, patch);
      const o = store.peek(officeId)?.office;
      if ('status' in patch && o) emitLinks(room.recompute(o.zones, [p.id]));
    },
    contextOf: (socketId) => contexts.get(socketId),
    onlineCount: (officeId: string) => rooms.get(officeId)?.players.size ?? 0,
    players: (officeId) => [...(rooms.get(officeId)?.players.values() ?? [])],
    linkedPeers: (officeId, playerId) => rooms.get(officeId)?.linkedPeers(playerId) ?? [],
    addLinkRule: (rule) => void linkRules.push(rule),
    relink(officeId, playerIds) {
      const room = rooms.get(officeId);
      const o = store.peek(officeId)?.office;
      if (room && o) emitLinks(room.recompute(o.zones, playerIds));
    },
    addJoinCheck: (check) => void joinChecks.push(check),
    removePlayer(officeId, playerId, reason) {
      if (contexts.get(playerId)?.room()?.officeId === officeId) controls.get(playerId)?.remove(reason);
    },
    onRoleChange: (handler) => void roleHandlers.push(handler),
    onOfficeChange: (handler) => void officeHandlers.push(handler),
    setRole(officeId, userId, role) {
      admissions++;
      const guests = store.peek(officeId)?.guests ?? 'off';
      for (const socketId of io.sockets.adapter.rooms.get(userRoom(userId)) ?? []) {
        if (contexts.get(socketId)?.room()?.officeId !== officeId) continue;
        const control = controls.get(socketId);
        if (role) control?.setRole(role, guests);
        else control?.remove('removed');
      }
    },
    removeGuests(officeId) {
      admissions++;
      for (const id of [...(rooms.get(officeId)?.guests ?? [])]) controls.get(id)?.remove('guests-off');
    },
    accessChanged(officeId, guests) {
      admissions++;
      if (guests === 'off') api.removeGuests(officeId);
      for (const id of rooms.get(officeId)?.players.keys() ?? []) {
        const role = contexts.get(id)?.role();
        if (role) controls.get(id)?.setRole(role, guests);
      }
    },
    lockChanged(officeId, locked, staffCap = null) {
      admissions++;
      const room = rooms.get(officeId);
      if (!locked || !room) return;
      // In the order they came in.
      const admins: string[] = [];
      for (const id of [...room.players.keys()]) {
        const ctx = contexts.get(id);
        const role = ctx?.role();
        if (role === 'owner' || ctx?.isOwner()) continue;
        if (role === 'admin') admins.push(id);
        else controls.get(id)?.remove('locked');
      }
      if (staffCap === null) return;
      while (admins.length && room.players.size > staffCap) controls.get(admins.pop()!)?.remove('locked');
    },
  };

  io.on('connection', (socket: ClientSocket) => {
    let room: Room | null = null;
    let role: Role | null = null;
    let isOwner = false;
    const user = socket.data.user ?? null;
    socket.data.uploadKey = crypto.randomBytes(24).toString('base64url');
    if (user) void socket.join(socket.data.sessionHash ? [userRoom(user.id), sessionRoom(socket.data.sessionHash)] : [userRoom(user.id)]);

    const office = () => (room ? store.peek(room.officeId)?.office : undefined);
    const customer = () => !!room && isCustomer(role, store.peek(room.officeId)?.kind);
    const ctx: SocketContext = {
      socket,
      user,
      room: () => room,
      me: () => room?.players.get(socket.id),
      office,
      role: () => role,
      isOwner: () => isOwner,
      mayEdit: () => {
        const stored = room ? store.peek(room.officeId) : undefined;
        return !!stored && (isOwner || may(role, 'build', { buildPolicy: stored.office.settings.buildPolicy, guests: stored.guests }));
      },
      mayChangeWorld: () => !!room && !customer(),
      limiter,
    };
    const { me, mayEdit, mayChangeWorld } = ctx;
    contexts.set(socket.id, ctx);

    const canEmote = limiter(2, 4);
    const canEdit = limiter(20, 60);
    const canProfile = limiter(2, 6);
    const canMove = limiter(40, 80);
    const canMusic = limiter(4, 12);
    const canSpotify = limiter(6, 20);
    const canRelink = limiter(1, 10);

    const endSpotify = (r: Room, itemId: string) => {
      if (r.spotify.delete(itemId)) io.to(roomName(r.officeId)).emit('spotify:session', itemId, null);
    };

    const leave = () => {
      if (!room) return;
      const r = room;
      const player = r.players.get(socket.id);
      room = null;
      socket.leave(roomName(r.officeId));
      for (const [itemId, s] of r.spotify) if (s.dj === socket.id) endSpotify(r, itemId);
      emitLinks(r.removePlayer(socket.id));
      io.to(roomName(r.officeId)).emit('player:left', socket.id);
      if (r.players.size === 0 && rooms.get(r.officeId) === r) {
        rooms.delete(r.officeId);
        void store.evict(r.officeId, () => rooms.has(r.officeId));
      }
      if (player) each(leaveHandlers, ctx, { officeId: r.officeId, player });
      role = null;
      isOwner = false;
    };

    controls.set(socket.id, {
      setRole(next, guests) {
        if (!room) return;
        const before = role!;
        role = next;
        isOwner = next === 'owner';
        if (next === 'guest') room.guests.add(socket.id);
        else room.guests.delete(socket.id);
        socket.emit('office:role', next, guests);
        if (before === next) return;
        // A customer made a member is no longer anonymous.
        const p = me();
        if (p?.customer && user && !customer()) api.updatePlayer(room.officeId, p.id, { customer: false, userId: user.id, name: user.name });
        each(roleHandlers, ctx, before);
      },
      remove(reason) {
        if (!room) return;
        socket.emit('office:removed', reason);
        leave();
      },
    });

    /**
     * Takes this page's earlier connections out of the office: the ones that joined with the same
     * resume secret, as the same person. One whose network dropped would stay until its heartbeat
     * times out (PING_INTERVAL_MS + PING_TIMEOUT_MS): the page, back on a new connection, says it's gone.
     */
    const replaceEarlier = (officeId: string, resume: string) => {
      for (const id of [...(rooms.get(officeId)?.players.keys() ?? [])]) {
        const other = contexts.get(id);
        if (id === socket.id || !other || other.socket.data.resume !== resume) continue;
        if ((other.user?.id ?? null) !== (user?.id ?? null)) continue;
        // Its player leaves at once (player:left, peer:disconnect), and features see it go.
        other.socket.disconnect(true);
      }
    };

    // Joins run one at a time per connection, and only the newest counts: two sent at once would
    // otherwise both get in (into two offices) while the connection only remembers one.
    let joining = Promise.resolve();
    let latestJoin = 0;
    const replaced: JoinResponse = { ok: false, error: 'Replaced by a newer join.' };

    const join = async (req: JoinRequest, ack: (res: JoinResponse) => void, seq: number) => {
      if (!req || typeof req !== 'object') return ack({ ok: false, error: 'Bad request' });
      leave();
      if (socket.disconnected) return;
      if (seq !== latestJoin) return ack(replaced);
      const officeId = String(req.officeId);
      const load = async () => {
        try {
          return { stored: await store.get(officeId) };
        } catch (err) {
          console.error('[store] could not load office:', err);
          return null;
        }
      };
      const full = (id: string) => (rooms.get(id)?.players.size ?? 0) >= MAX_PLAYERS_PER_ROOM;
      const unavailable: JoinResponse = { ok: false, error: 'Could not load this office right now. Please try again.' };
      let loaded = await load();
      if (!loaded) return ack(unavailable);
      let stored = loaded.stored;
      if (!stored) return ack({ ok: false, error: 'This office does not exist.' });
      const id = stored.office.id;
      // Back after a dropped connection: the old one goes first, so it isn't counted against the
      // limits below (nor in a call with this one).
      const resume = typeof req.resume === 'string' && RESUME.test(req.resume) ? sha256(req.resume) : null;
      const browser = typeof req.browser === 'string' && RESUME.test(req.browser) ? sha256(req.browser) : null;
      /**
       * This person's other connections in an office: the same account, or the same browser. This
       * page's own (the same resume) are the resume rule's alone.
       */
      const others = (officeId: string) =>
        [...(rooms.get(officeId)?.players.keys() ?? [])].filter((id) => {
          const other = contexts.get(id);
          if (id === socket.id || !other || (!!resume && other.socket.data.resume === resume)) return false;
          return (!!user && other.user?.id === user.id) || (!!browser && other.socket.data.browser === browser);
        });
      if (resume) replaceEarlier(id, resume);
      // The person's newest tab gets in even when the office is full: their other one makes room.
      if (full(id) && !others(id).length) return ack({ ok: false, error: 'This office is full.' });
      let admitted: Admission | null = null;
      let account: AccountUser | null = null;
      // Who may come in can change while this waits (a member removed, say): then it's checked again.
      for (let attempt = 1; ; attempt++) {
        const before = admissions;
        try {
          admitted = await opts.workspaces.admit(stored, user?.id ?? null, { ownerKey: req.ownerKey, guest: req.guest });
        } catch (err) {
          console.error('[workspaces] could not check who may come in:', err);
          return ack(unavailable);
        }
        if ('denied' in admitted) return ack({ ok: false, error: deniedMessage(admitted.denied), reason: admitted.denied });
        // Signed-in people appear with their account's name and character, whatever the page sent.
        if (user && !account) {
          try {
            account = await opts.accounts.get(user.id);
          } catch (err) {
            console.error('[accounts] could not load an account:', err);
          }
          // Never as someone else: without their account, they can't come in.
          if (!account) return ack({ ok: false, error: 'Could not load your account right now. Please try again.' });
          // An account without a character yet keeps the one they came in with (not a customer's).
          if (!account.profile.avatar && req.avatar && typeof req.avatar === 'object' && !isCustomer(admitted.role, stored.kind)) {
            try {
              account = (await opts.accounts.update(user.id, { profile: { avatar: sanitizeAvatar(req.avatar) } })) ?? account;
              io.to(userRoom(user.id)).emit('account:updated', account);
            } catch (err) {
              console.error('[accounts] could not save a character:', err);
            }
          }
        }
        // While we waited, the office's last visitor may have left and the office been dropped from
        // memory: then load it again, or edits would go to a copy nobody saves.
        while (store.peek(id) !== stored) {
          if (socket.disconnected) return;
          loaded = await load();
          if (!loaded?.stored) return ack(unavailable);
          stored = loaded.stored;
        }
        if (before === admissions) break;
        if (attempt === 3) return ack(unavailable);
      }
      // From here on nothing waits, so nothing changes until the player is in.
      if (socket.disconnected) return;
      if (seq !== latestJoin) return ack(replaced);
      const joinedAs: Role = admitted.role;
      // The guest link may have been turned off or replaced meanwhile.
      if (joinedAs === 'guest' && !welcomesGuests(stored, req.guest)) {
        const { denied } = refusal(req.guest, user?.id ?? null);
        return ack({ ok: false, error: deniedMessage(denied), reason: denied });
      }
      // The page's own earlier connection goes as before; the person's others (another tab or device)
      // step aside for this one, unless this page is coming back by itself: then it steps aside.
      if (resume) replaceEarlier(id, resume);
      const mine = others(id);
      if (mine.length) {
        if (req.rejoin === true) return ack({ ok: false, error: 'Homeoffice is open in another tab.', reason: 'elsewhere' });
        for (const other of mine) controls.get(other)?.remove('elsewhere');
      }
      // Checked before recording the visit too; this catches people who arrived in the meantime.
      if (full(id)) return ack({ ok: false, error: 'This office is full.' });
      let r = rooms.get(id);
      if (joinedAs === 'guest' && (r?.guests.size ?? 0) >= (admitted.guestCap ?? MAX_GUESTS_PER_ROOM)) return ack({ ok: false, error: 'This office is full.' });
      // A locked office lets in only a few of its admins at once (and its owner, always).
      if (typeof admitted.staffCap === 'number' && (r?.players.size ?? 0) >= admitted.staffCap) {
        return ack({ ok: false, error: `This workspace is paused, and only ${admitted.staffCap} people can be in it at once. Try again later.` });
      }
      for (const check of joinChecks) {
        let why: string | null = null;
        try {
          why = check(id, ctx, joinedAs);
        } catch (err) {
          console.error('[realtime] a join check failed:', err);
        }
        if (why) return ack({ ok: false, error: why });
      }
      if (!r) {
        r = new Room(id, linkRules);
        rooms.set(id, r);
      }

      role = joinedAs;
      isOwner = admitted.isOwner;
      if (resume) socket.data.resume = resume;
      if (browser) socket.data.browser = browser;
      // Coming back: where they were. Otherwise at the entrance.
      const back = req.at && typeof req.at === 'object' ? spotOn(stored.office, req.at.x, req.at.z, req.at.ry, req.at.anim) : null;
      const spot = back ?? spawnSpot(stored.office, r.players.values());
      // Customers stay anonymous to the others (the support feature numbers them once they have a
      // ticket): no account, its name or its character.
      const asCustomer = isCustomer(joinedAs, stored.kind);
      const player: PlayerState = {
        id: socket.id,
        name: asCustomer ? CUSTOMER_NAME : account?.name || sanitizeName(req.name) || 'Guest',
        avatar: (!asCustomer && account?.profile.avatar) || sanitizeAvatar(req.avatar),
        status: sanitizeStatus(req.status),
        x: spot.x,
        z: spot.z,
        ry: back?.ry ?? 0,
        anim: back?.anim ?? 'idle',
        mic: req.mic === true,
        cam: req.cam === true,
        screen: false,
      };
      if (asCustomer) player.customer = true;
      else if (user) player.userId = user.id;
      room = r;
      r.players.set(socket.id, player);
      if (joinedAs === 'guest') r.guests.add(socket.id);
      socket.join(roomName(id));
      ack({
        ok: true,
        selfId: socket.id,
        office: stored.office,
        players: [...r.players.values()],
        isOwner,
        role: joinedAs,
        kind: stored.kind,
        guests: stored.guests,
        spotify: [...r.spotify.values()],
        uploadKey: socket.data.uploadKey!,
      });
      socket.to(roomName(id)).emit('player:joined', player);
      emitLinks(r.recompute(stored.office.zones, [socket.id]));
      each(joinHandlers, ctx);
    };

    socket.on('join', (req, ack) => {
      if (typeof ack !== 'function') return;
      const seq = ++latestJoin;
      joining = joining
        .then(() => join(req, ack, seq))
        .catch((err) => {
          console.error('[realtime] a join failed:', err);
          ack({ ok: false, error: 'Something went wrong. Please try again.' });
        });
    });

    socket.on('move', (x, z, ry, anim) => {
      const p = me();
      const o = office();
      if (!p || !o || !room || !canMove()) return;
      const spot = spotOn(o, x, z, ry, anim);
      if (!spot) return;
      const was: Spot = { x: p.x, z: p.z, ry: p.ry, anim: p.anim };
      Object.assign(p, spot);
      // A step while walking may be dropped for someone whose connection is busy (the next one
      // replaces it), as may a repeat of where they already are. Anything else (stopping, sitting
      // down, standing up, a jump) happens once: it's queued for everyone, in order.
      const repeat = was.x === p.x && was.z === p.z && was.ry === p.ry && was.anim === p.anim;
      const step = was.anim === 'walk' && p.anim === 'walk';
      const to = repeat || step ? socket.volatile.to(roomName(room.officeId)) : socket.to(roomName(room.officeId));
      to.emit('player:moved', [p.id, p.x, p.z, p.ry, p.anim]);
      emitLinks(room.recompute(o.zones, [p.id]));
    });

    socket.on('profile', (patch) => {
      const p = me();
      if (!p || !office() || !room || !patch || typeof patch !== 'object' || !canProfile()) return;
      const clean = sanitizeProfile(patch, p.name);
      // A signed-in person's name and character change only with their account (Profile), and
      // customers' names only with their ticket.
      if (user) {
        delete clean.name;
        delete clean.avatar;
      }
      if (customer()) delete clean.name;
      if (Object.keys(clean).length) api.updatePlayer(room.officeId, p.id, clean);
    });

    socket.on('emote', (emoji) => {
      if (!room || !isEmote(emoji) || !canEmote()) return;
      io.to(roomName(room.officeId)).emit('emote', socket.id, emoji);
    });

    socket.on('office:op', (raw: OfficeOp) => {
      if (!room) return;
      let op = raw;
      const stored = store.peek(room.officeId);
      if (!stored) return;
      const reject = (reason: string) => socket.emit('office:sync', stored.office, reason);
      if (!canEdit()) return reject('You are editing too quickly.');
      if (!mayEdit()) return reject(stored.office.settings.buildPolicy === 'owner' ? 'Only the owner and admins can edit this office.' : 'Only members can edit this office.');
      if (op?.t === 'settings' && op.settings && 'buildPolicy' in op.settings && !isOwner) {
        return reject('Only the owner can change who may edit.');
      }
      // Some items are made for one kind of workspace (support desks).
      const kinds = (op?.t === 'add' || op?.t === 'update') && op.item && typeof op.item === 'object' ? getEntry(op.item.type)?.kinds : undefined;
      if (kinds && !kinds.includes(stored.kind)) return reject('That doesn’t belong in this kind of workspace.');
      // Item data (a jukebox's station and links…) changes only through its feature's own ops, so
      // moving, copying or re-typing an item can't overwrite (or forge) it.
      if (op?.t === 'update' && op.item && typeof op.item === 'object') {
        const moved = op.item;
        const existing = stored.office.items.find((i) => i.id === moved.id);
        op = { t: 'update', item: { ...moved, data: existing && existing.type === moved.type ? existing.data : undefined } };
      } else if (op?.t === 'add' && op.item && typeof op.item === 'object') {
        op = { ...op, item: { ...op.item, data: undefined } };
      }
      let next;
      try {
        next = applyOp(stored.office, op);
      } catch (err) {
        return reject(err instanceof OpError ? err.message : 'Invalid edit');
      }
      store.update(room.officeId, next);
      // Broadcast the normalised edit (to the sender too, so everybody converges on the server's order).
      let normalized: OfficeOp = op;
      if (op.t === 'add' || op.t === 'update') normalized = { t: op.t, item: next.items.find((i) => i.id === op.item.id)! };
      else if (op.t === 'zone:add' || op.t === 'zone:update') normalized = { t: op.t, zone: next.zones.find((z) => z.id === op.zone.id)! };
      else if (op.t === 'settings') normalized = { t: 'settings', settings: next.settings };
      else if (op.t === 'remove' || op.t === 'zone:remove') normalized = { t: op.t, id: op.id };
      io.to(roomName(room.officeId)).emit('office:op', normalized, socket.id);
      if (op.t.startsWith('zone:') || op.t === 'settings') emitLinks(room.recompute(next.zones));
      each(officeHandlers, room.officeId, next);
      // Listen-along sessions end with their jukebox (removed, re-typed, or cut off by a smaller floor).
      for (const itemId of [...room.spotify.keys()]) {
        if (!isJukebox(next.items.find((i) => i.id === itemId))) endSpotify(room, itemId);
      }
    });

    socket.on('rtc:signal', (to, sid, data) => {
      if (!room || typeof to !== 'string' || typeof sid !== 'number' || !data || typeof data !== 'object') return;
      // Only relay between people who are currently linked, on their current connection.
      if (room.linkSid(socket.id, to) !== sid) return;
      if (JSON.stringify(data).length > 100_000) return;
      io.to(to).emit('rtc:signal', socket.id, sid, data);
    });

    socket.on('rtc:relink', (to, sid) => {
      if (!room || typeof to !== 'string' || typeof sid !== 'number' || !canRelink()) return;
      // Only a current link, on the id it has now: when both ask, the second finds it renewed.
      const renewed = room.renew(socket.id, to, sid);
      if (renewed) emitLinks({ added: [renewed], removed: [] });
    });

    socket.on('music', (op) => {
      const p = me();
      if (!room || !p || !canMusic()) return;
      if (!mayChangeWorld()) {
        // Listeners' track lengths are just ignored.
        if (op?.t !== 'track:durations') socket.emit('notice', 'Only staff can change the music here.');
        return;
      }
      const r = room;
      const stored = store.peek(r.officeId);
      if (!stored) return;
      const result = applyMusicOp(stored.office, op, { id: p.id, name: p.name, canEdit: mayEdit() });
      if ('error' in result) {
        if (result.error) socket.emit('notice', result.error);
        return;
      }
      store.update(r.officeId, result.office);
      io.to(roomName(r.officeId)).emit('office:op', { t: 'update', item: result.item }, socket.id);
      if (result.added) void addLinkMeta(r, result.item.id, result.added);
    });

    /** Fill in a shared link's title and cover once Spotify's oEmbed answers. */
    const addLinkMeta = async (r: Room, itemId: string, link: MusicLink) => {
      if (link.kind === 'jam') return;
      const meta = await fetchLinkMeta(link.url);
      if (!meta.title && !meta.image) return;
      const stored = store.peek(r.officeId);
      if (!stored || rooms.get(r.officeId) !== r) return;
      const result = applyMusicOp(stored.office, { t: 'link:meta', itemId, linkId: link.id, ...meta }, { id: '', name: '', canEdit: true, server: true });
      if ('error' in result) return;
      store.update(r.officeId, result.office);
      io.to(roomName(r.officeId)).emit('office:op', { t: 'update', item: result.item }, 'server');
    };

    socket.on('spotify:session', (itemId, update, start) => {
      const p = me();
      if (!room || !p || typeof itemId !== 'string' || !mayChangeWorld()) return;
      if (update === null) {
        // Anyone in the room may stop the music, like turning off a shared speaker.
        endSpotify(room, itemId);
        return;
      }
      if (!canSpotify() || !isJukebox(office()?.items.find((i) => i.id === itemId))) return;
      const current = room.spotify.get(itemId);
      const clean = sanitizeSessionUpdate(update);
      if (!clean) return;
      // Only the DJ updates a running session; someone else has to take over explicitly.
      if (current && current.dj !== p.id && start !== true) return;
      const session: SpotifySession = { ...clean, itemId, dj: p.id, djName: p.name, at: Date.now() };
      room.spotify.set(itemId, session);
      io.to(roomName(room.officeId)).emit('spotify:session', itemId, session);
    });

    socket.on('time', (ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('disconnect', () => {
      leave();
      contexts.delete(socket.id);
      controls.delete(socket.id);
    });

    each(socketHandlers, ctx);
  });

  return { ...api, rooms };
}
