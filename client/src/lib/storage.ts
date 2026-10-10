import { DEFAULT_AVATAR, randomAvatar, sanitizeAvatar, sanitizeName } from '../../../shared/avatar';
import type { AvatarConfig } from '../../../shared/types';
import type { NoiseMode } from './noise';

const PREFIX = 'workchop:';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, quota); preferences just won't persist.
  }
}

/** A value kept in this tab only (null when storage is unavailable). */
function tabRead(key: string): string | null {
  try {
    return sessionStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function tabWrite(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(PREFIX + key);
    else sessionStorage.setItem(PREFIX + key, value);
  } catch {
    // Not kept, then.
  }
}

/** A random secret, URL-safe: 24 random bytes as 32 characters. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** This browser's id as this page knows it (all it has when storage is unavailable). */
let pageBrowserId: string | undefined;

/**
 * This browser's secret (JoinRequest.browser), sent with every join: you're one person per browser,
 * so coming into an office in another tab takes you out of it in this one. Without storage it's
 * this page's own, and the tab isn't matched with others. Signing out keeps it.
 */
export function browserId(): string {
  const kept = read<unknown>('browser');
  if (typeof kept === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(kept)) return (pageBrowserId = kept);
  pageBrowserId ??= randomSecret();
  write('browser', pageBrowserId);
  return pageBrowserId;
}

export interface Profile {
  name: string;
  avatar: AvatarConfig;
}

export function loadProfile(): Profile {
  const saved = read<Partial<Profile>>('profile');
  if (!saved) return { name: '', avatar: { ...randomAvatar(), hat: 'none' } };
  return { name: sanitizeName(saved.name), avatar: sanitizeAvatar(saved.avatar ?? DEFAULT_AVATAR) };
}

export function saveProfile(p: Profile): void {
  write('profile', p);
}

/** Where someone was going when they asked for a sign-up link, for when they open it in this browser. */
export function saveSignUpNext(path: string): void {
  write('signup-next', path);
}

export function takeSignUpNext(): string | null {
  const path = read<unknown>('signup-next');
  try {
    localStorage.removeItem(PREFIX + 'signup-next');
  } catch {
    // Nothing kept, then.
  }
  return typeof path === 'string' ? path : null;
}

/**
 * An email confirmation link opened while signed out (or as someone else), kept in this tab while
 * signing in; null clears it.
 */
export function setPendingConfirmation(token: string | null): void {
  tabWrite('confirm-email', token || null);
}

export function pendingConfirmation(): string | null {
  return tabRead('confirm-email');
}

/** Owner keys of offices made on this browser before accounts (the server no longer hands out new ones). */
function owners(): Record<string, string> {
  const all = read<unknown>('owners');
  if (!all || typeof all !== 'object') return {};
  return Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

export function getOwnerKey(officeId: string): string | undefined {
  return owners()[officeId];
}

/** The offices made on this browser, to add to your account (POST /api/offices/claim). */
export function ownerKeys(): { id: string; ownerKey: string }[] {
  return Object.entries(owners()).map(([id, ownerKey]) => ({ id, ownerKey }));
}

export function forgetOwnerKeys(ids: string[]): void {
  const left = owners();
  for (const id of ids) delete left[id];
  write('owners', left);
}

/** Guest link tokens (`/o/<id>#guest=…`) by office, sent when looking it up and joining. */
export function getGuestToken(officeId: string): string | undefined {
  const token = read<Record<string, unknown>>('guest-links')?.[officeId];
  return typeof token === 'string' ? token : undefined;
}

export function setGuestToken(officeId: string, token: string): void {
  write('guest-links', { ...(read<Record<string, unknown>>('guest-links') ?? {}), [officeId]: token });
}

/** A guest link that no longer works. */
export function forgetGuestToken(officeId: string): void {
  const links = { ...(read<Record<string, unknown>>('guest-links') ?? {}) };
  if (!(officeId in links)) return;
  delete links[officeId];
  write('guest-links', links);
}

/** Workspaces each account came into on this browser (`<accountId>:<officeId>`), most recent last. */
function entered(): string[] {
  const list = read<unknown>('entered');
  return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string') : [];
}

/** Whether this account came into this workspace on this browser before (then it skips the lobby). */
export function enteredBefore(accountId: string, officeId: string): boolean {
  return entered().includes(`${accountId}:${officeId}`);
}

export function rememberEntered(accountId: string, officeId: string): void {
  const key = `${accountId}:${officeId}`;
  write('entered', [...entered().filter((e) => e !== key), key].slice(-200));
}

/** You went home in this tab (left an office, or chose Home): it stops sending you to your default workspace. */
export function chooseHome(): void {
  tabWrite('home', '1');
}

export function choseHome(): boolean {
  return tabRead('home') === '1';
}

/** An invitation link opened in this tab, kept while signing in (null clears it). */
export function setPendingInvite(token: string | null): void {
  tabWrite('invite', token);
}

export function pendingInvite(): string | null {
  return tabRead('invite');
}

export interface RecentOffice {
  id: string;
  name: string;
  at: number;
}

export function recentOffices(): RecentOffice[] {
  const list = read<RecentOffice[]>('recent');
  return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string').slice(0, 8) : [];
}

export function rememberOffice(id: string, name: string): void {
  write('recent', [{ id, name, at: Date.now() }, ...recentOffices().filter((r) => r.id !== id)].slice(0, 8));
}

/**
 * Signed out: this browser forgets the workspaces you were in (their names, and what you had open in
 * each: features/chat's keys), so whoever uses it next doesn't see them.
 */
export function forgetVisits(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === PREFIX + 'recent' || key === PREFIX + 'entered' || key.startsWith(PREFIX + 'chat:')) localStorage.removeItem(key);
    }
  } catch {
    // Nothing kept, then.
  }
}

export interface DevicePrefs {
  audioIn?: string;
  videoIn?: string;
  audioOut?: string;
  micOn?: boolean;
  camOn?: boolean;
  noise?: NoiseMode;
}

export function loadDevices(): DevicePrefs {
  return read<DevicePrefs>('devices') ?? {};
}

export function saveDevices(prefs: DevicePrefs): void {
  write('devices', { ...loadDevices(), ...prefs });
}
