import type { ComponentType } from 'react';
import { createRegistry } from '../lib/registry';

/** Something features show over the office (cards pinned to things in the world…), under the panels. */
export interface OverlayDef {
  id: string;
  order: number;
  Component: ComponentType;
}

const overlays = createRegistry<OverlayDef>();

/** Adds an overlay to the office view (call it when your module loads); returns a function that removes it. */
export const registerOverlay = overlays.register;

export function Overlays() {
  const list = overlays.useList();
  return (
    <>
      {list.map((o) => (
        <o.Component key={overlays.keyOf(o)} />
      ))}
    </>
  );
}
