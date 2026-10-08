import { sanitizeName } from './avatar';
import { getEntry, rotateLocal } from './catalog';
import { itemBox, itemFootprint, zoneAt } from './geometry';
import { applyOp, OpError } from './office';
import { clip } from './text';
import type { Office, OfficeItem, Zone } from './types';

// Small things in the world people can use: lamps and light switches, desk monitors that wake up
// when someone sits down, desks people claim, and the sticky notes others leave on them.

// ---------- Lights ----------

/** A lamp's or a light switch's data. Lights are on unless switched off. */
export interface LightData {
  on: boolean;
}

export const LAMP_TYPES = ['floor-lamp', 'desk-lamp'];
export const SWITCH_TYPE = 'light-switch';

export function sanitizeLightData(raw: unknown): LightData {
  return { on: !(raw && typeof raw === 'object' && (raw as { on?: unknown }).on === false) };
}

export function isLamp(item: OfficeItem | undefined): boolean {
  return !!item && LAMP_TYPES.includes(item.type);
}

export function isLightSwitch(item: OfficeItem | undefined): boolean {
  return item?.type === SWITCH_TYPE;
}

export function isLightOn(item: OfficeItem): boolean {
  return (item.data as Partial<LightData> | undefined)?.on !== false;
}

/** The area outside every private area. */
export const OPEN_AREA = 'open';

/** The private area at a point (its zone id), or OPEN_AREA. */
export function areaAt(zones: Zone[], x: number, z: number): string {
  return zoneAt(zones, x, z)?.id ?? OPEN_AREA;
}

/**
 * The area a light switch works the lights of: where you stand to use it, just in front of it.
 * (A switch on a room's wall is in the room, even when the room's area starts a step from the wall.)
 */
export function switchArea(zones: Zone[], item: OfficeItem): string {
  const front = rotateLocal(0, 0.8, item.rot);
  return areaAt(zones, item.x + front.x, item.z + front.z);
}

/**
 * Areas whose ceiling lights are off: every light switch in them is off. Areas without a switch
 * are always lit.
 */
export function darkAreas(office: Pick<Office, 'items' | 'zones'>): Set<string> {
  const lit = new Map<string, boolean>();
  for (const item of office.items) {
    if (!isLightSwitch(item)) continue;
    const area = switchArea(office.zones, item);
    lit.set(area, lit.get(area) === true || isLightOn(item));
  }
  return new Set([...lit].filter(([, on]) => !on).map(([area]) => area));
}

export type WorldChange = { office: Office; items: OfficeItem[] } | { error: string };

/** Updates items' data (through applyOp, so they are checked as usual). */
function withData(office: Office, changes: { item: OfficeItem; data: unknown }[]): WorldChange {
  let next = office;
  try {
    for (const { item, data } of changes) next = applyOp(next, { t: 'update', item: { ...item, data: data as OfficeItem['data'] } });
  } catch (err) {
    return { error: err instanceof OpError ? err.message : 'That didn’t work.' };
  }
  return { office: next, items: changes.map(({ item }) => next.items.find((i) => i.id === item.id)!) };
}

/**
 * Turns a lamp on or off, or, for a light switch, the lights of its whole area: every switch in
 * the area follows, so any of them works the lights. Anyone in the office may do this.
 */
export function setLight(office: Office, itemId: string, on: boolean): WorldChange {
  const item = office.items.find((i) => i.id === itemId);
  if (!item || !(isLamp(item) || isLightSwitch(item))) return { error: 'That light is gone.' };
  const area = isLightSwitch(item) ? switchArea(office.zones, item) : null;
  const targets = area ? office.items.filter((i) => isLightSwitch(i) && switchArea(office.zones, i) === area) : [item];
  return withData(office, targets.filter((t) => isLightOn(t) !== on).map((t) => ({ item: t, data: { on } })));
}

/** The floor's unit cells, grouped by the area they belong to (to draw darkened areas). */
export function areaCells(zones: Zone[], width: number, depth: number): Map<string, { x: number; z: number }[]> {
  const out = new Map<string, { x: number; z: number }[]>();
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      const area = areaAt(zones, x + 0.5, z + 0.5);
      let list = out.get(area);
      if (!list) out.set(area, (list = []));
      list.push({ x, z });
    }
  }
  return out;
}

// ---------- Furniture ----------

/** Heights of the tops that small things (desk lamps, small plants) can stand on. */
const SURFACES: Record<string, number> = {
  desk: 0.625,
  'meeting-table': 0.63,
  reception: 0.945,
  counter: 0.845,
  'coffee-machine': 0.845,
  'coffee-table': 0.345,
  'round-table': 0.62,
  bookshelf: 1.995,
};

/** How high above the floor an item that stands on surfaces sits: on whatever is under its centre. */
export function surfaceHeight(items: OfficeItem[], item: Pick<OfficeItem, 'id' | 'x' | 'z'>): number {
  let best = 0;
  for (const other of items) {
    const top = SURFACES[other.type];
    if (top === undefined || top <= best || other.id === item.id) continue;
    const f = itemFootprint(other);
    if (f && item.x > f.minX && item.x < f.maxX && item.z > f.minZ && item.z < f.maxZ) best = top;
  }
  return best;
}

const WALL_TYPES = ['wall', 'wall-short', 'glass-wall', 'partition'];

/**
 * Where a wall-mounted item's back goes, as a local z offset (it faces +z): against the wall just
 * behind it, or the back of its footprint (the office's outer walls, or no wall at all).
 */
export function wallMountZ(items: OfficeItem[], item: OfficeItem): number {
  const d = getEntry(item.type)?.d ?? 0.5;
  const back = rotateLocal(0, -1, item.rot);
  // Probe just behind the item's centre for a wall.
  const px = item.x + back.x * (d / 2);
  const pz = item.z + back.z * (d / 2);
  for (const other of items) {
    if (!WALL_TYPES.includes(other.type)) continue;
    const b = itemBox(other);
    if (!b || px < b.minX - 0.01 || px > b.maxX + 0.01 || pz < b.minZ - 0.01 || pz > b.maxZ + 0.01) continue;
    // The wall's face towards the item, measured from the item's centre along its back direction.
    const face = back.x !== 0 ? (back.x > 0 ? b.minX - item.x : item.x - b.maxX) : back.z > 0 ? b.minZ - item.z : item.z - b.maxZ;
    return -Math.max(0, Math.min(d / 2, face));
  }
  return -d / 2;
}

/**
 * Which desk each office chair works at: the chair faces the desk's front from at most ~1.3 m in
 * front of it (and not off its side), and the desk's monitor faces the chair.
 */
export function pairChairsWithDesks(items: OfficeItem[]): Map<string, string> {
  const desks = items.filter((i) => i.type === 'desk');
  const pairs = new Map<string, string>();
  for (const chair of items) {
    if (chair.type !== 'chair') continue;
    const facing = rotateLocal(0, 1, chair.rot);
    let best: { id: string; d: number } | null = null;
    for (const desk of desks) {
      const front = rotateLocal(0, 1, desk.rot);
      if (facing.x * front.x + facing.z * front.z > -0.7) continue;
      const dx = chair.x - desk.x;
      const dz = chair.z - desk.z;
      const ahead = dx * front.x + dz * front.z;
      const aside = Math.abs(dx * front.z - dz * front.x);
      if (ahead < 0.3 || ahead > 1.3 || aside > 0.75) continue;
      const d = Math.hypot(dx, dz);
      if (!best || d < best.d) best = { id: desk.id, d };
    }
    if (best) pairs.set(chair.id, best.id);
  }
  return pairs;
}

// ---------- Desks ----------

/** A claimed desk's data. */
export interface DeskData {
  ownerUserId: string;
  ownerName: string;
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function sanitizeDeskData(raw: unknown): DeskData | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.ownerUserId !== 'string' || !USER_ID.test(r.ownerUserId)) return undefined;
  return { ownerUserId: r.ownerUserId, ownerName: sanitizeName(r.ownerName) || 'Someone' };
}

export function deskOwner(item: OfficeItem | undefined): DeskData | null {
  if (item?.type !== 'desk') return null;
  return sanitizeDeskData(item.data) ?? null;
}

/** The desk someone has claimed in an office, if any. */
export function deskOf(office: Pick<Office, 'items'>, userId: string): OfficeItem | undefined {
  return office.items.find((i) => deskOwner(i)?.ownerUserId === userId);
}

/** Claims a desk for a signed-in person, freeing the one they had (one desk per person per office). */
export function claimDesk(office: Office, itemId: string, user: { id: string; name: string }): WorldChange {
  const desk = office.items.find((i) => i.id === itemId);
  if (desk?.type !== 'desk') return { error: 'That desk is gone.' };
  const owner = deskOwner(desk);
  if (owner?.ownerUserId === user.id) return { office, items: [] };
  if (owner) return { error: `This is ${owner.ownerName}’s desk.` };
  const previous = office.items.filter((i) => deskOwner(i)?.ownerUserId === user.id);
  return withData(office, [
    ...previous.map((item) => ({ item, data: undefined })),
    { item: desk, data: { ownerUserId: user.id, ownerName: user.name } satisfies DeskData },
  ]);
}

/** Keeps the name plate on someone's desk in step with their name. */
export function renameDeskOwner(office: Office, user: { id: string; name: string }): WorldChange {
  const desk = deskOf(office, user.id);
  if (!desk || deskOwner(desk)?.ownerName === user.name) return { office, items: [] };
  return withData(office, [{ item: desk, data: { ownerUserId: user.id, ownerName: user.name } satisfies DeskData }]);
}

/** Frees a desk: its owner may, and so may anyone who can edit the office. */
export function releaseDesk(office: Office, itemId: string, actor: { userId: string | null; mayEdit: boolean }): WorldChange {
  const desk = office.items.find((i) => i.id === itemId);
  if (desk?.type !== 'desk') return { error: 'That desk is gone.' };
  const owner = deskOwner(desk);
  if (!owner) return { office, items: [] };
  if (owner.ownerUserId !== actor.userId && !actor.mayEdit) return { error: 'Only its owner, or someone who can edit this office, can free a desk.' };
  return withData(office, [{ item: desk, data: undefined }]);
}

// ---------- Desk notes ----------

/** Sticky-note colours: yellow, pink, green, blue. */
export const NOTE_COLORS = ['#ffe066', '#ffa8c5', '#a3e4a8', '#9fd4ff'];
export const MAX_NOTE_LENGTH = 500;
/** Notes a desk owner can have in an office; past it, the oldest read ones make room. */
export const MAX_NOTES_PER_DESK = 50;
/** Unread notes from guests a desk takes (anyone with the link is a guest), leaving room for coworkers'. */
export const MAX_GUEST_NOTES_PER_DESK = 10;
/** A guest's secret for deleting the notes they left (kept in their browser). */
export const GUEST_KEY = /^[A-Za-z0-9_-]{20,64}$/;

/** A note on someone's desk. Only the desk's owner, and whoever wrote it, ever get its text. */
export interface DeskNote {
  id: string;
  ownerUserId: string;
  authorName: string;
  /** Left by a guest: anyone with the office's link, under any name. */
  byGuest: boolean;
  text: string;
  color: string;
  createdAt: number;
  readAt: number | null;
}

/** What everyone sees of a desk's notes: how many, and the colours of the top few (oldest first). */
export interface StickySummary {
  count: number;
  colors: string[];
}

export const VISIBLE_STICKIES = 5;

export function sanitizeNoteText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clip(text, MAX_NOTE_LENGTH).trim();
}

export function sanitizeNoteColor(raw: unknown): string {
  return typeof raw === 'string' && NOTE_COLORS.includes(raw.toLowerCase()) ? raw.toLowerCase() : NOTE_COLORS[0];
}

/** Who wrote a note, as the server keeps it. */
export interface NoteAuthorship {
  ownerUserId: string;
  authorUserId: string | null;
  /** SHA-256 of the guest key of a guest author. */
  authorKey: string | null;
}

/** Someone acting on notes: their account (null for guests) and the hash of their guest key, if any. */
export interface NoteActor {
  userId: string | null;
  guestKeyHash: string | null;
}

/** Whoever wrote a note (guests by their key), and the desk's owner, may throw it away. */
export function mayDeleteNote(note: NoteAuthorship, actor: NoteActor): boolean {
  if (actor.userId && (actor.userId === note.ownerUserId || actor.userId === note.authorUserId)) return true;
  return !!note.authorKey && !!actor.guestKeyHash && note.authorKey === actor.guestKeyHash;
}

/** Anyone may leave a note on a claimed desk, except on their own. Returns why not, or null. */
export function whyNoNote(desk: OfficeItem | undefined, author: { userId: string | null }): string | null {
  if (desk?.type !== 'desk') return 'That desk is gone.';
  const owner = deskOwner(desk);
  if (!owner) return 'Nobody has claimed this desk yet.';
  if (owner.ownerUserId === author.userId) return 'That’s your own desk.';
  return null;
}

// ---------- Socket events ----------

export type WorldResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

declare module './types' {
  interface ClientToServerEvents {
    /** Turn a lamp, or the lights of a light switch's area, on or off. Anyone in the office may. */
    'world:light': (itemId: string, on: boolean) => void;
    /** Make a desk yours (signed-in people only; frees the desk you had in this office). */
    'desk:claim': (itemId: string, ack: (res: WorldResult) => void) => void;
    /** Free a desk (its owner, or anyone who can edit the office). */
    'desk:release': (itemId: string, ack: (res: WorldResult) => void) => void;
    /** Leave a note on someone's desk. Guests send their guest key so they can delete it later. */
    'desk:note': (
      itemId: string,
      note: { text: string; color: string; guestKey?: string | null },
      ack: (res: WorldResult<{ note: DeskNote }>) => void,
    ) => void;
    /** The notes on your desk in this office, newest first. */
    'desk:notes': (ack: (res: WorldResult<{ notes: DeskNote[] }>) => void) => void;
    /** The notes you left on someone's desk in this office. */
    'desk:authored': (ownerUserId: string, guestKey: string | null, ack: (res: WorldResult<{ notes: DeskNote[] }>) => void) => void;
    /** Mark one note on your desk (or 'all') as read. */
    'desk:note:read': (id: string, ack: (res: WorldResult) => void) => void;
    'desk:note:delete': (id: string, guestKey: string | null, ack: (res: WorldResult) => void) => void;
  }
  interface ServerToClientEvents {
    /** Note counts and colours by desk owner: all of them (replace) or the ones that changed. */
    'desk:stickies': (stickies: Record<string, StickySummary>, replace: boolean) => void;
    /** Someone left you a note (sent to every tab of yours, in any office). */
    'desk:note:new': (note: DeskNote, officeId: string, officeName: string) => void;
    /** How many unread notes you have on your desk in an office. */
    'desk:inbox': (officeId: string, unread: number) => void;
  }
}
