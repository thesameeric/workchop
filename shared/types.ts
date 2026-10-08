import type { AccountUser } from './account';
import type { JukeboxData, MusicOp, SpotifySession, SpotifySessionUpdate } from './music';
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
}

/** Changes to a player's public state. Fields features add to PlayerState are included automatically. */
export type PlayerPatch = Partial<Omit<PlayerState, 'id' | 'x' | 'z' | 'ry' | 'anim' | 'userId'>>;

/** What a client may change about itself with a 'profile' message (the server sets `app`). */
export type ProfilePatch = Omit<PlayerPatch, 'app'>;

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
}

export interface JoinRequest {
  officeId: string;
  name: string;
  avatar: AvatarConfig;
  status?: Status;
  ownerKey?: string;
  mic?: boolean;
  cam?: boolean;
}

export type JoinResponse =
  | {
      ok: true;
      selfId: string;
      office: Office;
      players: PlayerState[];
      isOwner: boolean;
      /** Spotify listen-along sessions running in this office. */
      spotify: SpotifySession[];
      /** Secret for uploading files while in this office (the X-Workchop-Upload-Key header); never shared. */
      uploadKey: string;
    }
  | { ok: false; error: string };

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
}

export interface ClientToServerEvents {
  join: (req: JoinRequest, ack: (res: JoinResponse) => void) => void;
  move: (x: number, z: number, ry: number, anim: AnimState) => void;
  profile: (patch: ProfilePatch) => void;
  emote: (emoji: string) => void;
  'office:op': (op: OfficeOp) => void;
  'rtc:signal': (to: string, sid: number, data: RtcSignal) => void;
  /** Change a jukebox (radio station, shared links). Allowed for everyone in the office. */
  music: (op: MusicOp) => void;
  /** Start (start=true), update or stop (null) a Spotify listen-along session on a jukebox. */
  'spotify:session': (itemId: string, update: SpotifySessionUpdate | null, start?: boolean) => void;
  /** Server clock, for keeping listen-along playback in sync. */
  time: (ack: (serverNow: number) => void) => void;
}
