import type { AnimState } from '../../../shared/types';

/** Latest network position of every remote person. Mutated at high frequency, read in render loops. */
export interface RemoteTarget {
  x: number;
  z: number;
  ry: number;
  anim: AnimState;
}

export const remoteTargets = new Map<string, RemoteTarget>();

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
