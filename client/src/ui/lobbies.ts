import type { ComponentType } from 'react';
import type { OfficeInfo } from '../../../shared/workspace';

/** A lobby of its own for some visitors (support customers), instead of the usual name, character and devices. */
export interface LobbyDef {
  id: string;
  /** Whether it's the lobby for this visitor of this workspace. */
  match(info: OfficeInfo): boolean;
  Component: ComponentType<{ info: OfficeInfo }>;
  /** The mic and camera it starts with (the usual lobby: as you left them). */
  media?: { mic: boolean; cam: boolean };
}

const lobbies = new Map<string, LobbyDef>();

/** Adds a lobby (call it when your module loads); registering an id again replaces it. Returns a function that removes it. */
export function registerLobby(def: LobbyDef): () => void {
  lobbies.set(def.id, def);
  return () => {
    if (lobbies.get(def.id) === def) lobbies.delete(def.id);
  };
}

/** The first registered lobby that matches, if any. */
export function lobbyFor(info: OfficeInfo): LobbyDef | undefined {
  for (const def of lobbies.values()) if (def.match(info)) return def;
  return undefined;
}
