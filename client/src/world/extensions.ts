import type { ComponentType } from 'react';
import type { Office, OfficeItem } from '../../../shared/types';
import { createRegistry } from '../lib/registry';

// Hooks for features that add to the 3D world: models for new item types, extra 3D bits on items,
// what clicking an item or pressing E near something does (whole scene layers are in layers.ts).
// Keep three.js out of the module that registers them (it loads at startup): register a module
// with registerWorldModule and register the 3D parts from there; it's loaded together with the scene.

/** Props of an item's model: centred on its footprint, standing on y = 0 and facing +z. */
export interface ItemModelProps {
  item: OfficeItem;
  /** The item's colour (or its type's default). */
  c: string;
}

const models = new Map<string, ComponentType<ItemModelProps>>();

/** The 3D model of an item type that the built-in models don't cover. */
export function registerItemModel(type: string, Component: ComponentType<ItemModelProps>): void {
  models.set(type, Component);
}

export function getItemModel(type: string): ComponentType<ItemModelProps> | undefined {
  return models.get(type);
}

/** Something drawn with every item of some types (in the item's own coordinates), e.g. a lit screen. */
export interface ItemDecor {
  id: string;
  order: number;
  types: string[];
  Component: ComponentType<{ item: OfficeItem }>;
}

const decor = createRegistry<ItemDecor>();
export const registerItemDecor = decor.register;
export const useItemDecor = decor.useList;

/** What clicking an item does while playing (instead of sitting on it). */
export interface ItemInteraction {
  onClick(item: OfficeItem): void;
  /** The pointer moved onto (true) or off (false) the item. */
  onHover?(item: OfficeItem, hovered: boolean): void;
}

const interactions = new Map<string, ItemInteraction>();

export function registerItemInteraction(types: string[], interaction: ItemInteraction): void {
  for (const type of types) interactions.set(type, interaction);
}

export function getItemInteraction(type: string): ItemInteraction | undefined {
  return interactions.get(type);
}

/** Something to do by pressing E near it (besides sitting down), e.g. a light switch. */
export interface NearbyAction {
  /** How far away it is; the nearest thing wins. */
  distance: number;
  hint: string;
  run(): void;
}

export type NearbyActionFinder = (office: Office, x: number, z: number) => NearbyAction | null;

const nearby = new Map<string, NearbyActionFinder>();

export function registerNearbyAction(id: string, find: NearbyActionFinder): void {
  nearby.set(id, find);
}

export function nearbyActionFinders(): Iterable<NearbyActionFinder> {
  return nearby.values();
}

const modules = new Set<() => Promise<unknown>>();

/** A module with 3D code (e.g. `() => import('./scene')`), loaded together with the 3D scene. */
export function registerWorldModule(load: () => Promise<unknown>): void {
  modules.add(load);
}

/** Loads the registered modules; one that fails is logged and left out. */
export async function loadWorldModules(): Promise<void> {
  await Promise.all([...modules].map((load) => load().catch((err) => console.error('[world] a module failed to load:', err))));
}
