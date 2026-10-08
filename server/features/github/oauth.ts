import { normalizeScopes, type Tokens } from './links';

// GitHub's OAuth App endpoints (web flow with PKCE, refresh, revoke). Errors never include tokens, and
// redirects aren't followed: they could carry the client secret or a token to another host.

export const TIMEOUT_MS = 10_000;

export interface OAuthConfig {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  /** https://github.com, or a stand-in in tests. */
  oauthBase: string;
  /** https://api.github.com, or a stand-in in tests. */
  apiBase: string;
  redirectUri: string;
  now: () => number;
}

/** GitHub refused the code or refresh token; `code` is its error code (bad_refresh_token…). */
export class OAuthRefused extends Error {
  constructor(readonly code: string) {
    super(`GitHub refused: ${code}`);
  }
}

const TOKEN = /^[\x21-\x7e]{1,1000}$/;
/** Only shown (the numeric id is who it is); Enterprise Managed Users' have an underscore (octo_acme). */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Headers for GitHub's REST API. */
export function apiHeaders(authorization: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: authorization, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Workchop', ...extra };
}

/** Lets go of a response body nobody reads. */
export const drain = (res: Response) => res.body?.cancel().catch(() => {});

const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export function createOAuth(config: OAuthConfig) {
  const { clientId, clientSecret, oauthBase, apiBase, redirectUri, now } = config;
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  /** POST /login/oauth/access_token; GitHub answers errors as `{ error }`, often with a 200. */
  const tokenRequest = async (params: Record<string, string>): Promise<Tokens> => {
    const res = await config.fetch(`${oauthBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Workchop' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.error === 'string') throw new OAuthRefused(body.error.slice(0, 60));
    if (res.status === 401) throw new OAuthRefused('unauthorized');
    if (!res.ok || !body || typeof body.access_token !== 'string' || !TOKEN.test(body.access_token)) {
      throw new Error(`GitHub's token endpoint answered ${res.status}`);
    }
    const at = now();
    const expiresIn = seconds(body.expires_in);
    const refreshIn = seconds(body.refresh_token_expires_in);
    const refreshToken = typeof body.refresh_token === 'string' && TOKEN.test(body.refresh_token) ? body.refresh_token : null;
    return {
      accessToken: body.access_token,
      refreshToken,
      accessExpiresAt: expiresIn === null ? null : at + expiresIn * 1000,
      refreshExpiresAt: refreshToken && refreshIn !== null ? at + refreshIn * 1000 : null,
      scopes: normalizeScopes(typeof body.scope === 'string' ? body.scope : ''),
    };
  };

  return {
    authorizeUrl(state: string, codeChallenge: string, scope: string): string {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        allow_signup: 'false',
      });
      return `${oauthBase}/login/oauth/authorize?${params.toString().replace(/\+/g, '%20')}`;
    },

    exchange: (code: string, codeVerifier: string) => tokenRequest({ code, redirect_uri: redirectUri, code_verifier: codeVerifier }),

    refresh: (refreshToken: string) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    /** The token's GitHub account (GET /user). */
    async user(accessToken: string): Promise<{ id: string; login: string }> {
      const res = await config.fetch(`${apiBase}/user`, {
        headers: apiHeaders(`Bearer ${accessToken}`),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as { id?: unknown; login?: unknown } | null;
      if (!res.ok) throw new Error(`GitHub's /user answered ${res.status}`);
      if (!Number.isSafeInteger(body?.id) || (body!.id as number) <= 0 || typeof body!.login !== 'string' || !LOGIN.test(body!.login)) {
        throw new Error("GitHub's /user sent an unexpected profile");
      }
      return { id: String(body!.id), login: body!.login };
    },

    /** Revokes just this token (not the whole grant, which other Workchop servers may share). */
    async revoke(accessToken: string): Promise<void> {
      const res = await config.fetch(`${apiBase}/applications/${encodeURIComponent(clientId)}/token`, {
        method: 'DELETE',
        headers: apiHeaders(basic, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ access_token: accessToken }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await drain(res);
      // 404/422: GitHub doesn't know it (any more), which is what we wanted.
      if (!res.ok && res.status !== 404 && res.status !== 422) throw new Error(`GitHub answered ${res.status}`);
    },
  };
}

export type OAuth = ReturnType<typeof createOAuth>;
