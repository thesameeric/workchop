import { sanitizeItem, sanitizeZone } from '../../../shared/office';
import type { ItemData, Office, OfficeItem, OfficeSettings, Zone } from '../../../shared/types';

// The small office on the landing page: a meeting room, a desk pod, a help desk with its waiting
// area, a ping pong table and a lounge with a music corner. x runs east and z south (towards the
// camera); rot is in quarter turns, and at rot 0 an item faces south.

const SETTINGS: OfficeSettings = {
  name: 'Homeoffice',
  width: 20,
  depth: 13,
  floor: 'wood',
  floorColor: '#c9a27e',
  wallColor: '#e9e4f2',
  spawn: { x: 10, z: 6.5 },
  buildPolicy: 'everyone',
};

type Row = [type: string, x: number, z: number, rot?: number, color?: string, data?: ItemData];

const ROWS: Row[] = [
  // Meeting room: glass on the south and east sides, with a door in the east wall at z 2–3.
  ['glass-wall', 1, 5],
  ['glass-wall', 3, 5],
  ['glass-wall', 5, 5],
  ['glass-wall', 7, 5],
  ['glass-wall', 8, 1, 1],
  ['glass-wall', 8, 4, 1],
  ['meeting-table', 4, 2.5],
  ['chair', 3, 1],
  ['chair', 5, 1],
  ['chair', 3, 4, 2],
  ['chair', 5, 4, 2],
  ['whiteboard', 0.25, 2.5, 1],
  ['art', 4, 0.05, 0, '#ff924c'],
  ['plant', 0.5, 0.5],
  ['plant', 7.5, 0.5],
  ['zz-plant', 0.5, 4.5],
  // Desk pod.
  ['desk', 10, 2.5, 2],
  ['desk', 12, 2.5, 2],
  ['desk', 10, 3.5],
  ['desk', 12, 3.5],
  ['chair', 10, 1.5],
  ['chair', 12, 1.5],
  ['chair', 10, 4.5, 2, '#2a9d8f'],
  ['chair', 12, 4.5, 2, '#2a9d8f'],
  ['bookshelf', 11, 0.25, 0, '#6d4c41'],
  ['tall-plant', 13.5, 0.5],
  ['coffee-machine', 14.5, 0.5],
  ['water-cooler', 15.25, 0.25],
  // Help desk, turned so staff (east) and customers (west) sit side by side as the camera sees them.
  ['support-desk', 17, 2.5, 3],
  ['info-board', 19, 0.25, 0, '#5b6cff', { title: 'Help desk', text: 'Take a seat by the fish tank. We’ll call you when it’s your turn.' }],
  ['monstera', 19.5, 4.5],
  // Waiting area and the entrance.
  ['aquarium', 17, 6.5],
  ['rug', 17, 9, 0, '#4361ee'],
  ['sofa', 17, 9, 2, '#3d405b'],
  ['fiddle-leaf', 19.5, 8.5],
  ['zz-plant', 14.5, 9.5],
  ['rug', 17, 12, 0, '#3d405b'],
  ['floor-lamp', 19.5, 11.5],
  // Ping pong.
  ['ping-pong', 10, 9],
  // Lounge and music corner.
  ['rug', 3.5, 10.5, 0, '#e76f51'],
  ['sofa', 3.5, 8.5, 0, '#264653'],
  ['coffee-table', 3.5, 10.5],
  ['armchair', 1, 10.5, 1, '#e9c46a'],
  ['jukebox', 0.5, 12, 1, undefined, { station: 'lofi', links: [], startedAt: 0 }],
  ['tall-plant', 0.5, 6],
  ['floor-lamp', 5.75, 7.75],
  ['monstera', 6.5, 12.5],
];

const items: OfficeItem[] = ROWS.map(([type, x, z, rot = 0, color, data], i) => {
  const item = sanitizeItem({ id: `i${i}`, type, x, z, rot, color, data }, SETTINGS);
  if (!item) throw new Error(`Bad landing item: ${type} at ${x}, ${z}`);
  return item;
});

export const ROOM: Zone = sanitizeZone({ id: 'room', name: 'Meeting room', x: 0, z: 0, w: 8, d: 5, color: '#6c8cff' }, SETTINGS)!;

export const OFFICE: Office = { id: 'landing', settings: SETTINGS, items, zones: [ROOM], createdAt: 0, updatedAt: 0 };

/** Desks with someone working at them, and the app on their screen. */
export const LIT_DESKS: { x: number; z: number; name: string; app: string }[] = [
  { x: 10, z: 3.5, name: 'Utibe', app: 'figma' },
  { x: 12, z: 3.5, name: 'Kayode', app: 'vscode' },
];

export interface Spot {
  x: number;
  z: number;
  /** Facing (three.js rotation.y: 0 faces south, π/2 east). */
  ry: number;
}

/** Where people sit and stand. The seats are seats of the items above (tests check them). */
export const SPOTS = {
  D_AMA: { x: 10, z: 1.5, ry: 0 },
  D_UTIBE: { x: 10, z: 4.5, ry: Math.PI },
  D_KAYODE: { x: 12, z: 4.5, ry: Math.PI },
  R1: { x: 5, z: 1, ry: 0 },
  R2: { x: 5, z: 4, ry: Math.PI },
  L1: { x: 4, z: 8.45, ry: 0 },
  W1: { x: 16.5, z: 9.05, ry: Math.PI },
  STAFF: { x: 18, z: 2.5, ry: -Math.PI / 2 },
  CUST: { x: 16, z: 2.5, ry: Math.PI / 2 },
  BY_AMA: { x: 11, z: 1.55, ry: -Math.PI / 2 },
  MAT: { x: 17, z: 12.3, ry: Math.PI },
  P1: { x: 7.75, z: 9, ry: Math.PI / 2 },
  P2: { x: 12.25, z: 9, ry: -Math.PI / 2 },
} satisfies Record<string, Spot>;

export type SpotId = keyof typeof SPOTS;
