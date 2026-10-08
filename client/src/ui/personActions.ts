import type { ComponentType } from 'react';
import { createRegistry } from '../lib/registry';
import type { RemotePlayer } from '../state/store';

/** A button next to someone in the People panel (after "Go to" and "Message"). */
export interface PersonAction {
  id: string;
  /** Position among the feature buttons. */
  order: number;
  /** Renders the button for this person, or null when it doesn't apply to them. */
  Component: ComponentType<{ player: RemotePlayer }>;
}

const actions = createRegistry<PersonAction>();

/** Adds a People panel button (call it when your module loads); returns a function that removes it. */
export const registerPersonAction = actions.register;
export const usePersonActions = actions.useList;
export const personActionKey = actions.keyOf;
