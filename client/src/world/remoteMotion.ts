import type { AnimState } from '../../../shared/types';
import type { RemoteTarget } from '../lib/positions';

/** A remote character as drawn: smoothed towards where the network last said they are. */
export interface Drawn {
  x: number;
  z: number;
  ry: number;
  anim: AnimState;
}

/** Further than this from where they're drawn, people jump there instead of sliding (they teleported). */
const SNAP_DISTANCE = 6;

/**
 * "Walking" with no step for this long means they stopped sending (a tab in the background) or the
 * last steps were lost: they're drawn standing still, not walking on the spot.
 */
export const STALE_WALK_MS = 500;

export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * One frame of a remote character, `dt` seconds after the last: where to draw them (`drawn` is
 * updated in place, or made on the first frame), what they're doing and how fast they go (for the
 * walk cycle). `now` is performance.now(), as in RemoteTarget.at.
 */
export function stepRemote(drawn: Drawn | null, t: RemoteTarget, dt: number, now: number): { drawn: Drawn; anim: AnimState; speed: number } {
  // Sitting down and getting up are jumps, as they are for the one doing it (seats don't move):
  // otherwise they'd slide through the desk in the sitting pose.
  if (!drawn || t.anim === 'sit' || drawn.anim === 'sit' || Math.hypot(t.x - drawn.x, t.z - drawn.z) > SNAP_DISTANCE) {
    const p = drawn ?? { x: t.x, z: t.z, ry: t.ry, anim: t.anim };
    Object.assign(p, { x: t.x, z: t.z, ry: t.ry, anim: t.anim === 'sit' ? 'sit' : 'idle' });
    return { drawn: p, anim: p.anim, speed: 0 };
  }
  const k = 1 - Math.exp(-dt * 10);
  const px = drawn.x;
  const pz = drawn.z;
  drawn.x += (t.x - drawn.x) * k;
  drawn.z += (t.z - drawn.z) * k;
  drawn.ry = lerpAngle(drawn.ry, t.ry, 1 - Math.exp(-dt * 12));
  const speed = Math.hypot(drawn.x - px, drawn.z - pz) / Math.max(dt, 1e-3);
  const walking = t.anim === 'walk' && now - t.at < STALE_WALK_MS;
  drawn.anim = speed > 0.4 || walking ? 'walk' : 'idle';
  return { drawn, anim: drawn.anim, speed: Math.max(speed, walking ? 3 : 0) };
}
