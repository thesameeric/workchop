import type { OfficeItem } from '../../../../shared/types';
import { darkAreas, isLightOn, isLightSwitch, switchArea, type DeskNote, type WorldResult } from '../../../../shared/world';
import { getSession } from '../../lib/session';
import { getState, toast } from '../../state/store';

// What people do with things in the world, sent to the server (server/features/world.ts).

const PREFIX = 'workchop:';

/** A guest's secret for deleting the notes they leave, kept in this browser. */
export function guestKey(): string | null {
  if (getState().account) return null;
  try {
    let key = localStorage.getItem(`${PREFIX}guest-key`);
    if (!key) {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem(`${PREFIX}guest-key`, key);
    }
    return key;
  } catch {
    return null;
  }
}

/** Whether the ceiling lights are on where this light switch is. */
export function areaLit(item: OfficeItem): boolean {
  const office = getState().office;
  if (!office) return true;
  return !darkAreas(office).has(switchArea(office.zones, item));
}

/** Click (or E) on a lamp or light switch. */
export function toggleLight(item: OfficeItem): void {
  const on = isLightSwitch(item) ? !areaLit(item) : !isLightOn(item);
  getSession()?.socket.emit('world:light', item.id, on);
}

type Ack<T extends object> = WorldResult<T>;

/** Sends a request that's answered; resolves to the answer, or to an error when there's none in time. */
async function ask<T extends object>(send: (ack: (res: Ack<T>) => void) => void): Promise<Ack<T>> {
  if (!getSession()?.socket.connected) return { ok: false, error: 'Not connected right now. Try again in a moment.' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'The server didn’t answer. Try again in a moment.' }), 8000);
    send((res) => {
      clearTimeout(timer);
      resolve(res && typeof res === 'object' ? res : { ok: false, error: 'Something went wrong.' });
    });
  });
}

/** Runs a request and shows its error, if any; returns whether it worked. */
async function act(send: (ack: (res: Ack<object>) => void) => void): Promise<boolean> {
  const res = await ask(send);
  if (!res.ok) toast(res.error, 'error');
  return res.ok;
}

export function claimDesk(itemId: string): Promise<boolean> {
  return act((ack) => getSession()!.socket.emit('desk:claim', itemId, ack));
}

export function releaseDesk(itemId: string): Promise<boolean> {
  return act((ack) => getSession()!.socket.emit('desk:release', itemId, ack));
}

export function leaveNote(itemId: string, text: string, color: string): Promise<Ack<{ note: DeskNote }>> {
  return ask((ack) => getSession()!.socket.emit('desk:note', itemId, { text, color, guestKey: guestKey() }, ack));
}

export function myNotes(): Promise<Ack<{ notes: DeskNote[] }>> {
  return ask((ack) => getSession()!.socket.emit('desk:notes', ack));
}

export function notesILeft(ownerUserId: string): Promise<Ack<{ notes: DeskNote[] }>> {
  return ask((ack) => getSession()!.socket.emit('desk:authored', ownerUserId, guestKey(), ack));
}

export function markRead(id: string | 'all'): Promise<boolean> {
  return act((ack) => getSession()!.socket.emit('desk:note:read', id, ack));
}

export function deleteNote(id: string): Promise<boolean> {
  return act((ack) => getSession()!.socket.emit('desk:note:delete', id, guestKey(), ack));
}
