import crypto from 'node:crypto';
import type express from 'express';
import type { AccountUser } from '../../../shared/account';
import type { GithubStatus } from '../../../shared/github';
import { safeReturnPath } from '../../auth';
import type { Feature } from '../../features';
import { windowLimiter } from '../../limits';
import { createApi, NeedsReconnect, NotLinked, RateLimited } from './api';
import { THREAD_ID } from './classify';
import { parseTokenKey } from './crypto';
import { hasRepoScope, Links, migrations, type Link } from './links';
import { createOAuth, OAuthRefused } from './oauth';
import { createPoller, defaultSchedule, type Schedule } from './poller';

// GitHub notifications for signed-in people (docs/specs/github.md): connecting an OAuth App
// (/api/integrations/github/*), the poller, and the panel's socket events. Tokens stay on the server.

export interface GithubOptions {
  /** Default: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; without both, GitHub is off (its routes answer 404). */
  clientId?: string | null;
  clientSecret?: string | null;
  /** Encrypts stored tokens: base64 of 32 random bytes. Default: TOKEN_ENCRYPTION_KEY. */
  tokenKey?: string | null;
  /** Where people authorize, and where links go. Default: GITHUB_OAUTH_BASE, or https://github.com. */
  oauthBase?: string | null;
  /** Default: GITHUB_API_BASE, or https://api.github.com. */
  apiBase?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** Runs the poller's timers (tests drive them). */
  schedule?: Schedule;
}

const TX_MINUTES = 10;
const SCOPES = { basic: 'notifications', private: 'notifications repo' };

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** An http(s) base address without a trailing slash, or null. */
function baseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.search && !url.hash && !url.username) return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    // Reported by the caller.
  }
  return null;
}

/** A same-site path to come back to, never under /api/ (a finished connection mustn't start another). */
function returnPath(raw: unknown): string {
  const path = safeReturnPath(raw);
  try {
    return /^\/api(\/|$)/i.test(decodeURIComponent(new URL(path, 'http://same.invalid').pathname)) ? '/' : path;
  } catch {
    return '/';
  }
}

/** `path` with ?github=<result>, which the client reads and removes. */
function withResult(path: string, result: 'connected' | 'cancelled' | 'failed' | 'signin'): string {
  const url = new URL(path, 'http://same.invalid');
  url.searchParams.set('github', result);
  return url.pathname + url.search + url.hash;
}

/** The GitHub feature; options default to the GITHUB_* variables and TOKEN_ENCRYPTION_KEY, read when it registers. */
export function githubFeature(options: GithubOptions = {}): Feature {
  return {
    name: 'github',
    migrations,
    register(ctx) {
      const env = process.env;
      const setting = (option: string | null | undefined, name: string) => (option !== undefined ? option : env[name])?.trim() || null;
      const clientId = setting(options.clientId, 'GITHUB_CLIENT_ID');
      const clientSecret = setting(options.clientSecret, 'GITHUB_CLIENT_SECRET');
      if (!clientId || !clientSecret) return;
      const key = parseTokenKey(setting(options.tokenKey, 'TOKEN_ENCRYPTION_KEY'));
      if (!key) {
        console.error('[github] TOKEN_ENCRYPTION_KEY must be 32 random bytes in base64 (openssl rand -base64 32); GitHub is off');
        return;
      }
      if (!ctx.publicOrigin) {
        console.warn('[github] GitHub needs PUBLIC_URL (the address people open Workchop at); it is off');
        return;
      }
      const oauthBase = baseUrl(setting(options.oauthBase, 'GITHUB_OAUTH_BASE') ?? 'https://github.com');
      const apiBase = baseUrl(setting(options.apiBase, 'GITHUB_API_BASE') ?? 'https://api.github.com');
      if (!oauthBase || !apiBase) {
        console.error('[github] GITHUB_OAUTH_BASE and GITHUB_API_BASE must be http(s) addresses; GitHub is off');
        return;
      }
      const now = options.now ?? Date.now;
      const fetchFn = options.fetch ?? fetch;
      const links = new Links(ctx.db, key);
      const oauth = createOAuth({
        fetch: fetchFn,
        clientId,
        clientSecret,
        oauthBase,
        apiBase,
        // Always from PUBLIC_URL, never from the request: it must match the app's registered callback.
        redirectUri: `${ctx.publicOrigin}/api/integrations/github/callback`,
        now,
      });

      const statusOf = async (userId: string): Promise<GithubStatus> => {
        const link = await links.get(userId);
        if (!link) return { connected: false, private: false, needsReconnect: false, clientId };
        return {
          connected: true,
          login: link.login,
          avatarUrl: `https://avatars.githubusercontent.com/u/${link.githubId}?v=4`,
          private: hasRepoScope(link.scopes),
          needsReconnect: link.needsReconnect,
          clientId,
        };
      };
      const sendStatus = (userId: string) =>
        statusOf(userId)
          .then((status) => ctx.realtime.emitToUser(userId, 'github:status', status))
          .catch((err) => console.error('[github] could not send a status:', (err as Error).message));
      const revoke = (token: string) => oauth.revoke(token).catch((err) => console.warn('[github] could not revoke a token:', (err as Error).message));
      /**
       * Revokes a connection's token, best effort. GitHub no longer knows an expired one, so that is
       * refreshed first (unless GitHub already refused the connection's tokens).
       */
      const revokeLink = async (link: Link) => {
        let token = link.accessToken;
        const t = now();
        const expired = link.accessExpiresAt !== null && link.accessExpiresAt <= t;
        if (expired && !link.needsReconnect && link.refreshToken && (link.refreshExpiresAt === null || link.refreshExpiresAt > t)) {
          token = await oauth.refresh(link.refreshToken).then(
            (tokens) => tokens.accessToken,
            (err) => {
              console.warn('[github] could not refresh a token to revoke it:', (err as Error).message);
              return link.accessToken;
            },
          );
        }
        if (token) await revoke(token);
      };

      const api = createApi({
        fetch: fetchFn,
        apiBase,
        links,
        oauth,
        now,
        onNeedsReconnect(userId) {
          poller.stop(userId);
          void sendStatus(userId);
        },
        onScopes: (userId) => void sendStatus(userId),
      });
      const poller = createPoller({
        api,
        bases: { apiBase, webBase: oauthBase },
        now,
        schedule: options.schedule ?? defaultSchedule,
        emitToUser: ctx.realtime.emitToUser,
      });
      /** Polls with the user's current connection if they're in an office. */
      const restart = (userId: string) => {
        poller.stop(userId);
        if (ctx.realtime.playersOfUser(userId).length) poller.start(userId);
      };

      ctx.app.get('/integrations/github/status', ctx.auth.requireUser, async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(await statusOf((res.locals.user as AccountUser).id));
      });

      // Each attempt mints a new token if it succeeds, and GitHub re-prompts and revokes tokens past
      // 10 an hour, so attempts are limited.
      const mayConnect = windowLimiter(5, 10 * 60_000);
      /** Whether this app's own page opened the address (or the person typed it): never another site. */
      const fromThisApp = (req: express.Request) => {
        const site = req.get('sec-fetch-site');
        if (site) return site === 'same-origin' || site === 'none';
        // Browsers without Sec-Fetch-Site still say where the page was.
        const from = req.get('origin') ?? req.get('referer');
        try {
          return !!from && new URL(from).origin === ctx.publicOrigin;
        } catch {
          return false;
        }
      };

      ctx.app.get('/integrations/github/connect', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const returnTo = returnPath(req.query.return);
        // Another site mustn't connect (or re-connect) you behind your back.
        if (!fromThisApp(req)) {
          res.redirect(withResult(returnTo, 'failed'));
          return;
        }
        const user = await ctx.auth.userFromRequest(req);
        if (!user) {
          res.redirect(withResult(returnTo, 'signin'));
          return;
        }
        if (!mayConnect(user.id)) {
          res.redirect(withResult(returnTo, 'failed'));
          return;
        }
        const state = crypto.randomBytes(32).toString('base64url');
        const verifier = crypto.randomBytes(32).toString('base64url');
        try {
          await links.startTx(sha256(state), user.id, verifier, returnTo, TX_MINUTES);
        } catch (err) {
          console.error('[github] could not start connecting:', (err as Error).message);
          res.redirect(withResult(returnTo, 'failed'));
          return;
        }
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        res.redirect(oauth.authorizeUrl(state, challenge, req.query.scope === 'private' ? SCOPES.private : SCOPES.basic));
      });

      ctx.app.get('/integrations/github/callback', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        // The address has the code in it; it shouldn't travel on as a referrer.
        res.set('Referrer-Policy', 'no-referrer');
        const { state, code, error } = req.query;
        let tx: Awaited<ReturnType<Links['takeTx']>> = null;
        try {
          // Used up whatever happens next, GitHub's error answers included.
          if (typeof state === 'string' && state.length <= 100) tx = await links.takeTx(sha256(state));
        } catch (err) {
          console.error('[github] could not check a connection:', (err as Error).message);
        }
        if (!tx) {
          // No way of knowing where it came from: the page that closes the connect window (or links back).
          res.redirect(withResult('/github-callback.html', 'failed'));
          return;
        }
        const user = await ctx.auth.userFromRequest(req);
        if (!user) {
          res.redirect(withResult(tx.returnTo, 'signin'));
          return;
        }
        if (!tx.fresh || tx.userId !== user.id) {
          res.redirect(withResult(tx.returnTo, 'failed'));
          return;
        }
        if (error !== undefined) {
          res.redirect(withResult(tx.returnTo, error === 'access_denied' ? 'cancelled' : 'failed'));
          return;
        }
        if (typeof code !== 'string' || !code || code.length > 200) {
          res.redirect(withResult(tx.returnTo, 'failed'));
          return;
        }
        let token: string | null = null;
        try {
          const tokens = await oauth.exchange(code, tx.codeVerifier);
          token = tokens.accessToken;
          const account = await oauth.user(token);
          const { replaced, movedFrom } = await links.link(user.id, account, tokens);
          token = null;
          // A re-connect (say, to add the repo scope) leaves the old token unused: GitHub keeps only 10.
          for (const old of replaced) void revokeLink(old);
          for (const other of movedFrom) {
            poller.stop(other);
            void sendStatus(other);
          }
          restart(user.id);
          void sendStatus(user.id);
          res.redirect(withResult(tx.returnTo, 'connected'));
        } catch (err) {
          console.warn('[github] connecting failed:', err instanceof OAuthRefused ? err.code : (err as Error).message);
          if (token) void revoke(token);
          res.redirect(withResult(tx.returnTo, 'failed'));
        }
      });

      ctx.app.post('/integrations/github/disconnect', ctx.auth.requireUser, async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        const userId = (res.locals.user as AccountUser).id;
        const removed = await links.remove(userId);
        poller.stop(userId);
        // Only this token: revoking the whole grant would sign out other Workchop servers sharing the app.
        // Not waited for: the connection is already gone here, however long GitHub takes.
        if (removed) void revokeLink(removed);
        const status = await statusOf(userId);
        ctx.realtime.emitToUser(userId, 'github:status', status);
        res.json(status);
      });

      ctx.realtime.onJoin((s) => {
        if (!s.user) return;
        poller.start(s.user.id);
        // Before the first poll is done there's none yet: that poll sends it to all of the user's tabs.
        const inbox = poller.inbox(s.user.id);
        if (inbox) s.socket.emit('github:inbox', inbox);
      });
      ctx.realtime.onLeave((s) => {
        if (s.user && !ctx.realtime.playersOfUser(s.user.id).length) poller.leave(s.user.id);
      });

      ctx.realtime.onSocket((s) => {
        const allowed = s.limiter(2, 10);
        /** Runs an action for a signed-in socket and acks whether it worked. */
        const act = (ack: unknown, run: (userId: string) => Promise<boolean>) => {
          (s.user && allowed() ? run(s.user.id) : Promise.resolve(false))
            .catch((err: unknown) => {
              if (!(err instanceof NotLinked || err instanceof NeedsReconnect || err instanceof RateLimited)) console.warn('[github] an action failed:', (err as Error).message);
              return false;
            })
            .then((ok) => {
              if (typeof ack === 'function') ack(ok);
            })
            .catch((err) => console.error('[github] an action failed:', err));
        };
        const threadId = (id: unknown): id is string => typeof id === 'string' && THREAD_ID.test(id);
        s.socket.on('github:read', (id, ack) => act(ack, async (userId) => threadId(id) && poller.read(userId, id)));
        s.socket.on('github:done', (id, ack) => act(ack, async (userId) => threadId(id) && poller.done(userId, id)));
        s.socket.on('github:readAll', (ack) => act(ack, (userId) => poller.readAll(userId)));
      });

      // Connections people started and never finished.
      const cleanup = () => links.cleanupTx().catch((err) => console.error('[github] cleanup failed:', (err as Error).message));
      void cleanup();
      setInterval(cleanup, 3600_000).unref();
    },
  };
}

export const feature = githubFeature();
