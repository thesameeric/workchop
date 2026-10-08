import type { AccountUser, UserProfile } from '../../../shared/account';
import type { AvatarConfig, Status } from '../../../shared/types';
import { getState, setState, toast } from '../state/store';
import { devSignIn, fetchMe, fetchProviders, signOutRequest, updateMe } from './api';
import { getSession, leaveOffice } from './session';
import { loadProfile, saveProfile } from './storage';
import { getTheme, isTheme, setTheme } from './theme';

// The signed-in person's account on the client: loading it, signing in and out, and saving the
// character (and other settings) to it so they follow the person across devices. Guests keep
// theirs in this browser.

type Character = { name: string; avatar: AvatarConfig; status: Status };

const sameAvatar = (a: AvatarConfig | undefined, b: AvatarConfig | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** Account changes on their way to the server (see patchAccount). */
let pendingSaves = 0;

/**
 * Takes in who is signed in. Their saved name, character and status become yours; inside an office,
 * everyone sees the change (e.g. made on another device).
 */
export function applyAccount(user: AccountUser | null): void {
  const { account, me, phase } = getState();
  if (!user) {
    setState({ account: null });
    // Back to this browser's own character, except mid-visit (you stay who people see).
    if (account && phase !== 'office') {
      const local = loadProfile();
      setState({ me: { name: local.name, avatar: local.avatar, status: 'available' } });
    }
    return;
  }
  // While your own changes are being saved, `me` already shows them and an older answer would undo
  // them: take the character from the account once the last one is saved.
  if (pendingSaves) {
    setState({ account: user });
    return;
  }
  const next: Character = { name: user.name || me.name, avatar: user.profile.avatar ?? me.avatar, status: user.profile.status ?? me.status };
  const changed: Partial<Character> = {};
  if (next.name !== me.name) changed.name = next.name;
  if (!sameAvatar(next.avatar, me.avatar)) changed.avatar = next.avatar;
  if (next.status !== me.status) changed.status = next.status;
  setState({ account: user, me: next });
  if (phase === 'office' && Object.keys(changed).length) getSession()?.socket.emit('profile', changed);
}

/** A theme saved with the account wins over this browser's (which only paints the first frame). */
function adoptTheme(user: AccountUser | null): void {
  const theme = user?.profile.settings?.theme;
  if (isTheme(theme) && theme !== getTheme()) setTheme(theme);
}

/** The account changed on another tab or device (or a save of yours came back): take it in. */
export function accountUpdated(user: AccountUser): void {
  applyAccount(user);
  adoptTheme(user);
}

/** Asks the server who is signed in and how they can sign in (at startup). */
export async function loadAccount(): Promise<void> {
  const [providers, user] = await Promise.all([fetchProviders().catch(() => null), fetchMe().catch(() => undefined)]);
  if (providers) setState({ providers });
  // undefined: the server didn't answer; carry on as a guest.
  if (user !== undefined) {
    applyAccount(user);
    adoptTheme(user);
  }
  setState({ accountReady: true });
}

/** Checks again who is signed in (coming back to the page, or after being signed out elsewhere). */
export async function refreshAccount(): Promise<void> {
  try {
    const user = await fetchMe();
    applyAccount(user);
    adoptTheme(user);
  } catch {
    // Offline: keep what we have.
  }
}

const AUTH_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'Sign-in took too long. Please try again.',
  unavailable: 'The sign-in service can’t be reached right now. Please try again later.',
  failed: 'Sign-in didn’t work. Please try again.',
};

/** A failed sign-in comes back with ?auth_error=…: say what happened, and tidy up the address. */
export function reportAuthError(): void {
  const url = new URL(location.href);
  const code = url.searchParams.get('auth_error');
  if (code === null) return;
  url.searchParams.delete('auth_error');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  toast(AUTH_ERRORS[code] ?? AUTH_ERRORS.failed, 'error');
}

/** Where a sign-in button goes: the provider, then back to this page. */
export function signInUrl(provider: 'google' | 'apple'): string {
  return `/api/auth/${provider}/start?return=${encodeURIComponent(location.pathname + location.search)}`;
}

export async function signInWithDev(name: string, email: string): Promise<void> {
  const user = await devSignIn(name, email);
  applyAccount(user);
  adoptTheme(user);
}

/** Signs out. Inside an office you go back to its lobby, to come in again as a guest. */
export async function signOut(): Promise<void> {
  const { phase, officeId } = getState();
  // The lobby waits until we're signed out, so it doesn't show the account's name first.
  setState({ accountReady: false });
  if (phase === 'office' && officeId) {
    leaveOffice();
    setState({ phase: 'lobby', officeId });
  }
  try {
    await signOutRequest();
    applyAccount(null);
  } catch (err) {
    toast(`Couldn’t sign out: ${(err as Error).message}`, 'error');
  } finally {
    setState({ accountReady: true });
  }
}

let saving: Promise<unknown> = Promise.resolve();

/** Account changes go out one at a time, each worked out from the latest saved account. */
function patchAccount(make: (account: AccountUser) => { name?: string; profile?: UserProfile } | null): Promise<void> {
  pendingSaves++;
  const run = async () => {
    let user: AccountUser | null = null;
    try {
      const account = getState().account;
      const patch = account && make(account);
      user = patch ? await updateMe(patch) : account;
    } finally {
      pendingSaves--;
    }
    if (user) applyAccount(user);
  };
  const result = saving.then(run, run);
  saving = result.catch(() => {});
  return result;
}

/**
 * Saves your name, character and status: to your account when signed in (so they follow you to
 * other devices), otherwise in this browser (name and character only, as before).
 */
export async function saveCharacter(patch: Partial<Character>): Promise<void> {
  if (!getState().account) {
    const { me } = getState();
    if (patch.name !== undefined || patch.avatar) saveProfile({ name: patch.name ?? me.name, avatar: patch.avatar ?? me.avatar });
    return;
  }
  try {
    await patchAccount((account) => {
      const out: { name?: string; profile?: UserProfile } = {};
      const profile: UserProfile = {};
      if (patch.name && patch.name !== account.name) out.name = patch.name;
      if (patch.avatar && !sameAvatar(patch.avatar, account.profile.avatar)) profile.avatar = patch.avatar;
      if (patch.status && patch.status !== (account.profile.status ?? 'available')) profile.status = patch.status;
      if (Object.keys(profile).length) out.profile = profile;
      return out.name || out.profile ? out : null;
    });
  } catch (err) {
    toast(`Couldn’t save to your account: ${(err as Error).message}`, 'error');
  }
}

/**
 * Saves small preferences with the account (profile.settings: flat keys, short values, at most 50 in
 * all); the server merges them key by key with the ones already there. Does nothing for guests;
 * rejects if the server refuses.
 */
export function saveAccountSettings(settings: Record<string, string | number | boolean>): Promise<void> {
  return patchAccount(() => ({ profile: { settings } }));
}
