import type { AccountUser, AuthProvider, Space, UserProfile } from '../../../shared/account';
import type { TemplateId } from '../../../shared/templates';

/**
 * How long to wait for the server. Generous, because a server that was asleep (Cloudflare
 * Containers stop when idle) needs a few seconds to start and reach its database.
 */
const SERVER_TIMEOUT_MS = 30_000;

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
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

export async function createOffice(name: string, template: TemplateId): Promise<{ id: string; ownerKey: string }> {
  return json(
    await fetch('/api/offices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, template }),
    }),
  );
}

export async function fetchOfficeInfo(id: string): Promise<{ id: string; name: string; online: number } | null> {
  // A server that accepts the connection but never answers counts as unreachable.
  const res = await fetch(`/api/offices/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) });
  if (res.status === 404) return null;
  return json(res);
}

// Accounts (see the README's "Accounts and sign-in").

export async function fetchProviders(): Promise<Record<AuthProvider, boolean>> {
  const p = await json<Partial<Record<AuthProvider, boolean>>>(await fetch('/api/auth/providers', { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) }));
  return { google: p.google === true, apple: p.apple === true, github: p.github === true, dev: p.dev === true };
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

/** The offices the signed-in person belongs to, most recently visited first. */
export async function fetchSpaces(): Promise<Space[]> {
  return json(await fetch('/api/me/spaces', { cache: 'no-store' }));
}
