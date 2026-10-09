import { getEntry } from '../../../shared/catalog';
import { getSession } from '../lib/session';
import { getState, setState } from '../state/store';

// What the build panel's buttons and build mode's keys do to the selection (no three.js here, so the
// panel can use them without loading the scene).

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function rotateSelected(): void {
  const { office, build } = getState();
  if (build.tool === 'place') {
    setState({ build: { ...build, rot: (build.rot + 1) % 4 } });
    return;
  }
  const item = office?.items.find((i) => i.id === build.selectedId);
  if (item) getSession()?.edit({ t: 'update', item: { ...item, rot: (item.rot + 1) % 4 } });
}

function deleteSelected(): void {
  const { build } = getState();
  if (build.selectedId) getSession()?.edit({ t: 'remove', id: build.selectedId });
  else if (build.selectedZoneId) getSession()?.edit({ t: 'zone:remove', id: build.selectedZoneId });
}

function duplicateSelected(): void {
  const { office, build } = getState();
  const item = office?.items.find((i) => i.id === build.selectedId);
  if (!item || !office) return;
  const entry = getEntry(item.type)!;
  const copy = { ...item, id: newId('i'), x: item.x + (item.rot % 2 ? entry.d : entry.w) };
  if (getSession()?.edit({ t: 'add', item: copy })) setState({ build: { ...build, selectedId: copy.id } });
}

export const buildActions = { rotateSelected, deleteSelected, duplicateSelected };
