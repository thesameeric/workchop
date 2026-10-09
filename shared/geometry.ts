import { getEntry, rotateLocal, rotatedSize, type Seat } from './catalog';
import type { Office, OfficeItem, OfficeSettings, Status, Zone } from './types';

export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const PLAYER_RADIUS = 0.28;

/** Within this distance two people connect audio/video. */
export const CONNECT_RADIUS = 4;
/** Already-connected people stay connected until they drift past this distance. */
export const DISCONNECT_RADIUS = 5;
/** Inside this distance remote audio plays at full volume. */
export const FULL_VOLUME_RADIUS = 1.75;

export function itemBox(item: OfficeItem): AABB | null {
  const entry = getEntry(item.type);
  if (!entry) return null;
  const base = entry.box ?? { w: entry.w, d: entry.d };
  const { w, d } = rotatedSize(base.w, base.d, item.rot);
  return { minX: item.x - w / 2, maxX: item.x + w / 2, minZ: item.z - d / 2, maxZ: item.z + d / 2 };
}

export function itemFootprint(item: OfficeItem): AABB | null {
  const entry = getEntry(item.type);
  if (!entry) return null;
  const { w, d } = rotatedSize(entry.w, entry.d, item.rot);
  return { minX: item.x - w / 2, maxX: item.x + w / 2, minZ: item.z - d / 2, maxZ: item.z + d / 2 };
}

export function buildColliders(office: Pick<Office, 'items'>): AABB[] {
  const boxes: AABB[] = [];
  for (const item of office.items) {
    if (!getEntry(item.type)?.solid) continue;
    const b = itemBox(item);
    if (b) boxes.push(b);
  }
  return boxes;
}

export function circleHitsBox(x: number, z: number, r: number, b: AABB): boolean {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

type Bounds = Pick<OfficeSettings, 'width' | 'depth'>;

export function isBlocked(x: number, z: number, colliders: AABB[], bounds: Bounds, r = PLAYER_RADIUS): boolean {
  if (x < r || z < r || x > bounds.width - r || z > bounds.depth - r) return true;
  for (const b of colliders) if (circleHitsBox(x, z, r, b)) return true;
  return false;
}

/** Move a circle by (dx, dz), sliding along whatever it bumps into. */
export function moveWithCollision(
  x: number,
  z: number,
  dx: number,
  dz: number,
  colliders: AABB[],
  bounds: Bounds,
  r = PLAYER_RADIUS,
): { x: number; z: number } {
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / (r * 0.5)));
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    if (!isBlocked(x + sx, z + sz, colliders, bounds, r)) {
      x += sx;
      z += sz;
    } else if (sx !== 0 && !isBlocked(x + sx, z, colliders, bounds, r)) {
      x += sx;
    } else if (sz !== 0 && !isBlocked(x, z + sz, colliders, bounds, r)) {
      z += sz;
    } else {
      break;
    }
  }
  return { x, z };
}

/** Nearest unblocked point to (x, z), searching outward on a half-tile grid. */
export function findFreeSpot(x: number, z: number, colliders: AABB[], bounds: Bounds): { x: number; z: number } {
  const cx = Math.min(Math.max(x, PLAYER_RADIUS + 0.01), bounds.width - PLAYER_RADIUS - 0.01);
  const cz = Math.min(Math.max(z, PLAYER_RADIUS + 0.01), bounds.depth - PLAYER_RADIUS - 0.01);
  if (!isBlocked(cx, cz, colliders, bounds)) return { x: cx, z: cz };
  const maxRing = Math.ceil(Math.max(bounds.width, bounds.depth) * 2);
  for (let ring = 1; ring <= maxRing; ring++) {
    let best: { x: number; z: number; d: number } | null = null;
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const px = Math.round(cx * 2) / 2 + i * 0.5;
        const pz = Math.round(cz * 2) / 2 + j * 0.5;
        if (isBlocked(px, pz, colliders, bounds)) continue;
        const d = (px - x) ** 2 + (pz - z) ** 2;
        if (!best || d < best.d) best = { x: px, z: pz, d };
      }
    }
    if (best) return { x: best.x, z: best.z };
  }
  return { x: bounds.width / 2, z: bounds.depth / 2 };
}

/**
 * Where you stand after getting up from a seat. Off a sofa (or anything solid) you step forward, to
 * the nearest free spot; when there's none in front (a desk), you step back instead. A chair leaves
 * you where you sat.
 */
export function standUpSpot(seat: Seat, solid: boolean, colliders: AABB[], bounds: Bounds): { x: number; z: number } {
  if (!solid) return isBlocked(seat.x, seat.z, colliders, bounds) ? findFreeSpot(seat.x, seat.z, colliders, bounds) : { x: seat.x, z: seat.z };
  const fx = Math.sin(seat.ry);
  const fz = Math.cos(seat.ry);
  const spot = findFreeSpot(seat.x + fx * 0.8, seat.z + fz * 0.8, colliders, bounds);
  if ((spot.x - seat.x) * fx + (spot.z - seat.z) * fz > 0.3) return spot;
  const back = { x: seat.x - fx * 0.8, z: seat.z - fz * 0.8 };
  return isBlocked(back.x, back.z, colliders, bounds) ? spot : back;
}

/** A spot `gap` in front of an item (beyond its footprint), where you'd stand to look at it. */
export function inFrontOf(item: OfficeItem, gap = 1): { x: number; z: number } {
  const d = getEntry(item.type)?.d ?? 1;
  const o = rotateLocal(0, d / 2 + gap, item.rot);
  return { x: item.x + o.x, z: item.z + o.z };
}

export function zoneAt(zones: Zone[], x: number, z: number): Zone | undefined {
  // Later zones are drawn on top, so they win when zones overlap.
  for (let i = zones.length - 1; i >= 0; i--) {
    const zn = zones[i];
    if (x >= zn.x && x < zn.x + zn.w && z >= zn.z && z < zn.z + zn.d) return zn;
  }
  return undefined;
}

export interface Presence {
  x: number;
  z: number;
  status: Status;
}

/**
 * Should two people have an open audio/video link?
 * - Inside a private zone you are connected to exactly the others in that zone.
 * - Otherwise you connect to people within CONNECT_RADIUS, and stay connected
 *   until DISCONNECT_RADIUS (hysteresis so links don't flap at the edge).
 * - "Busy" people only connect inside private zones.
 */
export function shouldLink(a: Presence, b: Presence, zones: Zone[], linked: boolean): boolean {
  const za = zoneAt(zones, a.x, a.z);
  const zb = zoneAt(zones, b.x, b.z);
  if (za || zb) return !!za && !!zb && za.id === zb.id;
  if (a.status === 'busy' || b.status === 'busy') return false;
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  return d < (linked ? DISCONNECT_RADIUS : CONNECT_RADIUS);
}

/** Playback volume for someone you're linked with, falling off with distance. */
export function proximityVolume(a: { x: number; z: number }, b: { x: number; z: number }, zones: Zone[]): number {
  const za = zoneAt(zones, a.x, a.z);
  const zb = zoneAt(zones, b.x, b.z);
  if (za || zb) return za && zb && za.id === zb.id ? 1 : 0;
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  if (d <= FULL_VOLUME_RADIUS) return 1;
  const t = (d - FULL_VOLUME_RADIUS) / (DISCONNECT_RADIUS - FULL_VOLUME_RADIUS);
  return Math.max(0, Math.min(1, 1 - t * t));
}

const GRID = 0.5;

/**
 * A* over a half-tile grid. Returns waypoints from (but excluding) the start to the goal,
 * or null if the goal can't be reached.
 */
export function findPath(
  start: { x: number; z: number },
  goal: { x: number; z: number },
  colliders: AABB[],
  bounds: Bounds,
): { x: number; z: number }[] | null {
  const cols = Math.floor(bounds.width / GRID);
  const rows = Math.floor(bounds.depth / GRID);
  if (cols <= 0 || rows <= 0) return null;
  const toCell = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.floor(v / GRID)));
  const center = (c: number) => c * GRID + GRID / 2;

  // Where the walk ends: the goal, or the free spot nearest to it (for a sofa's seat).
  const end = isBlocked(goal.x, goal.z, colliders, bounds) ? findFreeSpot(goal.x, goal.z, colliders, bounds) : { x: goal.x, z: goal.z };
  // Nothing in the way: straight there, wherever the grid says you stand.
  if (clearLine(start, end, colliders, bounds)) return [end];

  const blocked = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      blocked[r * cols + c] = isBlocked(center(c), center(r), colliders, bounds) ? 1 : 0;
    }
  }

  const cellOf = (p: { x: number; z: number }) => toCell(p.z, rows) * cols + toCell(p.x, cols);
  const centerOf = (i: number) => ({ x: center(i % cols), z: center(Math.floor(i / cols)) });
  // Grid steps from one point to another with nothing in between, as A* counts them.
  const steps = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const dx = Math.abs(a.x - b.x) / GRID;
    const dz = Math.abs(a.z - b.z) / GRID;
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };
  // The open cells to set off from or arrive at: the point's own, or, in a gap too tight for the grid
  // (between a sofa and the coffee table, behind a desk), every one nearby in a straight line from it:
  // the nearest can be a pocket that leads nowhere.
  const openCells = (p: { x: number; z: number }): number[] => {
    const own = cellOf(p);
    if (!blocked[own]) return [own];
    const c0 = own % cols;
    const r0 = (own - c0) / cols;
    const out: number[] = [];
    for (let r = Math.max(0, r0 - 4); r <= Math.min(rows - 1, r0 + 4); r++) {
      for (let c = Math.max(0, c0 - 4); c <= Math.min(cols - 1, c0 + 4); c++) {
        const i = r * cols + c;
        if (!blocked[i] && clearLine(p, centerOf(i), colliders, bounds)) out.push(i);
      }
    }
    return out;
  };

  const starts = openCells(start);
  const goals = openCells(end);
  if (!starts.length || !goals.length) return null;
  const ownStart = cellOf(start);
  const ownEnd = cellOf(end);
  const isGoal = new Uint8Array(cols * rows);
  for (const i of goals) isGoal[i] = 1;
  // Every goal cell leads on to this one, the end itself, at the cost of the last straight bit.
  const END = cols * rows;

  const g = new Float32Array(END + 1).fill(Infinity);
  const came = new Int32Array(END + 1).fill(-1);
  const closed = new Uint8Array(END + 1);
  // Simple binary heap keyed on f-score.
  const heap: number[] = [];
  const f = new Float32Array(END + 1).fill(Infinity);
  const push = (i: number) => {
    heap.push(i);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (f[heap[p]] <= f[heap[k]]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
        if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  // Never more than what's left (steps on to the end), so the first way found is a shortest one.
  const h = (c: number, r: number) => steps({ x: center(c), z: center(r) }, end);

  for (const i of starts) {
    g[i] = steps(start, centerOf(i));
    f[i] = g[i] + h(i % cols, Math.floor(i / cols));
    push(i);
  }
  const dirs = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  let found = false;
  while (heap.length) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === END) {
      found = true;
      break;
    }
    if (isGoal[cur]) {
      const ng = g[cur] + steps(centerOf(cur), end);
      if (ng < g[END]) {
        g[END] = f[END] = ng;
        came[END] = cur;
        push(END);
      }
    }
    const cc = cur % cols;
    const cr = (cur - cc) / cols;
    for (const [dc, dr, cost] of dirs) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (blocked[ni] || closed[ni]) continue;
      // No cutting corners past obstacles.
      if (dc !== 0 && dr !== 0 && (blocked[cr * cols + nc] || blocked[nr * cols + cc])) continue;
      const ng = g[cur] + cost;
      if (ng >= g[ni]) continue;
      // Two open cells can still have something in between (the end of a glass wall by a doorway).
      if (isBlocked(center(cc) + (dc * GRID) / 2, center(cr) + (dr * GRID) / 2, colliders, bounds)) continue;
      g[ni] = ng;
      f[ni] = ng + h(nc, nr);
      came[ni] = cur;
      push(ni);
    }
  }
  if (!found) return null;

  const cells: number[] = [];
  for (let i = came[END]; i !== -1; i = came[i]) cells.push(i);
  cells.reverse();
  // Leave out the cell you stand in, unless the end is only in sight from its middle.
  if (cells[0] === ownStart && cells.length > 1) cells.shift();
  const points = cells.map(centerOf);
  // End exactly on the goal (or the free spot next to it).
  if (cells[cells.length - 1] === ownEnd) points[points.length - 1] = end;
  else points.push(end);
  return smoothPath(start, points, colliders, bounds);
}

/** Drop waypoints that can be skipped with a straight, unobstructed walk. */
function smoothPath(
  start: { x: number; z: number },
  points: { x: number; z: number }[],
  colliders: AABB[],
  bounds: Bounds,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  let from = start;
  let i = 0;
  while (i < points.length) {
    let j = points.length - 1;
    while (j > i && !clearLine(from, points[j], colliders, bounds)) j--;
    out.push(points[j]);
    from = points[j];
    i = j + 1;
  }
  return out;
}

function clearLine(a: { x: number; z: number }, b: { x: number; z: number }, colliders: AABB[], bounds: Bounds): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.ceil(len / 0.1);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    if (isBlocked(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, colliders, bounds)) return false;
  }
  return true;
}
