import { LOOP, T_POSTER } from './director';

// Where the camera stands for the live hero and for each still. A shot looks at `target` from the
// direction (theta round the vertical from south towards east, phi down from straight up), as far
// away as it takes for `fit` metres across at the target to fill the frame's width.

export const FOV = 30;

export interface Shot {
  target: [number, number, number];
  theta: number;
  phi: number;
  fit: number;
}

export const SHOTS = {
  /** The hero from 640px up (4:3), and its poster: the meeting room, desks, ping pong and help desk (the lounge and the empty south strip bleed out). */
  heroWide: { target: [10.2, 0.4, 5.2], theta: 0.4, phi: 0.98, fit: 20.5 },
  /** The hero on phones (6:5): closer, from inside the meeting room to the help desk. */
  heroNarrow: { target: [11.6, 0.6, 5], theta: 0.3, phi: 0.98, fit: 14.5 },
  lounge: { target: [3.2, 0.5, 10.2], theta: 0.3, phi: 0.95, fit: 9 },
  support: { target: [17, 0.6, 3.7], theta: -0.35, phi: 0.95, fit: 8 },
  og: { target: [11, 0.4, 5.6], theta: 0.42, phi: 0.98, fit: 15 },
} satisfies Record<string, Shot>;

export type ShotName = keyof typeof SHOTS;

export interface CameraPlan {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

/**
 * The camera for a shot in a frame of this aspect (width / height). With the scene's time `t`, it
 * drifts gently (and it's back where the poster has it at T_POSTER); `nudge` turns it a little more
 * (the pointer's parallax).
 */
export function planShot(shot: Shot, aspect: number, t?: number, nudge = { theta: 0, phi: 0 }): CameraPlan {
  let theta = shot.theta + nudge.theta;
  let phi = shot.phi + nudge.phi;
  if (t !== undefined) {
    theta += 0.12 * Math.sin((2 * Math.PI * (t - T_POSTER)) / LOOP);
    phi += 0.025 * Math.sin((2 * Math.PI * (t - T_POSTER)) / 27);
  }
  const half = (FOV * Math.PI) / 360;
  const hfov = 2 * Math.atan(Math.tan(half) * aspect);
  const distance = shot.fit / 2 / Math.tan(hfov / 2);
  const [x, y, z] = shot.target;
  return {
    position: [x + distance * Math.sin(phi) * Math.sin(theta), y + distance * Math.cos(phi), z + distance * Math.sin(phi) * Math.cos(theta)],
    target: [x, y, z],
    fov: FOV,
  };
}
