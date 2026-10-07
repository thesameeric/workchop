import { DEFAULT_AVATAR, randomAvatar, sanitizeAvatar, sanitizeName } from '../../../shared/avatar';
import type { AvatarConfig } from '../../../shared/types';

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

export function getOwnerKey(officeId: string): string | undefined {
  return read<Record<string, string>>('owners')?.[officeId];
}

export function setOwnerKey(officeId: string, key: string): void {
  write('owners', { ...(read<Record<string, string>>('owners') ?? {}), [officeId]: key });
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

export interface DevicePrefs {
  audioIn?: string;
  videoIn?: string;
  audioOut?: string;
  micOn?: boolean;
  camOn?: boolean;
}

export function loadDevices(): DevicePrefs {
  return read<DevicePrefs>('devices') ?? {};
}

export function saveDevices(prefs: DevicePrefs): void {
  write('devices', { ...loadDevices(), ...prefs });
}
