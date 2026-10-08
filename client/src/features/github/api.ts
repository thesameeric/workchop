import type { GithubStatus } from '../../../../shared/github';

// The server's GitHub routes (all for signed-in people; missing when the server has no GitHub).

const BASE = '/api/integrations/github';

export type GithubScope = 'basic' | 'private';

async function failed(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return new Error(typeof body.error === 'string' ? body.error : `Request failed (${res.status})`);
}

function toStatus(raw: Partial<GithubStatus> | null): GithubStatus {
  if (!raw || typeof raw.connected !== 'boolean') throw new Error('Unexpected answer from the server');
  return {
    connected: raw.connected,
    login: typeof raw.login === 'string' ? raw.login : undefined,
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : undefined,
    private: raw.private === true,
    needsReconnect: raw.needsReconnect === true,
    clientId: typeof raw.clientId === 'string' ? raw.clientId : '',
  };
}

/** Your GitHub connection; 'off' when this server has no GitHub, 'guest' when you aren't signed in. */
export async function fetchStatus(): Promise<GithubStatus | 'off' | 'guest'> {
  const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (res.status === 404) return 'off';
  if (res.status === 401) return 'guest';
  if (!res.ok) throw await failed(res);
  return toStatus(await res.json());
}

/** Disconnects GitHub (the server revokes the token); answers the new status. */
export async function postDisconnect(): Promise<GithubStatus> {
  const res = await fetch(`${BASE}/disconnect`, { method: 'POST', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw await failed(res);
  return toStatus(await res.json());
}

/** Where connecting starts: the server sends you on to GitHub, and back to `returnTo` with ?github=…. */
export function connectUrl(scope: GithubScope, returnTo: string): string {
  return `${BASE}/connect?scope=${scope}&return=${encodeURIComponent(returnTo)}`;
}
