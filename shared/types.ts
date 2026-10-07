import type { JukeboxData, MusicOp, SpotifySession, SpotifySessionUpdate } from './music';

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
}

export type PlayerPatch = Partial<Pick<PlayerState, 'name' | 'avatar' | 'status' | 'mic' | 'cam' | 'screen'>>;

/** A piece of furniture or structure placed in an office. x/z is the footprint centre. */
export interface OfficeItem {
  id: string;
  type: string;
  x: number;
  z: number;
  /** Quarter turns around the vertical axis, 0..3. */
  rot: number;
  color?: string;
  /** Item-specific settings (jukebox: radio station and shared Spotify links). */
  data?: JukeboxData;
}

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

export type ChatScope = 'all' | 'nearby' | 'dm';

export interface ChatMessage {
  id: string;
  from: string;
  name: string;
  text: string;
  scope: ChatScope;
  /** Recipient id for direct messages. */
  to?: string;
  ts: number;
}

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
      chat: ChatMessage[];
      isOwner: boolean;
      /** Spotify listen-along sessions running in this office. */
      spotify: SpotifySession[];
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
  chat: (m: ChatMessage) => void;
  emote: (id: string, emoji: string) => void;
  'office:op': (op: OfficeOp, by: string) => void;
  'office:sync': (office: Office, reason?: string) => void;
  'spotify:session': (itemId: string, session: SpotifySession | null) => void;
  notice: (text: string) => void;
}

export interface ClientToServerEvents {
  join: (req: JoinRequest, ack: (res: JoinResponse) => void) => void;
  move: (x: number, z: number, ry: number, anim: AnimState) => void;
  profile: (patch: PlayerPatch) => void;
  chat: (text: string, scope: ChatScope, to?: string) => void;
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
