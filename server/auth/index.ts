import crypto from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';
import express from 'express';
import * as client from 'openid-client';
import { sanitizeProfile, sanitizeUserName, type AccountUser } from '../../shared/account';
import { clip } from '../../shared/text';
import type { Accounts } from '../accounts';
import type { Db } from '../db';
import type { ClientSocket } from '../realtime';
import { APPLE_ISSUER, appleProvider, checkPrivateKey, GOOGLE_ISSUER, googleProvider, parsePrivateKey, type AppleConfig, type GoogleConfig, type OidcProvider } from './oidc';
import { hashToken, SESSION_DAYS, Sessions, type Session } from './sessions';

export interface AuthOptions {
  google: GoogleConfig | null;
  apple: AppleConfig | null;
  /** The "dev" provider: sign in with any name and email, no password. For development and tests only. */
  devLogin: boolean;
}

/** `production`: the built server, which may run without NODE_ENV (e.g. `npm start`). */
export function authOptionsFromEnv(env: NodeJS.ProcessEnv = process.env, production = env.NODE_ENV === 'production'): AuthOptions {
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, issuer: env.GOOGLE_ISSUER || GOOGLE_ISSUER }
    : null;
  let apple: AppleConfig | null = null;
  if (env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
    apple = {
      clientId: env.APPLE_CLIENT_ID,
      teamId: env.APPLE_TEAM_ID,
      keyId: env.APPLE_KEY_ID,
      privateKey: env.APPLE_PRIVATE_KEY,
      issuer: env.APPLE_ISSUER || APPLE_ISSUER,
    };
  }
  let devLogin = env.DEV_LOGIN === 'true';
  if (devLogin && production && env.DEV_LOGIN_IN_PRODUCTION !== 'true') {
    console.warn('[auth] DEV_LOGIN is ignored in production (anyone could sign in as anyone)');
    devLogin = false;
  }
  return { google, apple, devLogin };
}

/** A same-site path to go back to after signing in; anything else becomes "/". */
export function safeReturnPath(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || v.length > 1000) return '/';
  try {
    const url = new URL(v, 'http://same.invalid');
    const out = url.pathname + url.search + url.hash;
    // Dot segments can turn into a protocol-relative "//other.site" only once resolved.
    return url.origin === 'http://same.invalid' && !out.startsWith('//') ? out : '/';
  } catch {
    return '/';
  }
}

function withError(path: string, code: string): string {
  const url = new URL(path, 'http://same.invalid');
  url.searchParams.set('auth_error', code);
  return url.pathname + url.search + url.hash;
}

const TX_MINUTES = 10;

export interface AuthDeps {
  db: Db;
  accounts: Accounts;
  /** Origin the browser uses (PUBLIC_URL); null disables Google and Apple, which need it for redirects. */
  publicOrigin: string | null;
  options: AuthOptions;
  /** Called after a session is deleted, to disconnect its sockets. */
  onLogout?: (tokenHash: string) => void;
  /** Called after someone changed their account (PATCH /api/me), to tell their other tabs and devices. */
  onUserUpdated?: (user: AccountUser) => void;
  quiet?: boolean;
}

export type Auth = ReturnType<typeof createAuth>;

/** Sign-in with Google, Apple or the dev login, cookie sessions, and the /api/auth and /api/me routes. */
export function createAuth(deps: AuthDeps) {
  const { db, accounts, publicOrigin, options } = deps;
  const sessions = new Sessions(db);
  // Secure cookies need HTTPS, and Safari won't send them to http://localhost.
  const secure = publicOrigin?.startsWith('https:') ?? false;
  const sessionCookie = secure ? '__Host-wc_session' : 'wc_session';
  const googleTxCookie = secure ? '__Host-wc_auth' : 'wc_auth';
  // Apple returns with a cross-site POST, which only carries SameSite=None (and so Secure) cookies.
  const appleTxCookie = '__Host-wc_auth_apple';

  const providers: Partial<Record<'google' | 'apple', OidcProvider>> = {};
  if (options.google || options.apple) {
    if (!publicOrigin) console.warn('[auth] Google and Apple sign-in need PUBLIC_URL (the address people open Workchop at); they are off');
    else {
      if (options.google) providers.google = googleProvider(options.google);
      if (options.apple) {
        try {
          const privateKey = parsePrivateKey(options.apple.privateKey);
          checkPrivateKey(privateKey);
          providers.apple = appleProvider({ ...options.apple, privateKey });
        } catch (err) {
          console.error(`[auth] Apple sign-in is off: APPLE_PRIVATE_KEY is not a valid key (${(err as Error).message})`);
        }
      }
    }
  }
  if (!deps.quiet) {
    const on = [...Object.keys(providers), ...(options.devLogin ? ['dev login'] : [])];
    if (on.length) console.log(`[auth] sign-in with ${on.join(', ')}`);
  }

  const setCookie = (res: express.Response, name: string, value: string | null, opts: { maxAge: number; sameSite?: 'lax' | 'none'; secure?: boolean }) => {
    res.append(
      'Set-Cookie',
      stringifySetCookie({
        name,
        value: value ?? '',
        httpOnly: true,
        secure: opts.secure ?? secure,
        sameSite: opts.sameSite ?? 'lax',
        path: '/',
        maxAge: value ? opts.maxAge : 0,
      }),
    );
  };
  const setSession = (res: express.Response, token: string | null) => setCookie(res, sessionCookie, token, { maxAge: SESSION_DAYS * 24 * 3600 });
  const cookiesOf = (header: string | undefined) => parseCookie(header ?? '');

  const sessionOfRequest = new WeakMap<express.Request, Promise<Session | null>>();
  /** The request's session (looked up once per request); null for guests or when storage fails. */
  const sessionFromRequest = (req: express.Request): Promise<Session | null> => {
    let pending = sessionOfRequest.get(req);
    if (!pending) {
      pending = sessions.lookup(cookiesOf(req.headers.cookie)[sessionCookie]).catch((err) => {
        console.error('[auth] could not check a session:', (err as Error).message);
        return null;
      });
      sessionOfRequest.set(req, pending);
    }
    return pending;
  };
  const userFromRequest = async (req: express.Request): Promise<AccountUser | null> => (await sessionFromRequest(req))?.user ?? null;

  /** 401 for guests; otherwise the user is in res.locals.user. */
  const requireUser: express.RequestHandler = async (req, res, next) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: 'Please sign in first.' });
      return;
    }
    res.locals.user = user;
    next();
  };

  /** Starts a session for `user` (a new token on every sign-in), ending the browser's previous one. */
  const signIn = async (req: express.Request, res: express.Response, user: AccountUser) => {
    const previous = await sessionFromRequest(req);
    if (previous) {
      await sessions.delete(previous.tokenHash);
      deps.onLogout?.(previous.tokenHash);
    }
    const token = await sessions.create(user.id, req.get('user-agent'));
    setSession(res, token);
  };

  const router = express.Router();

  router.get('/auth/providers', (_req, res) => {
    res.json({ google: !!providers.google, apple: !!providers.apple, dev: options.devLogin });
  });

  router.get('/auth/:provider/start', async (req, res) => {
    const name = req.params.provider;
    const provider = name === 'google' || name === 'apple' ? providers[name] : undefined;
    if (!provider || !publicOrigin) {
      res.status(404).json({ error: 'This sign-in method is not available.' });
      return;
    }
    const returnTo = safeReturnPath(req.query.return);
    let config: client.Configuration;
    try {
      config = await provider.config();
    } catch (err) {
      console.error(`[auth] could not reach ${provider.name}:`, (err as Error).message);
      res.redirect(withError(returnTo, 'unavailable'));
      return;
    }
    const state = client.randomState();
    const nonce = client.randomNonce();
    const verifier = provider.pkce ? client.randomPKCECodeVerifier() : null;
    const txId = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO auth_tx (id_hash, provider, state, nonce, code_verifier, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '${TX_MINUTES} minutes')`,
      [hashToken(txId), provider.name, state, nonce, verifier, returnTo],
    );
    const params: Record<string, string> = {
      ...provider.params,
      // Always from PUBLIC_URL: behind a proxy the request itself may say http://container:3001.
      redirect_uri: `${publicOrigin}/api/auth/${provider.name}/callback`,
      state,
      nonce,
    };
    if (verifier) {
      params.code_challenge = await client.calculatePKCECodeChallenge(verifier);
      params.code_challenge_method = 'S256';
    }
    const url = client.buildAuthorizationUrl(config, params);
    // Apple wants spaces in the scope as %20, not "+".
    url.search = url.searchParams.toString().replace(/\+/g, '%20');
    if (provider.name === 'apple') setCookie(res, appleTxCookie, txId, { maxAge: TX_MINUTES * 60, sameSite: 'none', secure: true });
    else setCookie(res, googleTxCookie, txId, { maxAge: TX_MINUTES * 60 });
    res.redirect(url.href);
  });

  /** Checks the provider's answer against the saved sign-in, then starts a session and goes back. */
  const finish = async (req: express.Request, res: express.Response, provider: OidcProvider, params: URLSearchParams, appleUser?: unknown) => {
    const txName = provider.name === 'apple' ? appleTxCookie : googleTxCookie;
    const txId = cookiesOf(req.headers.cookie)[txName];
    setCookie(res, txName, null, { maxAge: 0, ...(provider.name === 'apple' ? { sameSite: 'none', secure: true } : {}) });
    const found = txId
      ? await db.query<{ state: string; nonce: string; code_verifier: string | null; return_to: string; fresh: boolean }>(
          `DELETE FROM auth_tx WHERE id_hash = $1 AND provider = $2
           RETURNING state, nonce, code_verifier, return_to, expires_at > now() AS fresh`,
          [hashToken(txId), provider.name],
        )
      : null;
    const tx = found?.rows[0];
    if (!tx || !tx.fresh) {
      res.redirect(withError('/', 'expired'));
      return;
    }
    const error = params.get('error');
    if (error) {
      res.redirect(withError(tx.return_to, error === 'access_denied' || error === 'user_cancelled_authorize' ? 'cancelled' : 'failed'));
      return;
    }
    const current = new URL(`/api/auth/${provider.name}/callback`, publicOrigin!);
    for (const [key, value] of params) current.searchParams.set(key, value);
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(await provider.config(), current, {
        pkceCodeVerifier: tx.code_verifier ?? undefined,
        expectedState: tx.state,
        expectedNonce: tx.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (err) {
      console.warn(`[auth] ${provider.name} sign-in failed:`, (err as Error).message);
    }
    if (!claims) {
      res.redirect(withError(tx.return_to, 'failed'));
      return;
    }
    const user = await accounts.signIn(provider.identity(claims, { appleUser }));
    await signIn(req, res, user);
    res.redirect(tx.return_to);
  };

  router.get('/auth/google/callback', async (req, res) => {
    if (!providers.google) {
      res.status(404).json({ error: 'Google sign-in is not enabled.' });
      return;
    }
    await finish(req, res, providers.google, new URL(req.originalUrl, 'http://same.invalid').searchParams);
  });

  // Apple posts the result as a form (response_mode=form_post).
  router.post('/auth/apple/callback', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    if (!providers.apple) {
      res.status(404).json({ error: 'Apple sign-in is not enabled.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = new URLSearchParams();
    // Only what the code flow returns; `user` is read separately (it isn't part of the signed answer).
    for (const key of ['code', 'state', 'error', 'iss']) if (typeof body[key] === 'string') params.set(key, body[key] as string);
    await finish(req, res, providers.apple, params, body.user);
  });

  router.post('/auth/dev', async (req, res) => {
    if (!options.devLogin) {
      res.status(404).json({ error: 'Dev login is not enabled.' });
      return;
    }
    const name = sanitizeUserName(req.body?.name);
    const email = typeof req.body?.email === 'string' ? clip(req.body.email.replace(/[\u0000-\u001f\u007f]/g, '').trim().toLowerCase(), 254) : '';
    if (!name && !email) {
      res.status(400).json({ error: 'Enter a name or an email address.' });
      return;
    }
    const user = await accounts.signIn({
      provider: 'dev',
      subject: email || name.toLowerCase(),
      email: email || null,
      emailVerified: false,
      isPrivateEmail: false,
      name: name || sanitizeUserName(email.split('@')[0]) || 'Developer',
      avatarUrl: null,
    });
    await signIn(req, res, user);
    res.json({ user });
  });

  router.post('/auth/logout', async (req, res) => {
    const session = await sessionFromRequest(req);
    if (session) {
      await sessions.delete(session.tokenHash);
      deps.onLogout?.(session.tokenHash);
    }
    // Only a request that carries the cookie clears it: other sites can post here, without it.
    if (cookiesOf(req.headers.cookie)[sessionCookie] !== undefined) setSession(res, null);
    res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const session = await sessionFromRequest(req);
    // Renew the cookie along with the session's sliding expiry.
    if (session) setSession(res, cookiesOf(req.headers.cookie)[sessionCookie] ?? null);
    res.json({ user: session?.user ?? null });
  });

  router.patch('/me', requireUser, async (req, res) => {
    const user = res.locals.user as AccountUser;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let name: string | undefined;
    if ('name' in body) {
      name = sanitizeUserName(body.name);
      if (!name) {
        res.status(400).json({ error: 'The name cannot be empty.' });
        return;
      }
    }
    const profile = 'profile' in body ? sanitizeProfile(body.profile) : undefined;
    const updated = await accounts.update(user.id, { name, profile });
    if (updated) deps.onUserUpdated?.(updated);
    res.json({ user: updated });
  });

  /** Socket.IO middleware: who is connecting (socket.data.user), without ever refusing guests. */
  const socketMiddleware = async (socket: ClientSocket, next: (err?: Error) => void) => {
    socket.data.user = null;
    try {
      const session = await sessions.lookup(cookiesOf(socket.request.headers.cookie)[sessionCookie]);
      if (session) {
        socket.data.user = { id: session.user.id, name: session.user.name };
        socket.data.sessionHash = session.tokenHash;
      }
    } catch (err) {
      console.error('[auth] could not check a session:', (err as Error).message);
    }
    next();
  };

  // Expired sessions and abandoned sign-ins pile up otherwise; sockets still open on an expired
  // session are signed out with it.
  const cleanup = () =>
    sessions
      .cleanup()
      .then((expired) => expired.forEach((hash) => deps.onLogout?.(hash)))
      .catch((err) => console.error('[auth] cleanup failed:', (err as Error).message));
  let cleaning = cleanup();
  const cleanupTimer = setInterval(() => (cleaning = cleanup()), 3600 * 1000);
  cleanupTimer.unref();

  return {
    router,
    sessions,
    userFromRequest,
    requireUser,
    socketMiddleware,
    async close() {
      clearInterval(cleanupTimer);
      await cleaning;
    },
  };
}
