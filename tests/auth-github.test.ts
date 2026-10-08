import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountUser } from '../shared/account';
import { authOptionsFromEnv } from '../server/auth';
import type { GithubConfig } from '../server/auth/github';
import type { Db } from '../server/db';
import type { Feature } from '../server/features';
import { githubFeature } from '../server/features/github';
import { parseTokenKey } from '../server/features/github/crypto';
import { Links } from '../server/features/github/links';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { startMockGithub, type MockGithub, type MockUser } from './helpers/github';
import { Jar, json, until } from './helpers/http';

type Server = Awaited<ReturnType<typeof startServer>>;

const CALLBACK = 'http://localhost:5173/api/auth/github/callback';
let mock: MockGithub;
let db: Db;
let dataDir: string;
let server: Server;
let base: string;
const extra: Server[] = [];

const start = (github: GithubConfig | null, publicUrl: string | null = 'http://localhost:5173', quiet = true, features: Feature[] = []) =>
  startServer({ port: 0, host: '127.0.0.1', db, dataDir, quiet, iceServers: [], publicUrl, features, auth: { google: null, apple: null, github, devLogin: true } });
/** The mock's OAuth App. */
const config = (): GithubConfig => ({ clientId: mock.clientId, clientSecret: mock.clientSecret, oauthBase: mock.base, apiBase: mock.apiBase });
const tokenKey = randomBytes(32).toString('base64');
const links = () => new Links(db, parseTokenKey(tokenKey)!);

beforeAll(async () => {
  mock = await startMockGithub();
  db = await createTestDb();
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-auth-github-'));
  // GitHub notifications are on too, through the same OAuth App, as they are with a TOKEN_ENCRYPTION_KEY.
  const notifications = githubFeature({ clientId: mock.clientId, clientSecret: mock.clientSecret, tokenKey, oauthBase: mock.base, apiBase: mock.apiBase, schedule: () => () => {} });
  server = await start(config(), undefined, true, [notifications]);
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  for (const s of [server, ...extra]) await s?.close();
  await mock?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.authorizeError = null;
  mock.tokenError = null;
  mock.emailsStatus = null;
  mock.revokeFails = false;
  mock.redirects.clear();
  vi.restoreAllMocks();
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** A link on Workchop's own page (browsers say so in Sec-Fetch-Site). */
const fromApp: RequestInit = { headers: { 'Sec-Fetch-Site': 'same-origin' } };
const location = (res: Response) => res.headers.get('location') ?? '';
/** The token Workchop last used on GitHub's API. */
const lastToken = () => mock.calls('/api/user').at(-1)!.headers.authorization!.replace(/^Bearer /, '');

let n = 0;
/** A GitHub account at the mock; returns its numeric id. */
function githubUser(more: Partial<Pick<MockUser, 'name' | 'email' | 'emails'>> = {}): number {
  const id = 7000 + ++n;
  mock.addUser(id, `gh-user${n}`, more);
  return id;
}

async function me(jar: Jar): Promise<AccountUser | null> {
  return ((await (await jar.fetch(`${base}/api/me`)).json()) as { user: AccountUser | null }).user;
}

/** Starts signing in; returns GitHub's authorize address. */
async function startSignIn(jar: Jar, returnTo = '/') {
  const res = await jar.fetch(`${base}/api/auth/github/start?return=${encodeURIComponent(returnTo)}`, fromApp);
  expect(res.status).toBe(302);
  return new URL(location(res));
}

/** GitHub's answer as `as`: the callback path (on PUBLIC_URL) it sends the browser back to. */
async function authorize(url: URL, as: number) {
  mock.authorizeAs = as;
  const back = new URL(location(await fetch(url, { redirect: 'manual' })));
  expect(back.origin + back.pathname).toBe(CALLBACK);
  return back.pathname + back.search;
}

/** The whole sign-in as GitHub user `as`; returns the callback's answer. */
async function signIn(jar: Jar, as: number, returnTo = '/') {
  const callback = await authorize(await startSignIn(jar, returnTo), as);
  return jar.fetch(`${base}${callback}`);
}

/** Another host, answering every request with `answer(path)`; `requests` lists what reached it. */
async function startElsewhere(answer: (path: string) => unknown) {
  const requests: string[] = [];
  const http = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer(req.url ?? '/')));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    requests,
    close: () => {
      http.closeAllConnections();
      return new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const identityOf = async (userId: string) =>
  (await db.query('SELECT provider, subject, email, email_verified, is_private_email FROM auth_identities WHERE user_id = $1', [userId])).rows;

describe('GitHub sign-in', () => {
  it('is listed when the OAuth App is set up', async () => {
    expect(await (await fetch(`${base}/api/auth/providers`)).json()).toEqual({ google: false, apple: false, github: true, dev: true });
  });

  it('signs in, then revokes the token it used', async () => {
    const id = githubUser({
      name: 'Mona Lisa',
      emails: [
        { email: 'other@example.com', primary: false, verified: true },
        { email: 'Mona@Example.com', primary: true, verified: true },
      ],
    });
    const jar = new Jar();
    const started = await jar.fetch(`${base}/api/auth/github/start?return=${encodeURIComponent('/o/abc?x=1')}`, fromApp);
    expect(started.status).toBe(302);
    const url = new URL(location(started));
    expect(url.origin + url.pathname).toBe(`${mock.base}/login/oauth/authorize`);
    const query = Object.fromEntries(url.searchParams);
    expect(query).toMatchObject({ client_id: mock.clientId, redirect_uri: CALLBACK, scope: 'user:email', code_challenge_method: 'S256', allow_signup: 'true', prompt: 'select_account' });
    expect(query.state).toMatch(/^[\w-]{40,}$/);
    expect(query.code_challenge).toMatch(/^[\w-]{43}$/);
    const txCookie = started.headers.getSetCookie().find((c) => c.startsWith('wc_auth='))!;
    expect(txCookie).toMatch(/HttpOnly/i);
    expect(txCookie).toMatch(/SameSite=Lax/i);
    const tx = await db.query('SELECT provider, state, return_to FROM auth_tx WHERE id_hash = $1', [sha256(jar.cookies.get('wc_auth')!)]);
    expect(tx.rows).toEqual([{ provider: 'github', state: query.state, return_to: '/o/abc?x=1' }]);

    const done = await jar.fetch(`${base}${await authorize(url, id)}`);
    expect(done.status).toBe(302);
    expect(location(done)).toBe('/o/abc?x=1');
    expect(jar.cookies.has('wc_session')).toBe(true);
    expect(jar.cookies.has('wc_auth')).toBe(false);
    const user = (await me(jar))!;
    expect(user).toMatchObject({ name: 'Mona Lisa', email: 'mona@example.com', avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4` });
    expect(await identityOf(user.id)).toEqual([{ provider: 'github', subject: String(id), email: 'mona@example.com', email_verified: true, is_private_email: false }]);

    // The code exchange carries the PKCE verifier and the same redirect_uri.
    const exchange = mock.calls('/login/oauth/access_token', 'POST').at(-1)!;
    expect(exchange.headers.accept).toBe('application/json');
    const sent = new URLSearchParams(exchange.body);
    expect(sent.get('redirect_uri')).toBe(CALLBACK);
    expect(sent.get('code_verifier')).toMatch(/^[\w-]{43,}$/);
    expect(mock.calls('/api/user').at(-1)!.headers).toMatchObject({ 'user-agent': 'Workchop', 'x-github-api-version': '2022-11-28', accept: 'application/vnd.github+json' });

    // Workchop keeps no token from signing in.
    const token = lastToken();
    await until(() => mock.revoked.includes(token));
    expect(mock.valid(token)).toBe(false);

    // Signing in again finds the same account, with a new session.
    const again = new Jar();
    expect(location(await signIn(again, id))).toBe('/');
    expect((await me(again))?.id).toBe(user.id);
    expect(again.cookies.get('wc_session')).not.toBe(jar.cookies.get('wc_session'));
  });

  it('uses the public email, or else only a verified primary one', async () => {
    const publicEmail = githubUser({ name: 'Pat', email: 'Pat@Example.com', emails: [{ email: 'pat@work.example', primary: true, verified: true }] });
    const emailsBefore = mock.calls('/api/user/emails').length;
    const a = new Jar();
    await signIn(a, publicEmail);
    const pat = (await me(a))!;
    expect(pat.email).toBe('pat@example.com');
    expect((await identityOf(pat.id))[0]).toMatchObject({ email: 'pat@example.com', email_verified: false });
    expect(mock.calls('/api/user/emails')).toHaveLength(emailsBefore);

    // An unverified primary address isn't used, even with a verified secondary one; nor is a name with control characters.
    const unverified = githubUser({
      name: '  Ada\u0007  Lovelace ',
      emails: [
        { email: 'ada@example.com', primary: true, verified: false },
        { email: 'ada@other.example', primary: false, verified: true },
      ],
    });
    const b = new Jar();
    await signIn(b, unverified);
    const ada = (await me(b))!;
    expect(ada).toMatchObject({ name: 'Ada Lovelace', email: null });
    expect((await identityOf(ada.id))[0]).toMatchObject({ email: null, email_verified: false });

    // No name: the login.
    const noName = githubUser();
    const c = new Jar();
    await signIn(c, noName);
    expect((await me(c))?.name).toBe(mock.users.get(noName)!.login);
  });

  it("signs in without an email address when GitHub won't list them", async () => {
    const id = githubUser({ name: 'Rio', emails: [{ email: 'rio@example.com', primary: true, verified: true }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const status of [403, 500]) {
      mock.emailsStatus = status;
      const jar = new Jar();
      expect(location(await signIn(jar, id, '/x'))).toBe('/x');
      const user = (await me(jar))!;
      expect(user).toMatchObject({ name: 'Rio', email: null });
      expect((await identityOf(user.id))[0]).toMatchObject({ subject: String(id), email: null, email_verified: false });
      expect(warn).toHaveBeenCalledWith('[auth] could not read GitHub email addresses:', `GitHub's /user/emails answered ${status}`);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(lastToken());
    }
  });

  it("only starts from Workchop's own pages", async () => {
    const pending = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM auth_tx WHERE provider = 'github'")).rows[0].n;
    const before = await pending();
    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site' } as Record<string, string>,
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://localhost:5173' },
      // Browsers without Sec-Fetch-Site.
      { Origin: 'https://evil.example' },
      { Referer: 'https://evil.example/page' },
      { Referer: 'http://localhost:5173.evil.example/' },
      {},
    ]) {
      const jar = new Jar();
      expect(location(await jar.fetch(`${base}/api/auth/github/start?return=/here`, { headers })), JSON.stringify(headers)).toBe('/here?auth_error=failed');
      expect(jar.cookies.has('wc_auth')).toBe(false);
    }
    expect(await pending()).toBe(before);
    for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' } as Record<string, string>, { 'Sec-Fetch-Site': 'none' }, { Referer: 'http://localhost:5173/o/abc' }, { Origin: 'http://localhost:5173' }]) {
      const url = new URL(location(await new Jar().fetch(`${base}/api/auth/github/start?return=/here`, { headers })));
      expect(url.origin + url.pathname, JSON.stringify(headers)).toBe(`${mock.base}/login/oauth/authorize`);
    }
  });

  it('goes back with an error when the person cancels or GitHub refuses, using up the sign-in', async () => {
    const id = githubUser();
    const jar = new Jar();
    mock.authorizeError = 'access_denied';
    const url = await startSignIn(jar, '/somewhere');
    const txId = jar.cookies.get('wc_auth')!;
    expect(location(await jar.fetch(`${base}${await authorize(url, id)}`))).toBe('/somewhere?auth_error=cancelled');
    expect(jar.cookies.has('wc_auth')).toBe(false);
    expect((await db.query('SELECT 1 FROM auth_tx WHERE id_hash = $1', [sha256(txId)])).rowCount).toBe(0);

    mock.authorizeError = 'application_suspended';
    expect(location(await signIn(jar, id, '/somewhere'))).toBe('/somewhere?auth_error=failed');
    expect(jar.cookies.has('wc_session')).toBe(false);
  });

  it('takes an answer once, in the browser that started it, before it expires', async () => {
    const id = githubUser();

    // Replayed.
    const jar = new Jar();
    const callback = await authorize(await startSignIn(jar), id);
    expect(location(await jar.fetch(`${base}${callback}`))).toBe('/');
    const session = jar.cookies.get('wc_session');
    expect(location(await jar.fetch(`${base}${callback}`))).toBe('/?auth_error=expired');
    expect(jar.cookies.get('wc_session')).toBe(session);

    // Another browser (no sign-in cookie) gets nowhere, and leaves the real one working.
    const real = new Jar();
    const realCallback = await authorize(await startSignIn(real, '/mine'), id);
    const other = new Jar();
    expect(location(await other.fetch(`${base}${realCallback}`))).toBe('/?auth_error=expired');
    expect(other.cookies.has('wc_session')).toBe(false);
    expect(location(await real.fetch(`${base}${realCallback}`))).toBe('/mine');

    // Expired.
    const late = new Jar();
    const lateCallback = await authorize(await startSignIn(late), id);
    const lateId = sha256(late.cookies.get('wc_auth')!);
    await db.query("UPDATE auth_tx SET expires_at = now() - interval '1 second' WHERE id_hash = $1", [lateId]);
    expect(location(await late.fetch(`${base}${lateCallback}`))).toBe('/?auth_error=expired');
    expect((await db.query('SELECT 1 FROM auth_tx WHERE id_hash = $1', [lateId])).rowCount).toBe(0);
    expect(late.cookies.has('wc_session')).toBe(false);

    // A state that isn't the saved one fails, and uses the sign-in up.
    const forged = new Jar();
    const forgedCallback = await authorize(await startSignIn(forged, '/x'), id);
    expect(location(await forged.fetch(`${base}${forgedCallback.replace(/state=[^&]+/, 'state=forged')}`))).toBe('/x?auth_error=failed');
    expect(location(await forged.fetch(`${base}${forgedCallback}`))).toBe('/?auth_error=expired');
    expect(forged.cookies.has('wc_session')).toBe(false);

    // No code.
    const noCode = new Jar();
    const state = (await startSignIn(noCode)).searchParams.get('state')!;
    expect(location(await noCode.fetch(`${base}/api/auth/github/callback?state=${state}`))).toBe('/?auth_error=failed');

    // Another provider's sign-in in progress isn't GitHub's.
    const google = new Jar();
    google.cookies.set('wc_auth', 'google-tx-0123456789abcdefghijklmnopqrstuvwxyzABCDEFG');
    await db.query(
      `INSERT INTO auth_tx (id_hash, provider, state, nonce, code_verifier, return_to, expires_at)
       VALUES ($1, 'google', 'google-state', 'n', 'v', '/', now() + interval '5 minutes')`,
      [sha256(google.cookies.get('wc_auth')!)],
    );
    expect(location(await google.fetch(`${base}/api/auth/github/callback?code=abc&state=google-state`))).toBe('/?auth_error=expired');
  });

  it("fails when GitHub's token endpoint answers with an error, without logging secrets", async () => {
    const id = githubUser();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const jar = new Jar();
    const callback = await authorize(await startSignIn(jar, '/x'), id);
    mock.tokenError = 'bad_verification_code';
    expect(location(await jar.fetch(`${base}${callback}`))).toBe('/x?auth_error=failed');
    expect(jar.cookies.has('wc_session')).toBe(false);
    expect(warn).toHaveBeenCalledWith('[auth] github sign-in failed:', expect.stringContaining('bad_verification_code'));
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(mock.clientSecret);
    expect(logged).not.toContain(new URL(callback, base).searchParams.get('code'));
  });

  it("never follows GitHub's redirects, which would take the secret or a token to another host", async () => {
    const id = githubUser();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Another host, with a token and a profile that would work, for anything that follows a redirect.
    const elsewhere = await startElsewhere((path) => (path === '/token' ? { access_token: mock.issue(id, 'user:email').access_token } : { id, login: 'elsewhere' }));
    try {
      // The API's /user: signing in fails, and the token is still revoked.
      mock.redirects.set('/api/user', { status: 302, location: `${elsewhere.url}/user` });
      const jar = new Jar();
      expect(location(await signIn(jar, id, '/x'))).toBe('/x?auth_error=failed');
      expect(jar.cookies.has('wc_session')).toBe(false);
      const token = lastToken();
      await until(() => mock.revoked.includes(token));
      mock.redirects.clear();

      // The token endpoint (a 307 would post the client secret and the code again).
      mock.redirects.set('/login/oauth/access_token', { status: 307, location: `${elsewhere.url}/token` });
      const second = new Jar();
      expect(location(await signIn(second, id, '/x'))).toBe('/x?auth_error=failed');
      expect(second.cookies.has('wc_session')).toBe(false);
      mock.redirects.clear();

      // Revoking (the token, with the app's credentials): signing in still works.
      mock.redirects.set(`/api/applications/${mock.clientId}/token`, { status: 307, location: `${elsewhere.url}/revoke` });
      const third = new Jar();
      expect(location(await signIn(third, id))).toBe('/');
      await until(() => warn.mock.calls.some((c) => String(c[0]).includes('could not revoke')));

      expect(elsewhere.requests).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it('signs in even when revoking the token fails', async () => {
    const id = githubUser();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.revokeFails = true;
    const jar = new Jar();
    expect(location(await signIn(jar, id))).toBe('/');
    expect(await me(jar)).not.toBeNull();
    await until(() => warn.mock.calls.some((c) => String(c[0]).includes('could not revoke')));
  });

  it('only goes back to same-site paths', async () => {
    const id = githubUser();
    for (const bad of ['https://evil.example/', '//evil.example', '/a/..//evil.example']) {
      expect(location(await signIn(new Jar(), id, bad)), bad).toBe('/');
    }
    mock.authorizeError = 'access_denied';
    expect(location(await signIn(new Jar(), id, '//evil.example'))).toBe('/?auth_error=cancelled');
  });

  it('never links accounts by email address', async () => {
    const id = githubUser({ emails: [{ email: 'same@example.com', primary: true, verified: true }] });
    const github = new Jar();
    await signIn(github, id);
    const dev = new Jar();
    await dev.fetch(`${base}/api/auth/dev`, json({ name: 'Same', email: 'same@example.com' }));
    expect((await me(github))!.email).toBe('same@example.com');
    expect((await me(github))!.id).not.toBe((await me(dev))!.id);
  });

  it('says which callback to register, unless quiet', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    extra.push(await start(config()));
    expect(logs.mock.calls.flat().join('\n')).not.toContain('[auth]');
    extra.push(await start(config(), 'http://localhost:5173', false));
    expect(logs.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining(['[auth] sign-in with github, dev login', `[auth] GitHub sign-in callback to register: ${CALLBACK}`]));
  });

  it('is on with GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, and needs PUBLIC_URL', async () => {
    expect(authOptionsFromEnv({}).github).toBeNull();
    expect(authOptionsFromEnv({ GITHUB_CLIENT_ID: 'id' }).github).toBeNull();
    expect(authOptionsFromEnv({ GITHUB_CLIENT_ID: ' id ', GITHUB_CLIENT_SECRET: 'secret' }).github).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      oauthBase: 'https://github.com',
      apiBase: 'https://api.github.com',
    });
    expect(
      authOptionsFromEnv({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', GITHUB_OAUTH_BASE: 'http://localhost:3999/', GITHUB_API_BASE: 'http://localhost:3999/api/' }).github,
    ).toMatchObject({ oauthBase: 'http://localhost:3999', apiBase: 'http://localhost:3999/api' });

    const off = await start(null);
    extra.push(off);
    const offBase = `http://127.0.0.1:${off.port}`;
    expect(await (await fetch(`${offBase}/api/auth/providers`)).json()).toMatchObject({ github: false });
    expect((await fetch(`${offBase}/api/auth/github/start`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${offBase}/api/auth/github/callback?code=x&state=y`, { redirect: 'manual' })).status).toBe(404);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noUrl = await start(config(), null);
    extra.push(noUrl);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PUBLIC_URL'));
    const noUrlBase = `http://127.0.0.1:${noUrl.port}`;
    expect(await (await fetch(`${noUrlBase}/api/auth/providers`)).json()).toMatchObject({ github: false });
    expect((await fetch(`${noUrlBase}/api/auth/github/start`, { redirect: 'manual' })).status).toBe(404);
  });
});

describe('GitHub sign-in next to GitHub notifications', () => {
  it('goes back from a sign-in that GitHub sent to the notifications callback, saying which callbacks to register', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const jar = new Jar();
    const state = (await startSignIn(jar, '/o/abc')).searchParams.get('state');
    const txId = jar.cookies.get('wc_auth')!;
    // What GitHub does when the OAuth App doesn't list the sign-in's callback: its registered one, with an error.
    const mismatch = `/api/integrations/github/callback?error=redirect_uri_mismatch&error_description=The+redirect_uri+MUST+match&state=${state}`;
    expect(location(await jar.fetch(`${base}${mismatch}`))).toBe('/o/abc?auth_error=failed');
    expect(jar.cookies.has('wc_auth')).toBe(false);
    expect(jar.cookies.has('wc_session')).toBe(false);
    expect((await db.query('SELECT 1 FROM auth_tx WHERE id_hash = $1', [sha256(txId)])).rowCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      '[github] GitHub refused a callback URL (redirect_uri_mismatch): the OAuth App needs both http://localhost:5173/api/integrations/github/callback and http://localhost:5173/api/auth/github/callback',
    );
    // Once.
    expect(location(await jar.fetch(`${base}${mismatch}`))).toBe('/github-callback.html?github=failed');

    // Anything else is still the notifications' own (the page that closes the connect window), and
    // leaves a sign-in in progress alone.
    const other = new Jar();
    const pending = await startSignIn(other, '/mine');
    for (const query of [`error=redirect_uri_mismatch&state=${state}`, 'error=redirect_uri_mismatch&state=other', 'code=abc&state=other']) {
      expect(location(await other.fetch(`${base}/api/integrations/github/callback?${query}`)), query).toBe('/github-callback.html?github=failed');
    }
    expect(location(await new Jar().fetch(`${base}${mismatch.replace(state!, pending.searchParams.get('state')!)}`))).toBe('/github-callback.html?github=failed');
    expect(location(await other.fetch(`${base}${await authorize(pending, githubUser())}`))).toBe('/mine');
    expect(await me(other)).not.toBeNull();
  });

  it('leaves the notifications connection alone, and disconnecting that keeps you signed in', async () => {
    const id = githubUser();
    const jar = new Jar();
    await signIn(jar, id);
    const user = (await me(jar))!;
    // Connecting notifications, as the same GitHub account.
    const connect = await jar.fetch(`${base}/api/integrations/github/connect?return=/o/abc`, fromApp);
    mock.authorizeAs = id;
    const back = new URL(location(await fetch(location(connect), { redirect: 'manual' })));
    expect(location(await jar.fetch(`${base}${back.pathname}${back.search}`))).toBe('/o/abc?github=connected');
    const linked = (await links().get(user.id))!.accessToken!;
    const status = async () => (await (await jar.fetch(`${base}/api/integrations/github/status`)).json()) as Record<string, unknown>;

    // Signing in again revokes only the sign-in's token.
    await signIn(jar, id);
    expect((await me(jar))?.id).toBe(user.id);
    const signInToken = lastToken();
    expect(signInToken).not.toBe(linked);
    await until(() => mock.revoked.includes(signInToken));
    expect(mock.valid(linked)).toBe(true);
    expect(await status()).toMatchObject({ available: true, connected: true, login: mock.users.get(id)!.login });

    // Disconnecting revokes the connection's token, and the session stays.
    expect((await jar.fetch(`${base}/api/integrations/github/disconnect`, { method: 'POST' })).status).toBe(200);
    await until(() => mock.revoked.includes(linked));
    expect((await me(jar))?.id).toBe(user.id);
    expect(await status()).toMatchObject({ available: true, connected: false });
  });
});
