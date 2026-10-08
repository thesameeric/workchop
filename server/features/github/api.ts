import type { Tx } from '../../db';
import { hasRepoScope, normalizeScopes, type Links, type Tokens } from './links';
import { apiHeaders, drain, OAuthRefused, TIMEOUT_MS, type OAuth } from './oauth';

// Calls GitHub's REST API as a user: refreshes their token shortly before it expires (one refresh at
// a time per user, across servers), retries once after a 401, and reports rate limits.

/** The user hasn't connected GitHub. */
export class NotLinked extends Error {}
/** GitHub no longer accepts the user's token: they have to connect again. */
export class NeedsReconnect extends Error {}
/** GitHub asked us to wait until `until` (ms since 1970). */
export class RateLimited extends Error {
  constructor(readonly until: number) {
    super('GitHub rate limit');
  }
}

/** Refresh access tokens with less than this left. */
const REFRESH_BEFORE = 5 * 60_000;
/** After a refresh failed while the token still works, the next try waits this long. */
const RETRY_REFRESH_MS = 60_000;
/** GitHub's answers to a refresh that mean the refresh token is no good. */
const DEAD_REFRESH = new Set(['bad_refresh_token', 'unauthorized', 'invalid_grant']);
/** How often a refresh waiting for another server's looks again. */
const LEASE_RETRY_MS = 250;
const MAX_WAIT = 3600_000;
/** Redirects followed (when they stay on the API), at most MAX_REDIRECTS in a row. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** When a 403/429 lets us try again (ms since 1970), or null when it isn't about rate limits. */
export function rateLimitedUntil(res: Response, now: number): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers.get('retry-after');
  let until: number | null = null;
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) until = now + Number(retryAfter) * 1000;
  else if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 60_000;
  } else if (res.status === 429) until = now + 60_000;
  return until === null ? null : Math.min(Math.max(until, now + 1000), now + MAX_WAIT);
}

/** Whether an error answer's message is about rate limits (read from a copy: the answer stays unread). */
async function aboutRateLimits(res: Response): Promise<boolean> {
  const body = (await res.clone().json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string' && /rate limit/i.test(body.message);
}

export interface ApiDeps {
  fetch: typeof fetch;
  apiBase: string;
  links: Links;
  oauth: OAuth;
  now: () => number;
  /** A link stopped working: it now needs reconnecting. */
  onNeedsReconnect(userId: string): void;
  /** GitHub reported different scopes for a token (people can change them on GitHub). */
  onScopes(userId: string): void;
}

type Refreshed = { token: string; scopes: string } | 'gone' | 'dead';

export function createApi(deps: ApiDeps) {
  const { links, oauth, now, apiBase } = deps;
  const api = new URL(apiBase);
  const refreshing = new Map<string, Promise<{ token: string; scopes: string }>>();
  /** When a refresh last failed while the token still worked (it isn't tried again for a minute). */
  const refreshFailedAt = new Map<string, number>();

  /**
   * GitHub refused `token`: the link needs reconnecting, unless it has another token by now (connected
   * again, or refreshed meanwhile: then it's an ordinary error, and the next try uses the new one).
   */
  const lost = async (userId: string, token: string): Promise<Error> => {
    const outcome = await links.withLock(userId, async (tx) => {
      const link = await links.get(userId, tx, true);
      if (!link) return 'gone';
      if (link.accessToken !== token) return 'changed';
      await links.setNeedsReconnect(userId, tx);
      return 'marked';
    });
    if (outcome === 'gone') return new NotLinked();
    if (outcome === 'changed') return new Error('GitHub refused a token that has been replaced since');
    deps.onNeedsReconnect(userId);
    return new NeedsReconnect();
  };

  /**
   * Whoever gets there first refreshes; the rest use what it saved. Other servers may share a Postgres
   * database, so there the user's refresh is leased first (they wait for it to finish). PGlite has one
   * process (its directory is locked), so there the single-flight below is enough. Either way the
   * lock is only taken to save, and nothing holds a database connection while GitHub answers.
   */
  async function refreshLeased(userId: string, failed: string | undefined): Promise<Refreshed> {
    if (!links.shared) return refreshWith(userId, failed);
    let lease = await links.leaseRefresh(userId);
    while (lease === null) {
      await pause(LEASE_RETRY_MS);
      lease = await links.leaseRefresh(userId);
    }
    if (lease === 'gone') return 'gone';
    try {
      return await refreshWith(userId, failed);
    } finally {
      await links.releaseRefresh(userId, lease).catch((err) => console.warn('[github] could not release a refresh lease:', (err as Error).message));
    }
  }

  async function refreshWith(userId: string, failed: string | undefined): Promise<Refreshed> {
    const link = await links.get(userId);
    if (!link) return 'gone';
    if (link.needsReconnect) return 'dead';
    const t = now();
    const usable = link.accessExpiresAt === null || link.accessExpiresAt > t;
    const fresh = link.accessExpiresAt === null || link.accessExpiresAt - t >= REFRESH_BEFORE;
    const current = { token: link.accessToken!, scopes: link.scopes };
    // Another caller (or server) refreshed it meanwhile.
    if (link.accessToken !== failed && (failed !== undefined ? usable : fresh)) return current;
    let tokens: Tokens | null = null;
    if (link.refreshToken && (link.refreshExpiresAt === null || link.refreshExpiresAt > t)) {
      try {
        tokens = await oauth.refresh(link.refreshToken);
      } catch (err) {
        if (!(err instanceof OAuthRefused && DEAD_REFRESH.has(err.code))) {
          if (failed !== undefined || !usable) throw err;
          // GitHub couldn't refresh it just now; the token works until it expires.
          console.warn('[github] could not refresh a token:', (err as Error).message);
          refreshFailedAt.set(userId, now());
          return current;
        }
      }
    } else if (failed === undefined && usable) {
      // Without a refresh token, a token that still works is used until it expires.
      return current;
    }
    const save = async (tx: Tx): Promise<Refreshed> => {
      const stored = await links.get(userId, tx, true);
      if (stored?.accessToken !== link.accessToken || stored?.refreshToken !== link.refreshToken) {
        // Changed meanwhile (connected again or disconnected, or refreshed elsewhere): what's stored counts.
        if (tokens) void oauth.revoke(tokens.accessToken).catch((err) => console.warn('[github] could not revoke a token:', (err as Error).message));
        if (!stored) return 'gone';
        return stored.needsReconnect ? 'dead' : { token: stored.accessToken!, scopes: stored.scopes };
      }
      if (!tokens) {
        await links.setNeedsReconnect(userId, tx);
        return 'dead';
      }
      // GitHub may leave out the scope; it doesn't change on refresh.
      if (!tokens.scopes) tokens.scopes = link.scopes;
      await links.saveTokens(tx, userId, tokens);
      refreshFailedAt.delete(userId);
      return { token: tokens.accessToken, scopes: tokens.scopes };
    };
    return links.withLock(userId, save);
  }

  /** One refresh per user at a time in this process; a network error leaves everything as it was. */
  const refresh = (userId: string, failed?: string) => {
    let pending = refreshing.get(userId);
    if (!pending) {
      pending = refreshLeased(userId, failed)
        .then((r) => {
          if (r === 'gone') throw new NotLinked();
          if (r === 'dead') {
            deps.onNeedsReconnect(userId);
            throw new NeedsReconnect();
          }
          return r;
        })
        .finally(() => refreshing.delete(userId));
      refreshing.set(userId, pending);
    }
    return pending;
  };

  /** A usable access token for the user, refreshed when it is about to expire. */
  const token = async (userId: string): Promise<{ token: string; scopes: string }> => {
    const link = await links.get(userId);
    if (!link) throw new NotLinked();
    if (link.needsReconnect) throw new NeedsReconnect();
    const current = { token: link.accessToken!, scopes: link.scopes };
    const t = now();
    if (link.accessExpiresAt === null || link.accessExpiresAt - t >= REFRESH_BEFORE) return current;
    // After a failed refresh, a token that still works is used for a minute before trying again.
    if (link.accessExpiresAt > t && t - (refreshFailedAt.get(userId) ?? -Infinity) < RETRY_REFRESH_MS) return current;
    return refresh(userId);
  };

  /** An API path ("/notifications"), or a URL GitHub gave us; tokens are only ever sent to the API. */
  const resolve = (pathOrUrl: string): string => {
    const url = new URL(pathOrUrl.startsWith('/') ? `${apiBase}${pathOrUrl}` : pathOrUrl);
    const prefix = api.pathname.replace(/\/$/, '');
    if (url.origin !== api.origin || !url.pathname.startsWith(`${prefix}/`)) throw new Error('Not a GitHub API address');
    return url.href;
  };

  /** A redirect's Location (relative to `from`) when it stays on the API; null otherwise. */
  const onApi = (location: string | null, from: string): string | null => {
    if (!location) return null;
    try {
      return resolve(new URL(location, from).href);
    } catch {
      return null;
    }
  };

  /**
   * Sends a request as the user. Throws NotLinked, NeedsReconnect or RateLimited; other answers
   * (errors included) are returned.
   */
  async function call(userId: string, pathOrUrl: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
    const url = resolve(pathOrUrl);
    /** Sends the request, following GitHub's redirects (say, for a renamed repository) only within the API. */
    const send = async (token: string) => {
      let target = url;
      let method = init.method ?? 'GET';
      let body = init.body === undefined ? undefined : JSON.stringify(init.body);
      for (let hops = 0; ; hops++) {
        const res = await deps.fetch(target, {
          method,
          headers: apiHeaders(`Bearer ${token}`, body === undefined ? init.headers : { 'Content-Type': 'application/json', ...init.headers }),
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const next = REDIRECTS.has(res.status) && hops < MAX_REDIRECTS ? onApi(res.headers.get('location'), target) : null;
        if (!next) return res;
        await drain(res);
        target = next;
        // Only 307 and 308 ask for the same request again.
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
      }
    };
    let { token: current, scopes } = await token(userId);
    let res = await send(current);
    if (res.status === 401) {
      await drain(res);
      ({ token: current, scopes } = await refresh(userId, current));
      res = await send(current);
      if (res.status === 401) {
        await drain(res);
        throw await lost(userId, current);
      }
    }
    const header = res.headers.get('x-oauth-scopes');
    if (header !== null && normalizeScopes(header) !== scopes) {
      await links.setScopes(userId, normalizeScopes(header));
      if (hasRepoScope(normalizeScopes(header)) !== hasRepoScope(scopes)) deps.onScopes(userId);
    }
    let until = rateLimitedUntil(res, now());
    // A secondary rate limit may come as a 403 that says so only in its message: wait a minute or more.
    if (until === null && res.status === 403 && (await aboutRateLimits(res))) until = now() + 60_000;
    if (until !== null) {
      await drain(res);
      throw new RateLimited(until);
    }
    return res;
  }

  return { call, token };
}

export type Api = ReturnType<typeof createApi>;
