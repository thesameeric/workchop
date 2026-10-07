import { isHexColor, sanitizeName } from './avatar';
import { getEntry, rotatedSize, snapCoord } from './catalog';
import type { BuildPolicy, FloorStyle, Office, OfficeItem, OfficeOp, OfficeSettings, Zone } from './types';

export const FLOOR_STYLES: FloorStyle[] = ['wood', 'carpet', 'tile', 'concrete'];
export const MIN_SIZE = 8;
export const MAX_SIZE = 80;
export const MAX_ITEMS = 1500;
export const MAX_ZONES = 50;
export const ZONE_COLORS = ['#6c8cff', '#ff9f6c', '#4cc9a0', '#e66cff', '#ffd166', '#ff6b8b'];

const ID = /^[A-Za-z0-9_-]{1,40}$/;

export function isValidId(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v);
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Validate an item and snap it onto the grid inside the office. Returns null if unusable. */
export function sanitizeItem(raw: unknown, bounds: Pick<OfficeSettings, 'width' | 'depth'>): OfficeItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isValidId(r.id) || typeof r.type !== 'string') return null;
  const entry = getEntry(r.type);
  if (!entry || !finite(r.x) || !finite(r.z)) return null;
  const rot = finite(r.rot) ? ((Math.round(r.rot) % 4) + 4) % 4 : 0;
  const { w, d } = rotatedSize(entry.w, entry.d, rot);
  const x = clamp(snapCoord(r.x, w, entry.snapCenter), w / 2, bounds.width - w / 2);
  const z = clamp(snapCoord(r.z, d, entry.snapCenter), d / 2, bounds.depth - d / 2);
  const item: OfficeItem = { id: r.id, type: entry.type, x: round(x), z: round(z), rot };
  if (entry.colorable && isHexColor(r.color)) item.color = r.color.toLowerCase();
  return item;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function sanitizeZone(raw: unknown, bounds: Pick<OfficeSettings, 'width' | 'depth'>): Zone | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isValidId(r.id) || !finite(r.x) || !finite(r.z) || !finite(r.w) || !finite(r.d)) return null;
  const x = clamp(Math.round(r.x), 0, bounds.width - 1);
  const z = clamp(Math.round(r.z), 0, bounds.depth - 1);
  const w = clamp(Math.round(r.w), 1, bounds.width - x);
  const d = clamp(Math.round(r.d), 1, bounds.depth - z);
  const name = sanitizeName(r.name) || 'Private area';
  const color = isHexColor(r.color) ? r.color.toLowerCase() : ZONE_COLORS[0];
  return { id: r.id, name, x, z, w, d, color };
}

/** Validate a partial settings update against the current settings. */
export function sanitizeSettings(raw: unknown, current: OfficeSettings): OfficeSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const next: OfficeSettings = { ...current, spawn: { ...current.spawn } };
  if (typeof r.name === 'string') next.name = sanitizeName(r.name, 48) || current.name;
  if (finite(r.width)) next.width = clamp(Math.round(r.width), MIN_SIZE, MAX_SIZE);
  if (finite(r.depth)) next.depth = clamp(Math.round(r.depth), MIN_SIZE, MAX_SIZE);
  if (typeof r.floor === 'string' && (FLOOR_STYLES as string[]).includes(r.floor)) next.floor = r.floor as FloorStyle;
  if (isHexColor(r.floorColor)) next.floorColor = r.floorColor.toLowerCase();
  if (isHexColor(r.wallColor)) next.wallColor = r.wallColor.toLowerCase();
  if (r.buildPolicy === 'everyone' || r.buildPolicy === 'owner') next.buildPolicy = r.buildPolicy as BuildPolicy;
  const spawn = r.spawn as Record<string, unknown> | undefined;
  if (spawn && finite(spawn.x) && finite(spawn.z)) next.spawn = { x: round(spawn.x), z: round(spawn.z) };
  next.spawn = {
    x: clamp(next.spawn.x, 0.5, next.width - 0.5),
    z: clamp(next.spawn.z, 0.5, next.depth - 0.5),
  };
  return next;
}

export class OpError extends Error {}

/**
 * Apply an edit to an office, returning a new office object (unchanged items keep their identity,
 * which lets React skip re-rendering them). Throws OpError for invalid edits.
 */
export function applyOp(office: Office, op: OfficeOp): Office {
  const bounds = office.settings;
  const now = Date.now();
  switch (op?.t) {
    case 'add': {
      if (office.items.length >= MAX_ITEMS) throw new OpError('Too many items in this office');
      const item = sanitizeItem(op.item, bounds);
      if (!item) throw new OpError('Invalid item');
      if (office.items.some((i) => i.id === item.id)) throw new OpError('Duplicate item id');
      return { ...office, items: [...office.items, item], updatedAt: now };
    }
    case 'update': {
      const item = sanitizeItem(op.item, bounds);
      if (!item) throw new OpError('Invalid item');
      const idx = office.items.findIndex((i) => i.id === item.id);
      if (idx < 0) throw new OpError('Unknown item');
      const items = office.items.slice();
      items[idx] = item;
      return { ...office, items, updatedAt: now };
    }
    case 'remove': {
      if (!office.items.some((i) => i.id === op.id)) throw new OpError('Unknown item');
      return { ...office, items: office.items.filter((i) => i.id !== op.id), updatedAt: now };
    }
    case 'zone:add': {
      if (office.zones.length >= MAX_ZONES) throw new OpError('Too many zones');
      const zone = sanitizeZone(op.zone, bounds);
      if (!zone) throw new OpError('Invalid zone');
      if (office.zones.some((z) => z.id === zone.id)) throw new OpError('Duplicate zone id');
      return { ...office, zones: [...office.zones, zone], updatedAt: now };
    }
    case 'zone:update': {
      const zone = sanitizeZone(op.zone, bounds);
      if (!zone) throw new OpError('Invalid zone');
      const idx = office.zones.findIndex((z) => z.id === zone.id);
      if (idx < 0) throw new OpError('Unknown zone');
      const zones = office.zones.slice();
      zones[idx] = zone;
      return { ...office, zones, updatedAt: now };
    }
    case 'zone:remove': {
      if (!office.zones.some((z) => z.id === op.id)) throw new OpError('Unknown zone');
      return { ...office, zones: office.zones.filter((z) => z.id !== op.id), updatedAt: now };
    }
    case 'settings': {
      const settings = sanitizeSettings(op.settings, office.settings);
      const resized = settings.width !== office.settings.width || settings.depth !== office.settings.depth;
      if (!resized) return { ...office, settings, updatedAt: now };
      // Shrinking the floor drops whatever no longer fits and trims zones.
      const items = office.items
        .map((i) => {
          const entry = getEntry(i.type)!;
          const { w, d } = rotatedSize(entry.w, entry.d, i.rot);
          return i.x + w / 2 <= settings.width && i.z + d / 2 <= settings.depth ? i : null;
        })
        .filter((i): i is OfficeItem => i !== null);
      const zones = office.zones
        .filter((z) => z.x < settings.width - 1 && z.z < settings.depth - 1)
        .map((z) => sanitizeZone(z, settings)!)
        .filter(Boolean);
      return { ...office, settings, items, zones, updatedAt: now };
    }
    default:
      throw new OpError('Unknown operation');
  }
}

/** Checks a whole office loaded from disk; drops anything invalid rather than failing. */
export function sanitizeOffice(raw: unknown): Office | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isValidId(r.id)) return null;
  const settings = sanitizeSettings(r.settings, defaultSettings('Office'));
  const items = (Array.isArray(r.items) ? r.items : [])
    .map((i) => sanitizeItem(i, settings))
    .filter((i): i is OfficeItem => i !== null)
    .slice(0, MAX_ITEMS);
  const zones = (Array.isArray(r.zones) ? r.zones : [])
    .map((z) => sanitizeZone(z, settings))
    .filter((z): z is Zone => z !== null)
    .slice(0, MAX_ZONES);
  return {
    id: r.id,
    settings,
    items,
    zones,
    createdAt: finite(r.createdAt) ? r.createdAt : Date.now(),
    updatedAt: finite(r.updatedAt) ? r.updatedAt : Date.now(),
  };
}

export function defaultSettings(name: string): OfficeSettings {
  return {
    name,
    width: 20,
    depth: 16,
    floor: 'wood',
    floorColor: '#c9a27e',
    wallColor: '#e9e4f2',
    spawn: { x: 10, z: 8 },
    buildPolicy: 'everyone',
  };
}
