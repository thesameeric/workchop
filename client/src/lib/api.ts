import type { AccountUser, SignInMethod, SignInMethods, SignInProviders, Space, UserProfile } from '../../../shared/account';
import type { TemplateId } from '../../../shared/templates';
import type { AvatarConfig } from '../../../shared/types';
import type { AccessDenied, GuestAccess, Invite, Member, MemberRole, MembersAnswer, OfficeInfo, OfficeKind } from '../../../shared/workspace';

/**
 * How long to wait for the server. Generous, because a server that was asleep (Cloudflare
 * Containers stop when idle) needs a few seconds to start and reach its database.
 */
const SERVER_TIMEOUT_MS = 30_000;

/** A request the server turned down: its message, the HTTP status and the error's `code`, if any. */
export class ApiError extends Error {
  status: number;
  /** What kind of refusal, for the client to word: 'expired' (an emailed link), 'taken', 'mail-off'… */
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { error, code } = body as { error?: unknown; code?: unknown };
    throw new ApiError(typeof error === 'string' ? error : `Request failed (${res.status})`, res.status, typeof code === 'string' ? code : null);
  }
  return body as T;
}

/** A JSON request (POST unless `method` says otherwise). */
async function send<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) };
  if (body !== undefined) Object.assign(init, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return json(await fetch(url, init));
}

export interface ClientConfig {
  iceServers: RTCIceServer[];
  /** Seconds until TURN credentials in `iceServers` expire, when they do. */
  iceTtl?: number;
  /** The server hands out short-lived TURN credentials (refresh them; retry if these have none). */
  turn?: boolean;
  /** Set when the server enables Spotify listen-along. */
  spotifyClientId: string | null;
  /** The largest file the server takes, when known. */
  uploadMaxBytes?: number;
}

export async function fetchConfig(): Promise<ClientConfig> {
  try {
    const cfg = await json<Partial<ClientConfig>>(await fetch('/api/config', { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS), cache: 'no-store' }));
    const iceTtl = typeof cfg.iceTtl === 'number' && cfg.iceTtl > 0 ? cfg.iceTtl : undefined;
    const uploadMaxBytes = typeof cfg.uploadMaxBytes === 'number' && cfg.uploadMaxBytes > 0 ? cfg.uploadMaxBytes : undefined;
    return { iceServers: cfg.iceServers ?? [], iceTtl, turn: cfg.turn === true, spotifyClientId: cfg.spotifyClientId ?? null, uploadMaxBytes };
  } catch {
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], spotifyClientId: null };
  }
}

// Workspaces (see the README's "Workspaces").

/** Creates a workspace you own (signed in only). */
export async function createOffice(name: string, kind: OfficeKind, template: TemplateId): Promise<{ id: string }> {
  return send('/api/offices', { name, kind, template });
}

/** An office as you'd come in, why you can't ('sign-in', 'members-only', 'link'), or null when there's none. */
export type OfficeLookup = OfficeInfo | { denied: AccessDenied } | null;

/** Looks an office up, with the guest link's token if you have one. */
export async function fetchOfficeInfo(id: string, guest?: string): Promise<OfficeLookup> {
  // A server that accepts the connection but never answers counts as unreachable.
  const res = await fetch(`/api/offices/${encodeURIComponent(id)}`, {
    headers: guest ? { 'X-Workchop-Guest': guest } : {},
    signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (res.status === 403) {
    const { reason } = (await res.json().catch(() => ({}))) as { reason?: AccessDenied };
    return { denied: reason ?? 'members-only' };
  }
  return json(res);
}

/** Adds offices made on this browser before accounts to yours; answers the ones it added. */
export async function claimOffices(offices: { id: string; ownerKey: string }[]): Promise<string[]> {
  return (await send<{ claimed: string[] }>('/api/offices/claim', { offices })).claimed;
}

const officeApi = (id: string, path = '') => `/api/offices/${encodeURIComponent(id)}${path}`;

export async function fetchMembers(officeId: string): Promise<MembersAnswer> {
  return json(await fetch(officeApi(officeId, '/members'), { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS), cache: 'no-store' }));
}

/** Adds someone by email: at once when they have an account with that address, otherwise an invitation. */
export async function addMember(officeId: string, email: string, role: 'admin' | 'member'): Promise<{ member: Member } | { invite: Invite }> {
  return send(officeApi(officeId, '/members'), { email, role });
}

export async function changeRole(officeId: string, userId: string, role: MemberRole): Promise<Member> {
  return (await send<{ member: Member }>(officeApi(officeId, `/members/${encodeURIComponent(userId)}`), { role }, 'PATCH')).member;
}

/** Removes someone (or yourself: leaving the workspace). */
export async function removeMember(officeId: string, userId: string): Promise<void> {
  await send(officeApi(officeId, `/members/${encodeURIComponent(userId)}`), undefined, 'DELETE');
}

/** Makes another member the owner; you become an admin. */
export async function transferOwnership(officeId: string, userId: string): Promise<void> {
  await send(officeApi(officeId, '/owner'), { userId });
}

export async function revokeInvite(officeId: string, inviteId: string): Promise<void> {
  await send(officeApi(officeId, `/invites/${encodeURIComponent(inviteId)}`), undefined, 'DELETE');
}

export async function resendInvite(officeId: string, inviteId: string): Promise<void> {
  await send(officeApi(officeId, `/invites/${encodeURIComponent(inviteId)}/resend`));
}

export type GuestLink = { guests: GuestAccess; link: string | null };

/** Turns the guest link on or off. */
export async function setGuestAccess(officeId: string, guests: 'off' | 'link'): Promise<GuestLink> {
  return send(officeApi(officeId, '/access'), { guests }, 'PUT');
}

/** A new guest link; the old one stops working (people already in stay). */
export async function resetGuestLink(officeId: string): Promise<GuestLink> {
  return send(officeApi(officeId, '/access/reset'));
}

export interface InvitePreview {
  officeName: string;
  email: string;
  role: 'admin' | 'member';
  /** An account already has that address: sign in with it to accept. */
  hasAccount: boolean;
}

/** What an emailed invitation is for, without using it up. */
export async function previewInvite(token: string): Promise<InvitePreview> {
  return send('/api/invites/preview', { token });
}

/**
 * Accepts an invitation: signed in with its address, or creating that account (name, password and
 * character) and signing in.
 */
export async function acceptInviteRequest(
  token: string,
  account?: { name: string; password: string; avatar: AvatarConfig },
): Promise<{ user: AccountUser; officeId: string }> {
  return send('/api/invites/accept', { token, ...account });
}

// Accounts (see the README's "Accounts and sign-in").

export async function fetchProviders(): Promise<SignInProviders> {
  const p = await json<Partial<SignInProviders>>(await fetch('/api/auth/providers', { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) }));
  return {
    google: p.google === true,
    apple: p.apple === true,
    github: p.github === true,
    dev: p.dev === true,
    password: p.password === true,
    emailLinks: p.emailLinks === true,
  };
}

/** Who is signed in (null for guests); throws when the server can't be reached. */
export async function fetchMe(): Promise<AccountUser | null> {
  const res = await fetch('/api/me', { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS), cache: 'no-store' });
  return (await json<{ user: AccountUser | null }>(res)).user;
}

export async function updateMe(patch: { name?: string; profile?: UserProfile }): Promise<AccountUser> {
  const res = await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  return (await json<{ user: AccountUser }>(res)).user;
}

export async function devSignIn(name: string, email: string): Promise<AccountUser> {
  const res = await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email }) });
  return (await json<{ user: AccountUser }>(res)).user;
}

export async function signOutRequest(): Promise<void> {
  await json(await fetch('/api/auth/logout', { method: 'POST' }));
}

/** Ends your sessions on other devices; answers how many there were. */
export async function signOutOthersRequest(): Promise<number> {
  return (await send<{ ended: number }>('/api/auth/logout-others')).ended;
}

// Email and password. Emailed links hold a token in their fragment, which the page sends here.

/** Mails a link to finish signing up (always "sent" for a valid address, so nobody learns who has an account). */
export async function signUpRequest(email: string): Promise<void> {
  await send('/api/auth/signup', { email });
}

export async function finishSignUpRequest(token: string, name: string, password: string, avatar: AvatarConfig): Promise<AccountUser> {
  return (await send<{ user: AccountUser }>('/api/auth/signup/finish', { token, name, password, avatar })).user;
}

export async function passwordSignIn(email: string, password: string): Promise<AccountUser> {
  return (await send<{ user: AccountUser }>('/api/auth/password', { email, password })).user;
}

export async function forgotPasswordRequest(email: string): Promise<void> {
  await send('/api/auth/password/forgot', { email });
}

export async function resetPasswordRequest(token: string, password: string): Promise<AccountUser> {
  return (await send<{ user: AccountUser }>('/api/auth/password/reset', { token, password })).user;
}

/** Which address an emailed sign-up or reset link is for, without using it up. */
export async function peekLinkRequest(token: string): Promise<{ email: string; purpose: string }> {
  return send('/api/auth/link/peek', { token });
}

/** Confirms an email address from its emailed link; only the account that asked for it may (401 'sign-in'). */
export async function confirmEmailRequest(token: string): Promise<AccountUser> {
  return (await send<{ user: AccountUser }>('/api/auth/email/confirm', { token })).user;
}

/** Changes your password (ending your other sessions). */
export async function changePasswordRequest(current: string, password: string): Promise<void> {
  await send('/api/me/password', { current, password });
}

/** Mails you a link to set a password (accounts that sign in with Google, Apple or GitHub). */
export async function passwordLinkRequest(): Promise<void> {
  await send('/api/me/password/link');
}

/**
 * Mails a confirmation link to a new address (or to your current one, to confirm it), unless another
 * account has it. `current` is your password, when the account has one.
 */
export async function changeEmailRequest(email: string, current?: string): Promise<void> {
  await send('/api/me/email', { email, current });
}

export async function fetchSignInMethods(): Promise<SignInMethods> {
  return json(await fetch('/api/me/sign-in', { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS), cache: 'no-store' }));
}

/** Disconnects one identity (`subject`) of a provider from the account. */
export async function removeSignInMethod(method: Pick<SignInMethod, 'provider' | 'subject'>): Promise<SignInMethods> {
  return send(`/api/me/sign-in/${method.provider}/${encodeURIComponent(method.subject)}`, undefined, 'DELETE');
}

/** The workspaces the signed-in person belongs to, most recently visited first (the first is their default). */
export async function fetchSpaces(): Promise<Space[]> {
  return json(await fetch('/api/me/spaces', { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS), cache: 'no-store' }));
}
