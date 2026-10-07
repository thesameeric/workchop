import { useCallback, useRef } from 'react';

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

interface Anchor {
  el: HTMLElement;
  world: () => WorldPoint | null;
  last: string;
}

/**
 * DOM elements pinned to points in the 3D world (name tags, zone labels, reactions).
 * They live in the normal React DOM tree; a projector inside the canvas moves them every frame.
 */
export const anchors = new Map<string, Anchor>();

/** Returns a ref callback that pins the element to `world()` (re-evaluated every frame). */
export function useAnchor(key: string, world: () => WorldPoint | null) {
  const worldRef = useRef(world);
  worldRef.current = world;
  return useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        el.style.visibility = 'hidden';
        anchors.set(key, { el, world: () => worldRef.current(), last: '' });
      } else {
        anchors.delete(key);
      }
    },
    [key],
  );
}
