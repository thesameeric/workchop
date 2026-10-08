import { sanitizeAvatar, sanitizeName, sanitizeStatus } from './avatar';
import { clip } from './text';
import type { AvatarConfig, Status } from './types';

// Accounts: people who signed in (Google, Apple, or the dev login). Guests have none.

export type AuthProvider = 'google' | 'apple' | 'dev';

/** What a signed-in person keeps with their account: their character, status and settings. */
export interface UserProfile {
  avatar?: AvatarConfig;
  status?: Status;
  /** Small app preferences (theme, toggles…): flat keys with short values. */
  settings?: Record<string, string | number | boolean>;
}

export interface AccountUser {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  profile: UserProfile;
}

/** A place someone signed in has been to, newest first in GET /api/me/spaces. */
export interface Space {
  id: string;
  name: string;
  role: 'owner' | 'member';
  lastVisitAt: number;
  online: number;
}

export const MAX_USER_NAME = 32;
const SETTING_KEY = /^[A-Za-z][\w.-]{0,39}$/;
const MAX_SETTINGS = 50;

export function sanitizeUserName(v: unknown): string {
  return sanitizeName(v, MAX_USER_NAME);
}

/** Keeps only the known, valid parts of an untrusted profile (absent parts stay absent). */
export function sanitizeProfile(raw: unknown): UserProfile {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: UserProfile = {};
  if ('avatar' in r) out.avatar = sanitizeAvatar(r.avatar);
  if ('status' in r) out.status = sanitizeStatus(r.status);
  if (r.settings && typeof r.settings === 'object' && !Array.isArray(r.settings)) {
    const settings: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(r.settings).slice(0, MAX_SETTINGS)) {
      if (!SETTING_KEY.test(key)) continue;
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) settings[key] = value;
      else if (typeof value === 'string') settings[key] = clip(value.replace(/\u0000/g, ''), 200);
    }
    out.settings = settings;
  }
  return out;
}
