import type { ComponentType } from 'react';
import { createRegistry } from '../lib/registry';
import { useStore } from '../state/store';
import { BuildPanel } from './BuildPanel';
import { HammerIcon, MusicIcon, PeopleIcon, type IconComponent } from './icons';
import { MusicPanel } from './MusicPanel';
import { PeoplePanel } from './PeoplePanel';

/** A side panel in the office, with its button in the dock. */
export interface PanelDef {
  /** Also the value of the store's `panel` while it is open (setPanel(id) toggles it). */
  id: string;
  title: string;
  icon: IconComponent;
  /** The panel's content, under its title bar. */
  Component: ComponentType;
  /** Position of its dock button among the others: chat 10, music 20, people 30. */
  order: number;
  /** Has a dock button (default true). */
  dock?: boolean;
  /** No dock button on narrow screens. */
  hideOnMobile?: boolean;
  /** A hook giving the dock button's badge (a count, or short text like "9+"); null or 0 shows none. */
  useBadge?: () => number | string | null;
  /** 'alert' (default) is red, for things to look at; 'neutral' is grey, for plain counts. */
  badgeTone?: 'alert' | 'neutral';
  /** Keyboard shortcut named in the button's tooltip, e.g. "Enter". */
  shortcut?: string;
}

const panels = createRegistry<PanelDef>();

/** Adds a side panel (call it when your module loads); returns a function that removes it. */
export const registerPanel = panels.register;
export const getPanel = panels.get;
export const usePanels = panels.useList;
/** The React key for a panel's dock button (it changes when the panel is registered again). */
export const panelKey = panels.keyOf;

// Chat (order 10) is registered by its feature (features/chat).
registerPanel({ id: 'music', title: 'Music', icon: MusicIcon, Component: MusicPanel, order: 20, hideOnMobile: true });
registerPanel({
  id: 'people',
  title: 'People',
  icon: PeopleIcon,
  Component: PeoplePanel,
  order: 30,
  badgeTone: 'neutral',
  useBadge: () => useStore((s) => Object.keys(s.players).length + 1),
});
// Build mode has its own button in the middle of the dock.
registerPanel({ id: 'build', title: 'Build', icon: HammerIcon, Component: BuildPanel, order: 100, dock: false });
