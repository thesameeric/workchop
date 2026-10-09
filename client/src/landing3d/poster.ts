import type { ActorId } from './cast';

// The hero's still: the live scene at T_POSTER, captured by capture.tsx. It shows until the live
// scene takes over (and instead of it under reduced motion, without WebGL and on slow devices).

export const HERO_ALT =
  'A small 3D office. Ama and Promise talk in a glass meeting room, Utibe works in Figma, Kayode focuses with headphones on, Deji and Damo play ping pong, and Samuel helps a customer at the help desk.';

/** The stills, in the frame's two shapes (4:3 from 640px up, 6:5 below). */
export const POSTER = {
  wide: { src: '/landing/hero-wide.webp', width: 1360, height: 1020 },
  narrow: { src: '/landing/hero-narrow.webp', width: 720, height: 600 },
};

/** A label drawn over the still, at x% and y% of the frame (a bubble at its speaker's name tag). */
export type PosterLabel =
  | { kind: 'tag'; who: ActorId; speaking: boolean; x: number; y: number }
  | { kind: 'bubble'; who: ActorId; text: string; x: number; y: number }
  | { kind: 'sign'; active: boolean; x: number; y: number };

// Pasted from the capture tool's output (see capture.tsx).
export const POSTER_LABELS: Record<'wide' | 'narrow', PosterLabel[]> = {
  wide: [
    { kind: 'sign', active: true, x: 24.61, y: 43.05 },
    { kind: 'tag', who: 'ama', speaking: false, x: 30.14, y: 31.68 },
    { kind: 'tag', who: 'promise', speaking: true, x: 36.52, y: 24.2 },
    { kind: 'tag', who: 'utibe', speaking: false, x: 50.43, y: 39.19 },
    { kind: 'tag', who: 'kayode', speaking: false, x: 59.72, y: 41.85 },
    { kind: 'tag', who: 'samuel', speaking: false, x: 92.07, y: 43.6 },
    { kind: 'tag', who: 'sanni', speaking: true, x: 81.91, y: 40.87 },
    { kind: 'tag', who: 'deji', speaking: false, x: 29.59, y: 49.92 },
    { kind: 'tag', who: 'damo', speaking: false, x: 52.37, y: 57.46 },
    { kind: 'bubble', who: 'promise', text: 'So, about the launch…', x: 36.52, y: 24.2 },
    { kind: 'bubble', who: 'sanni', text: 'Can I move my delivery to Friday?', x: 81.91, y: 40.87 },
  ],
  narrow: [
    { kind: 'sign', active: true, x: 4.33, y: 44 },
    { kind: 'tag', who: 'ama', speaking: false, x: 11.44, y: 29.23 },
    { kind: 'tag', who: 'promise', speaking: true, x: 20.07, y: 19.89 },
    { kind: 'tag', who: 'utibe', speaking: false, x: 40.5, y: 36.72 },
    { kind: 'tag', who: 'kayode', speaking: false, x: 53.72, y: 39.2 },
    { kind: 'tag', who: 'samuel', speaking: false, x: 97.92, y: 38.62 },
    { kind: 'tag', who: 'sanni', speaking: true, x: 83.82, y: 36.16 },
    { kind: 'tag', who: 'deji', speaking: false, x: 11.19, y: 52.23 },
    { kind: 'tag', who: 'damo', speaking: false, x: 45.25, y: 59.89 },
    { kind: 'bubble', who: 'promise', text: 'So, about the launch…', x: 20.07, y: 19.89 },
    { kind: 'bubble', who: 'sanni', text: 'Can I move my delivery to Friday?', x: 83.82, y: 36.16 },
  ],
};
