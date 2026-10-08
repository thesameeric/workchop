import { create } from 'zustand';
import type { OfficeItem } from '../../../../shared/types';
import type { StickySummary } from '../../../../shared/world';
import { local } from '../../lib/positions';

/** The card pinned next to a plant or desk someone clicked. */
export interface Card {
  kind: 'plant' | 'desk';
  itemId: string;
  /** Walking further away than this closes it. */
  maxDistance: number;
}

interface WorldState {
  card: Card | null;
  /** The item under the pointer (outlined). */
  hovered: string | null;
  /** Notes on desks, by desk owner (what everyone sees: counts and colours). */
  stickies: Record<string, StickySummary>;
  /** Unread notes on your desk here. */
  unread: number;
  /** Bumped when the notes on your desk change, so open lists reload. */
  notesVersion: number;
  /** Desks whose monitor is on: desk id -> who sits there (a player id, or 'self'). */
  screens: Record<string, string>;
}

export const initialWorld: WorldState = {
  card: null,
  hovered: null,
  stickies: {},
  unread: 0,
  notesVersion: 0,
  screens: {},
};

export const useWorld = create<WorldState>()(() => initialWorld);

export function openCard(card: Card | null): void {
  useWorld.setState({ card });
}

/** Opens the card of a plant or desk (clicking it again closes it). */
export function toggleCard(kind: Card['kind'], item: OfficeItem): void {
  if (useWorld.getState().card?.itemId === item.id) return openCard(null);
  openCard({ kind, itemId: item.id, maxDistance: Math.max(8, Math.hypot(item.x - local.x, item.z - local.z) + 3) });
}

/** The pinned card's element; the scene moves it next to its item every frame. */
export const cardAnchor: { el: HTMLElement | null } = { el: null };

/** Things only the 3D side can do (it loads with the scene). */
export const sceneActions: { sitAtDesk?: (deskId: string) => void } = {};
