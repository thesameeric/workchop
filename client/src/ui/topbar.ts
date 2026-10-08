import type { ComponentType } from 'react';
import { createRegistry } from '../lib/registry';

/** Something a feature shows in the office's top bar, under the office's name (e.g. the weather). */
export interface TopBarItem {
  id: string;
  /** Position among the feature items, which come after the music that's playing. */
  order: number;
  /** Renders null when there's nothing to show. */
  Component: ComponentType;
}

const items = createRegistry<TopBarItem>();

/** Adds a top-bar item (call it when your module loads); returns a function that removes it. */
export const registerTopBarItem = items.register;
export const useTopBarItems = items.useList;
/** The React key for an item (it changes when the item is registered again). */
export const topBarItemKey = items.keyOf;
