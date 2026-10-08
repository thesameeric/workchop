import { create } from 'zustand';
import type { ManualApp, PresenceState, PresenceUpdate } from '../../../../shared/presence';
import { serverNow } from '../../lib/clock';
import { getSession } from '../../lib/session';
import { getState, useStore } from '../../state/store';

/** Your own presence, as the server last told you (null outside an office). */
export const usePresence = create<{ self: PresenceState | null }>(() => ({ self: null }));

/**
 * The app shown next to someone's name (`self` for you), or null: what everyone in the office sees,
 * after their privacy settings. Name tags, the people list, video tiles and desk monitors all use it.
 */
export function useShownApp(id: string | null | undefined, self = false): string | null {
  const theirs = useStore((s) => (!self && id ? (s.players[id]?.app ?? null) : null));
  const mine = usePresence((s) => (self ? (s.self?.app ?? null) : null));
  return self ? mine : theirs;
}

/** Your sharing settings, kept with your account (both on unless turned off; off until it's known). */
export function sharingPrefs(): { share: boolean; others: boolean } {
  const account = getState().account;
  const settings = account?.profile.settings;
  return { share: !!account && settings?.appShare !== false, others: settings?.appOthers !== false };
}

export function sendPresence(update: PresenceUpdate): boolean {
  const session = getSession();
  if (!session) return false;
  session.socket.emit('presence:set', update);
  return true;
}

export type Expiry = 'never' | '30m' | '1h' | 'today';

export const EXPIRIES: { id: Expiry; label: string }[] = [
  { id: 'never', label: 'Until I clear it' },
  { id: '30m', label: '30 minutes' },
  { id: '1h', label: '1 hour' },
  { id: 'today', label: 'Today' },
];

const EXPIRY_KEY = 'workchop.presence.expiry';

export function loadExpiry(): Expiry {
  try {
    const v = localStorage.getItem(EXPIRY_KEY);
    if (EXPIRIES.some((e) => e.id === v)) return v as Expiry;
  } catch {
    // Storage may be blocked; the default does.
  }
  return 'never';
}

export function saveExpiry(e: Expiry): void {
  try {
    localStorage.setItem(EXPIRY_KEY, e);
  } catch {
    // Only a convenience.
  }
}

/** When a status picked now should end, on the server's clock (this device's may be off). */
export function untilFor(e: Expiry, now = new Date()): number | null {
  let ms: number;
  if (e === '30m') ms = 30 * 60_000;
  else if (e === '1h') ms = 60 * 60_000;
  else if (e === 'today') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    ms = end.getTime() - now.getTime();
  } else return null;
  return serverNow() + ms;
}

export function setManual(manual: ManualApp | null): void {
  sendPresence({ manual });
}
