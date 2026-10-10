import type { AnimState } from '../../../shared/types';

/** Latest network position of every remote person. Mutated at high frequency, read in render loops. */
export interface RemoteTarget {
  x: number;
  z: number;
  ry: number;
  anim: AnimState;
  /** When they last moved or changed what they're doing (performance.now()): a repeat doesn't count. */
  at: number;
}

export const remoteTargets = new Map<string, RemoteTarget>();

/** Records where someone is now (from a join, player:joined or player:moved). */
export function setRemoteTarget(id: string, x: number, z: number, ry: number, anim: AnimState, now = performance.now()): void {
  const t = remoteTargets.get(id);
  if (!t) {
    remoteTargets.set(id, { x, z, ry, anim, at: now });
    return;
  }
  if (t.x !== x || t.z !== z || t.ry !== ry || t.anim !== anim) t.at = now;
  t.x = x;
  t.z = z;
  t.ry = ry;
  t.anim = anim;
}

export interface LocalState {
  x: number;
  z: number;
  ry: number;
  anim: AnimState;
  /** Seat we're sitting on, if any. */
  seat: { x: number; z: number; ry: number; itemId: string } | null;
  /** Waypoints for click-to-walk. */
  path: { x: number; z: number }[] | null;
  /** Sit down on this seat when the path finishes. */
  pathSeat: { x: number; z: number; ry: number; itemId: string } | null;
}

export const local: LocalState = { x: 0, z: 0, ry: 0, anim: 'idle', seat: null, path: null, pathSeat: null };

/** Where each remote character is currently drawn (after smoothing), for labels that follow them. */
export const rendered = new Map<string, { x: number; z: number; sit: boolean }>();
