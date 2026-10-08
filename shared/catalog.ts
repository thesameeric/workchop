import { sanitizeJukeboxData } from './music';
import type { OfficeItem } from './types';
import { sanitizeDeskData, sanitizeLightData } from './world';

export type Category = 'Work' | 'Lounge' | 'Kitchen' | 'Structure' | 'Decor' | 'Plants' | 'Fun';
export const CATEGORIES: Category[] = ['Work', 'Lounge', 'Kitchen', 'Structure', 'Decor', 'Plants', 'Fun'];

export interface CatalogEntry {
  type: string;
  label: string;
  icon: string;
  category: Category;
  /** Footprint at rot 0: extent along x and z, in world units (1 unit = 1 floor tile). */
  w: number;
  d: number;
  /** Rough height, used for selection boxes and camera cut-away. */
  h: number;
  /** Whether people collide with it. */
  solid: boolean;
  /** Collision box size when it differs from the footprint. */
  box?: { w: number; d: number };
  /** Local seat offsets; a seated person faces the item's forward (+z at rot 0). */
  seats?: { x: number; z: number }[];
  colorable?: boolean;
  defaultColor?: string;
  /** Tall opaque items fade out when they block the view of your character. */
  tall?: boolean;
  /** Thin items (walls) snap their centre to grid lines instead of their corner. */
  snapCenter?: boolean;
  /** Plays music for people nearby (see shared/music.ts). */
  music?: boolean;
  /** Small things (desk lamps, small plants) stand on a desk, table or shelf placed under them. */
  onSurfaces?: boolean;
  /**
   * Checks the item's `data` (untrusted: it comes from clients and saved offices) and returns the
   * clean value, or undefined for none. Items without it never keep data.
   */
  sanitizeData?(raw: unknown): unknown;
}

const entries: CatalogEntry[] = [
  // Work
  // A wrapper (like the jukebox's below), so the import cycle with world.ts doesn't matter.
  { type: 'desk', label: 'Desk', icon: '🖥️', category: 'Work', w: 2, d: 1, h: 1.2, solid: true, colorable: true, defaultColor: '#c8a27a', sanitizeData: (raw) => sanitizeDeskData(raw) },
  { type: 'chair', label: 'Office chair', icon: '🪑', category: 'Work', w: 1, d: 1, h: 1.1, solid: false, seats: [{ x: 0, z: 0 }], colorable: true, defaultColor: '#2b2d42' },
  { type: 'meeting-table', label: 'Meeting table', icon: '🟫', category: 'Work', w: 4, d: 2, h: 0.75, solid: true, colorable: true, defaultColor: '#8d6e63' },
  { type: 'reception', label: 'Reception desk', icon: '🛎️', category: 'Work', w: 3, d: 1, h: 1.1, solid: true, colorable: true, defaultColor: '#f2f2f2' },
  { type: 'whiteboard', label: 'Whiteboard', icon: '📋', category: 'Work', w: 2, d: 0.5, h: 1.9, solid: true, box: { w: 2, d: 0.3 }, tall: true },
  { type: 'tv', label: 'TV screen', icon: '📺', category: 'Work', w: 2, d: 0.5, h: 1.7, solid: true, tall: true },
  { type: 'bookshelf', label: 'Bookshelf', icon: '📚', category: 'Work', w: 2, d: 0.5, h: 2, solid: true, colorable: true, defaultColor: '#a47148', tall: true },
  { type: 'printer', label: 'Printer', icon: '🖨️', category: 'Work', w: 1, d: 0.8, h: 1, solid: true },

  // Lounge
  { type: 'sofa', label: 'Sofa', icon: '🛋️', category: 'Lounge', w: 2, d: 1, h: 0.9, solid: true, seats: [{ x: -0.5, z: -0.05 }, { x: 0.5, z: -0.05 }], colorable: true, defaultColor: '#2a9d8f' },
  { type: 'armchair', label: 'Armchair', icon: '💺', category: 'Lounge', w: 1, d: 1, h: 0.9, solid: true, seats: [{ x: 0, z: -0.05 }], colorable: true, defaultColor: '#4cc9f0' },
  { type: 'beanbag', label: 'Beanbag', icon: '🫘', category: 'Lounge', w: 1, d: 1, h: 0.6, solid: false, seats: [{ x: 0, z: 0.14 }], colorable: true, defaultColor: '#ef476f' },
  { type: 'stool', label: 'Stool', icon: '🍄', category: 'Lounge', w: 1, d: 1, h: 0.7, solid: false, seats: [{ x: 0, z: 0 }], colorable: true, defaultColor: '#e9c46a' },
  { type: 'coffee-table', label: 'Coffee table', icon: '🟤', category: 'Lounge', w: 2, d: 1, h: 0.4, solid: true, colorable: true, defaultColor: '#d4a373' },
  { type: 'round-table', label: 'Café table', icon: '⚪', category: 'Lounge', w: 1, d: 1, h: 0.75, solid: true, box: { w: 0.8, d: 0.8 }, colorable: true, defaultColor: '#f2f2f2' },
  { type: 'rug', label: 'Rug', icon: '🟥', category: 'Lounge', w: 3, d: 2, h: 0.02, solid: false, colorable: true, defaultColor: '#e76f51' },
  { type: 'rug-round', label: 'Round rug', icon: '⭕', category: 'Lounge', w: 2, d: 2, h: 0.02, solid: false, colorable: true, defaultColor: '#9b5de5' },

  // Kitchen
  { type: 'counter', label: 'Counter', icon: '🚰', category: 'Kitchen', w: 2, d: 1, h: 0.95, solid: true, colorable: true, defaultColor: '#f2f2f2' },
  { type: 'coffee-machine', label: 'Coffee station', icon: '☕', category: 'Kitchen', w: 1, d: 1, h: 1.4, solid: true, colorable: true, defaultColor: '#f2f2f2' },
  { type: 'fridge', label: 'Fridge', icon: '🧊', category: 'Kitchen', w: 1, d: 1, h: 1.9, solid: true, colorable: true, defaultColor: '#dfe6e9', tall: true },
  { type: 'vending', label: 'Vending machine', icon: '🥤', category: 'Kitchen', w: 1, d: 1, h: 1.9, solid: true, colorable: true, defaultColor: '#ef476f', tall: true },
  { type: 'water-cooler', label: 'Water cooler', icon: '💧', category: 'Kitchen', w: 0.5, d: 0.5, h: 1.3, solid: true },

  // Structure
  { type: 'wall', label: 'Wall', icon: '🧱', category: 'Structure', w: 2, d: 0.2, h: 2.6, solid: true, colorable: true, defaultColor: '#e8e4dc', tall: true, snapCenter: true },
  { type: 'wall-short', label: 'Wall (short)', icon: '▫️', category: 'Structure', w: 1, d: 0.2, h: 2.6, solid: true, colorable: true, defaultColor: '#e8e4dc', tall: true, snapCenter: true },
  { type: 'glass-wall', label: 'Glass wall', icon: '🪟', category: 'Structure', w: 2, d: 0.15, h: 2.6, solid: true, snapCenter: true },
  { type: 'partition', label: 'Partition', icon: '🚧', category: 'Structure', w: 2, d: 0.15, h: 1.2, solid: true, colorable: true, defaultColor: '#7f8c8d', snapCenter: true },
  // Switches the lights of the area it's in (see shared/world.ts); its back goes against a wall.
  { type: 'light-switch', label: 'Light switch', icon: '🎚️', category: 'Structure', w: 0.5, d: 0.5, h: 1.4, solid: false, sanitizeData: (raw) => sanitizeLightData(raw) },

  // Decor
  { type: 'floor-lamp', label: 'Floor lamp', icon: '💡', category: 'Decor', w: 0.5, d: 0.5, h: 1.8, solid: true, colorable: true, defaultColor: '#ffe8a3', sanitizeData: (raw) => sanitizeLightData(raw) },
  { type: 'desk-lamp', label: 'Desk lamp', icon: '🔦', category: 'Decor', w: 0.5, d: 0.5, h: 1.3, solid: false, colorable: true, defaultColor: '#e9c46a', onSurfaces: true, sanitizeData: (raw) => sanitizeLightData(raw) },
  { type: 'art', label: 'Wall art', icon: '🖼️', category: 'Decor', w: 1.5, d: 0.1, h: 2.2, solid: false, colorable: true, defaultColor: '#4cc9f0', snapCenter: true },

  // Plants (what each one is: shared/plants.ts). Small ones also stand on desks, tables and shelves.
  { type: 'plant', label: 'Boston fern', icon: '🪴', category: 'Plants', w: 1, d: 1, h: 1.1, solid: true, box: { w: 0.6, d: 0.6 } },
  { type: 'tall-plant', label: 'Weeping fig', icon: '🌿', category: 'Plants', w: 1, d: 1, h: 2.1, solid: true, box: { w: 0.6, d: 0.6 } },
  { type: 'monstera', label: 'Monstera', icon: '🍃', category: 'Plants', w: 1, d: 1, h: 1.4, solid: true, box: { w: 0.7, d: 0.7 } },
  { type: 'snake-plant', label: 'Snake plant', icon: '🌱', category: 'Plants', w: 1, d: 1, h: 1.1, solid: true, box: { w: 0.5, d: 0.5 } },
  { type: 'fiddle-leaf', label: 'Fiddle-leaf fig', icon: '🌳', category: 'Plants', w: 1, d: 1, h: 2.2, solid: true, box: { w: 0.6, d: 0.6 } },
  { type: 'bird-of-paradise', label: 'Bird of paradise', icon: '🐦', category: 'Plants', w: 1, d: 1, h: 2, solid: true, box: { w: 0.6, d: 0.6 } },
  { type: 'rubber-plant', label: 'Rubber plant', icon: '🌴', category: 'Plants', w: 1, d: 1, h: 1.8, solid: true, box: { w: 0.6, d: 0.6 } },
  { type: 'zz-plant', label: 'ZZ plant', icon: '🎋', category: 'Plants', w: 1, d: 1, h: 1, solid: true, box: { w: 0.5, d: 0.5 } },
  { type: 'pothos', label: 'Golden pothos', icon: '☘️', category: 'Plants', w: 0.5, d: 0.5, h: 1.3, solid: true, box: { w: 0.4, d: 0.4 }, onSurfaces: true },
  { type: 'peace-lily', label: 'Peace lily', icon: '🕊️', category: 'Plants', w: 0.5, d: 0.5, h: 1.3, solid: true, box: { w: 0.4, d: 0.4 }, onSurfaces: true },
  { type: 'cactus', label: 'Barrel cactus', icon: '🌵', category: 'Plants', w: 0.5, d: 0.5, h: 1.3, solid: true, box: { w: 0.4, d: 0.4 }, onSurfaces: true },
  { type: 'bonsai', label: 'Bonsai', icon: '🎍', category: 'Plants', w: 0.5, d: 0.5, h: 1.3, solid: true, box: { w: 0.4, d: 0.4 }, onSurfaces: true },
  { type: 'lavender', label: 'Lavender', icon: '💜', category: 'Plants', w: 0.5, d: 0.5, h: 1.3, solid: true, box: { w: 0.4, d: 0.4 }, onSurfaces: true },

  // Fun
  { type: 'ping-pong', label: 'Ping pong', icon: '🏓', category: 'Fun', w: 3, d: 2, h: 0.9, solid: true, box: { w: 2.8, d: 1.6 } },
  // A wrapper, so the import cycle with music.ts doesn't matter (it is resolved only when called).
  { type: 'jukebox', label: 'Jukebox', icon: '🎵', category: 'Fun', w: 1, d: 1, h: 1.6, solid: true, box: { w: 0.9, d: 0.7 }, colorable: true, defaultColor: '#e63946', music: true, sanitizeData: (raw) => sanitizeJukeboxData(raw) },
  { type: 'arcade', label: 'Arcade cabinet', icon: '🕹️', category: 'Fun', w: 1, d: 1, h: 1.8, solid: true, box: { w: 0.9, d: 0.8 }, colorable: true, defaultColor: '#9b5de5', tall: true },
];

export const CATALOG: Record<string, CatalogEntry> = Object.fromEntries(entries.map((e) => [e.type, e]));
export const CATALOG_LIST = entries;

export function getEntry(type: string): CatalogEntry | undefined {
  return Object.prototype.hasOwnProperty.call(CATALOG, type) ? CATALOG[type] : undefined;
}

/** Footprint extents for a rotation (odd quarter turns swap the axes). */
export function rotatedSize(w: number, d: number, rot: number): { w: number; d: number } {
  return rot % 2 === 0 ? { w, d } : { w: d, d: w };
}

/** Rotate a local offset by the item's rotation (matches three.js rotation.y = rot * PI/2). */
export function rotateLocal(lx: number, lz: number, rot: number): { x: number; z: number } {
  const a = (rot * Math.PI) / 2;
  const c = Math.round(Math.cos(a));
  const s = Math.round(Math.sin(a));
  return { x: lx * c + lz * s, z: -lx * s + lz * c };
}

export interface Seat {
  x: number;
  z: number;
  /** Facing angle (three.js rotation.y). */
  ry: number;
}

export function seatsOf(item: OfficeItem): Seat[] {
  const entry = getEntry(item.type);
  if (!entry?.seats) return [];
  return entry.seats.map((s) => {
    const o = rotateLocal(s.x, s.z, item.rot);
    return { x: item.x + o.x, z: item.z + o.z, ry: (item.rot * Math.PI) / 2 };
  });
}

/** Snap a centre coordinate so the item lines up with the half-tile grid. */
export function snapCoord(v: number, size: number, snapCenter = false): number {
  const g = 0.5;
  if (snapCenter) return Math.round(v / g) * g;
  return Math.round((v - size / 2) / g) * g + size / 2;
}
