import { sanitizeAvatar, sanitizeName, sanitizeStatus } from './avatar';
import { clip } from './text';
import type { AvatarConfig, Status } from './types';
import type { MemberRole, OfficeKind } from './workspace';

// Accounts: people who signed in (email and password, Google, Apple, GitHub, or the dev login).
// Guests have none.

export type AuthProvider = 'google' | 'apple' | 'github' | 'dev';

/** What GET /api/auth/providers answers: the ways this server lets people sign in. */
export interface SignInProviders {
  google: boolean;
  apple: boolean;
  github: boolean;
  dev: boolean;
  /** Email and password. */
  password: boolean;
  /** The server can send email: signing up with an email address, password resets, email changes. */
  emailLinks: boolean;
}

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
  /** The email address is confirmed (by a link we sent, or by the sign-in provider). */
  emailVerified: boolean;
  /** The account can sign in with a password. */
  hasPassword: boolean;
  avatarUrl: string | null;
  profile: UserProfile;
}

/** A sign-in provider connected to the account (GET /api/me/sign-in); an account may have several at one provider. */
export interface SignInMethod {
  provider: Exclude<AuthProvider, 'dev'>;
  /** The provider's id for it: removed with DELETE /api/me/sign-in/:provider/:subject. */
  subject: string;
  /** What to call it: the GitHub login, else the email address, else "Google account" and the like. */
  label: string;
  email: string | null;
  emailVerified: boolean;
}

/** GET /api/me/sign-in: how the account can sign in. */
export interface SignInMethods {
  methods: SignInMethod[];
  hasPassword: boolean;
}

/** A workspace someone belongs to: in GET /api/me/spaces, most recently visited first, then those not visited yet. */
export interface Space {
  id: string;
  name: string;
  kind: OfficeKind;
  role: MemberRole;
  /** Their last visit; null when they haven't been there yet. */
  lastVisitAt: number | null;
  online: number;
  /** A billing problem to show on its card (see shared/billing.ts); absent when there is none. */
  billing?: SpaceBilling;
}

/** 'locked': only the owner and admins can come in; 'past-due': a payment is overdue (owner and admins
 * only); 'unpaid': a support workspace that hasn't been paid for yet (owner and admins only). */
export type SpaceBilling = 'locked' | 'past-due' | 'unpaid';

export const MAX_USER_NAME = 32;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** An email address as accounts store it (trimmed, lower case), or null when it can't be one. */
export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const email = v.normalize('NFKC').trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) && !/[\u0000-\u001f\u007f]/.test(email) ? email : null;
}

/** A password as it is hashed: the same characters typed on any device give the same password. */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/** What's wrong with a new password, in words for the person choosing it; null when it's fine. */
export function passwordProblem(password: string, email: string | null): string | null {
  const p = normalizePassword(password);
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  const lower = p.toLowerCase();
  if (email && (lower === email || lower === email.split('@')[0])) return 'Don’t use your email address as your password.';
  if (new Set(p).size === 1) return 'Choose a less predictable password.';
  return null;
}
const SETTING_KEY = /^[A-Za-z][\w.-]{0,39}$/;
export const MAX_SETTINGS = 50;

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
