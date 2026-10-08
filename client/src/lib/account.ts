import type { AccountUser, AuthProvider, UserProfile } from '../../../shared/account';
import type { AvatarConfig, Status } from '../../../shared/types';
import { getState, setState, toast } from '../state/store';
import { acceptInviteRequest, ApiError, devSignIn, fetchMe, fetchProviders, finishSignUpRequest, passwordSignIn, resetPasswordRequest, signOutRequest, updateMe } from './api';
import { navigate, wantDefault, withNext } from './router';
import { backToLobby, getSession } from './session';
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
 * everyone sees the change (e.g. made on another device). The server shows your account's name and
 * character there itself; the status is sent from here.
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
  setState({ account: user, me: next });
  if (phase === 'office' && next.status !== me.status) getSession()?.socket.emit('profile', { status: next.status });
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
  'linked-elsewhere': 'That sign-in already belongs to another Workchop account.',
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

/** Where a sign-in button goes: the provider, then back to `returnTo` (this page). */
export function signInUrl(provider: Exclude<AuthProvider, 'dev'>, returnTo = location.pathname + location.search): string {
  return `/api/auth/${provider}/start?return=${encodeURIComponent(returnTo)}`;
}

/** Connects another provider to your account (from Profile), then back to this page. */
export function connectUrl(provider: Exclude<AuthProvider, 'dev'>): string {
  return `/api/auth/${provider}/start?link=1&return=${encodeURIComponent(location.pathname + location.search)}`;
}

function signedIn(user: AccountUser): void {
  applyAccount(user);
  adoptTheme(user);
  // Signed in inside an office (say, from the GitHub panel): come back in as the account.
  if (getState().phase === 'office') getSession()?.reconnect();
}

export async function signInWithDev(name: string, email: string): Promise<void> {
  signedIn(await devSignIn(name, email));
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  signedIn(await passwordSignIn(email, password));
}

/** Creates the account from the emailed sign-up link, and signs in. */
export async function finishSignUp(token: string, name: string, password: string, avatar: AvatarConfig): Promise<void> {
  signedIn(await finishSignUpRequest(token, name, password, avatar));
}

/** Sets a new password from the emailed link, and signs in (everywhere else is signed out). */
export async function resetPassword(token: string, password: string): Promise<void> {
  signedIn(await resetPasswordRequest(token, password));
}

/**
 * Accepts an emailed invitation (creating the account first when `account` is given, which signs
 * you in); answers the workspace's id.
 */
export async function acceptInvite(token: string, account?: { name: string; password: string; avatar: AvatarConfig }): Promise<string> {
  const { user, officeId } = await acceptInviteRequest(token, account);
  if (getState().account?.id !== user.id) signedIn(user);
  else accountUpdated(user);
  return officeId;
}

/**
 * Where to go once signed in: first the welcome (to set up a character) if you have none yet, then
 * `next`. Inside an office you stay; the welcome waits until you leave (see welcomeIfNeeded).
 */
export function afterSignIn(next: string): void {
  const { account, phase } = getState();
  if (phase === 'office') return;
  navigate(account && !account.profile.avatar ? withNext('/welcome', next) : next, { replace: true });
  // Signed in from home: on to your default workspace.
  if (next === '/') wantDefault();
}

/** Signed in without a character yet (say, the first time with GitHub): set one up before going on. */
export function welcomeIfNeeded(): void {
  const { account, phase } = getState();
  if (!account || account.profile.avatar || (phase !== 'landing' && phase !== 'lobby' && phase !== 'profile')) return;
  // Having left an office, the address may still be the office's.
  const next = phase === 'landing' ? '/' : location.pathname + location.search;
  navigate(withNext('/welcome', next), { replace: true });
}

/** What went wrong with an account request, in a few words for the person. */
export function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Can’t reach the server. Check your connection and try again.';
  if (err.code === 'expired') return 'This link has expired or was already used.';
  if (err.code === 'taken') return 'Another account already uses this email address.';
  if (err.code === 'mail-off') return 'This server can’t send email, so this isn’t available.';
  if (err.status === 429) return 'Too many tries. Wait a few minutes, then try again.';
  return err.message;
}

/** Signs out. Inside an office you go back to its lobby, to come in again as a guest. */
export async function signOut(): Promise<void> {
  const { phase, officeId } = getState();
  // The lobby waits until we're signed out, so it doesn't show the account's name first.
  setState({ accountReady: false });
  if (phase === 'office' && officeId) backToLobby();
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

/** The changes `patch` makes to the account's name, character and status (null for none). */
function characterPatch(account: AccountUser, patch: Partial<Character>): { name?: string; profile?: UserProfile } | null {
  const out: { name?: string; profile?: UserProfile } = {};
  const profile: UserProfile = {};
  if (patch.name && patch.name !== account.name) out.name = patch.name;
  if (patch.avatar && !sameAvatar(patch.avatar, account.profile.avatar)) profile.avatar = patch.avatar;
  if (patch.status && patch.status !== (account.profile.status ?? 'available')) profile.status = patch.status;
  if (Object.keys(profile).length) out.profile = profile;
  return out.name || out.profile ? out : null;
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
    await patchAccount((account) => characterPatch(account, patch));
  } catch (err) {
    toast(`Couldn’t save to your account: ${(err as Error).message}`, 'error');
  }
}

/** Saves the account's name and character (Profile, Welcome); rejects if the server refuses. */
export function saveAccountCharacter(name: string, avatar: AvatarConfig): Promise<void> {
  return patchAccount((account) => characterPatch(account, { name, avatar }));
}

/**
 * Saves small preferences with the account (profile.settings: flat keys, short values, at most 50 in
 * all); the server merges them key by key with the ones already there. Does nothing for guests;
 * rejects if the server refuses.
 */
export function saveAccountSettings(settings: Record<string, string | number | boolean>): Promise<void> {
  return patchAccount(() => ({ profile: { settings } }));
}
