import { sanitizeUserName } from '../../shared/account';
import type { Identity } from '../accounts';

// Sign-in with GitHub, through the same OAuth App as GitHub notifications. GitHub is OAuth 2, not
// OpenID Connect: who someone is comes from its API, with a token that is revoked right after.
// Errors never include tokens, and redirects aren't followed: they could carry the client secret or
// a token to another host.

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** https://github.com, or a stand-in in tests (GITHUB_OAUTH_BASE). */
  oauthBase: string;
  /** https://api.github.com, or a stand-in in tests (GITHUB_API_BASE). */
  apiBase: string;
}

export const GITHUB_OAUTH_BASE = 'https://github.com';
export const GITHUB_API_BASE = 'https://api.github.com';

const TIMEOUT_MS = 10_000;
const TOKEN = /^[\x21-\x7e]{1,1000}$/;
/** Enterprise Managed Users' logins have an underscore (octo_acme). */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const headers = (authorization: string, extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: authorization,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Workchop',
  ...extra,
});

const emailOf = (v: unknown): string | null => (typeof v === 'string' && v.includes('@') && v.length <= 254 ? v.toLowerCase() : null);

export function githubProvider(cfg: GithubConfig, redirectUri: string) {
  const basic = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;

  /** GitHub answers errors as `{ error }`, often with a 200. */
  const exchange = async (code: string, codeVerifier: string): Promise<string> => {
    const res = await fetch(`${cfg.oauthBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Workchop' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.error === 'string') throw new Error(`GitHub refused the code: ${body.error.slice(0, 60)}`);
    if (!res.ok || typeof body?.access_token !== 'string' || !TOKEN.test(body.access_token)) throw new Error(`GitHub's token endpoint answered ${res.status}`);
    return body.access_token;
  };

  const get = async (path: string, token: string): Promise<unknown> => {
    const res = await fetch(`${cfg.apiBase}${path}`, { headers: headers(`Bearer ${token}`), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`GitHub's ${path} answered ${res.status}`);
    return body;
  };

  const profile = async (token: string): Promise<Identity> => {
    const user = (await get('/user', token)) as Record<string, unknown> | null;
    const id = user?.id;
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof user!.login !== 'string' || !LOGIN.test(user!.login)) {
      throw new Error("GitHub's /user sent an unexpected profile");
    }
    // The primary address if GitHub has verified it (it links to the account with that address);
    // otherwise the public profile email, as unverified.
    let email: string | null = null;
    try {
      const emails = await get('/user/emails', token);
      const primary = Array.isArray(emails) ? (emails as Record<string, unknown>[]).find((e) => e?.primary === true && e.verified === true) : undefined;
      email = emailOf(primary?.email);
    } catch (err) {
      // Signing in doesn't need an email address.
      console.warn('[auth] could not read GitHub email addresses:', (err as Error).message);
    }
    const emailVerified = !!email;
    email ??= emailOf(user!.email);
    const avatar = user!.avatar_url;
    return {
      provider: 'github',
      subject: String(id),
      email,
      emailVerified,
      isPrivateEmail: false,
      name: sanitizeUserName(user!.name) || sanitizeUserName(user!.login),
      avatarUrl: typeof avatar === 'string' && avatar.startsWith('https://') && avatar.length < 1000 ? avatar : null,
      label: user!.login as string,
    };
  };

  /** Revokes just this token (not the grant, which GitHub notifications may share). */
  const revoke = async (token: string): Promise<void> => {
    const res = await fetch(`${cfg.apiBase}/applications/${encodeURIComponent(cfg.clientId)}/token`, {
      method: 'DELETE',
      headers: headers(basic, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ access_token: token }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    // 404/422: GitHub doesn't know it (any more), which is what we wanted.
    if (!res.ok && res.status !== 404 && res.status !== 422) throw new Error(`GitHub answered ${res.status}`);
  };

  return {
    authorizeUrl(state: string, codeChallenge: string): string {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        scope: 'user:email',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        allow_signup: 'true',
        // A click every time, even for someone who approved the app before (as Google's sign-in does).
        prompt: 'select_account',
      });
      return `${cfg.oauthBase}/login/oauth/authorize?${params}`;
    },

    /** Who signed in, for an authorization code. Workchop keeps no GitHub token from signing in. */
    async identity(code: string, codeVerifier: string): Promise<Identity> {
      const token = await exchange(code, codeVerifier);
      try {
        return await profile(token);
      } finally {
        revoke(token).catch((err) => console.warn('[auth] could not revoke a GitHub sign-in token:', (err as Error).message));
      }
    },
  };
}

export type GithubProvider = ReturnType<typeof githubProvider>;
