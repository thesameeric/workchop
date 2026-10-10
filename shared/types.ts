import type { AccountUser } from './account';
import type { JukeboxData, MusicOp, SpotifySession, SpotifySessionUpdate } from './music';
import type { AccessDenied, GuestAccess, OfficeKind, RemovedReason, Role } from './workspace';
import type { DeskData, LightData } from './world';

// Types shared by the browser client and the Node server.

export type HairStyle = 'none' | 'short' | 'long' | 'bun' | 'ponytail' | 'mohawk' | 'curly' | 'spiky';
export type TopStyle = 'tshirt' | 'hoodie' | 'suit' | 'dress';
export type HatStyle = 'none' | 'cap' | 'beanie' | 'tophat' | 'crown' | 'headphones';
export type GlassesStyle = 'none' | 'round' | 'shades';
export type FacialHair = 'none' | 'beard' | 'mustache';

export interface AvatarConfig {
  skin: string;
  hair: HairStyle;
  hairColor: string;
  top: TopStyle;
  topColor: string;
  bottomColor: string;
  shoeColor: string;
  hat: HatStyle;
  hatColor: string;
  glasses: GlassesStyle;
  facialHair: FacialHair;
}

export type AnimState = 'idle' | 'walk' | 'sit';
export type Status = 'available' | 'busy' | 'away';

/** Everything the server knows about a connected person. */
export interface PlayerState {
  id: string;
  name: string;
  avatar: AvatarConfig;
  status: Status;
  x: number;
  z: number;
  ry: number;
  anim: AnimState;
  mic: boolean;
  cam: boolean;
  screen: boolean;
  /** Account id when signed in (a random id, shown so others can tell members apart). */
  userId?: string;
  /** Headphones on: focusing, not to be disturbed. Set by the client with a profile patch. */
  focus?: boolean;
  /** The app the person is using right now (an app id), set only by the server. */
  app?: string | null;
  /**
   * A customer of a support workspace (a guest there, see isCustomer in shared/workspace.ts): shown
   * as a visitor, and only in their ticket's chat. Set by the server when they come in, and false
   * (in a player:updated) if they're made a member while inside. Customers carry no userId.
   */
  customer?: boolean;
}

/**
 * Changes to a player's public state (player:updated). Fields features add to PlayerState are
 * included automatically. `userId` and `customer` change only when a customer is made a member.
 */
export type PlayerPatch = Partial<Omit<PlayerState, 'id' | 'x' | 'z' | 'ry' | 'anim'>>;

/**
 * What a client may change about itself with a 'profile' message (the server sets `app`, `userId`
 * and `customer`). A signed-in person's name and avatar are ignored: they come from the account
 * (PATCH /api/me); so are customers' names.
 */
export type ProfilePatch = Omit<PlayerPatch, 'app' | 'userId' | 'customer'>;

/** A piece of furniture or structure placed in an office. x/z is the footprint centre. */
export interface OfficeItem {
  id: string;
  type: string;
  x: number;
  z: number;
  /** Quarter turns around the vertical axis, 0..3. */
  rot: number;
  color?: string;
  /**
   * Item-specific settings, checked by the item type's `sanitizeData` (shared/catalog.ts). Narrow it
   * by type: a jukebox's is JukeboxData (see isJukebox in shared/music.ts), a lamp's or light
   * switch's LightData and a claimed desk's DeskData (shared/world.ts).
   */
  data?: ItemData;
}

export type ItemData = JukeboxData | LightData | DeskData | Record<string, unknown>;

/** A private area: people inside hear only each other, regardless of distance. */
export interface Zone {
  id: string;
  name: string;
  /** Minimum corner. */
  x: number;
  z: number;
  w: number;
  d: number;
  color: string;
}

export type FloorStyle = 'wood' | 'carpet' | 'tile' | 'concrete';
export type BuildPolicy = 'everyone' | 'owner';

export interface OfficeSettings {
  name: string;
  width: number;
  depth: number;
  floor: FloorStyle;
  floorColor: string;
  wallColor: string;
  spawn: { x: number; z: number };
  buildPolicy: BuildPolicy;
}

export interface Office {
  id: string;
  settings: OfficeSettings;
  items: OfficeItem[];
  zones: Zone[];
  createdAt: number;
  updatedAt: number;
}

export type OfficeOp =
  | { t: 'add'; item: OfficeItem }
  | { t: 'update'; item: OfficeItem }
  | { t: 'remove'; id: string }
  | { t: 'zone:add'; zone: Zone }
  | { t: 'zone:update'; zone: Zone }
  | { t: 'zone:remove'; id: string }
  | { t: 'settings'; settings: Partial<OfficeSettings> };

export interface RtcSignal {
  sdp?: { type: 'offer' | 'answer'; sdp: string };
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null };
  /** From the side that doesn't make offers: its connection broke, please restart ICE. */
  restart?: boolean;
}

/** Where someone is, as `move` sends it. */
export interface Spot {
  x: number;
  z: number;
  ry: number;
  anim: AnimState;
}

export interface JoinRequest {
  officeId: string;
  /** A guest's name and character. Signed-in people get their account's (an account without a character yet keeps this one). */
  name: string;
  avatar: AvatarConfig;
  status?: Status;
  /** The secret an office made before accounts gave its creator's browser. */
  ownerKey?: string;
  /** The token from a guest link (`#guest=` in the address). */
  guest?: string;
  mic?: boolean;
  cam?: boolean;
  /**
   * A secret the page made for this visit (22 to 128 URL-safe characters), sent with every join of
   * it. Joining again with it replaces this page's earlier connections that are still in the office:
   * after a dropped connection the server may not have noticed yet, and they'd be left as ghosts.
   */
  resume?: string;
  /**
   * A secret this browser keeps (localStorage `workchop:browser`; 22 to 128 URL-safe characters).
   * You're one person per browser and per account: joining an office takes your other connection
   * there (another tab, or another device with the same account) out with office:removed
   * 'elsewhere'. Without it, a guest is never matched with anyone.
   */
  browser?: string;
  /**
   * The page coming back by itself (after a dropped connection, or after signing in or out in
   * another tab). While you're in this office on another connection (not this page's), it's refused
   * with reason 'elsewhere' instead of taking over.
   */
  rejoin?: boolean;
  /** Coming back after a dropped connection: where you are (instead of the entrance). */
  at?: Spot;
}

export type JoinResponse =
  | {
      ok: true;
      selfId: string;
      office: Office;
      players: PlayerState[];
      /** The owner, or whoever holds the owner key of an office nobody has claimed yet. */
      isOwner: boolean;
      role: Role;
      kind: OfficeKind;
      guests: GuestAccess;
      /** Spotify listen-along sessions running in this office. */
      spotify: SpotifySession[];
      /** Secret for uploading files while in this office (the X-Workchop-Upload-Key header); never shared. */
      uploadKey: string;
    }
  | { ok: false; error: string; reason?: AccessDenied | 'elsewhere' };

/** Compact movement packet: [id, x, z, ry, anim]. */
export type MovePacket = [string, number, number, number, AnimState];

export interface ServerToClientEvents {
  'player:joined': (p: PlayerState) => void;
  'player:left': (id: string) => void;
  'player:moved': (m: MovePacket) => void;
  'player:updated': (id: string, patch: PlayerPatch) => void;
  'peer:connect': (peerId: string, sid: number, initiator: boolean) => void;
  'peer:disconnect': (peerId: string) => void;
  'rtc:signal': (from: string, sid: number, data: RtcSignal) => void;
  emote: (id: string, emoji: string) => void;
  'office:op': (op: OfficeOp, by: string) => void;
  'office:sync': (office: Office, reason?: string) => void;
  'spotify:session': (itemId: string, session: SpotifySession | null) => void;
  notice: (text: string) => void;
  /** Your account changed (on another device or tab): only sent to your own sockets. */
  'account:updated': (user: AccountUser) => void;
  /** Your role in this office, or who else may come in, changed. */
  'office:role': (role: Role, guests: GuestAccess) => void;
  /** You were removed from the office (you've left it by the time this arrives). */
  'office:removed': (reason: RemovedReason) => void;
}

export interface ClientToServerEvents {
  join: (req: JoinRequest, ack: (res: JoinResponse) => void) => void;
  move: (x: number, z: number, ry: number, anim: AnimState) => void;
  profile: (patch: ProfilePatch) => void;
  emote: (emoji: string) => void;
  'office:op': (op: OfficeOp) => void;
  'rtc:signal': (to: string, sid: number, data: RtcSignal) => void;
  /**
   * The call with this person (on link `sid`) doesn't connect: start it over. Both get a new
   * peer:connect, with a new link id; a link that changed meanwhile is left alone.
   */
  'rtc:relink': (peerId: string, sid: number) => void;
  /** Change a jukebox (radio station, shared links). Allowed for everyone in the office. */
  music: (op: MusicOp) => void;
  /** Start (start=true), update or stop (null) a Spotify listen-along session on a jukebox. */
  'spotify:session': (itemId: string, update: SpotifySessionUpdate | null, start?: boolean) => void;
  /** Server clock, for keeping listen-along playback in sync. */
  time: (ack: (serverNow: number) => void) => void;
}
