import * as THREE from 'three';
import { getEntry, type Seat } from '../../../shared/catalog';
import { findFreeSpot, findPath, isBlocked, moveWithCollision } from '../../../shared/geometry';
import type { Office } from '../../../shared/types';
import { local } from '../lib/positions';
import { getSession } from '../lib/session';
import { getState, setState } from '../state/store';
import { nearbyActionFinders, type NearbyAction } from './extensions';
import { axis } from './input';
import { nearestSeat, officeData } from './officeCache';

const WALK_SPEED = 3.6;
const RUN_SPEED = 6.2;
const SIT_RANGE = 1.3;

type SeatRef = Seat & { itemId: string };

export function sitOn(seat: SeatRef): void {
  local.seat = { x: seat.x, z: seat.z, ry: seat.ry, itemId: seat.itemId };
  local.x = seat.x;
  local.z = seat.z;
  local.ry = seat.ry;
  local.anim = 'sit';
  local.path = null;
  local.pathSeat = null;
}

export function standUp(): void {
  const seat = local.seat;
  if (!seat) return;
  local.seat = null;
  local.anim = 'idle';
  const office = getState().office;
  if (!office) return;
  const item = office.items.find((i) => i.id === seat.itemId);
  const { colliders } = officeData(office);
  if (item && getEntry(item.type)?.solid) {
    // Step forward off the sofa.
    const spot = findFreeSpot(seat.x + Math.sin(seat.ry) * 0.8, seat.z + Math.cos(seat.ry) * 0.8, colliders, office.settings);
    local.x = spot.x;
    local.z = spot.z;
  } else if (isBlocked(local.x, local.z, colliders, office.settings)) {
    const spot = findFreeSpot(local.x, local.z, colliders, office.settings);
    local.x = spot.x;
    local.z = spot.z;
  }
}

/** The nearest thing to do with E where you stand: sit down, or what features offer (light switches…). */
function nearestAction(office: Office): NearbyAction | null {
  const seat = nearestSeat(office, local.x, local.z, SIT_RANGE);
  let best: NearbyAction | null = seat
    ? { distance: Math.hypot(seat.x - local.x, seat.z - local.z), hint: 'Press E to sit', run: () => sitOn(seat) }
    : null;
  for (const find of nearbyActionFinders()) {
    const action = find(office, local.x, local.z);
    if (action && (!best || action.distance < best.distance)) best = action;
  }
  return best;
}

/** E: stand up, or do the nearest thing (sit down, switch the lights…). */
export function interact(): void {
  if (local.seat) {
    standUp();
    return;
  }
  const office = getState().office;
  if (office) nearestAction(office)?.run();
}

/** Walk to a point using A*; optionally sit on a seat when arriving. */
export function walkTo(x: number, z: number, seat?: SeatRef): void {
  const office = getState().office;
  if (!office) return;
  standUp();
  const { colliders } = officeData(office);
  const path = findPath({ x: local.x, z: local.z }, { x, z }, colliders, office.settings);
  local.path = path && path.length ? path : null;
  local.pathSeat = seat ?? null;
  if (!local.path && seat && Math.hypot(seat.x - local.x, seat.z - local.z) < SIT_RANGE) sitOn(seat);
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const forward = new THREE.Vector3();
let hintTimer = 0;
/** How long click-to-walk has made no progress; the path is dropped after a moment. */
let stuckTime = 0;

/** Advance the local player one frame. Returns the horizontal speed (for animation). */
export function stepLocal(dt: number, camera: THREE.Camera): number {
  const office = getState().office;
  if (!office) return 0;
  const { colliders } = officeData(office);
  const input = axis();
  let dx = 0;
  let dz = 0;
  let speed = 0;

  if (input.x || input.y) {
    if (local.seat) standUp();
    local.path = null;
    local.pathSeat = null;
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    // Screen-relative movement: up = away from the camera.
    const rx = -forward.z;
    const rz = forward.x;
    let mx = forward.x * input.y + rx * input.x;
    let mz = forward.z * input.y + rz * input.x;
    const len = Math.hypot(mx, mz) || 1;
    mx /= len;
    mz /= len;
    speed = input.run ? RUN_SPEED : WALK_SPEED;
    dx = mx * speed * dt;
    dz = mz * speed * dt;
  } else if (local.path) {
    const target = local.path[0];
    const tx = target.x - local.x;
    const tz = target.z - local.z;
    const dist = Math.hypot(tx, tz);
    const step = WALK_SPEED * 1.15 * dt;
    if (dist <= step) {
      dx = tx;
      dz = tz;
      local.path.shift();
      if (!local.path.length) {
        local.path = null;
        const seat = local.pathSeat;
        local.pathSeat = null;
        if (seat && Math.hypot(seat.x - (local.x + dx), seat.z - (local.z + dz)) < SIT_RANGE) {
          sitOn(seat);
          return 0;
        }
      }
    } else {
      dx = (tx / dist) * step;
      dz = (tz / dist) * step;
    }
    speed = WALK_SPEED;
  }

  if (local.seat) {
    local.anim = 'sit';
  } else if (dx || dz) {
    const before = { x: local.x, z: local.z };
    const next = moveWithCollision(local.x, local.z, dx, dz, colliders, office.settings);
    local.x = next.x;
    local.z = next.z;
    const moved = Math.hypot(next.x - before.x, next.z - before.z);
    if (local.path && moved < Math.hypot(dx, dz) * 0.1) {
      stuckTime += dt;
      if (stuckTime > 0.4) local.path = null; // Blocked: give up on the path.
    } else {
      stuckTime = 0;
    }
    local.ry = lerpAngle(local.ry, Math.atan2(dx, dz), 1 - Math.exp(-dt * 14));
    local.anim = moved > 1e-4 ? 'walk' : 'idle';
    speed = moved / Math.max(dt, 1e-3);
  } else {
    local.anim = 'idle';
    speed = 0;
    // Furniture may have been placed on top of us.
    if (isBlocked(local.x, local.z, colliders, office.settings)) {
      const spot = findFreeSpot(local.x, local.z, colliders, office.settings);
      local.x = spot.x;
      local.z = spot.z;
    }
  }

  getSession()?.sendMove(local.x, local.z, local.ry, local.anim);

  hintTimer += dt;
  if (hintTimer > 0.25) {
    hintTimer = 0;
    const hint = local.seat ? 'Press E (or move) to stand up' : (nearestAction(office)?.hint ?? null);
    if (hint !== getState().hint) setState({ hint });
  }
  return speed;
}
