import crypto from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountUser } from '../shared/account';
import { DEFAULT_AVATAR } from '../shared/avatar';
import type { GithubInbox, GithubItem, GithubStatus } from '../shared/github';
import type { JoinResponse } from '../shared/types';
import type { Db } from '../server/db';
import { githubFeature, type GithubOptions } from '../server/features/github';
import { parseTokenKey } from '../server/features/github/crypto';
import { Links } from '../server/features/github/links';
import type { Schedule } from '../server/features/github/poller';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { startMockGithub, type MockGithub } from './helpers/github';
import { createOffice, Jar, json, until, type Client } from './helpers/http';

type Server = Awaited<ReturnType<typeof startServer>>;

let mock: MockGithub;
let db: Db;
let server: Server;
let base: string;
const extra: Server[] = [];
const sockets: Client[] = [];
const tokenKey = crypto.randomBytes(32).toString('base64');
const links = () => new Links(db, parseTokenKey(tokenKey)!);
const CALLBACK = 'http://localhost:5173/api/integrations/github/callback';

/** The poller's timers: tests run them instead of waiting minutes. */
const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
const schedule: Schedule = (fn, ms) => {
  const timer = { fn, ms, cancelled: false };
  timers.push(timer);
  return () => {
    timer.cancelled = true;
  };
};
const runTimers = () => {
  for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
};

const start = (options: GithubOptions, publicUrl: string | null = 'http://localhost:5173') =>
  startServer({
    port: 0,
    host: '127.0.0.1',
    db,
    quiet: true,
    iceServers: [],
    publicUrl,
    features: [githubFeature(options)],
    auth: { google: null, apple: null, devLogin: true },
  });

const configured = (): GithubOptions => ({
  clientId: mock.clientId,
  clientSecret: mock.clientSecret,
  tokenKey,
  oauthBase: mock.base,
  apiBase: mock.apiBase,
  schedule,
});

beforeAll(async () => {
  mock = await startMockGithub();
  db = await createTestDb();
  server = await start(configured());
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  for (const s of [server, ...extra]) await s?.close();
  await mock?.close();
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  mock.authorizeError = null;
  mock.tokenError = null;
  mock.revokeFails = false;
  vi.restoreAllMocks();
});

let n = 0;

/** A signed-in person (dev login) and a GitHub account of their own at the mock. */
async function person(name = 'Dev') {
  const i = ++n;
  const jar = new Jar();
  const res = await jar.fetch(`${base}/api/auth/dev`, json({ name: `${name} ${i}`, email: `dev${i}@example.com` }));
  const { user } = (await res.json()) as { user: AccountUser };
  const ghId = 9000 + i;
  mock.addUser(ghId, `gh-dev${i}`);
  return { jar, user, ghId, login: `gh-dev${i}` };
}

const api = (jar: Jar, path: string, init?: RequestInit) => jar.fetch(`${base}/api/integrations/github${path}`, init);
const location = (res: Response) => res.headers.get('location') ?? '';
const status = async (jar: Jar) => (await (await api(jar, '/status')).json()) as GithubStatus;

/** Opens the connect address as the app's page does (or with other `headers`). */
const openConnect = (jar: Jar, query: string, headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }) => api(jar, `/connect?${query}`, { headers });

/** Starts connecting; returns GitHub's authorize address. */
async function startConnect(jar: Jar, query = 'scope=basic&return=/github-callback.html') {
  const res = await openConnect(jar, query);
  expect(res.status).toBe(302);
  return new URL(location(res));
}

/** GitHub's answer: the callback path (on PUBLIC_URL) it sends the browser to. */
async function authorize(url: URL, as?: number) {
  mock.authorizeAs = as ?? null;
  const res = await fetch(url, { redirect: 'manual' });
  const back = new URL(location(res));
  expect(back.origin + back.pathname).toBe(CALLBACK);
  return back.pathname + back.search;
}

/** The whole connection, as a browser would go through it; returns where it ends up. */
async function connectGithub(jar: Jar, ghId: number, query?: string) {
  const callback = await authorize(await startConnect(jar, query), ghId);
  const res = await jar.fetch(`${base}${callback}`);
  expect(res.status).toBe(302);
  return location(res);
}

/** A socket (with the jar's session) that has joined an office, recording every event from the start. */
async function joinOffice(jar: Jar | null, officeId: string, name = 'Dev') {
  const cookie = jar?.header();
  const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: cookie ? { cookie } : {} });
  sockets.push(socket);
  const events: [string, ...unknown[]][] = [];
  socket.onAny((event: string, ...args: unknown[]) => events.push([event, ...args]));
  const res = await new Promise<JoinResponse>((resolve, reject) => {
    socket.on('connect_error', reject);
    socket.on('connect', () => socket.emit('join', { officeId, name, avatar: DEFAULT_AVATAR }, resolve));
  });
  if (!res.ok) throw new Error(res.error);
  const github = () => events.filter(([e]) => e.startsWith('github:'));
  return { socket, events, github };
}

const tokenOf = async (userId: string) => (await links().get(userId))?.accessToken ?? null;

describe('GitHub switched off', () => {
  it('registers nothing without a client id and secret', async () => {
    const off = await start({ clientId: null, clientSecret: null, tokenKey });
    extra.push(off);
    const at = `http://127.0.0.1:${off.port}/api/integrations/github`;
    const jar = new Jar();
    await jar.fetch(`http://127.0.0.1:${off.port}/api/auth/dev`, json({ name: 'Off' }));
    for (const path of ['/status', '/connect?scope=basic', '/callback?code=x&state=y']) expect((await jar.fetch(`${at}${path}`)).status).toBe(404);
    expect((await jar.fetch(`${at}/disconnect`, { method: 'POST' })).status).toBe(404);
  });

  it('stays off, saying why, without a valid TOKEN_ENCRYPTION_KEY or PUBLIC_URL', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const servers = [
      await start({ ...configured(), tokenKey: null }),
      await start({ ...configured(), tokenKey: 'not-a-key-but-a-secret-value' }),
      await start({ ...configured(), tokenKey: crypto.randomBytes(16).toString('base64') }),
      await start({ ...configured(), apiBase: 'ftp://example.com' }),
      await start(configured(), null),
    ];
    extra.push(...servers);
    for (const s of servers) {
      const jar = new Jar();
      await jar.fetch(`http://127.0.0.1:${s.port}/api/auth/dev`, json({ name: 'Off' }));
      expect((await jar.fetch(`http://127.0.0.1:${s.port}/api/integrations/github/status`)).status).toBe(404);
    }
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged.filter((m) => m.includes('TOKEN_ENCRYPTION_KEY'))).toHaveLength(3);
    expect(logged.some((m) => m.includes('GITHUB_API_BASE'))).toBe(true);
    expect(logged.join(' ')).not.toContain('not-a-key-but-a-secret-value');
    expect(warnings.mock.calls.some((c) => String(c[0]).includes('PUBLIC_URL'))).toBe(true);
  });
});

describe('connecting GitHub', () => {
  it('answers the status only to signed-in people', async () => {
    const guest = await fetch(`${base}/api/integrations/github/status`);
    expect(guest.status).toBe(401);
    expect(await guest.json()).toEqual({ error: expect.any(String) });
    const { jar } = await person();
    expect(await status(jar)).toEqual({ connected: false, private: false, needsReconnect: false, clientId: mock.clientId });
  });

  it('sends guests back to sign in, only ever to same-site paths', async () => {
    const guest = new Jar();
    expect(location(await openConnect(guest, 'scope=basic&return=/github-callback.html'))).toBe('/github-callback.html?github=signin');
    expect(location(await openConnect(guest, 'return=%2Foffice%2Fabc%3Fx%3D1'))).toBe('/office/abc?x=1&github=signin');
    for (const evil of ['//evil.example', 'https://evil.example/', '/\\evil.example', '/..//evil.example']) {
      expect(location(await openConnect(guest, `return=${encodeURIComponent(evil)}`))).toBe('/?github=signin');
    }
    // Never back into the API, where a finished connection could start another.
    for (const path of ['/api/integrations/github/connect?scope=private', '/api', '/API/x', '/%61pi/x', '/x/../api/x']) {
      expect(location(await openConnect(guest, `return=${encodeURIComponent(path)}`))).toBe('/?github=signin');
    }
  });

  it('goes to GitHub with PKCE and a single-use state bound to the person', async () => {
    const { jar, user } = await person();
    const url = await startConnect(jar);
    expect(url.origin + url.pathname).toBe(`${mock.base}/login/oauth/authorize`);
    const q = url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      client_id: mock.clientId,
      redirect_uri: CALLBACK,
      scope: 'notifications',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
      allow_signup: 'false',
    });
    const { rows } = await db.query<{ state_hash: string; code_verifier: string; return_to: string; minutes: number }>(
      `SELECT state_hash, code_verifier, return_to, extract(epoch FROM expires_at - now())::float8 / 60 AS minutes FROM github_oauth_tx WHERE user_id = $1`,
      [user.id],
    );
    expect(rows).toHaveLength(1);
    // Only a hash of the state is kept.
    expect(rows[0].state_hash).toBe(crypto.createHash('sha256').update(q.get('state')!).digest('hex'));
    expect(crypto.createHash('sha256').update(rows[0].code_verifier).digest('base64url')).toBe(q.get('code_challenge'));
    expect(rows[0].return_to).toBe('/github-callback.html');
    expect(rows[0].minutes).toBeGreaterThan(9.9);
    expect(rows[0].minutes).toBeLessThanOrEqual(10);

    expect((await startConnect(jar, 'scope=private')).search).toContain('scope=notifications%20repo');
    expect((await startConnect(jar, 'scope=everything')).searchParams.get('scope')).toBe('notifications');
  });

  it('connects through GitHub, storing only encrypted tokens', async () => {
    const { jar, user, ghId, login } = await person();
    const before = mock.requests.length;
    expect(await connectGithub(jar, ghId)).toBe('/github-callback.html?github=connected');
    expect(await status(jar)).toEqual({
      connected: true,
      login,
      avatarUrl: `https://avatars.githubusercontent.com/u/${ghId}?v=4`,
      private: false,
      needsReconnect: false,
      clientId: mock.clientId,
    });
    const exchange = mock.requests.slice(before).find((r) => r.path === '/login/oauth/access_token')!;
    expect(exchange.headers.accept).toBe('application/json');
    const body = new URLSearchParams(exchange.body);
    expect(Object.fromEntries(body)).toEqual({
      client_id: mock.clientId,
      client_secret: mock.clientSecret,
      code: expect.any(String),
      redirect_uri: CALLBACK,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const token = (await tokenOf(user.id))!;
    expect(mock.valid(token)).toBe(true);
    const { rows } = await db.query('SELECT * FROM github_links WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ login, scopes: 'notifications', needs_reconnect: false });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await db.query('SELECT * FROM github_oauth_tx WHERE user_id = $1', [user.id])).rowCount).toBe(0);
  });

  it('uses each state once, only for its own person, and only for ten minutes', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const guest = new Jar();

    // Used twice: the second time it's unknown.
    const callback = await authorize(await startConnect(a.jar, 'return=/here'), a.ghId);
    expect(location(await a.jar.fetch(`${base}${callback}`))).toBe('/here?github=connected');
    // Unknown, so where to go isn't known either: the page that closes the connect window.
    expect(location(await a.jar.fetch(`${base}${callback}`))).toBe('/github-callback.html?github=failed');

    // Someone else's browser (or a link someone was sent): refused, and the state is used up.
    const other = await authorize(await startConnect(b.jar, 'return=/b'), b.ghId);
    expect(location(await a.jar.fetch(`${base}${other}`))).toBe('/b?github=failed');
    expect(location(await b.jar.fetch(`${base}${other}`))).toBe('/github-callback.html?github=failed');
    expect((await status(b.jar)).connected).toBe(false);
    expect((await status(a.jar)).login).toBe(a.login);

    const signedOut = await authorize(await startConnect(b.jar, 'return=/b'), b.ghId);
    expect(location(await guest.fetch(`${base}${signedOut}`))).toBe('/b?github=signin');

    const late = await authorize(await startConnect(b.jar, 'return=/b'), b.ghId);
    await db.query(`UPDATE github_oauth_tx SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [b.user.id]);
    expect(location(await b.jar.fetch(`${base}${late}`))).toBe('/b?github=failed');
    expect((await db.query('SELECT 1 FROM github_oauth_tx WHERE user_id = $1', [b.user.id])).rowCount).toBe(0);

    for (const query of ['', '?code=abc', '?code=abc&state=nope', '?state[]=x&code=y']) {
      expect(location(await b.jar.fetch(`${base}/api/integrations/github/callback${query}`))).toBe('/github-callback.html?github=failed');
    }
    expect((await status(b.jar)).connected).toBe(false);
  });

  it('goes back saying whether the person cancelled or it failed, using up the state', async () => {
    const { jar, user, ghId } = await person();
    for (const [error, result] of [
      ['access_denied', 'cancelled'],
      ['redirect_uri_mismatch', 'failed'],
      ['application_suspended', 'failed'],
    ]) {
      mock.authorizeError = error;
      const callback = await authorize(await startConnect(jar, 'return=/office/x'), ghId);
      expect(new URL(callback, base).searchParams.get('error')).toBe(error);
      expect(location(await jar.fetch(`${base}${callback}`))).toBe(`/office/x?github=${result}`);
      expect((await db.query('SELECT 1 FROM github_oauth_tx WHERE user_id = $1', [user.id])).rowCount).toBe(0);
    }
    expect((await status(jar)).connected).toBe(false);
  });

  it("fails when GitHub's token endpoint answers with an error", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { jar, ghId } = await person();
    for (const error of ['bad_verification_code', 'incorrect_client_credentials', 'unverified_user_email']) {
      mock.tokenError = error;
      expect(await connectGithub(jar, ghId, 'return=/x')).toBe('/x?github=failed');
    }
    expect((await status(jar)).connected).toBe(false);
    expect(warn.mock.calls.map((c) => c.join(' '))).toEqual(expect.arrayContaining([expect.stringContaining('bad_verification_code')]));
  });

  it('revokes the old token when connecting again, e.g. to add the repo scope', async () => {
    const { jar, user, ghId } = await person();
    await connectGithub(jar, ghId);
    const first = (await tokenOf(user.id))!;
    expect(await connectGithub(jar, ghId, 'scope=private&return=/')).toBe('/?github=connected');
    const second = (await tokenOf(user.id))!;
    expect(second).not.toBe(first);
    expect(mock.scopeOf(second)).toBe('notifications,repo');
    expect(await status(jar)).toMatchObject({ connected: true, private: true });
    await until(() => mock.revoked.includes(first));
    const revoke = mock.calls(`/api/applications/${mock.clientId}/token`, 'DELETE').at(-1)!;
    expect(revoke.headers.authorization).toBe(`Basic ${Buffer.from(`${mock.clientId}:${mock.clientSecret}`).toString('base64')}`);
    expect(JSON.parse(revoke.body)).toEqual({ access_token: first });
    expect(mock.valid(second)).toBe(true);
  });

  it('links a GitHub account to one Workchop account at a time', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await connectGithub(a.jar, a.ghId);
    const token = (await tokenOf(a.user.id))!;
    await connectGithub(b.jar, a.ghId);
    expect(await status(b.jar)).toMatchObject({ connected: true, login: a.login });
    expect((await status(a.jar)).connected).toBe(false);
    await until(() => mock.revoked.includes(token));
  });

  it('connects Enterprise Managed Users, whose logins have an underscore', async () => {
    const { jar } = await person();
    const ghId = 9500 + n;
    mock.addUser(ghId, 'mona-cat_acme');
    expect(await connectGithub(jar, ghId)).toBe('/github-callback.html?github=connected');
    expect(await status(jar)).toMatchObject({ connected: true, login: 'mona-cat_acme' });
  });

  it('starts connecting only from its own pages', async () => {
    const { jar, user } = await person();
    const started = async () => (await db.query('SELECT 1 FROM github_oauth_tx WHERE user_id = $1', [user.id])).rowCount;
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
      expect(location(await openConnect(jar, 'scope=private&return=/here', headers))).toBe('/here?github=failed');
    }
    expect(await started()).toBe(0);
    for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' } as Record<string, string>, { 'Sec-Fetch-Site': 'none' }, { Referer: 'http://localhost:5173/office/abc' }, { Origin: 'http://localhost:5173' }]) {
      expect(location(await openConnect(jar, 'scope=basic&return=/here', headers))).toMatch(/^http.*\/login\/oauth\/authorize\?/);
    }
    expect(await started()).toBe(4);
  });

  it('limits how often a person can start connecting', async () => {
    const { jar } = await person();
    for (let i = 0; i < 5; i++) await startConnect(jar);
    const res = await openConnect(jar, 'scope=basic&return=/here');
    expect(res.status).toBe(302);
    expect(location(res)).toBe('/here?github=failed');
  });
});

describe('disconnecting GitHub', () => {
  it('revokes just this token and forgets it', async () => {
    const { jar, user, ghId } = await person();
    await connectGithub(jar, ghId);
    const token = (await tokenOf(user.id))!;
    const res = await api(jar, '/disconnect', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, private: false, needsReconnect: false, clientId: mock.clientId });
    // Revoking goes on after the answer.
    await until(() => mock.revoked.includes(token));
    // Not the whole grant.
    expect(mock.calls(`/api/applications/${mock.clientId}/grant`, 'DELETE')).toEqual([]);
    expect((await db.query('SELECT 1 FROM github_links WHERE user_id = $1', [user.id])).rowCount).toBe(0);
    expect((await status(jar)).connected).toBe(false);
  });

  it('refreshes an expired token to revoke it', async () => {
    const { jar, user, ghId } = await person();
    await connectGithub(jar, ghId);
    const token = (await tokenOf(user.id))!;
    // Not used for a day: the token has expired, and GitHub no longer knows it.
    mock.expire(token);
    await db.query(`UPDATE github_links SET access_expires_at = now() - interval '16 hours' WHERE user_id = $1`, [user.id]);
    const refreshes = mock.refreshes;
    const revoked = mock.revoked.length;
    expect(((await (await api(jar, '/disconnect', { method: 'POST' })).json()) as GithubStatus).connected).toBe(false);
    await until(() => mock.revoked.length === revoked + 1);
    expect(mock.refreshes).toBe(refreshes + 1);
    expect(mock.revoked.at(-1)).not.toBe(token);
    expect((await db.query('SELECT 1 FROM github_links WHERE user_id = $1', [user.id])).rowCount).toBe(0);

    // GitHub refusing the refresh doesn't stop it either.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await connectGithub(jar, ghId);
    mock.forget(ghId);
    await db.query(`UPDATE github_links SET access_expires_at = now() - interval '16 hours' WHERE user_id = $1`, [user.id]);
    expect(((await (await api(jar, '/disconnect', { method: 'POST' })).json()) as GithubStatus).connected).toBe(false);
    await until(() => warn.mock.calls.flat().join(' ').includes('bad_refresh_token'));
  });

  it('forgets the token even when GitHub fails to revoke it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { jar, user, ghId } = await person();
    await connectGithub(jar, ghId);
    const token = (await tokenOf(user.id))!;
    mock.revokeFails = true;
    expect(((await (await api(jar, '/disconnect', { method: 'POST' })).json()) as GithubStatus).connected).toBe(false);
    expect((await db.query('SELECT 1 FROM github_links WHERE user_id = $1', [user.id])).rowCount).toBe(0);
    await until(() => warn.mock.calls.flat().join(' ').includes('could not revoke'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain(token);
  });

  it('refuses guests and other sites', async () => {
    expect((await fetch(`${base}/api/integrations/github/disconnect`, { method: 'POST' })).status).toBe(401);
    const { jar, ghId } = await person();
    await connectGithub(jar, ghId);
    expect((await api(jar, '/disconnect', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await api(jar, '/disconnect', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await status(jar)).connected).toBe(true);
  });
});

describe('GitHub in the office', () => {
  it('sends the inbox when you join, and marks read, done and all read', async () => {
    const { jar, user, ghId } = await person();
    const mention = mock.addThread(ghId, { reason: 'mention', title: 'Ping', repo: 'octo/app', number: 1 });
    const review = mock.addThread(ghId, { reason: 'review_requested', title: 'Review me', repo: 'octo/app', number: 2 });
    const run = mock.addThread(ghId, { reason: 'ci_activity', type: 'CheckSuite', title: 'CI workflow run failed for main branch', repo: 'octo/app', noUrl: true });
    await connectGithub(jar, ghId);
    const { id: officeId } = await createOffice(base);
    const tab = await joinOffice(jar, officeId);
    await until(() => tab.github().length > 0);
    const [[event, inbox]] = tab.github() as [[string, GithubInbox]];
    expect(event).toBe('github:inbox');
    expect(inbox.items.map((i) => [i.id, i.bucket])).toEqual([
      [run.id, 'actions'],
      [review.id, 'reviews'],
      [mention.id, 'mentions'],
    ]);

    // Another tab gets it at once; the first isn't sent it again.
    const second = await joinOffice(jar, (await createOffice(base)).id);
    await until(() => second.github().length > 0);
    expect(second.github()).toEqual([['github:inbox', inbox]]);

    expect(await tab.socket.timeout(2000).emitWithAck('github:read', mention.id)).toBe(true);
    await until(() => tab.github().length === 2 && second.github().length === 2);
    expect(tab.github()[1]).toEqual(['github:item', { ...inbox.items[2], unread: false }]);
    expect(mock.threadsOf(ghId).find((t) => t.id === mention.id)!.unread).toBe(false);

    expect(await tab.socket.timeout(2000).emitWithAck('github:done', review.id)).toBe(true);
    await until(() => tab.github().length === 3);
    expect(tab.github()[2]).toEqual(['github:remove', review.id]);

    expect(await second.socket.timeout(2000).emitWithAck('github:readAll')).toBe(true);
    await until(() => tab.github().length === 4);
    const [, after] = tab.github()[3] as [string, GithubInbox];
    expect(after.items.map((i) => [i.id, i.unread])).toEqual([
      [run.id, false],
      [mention.id, false],
    ]);

    for (const bad of ['abc', '1'.repeat(21), '', 42, null, '1/../2']) {
      expect(await tab.socket.timeout(2000).emitWithAck('github:read', bad as string)).toBe(false);
    }
    // Tokens never reach the browser.
    const token = (await tokenOf(user.id))!;
    expect(JSON.stringify([tab.events, second.events])).not.toContain(token);
  });

  it('answers false to guests and to people without GitHub', async () => {
    const { id: officeId } = await createOffice(base);
    const guest = await joinOffice(null, officeId, 'Guest');
    expect(await guest.socket.timeout(2000).emitWithAck('github:read', '123')).toBe(false);
    expect(await guest.socket.timeout(2000).emitWithAck('github:readAll')).toBe(false);
    const { jar } = await person();
    const plain = await joinOffice(jar, officeId);
    expect(await plain.socket.timeout(2000).emitWithAck('github:done', '123')).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(plain.github()).toEqual([]);
  });

  it('polls only while you are in an office', async () => {
    const { jar, user, ghId } = await person();
    mock.addThread(ghId);
    await connectGithub(jar, ghId);
    const token = (await tokenOf(user.id))!;
    const polls = () => mock.calls('/api/notifications').filter((r) => r.headers.authorization === `Bearer ${token}`).length;
    const tab = await joinOffice(jar, (await createOffice(base)).id);
    await until(() => tab.github().length > 0);
    expect(polls()).toBe(1);
    runTimers();
    await until(() => polls() === 2);
    tab.socket.disconnect();
    await until(() => server.realtime.playersOfUser(user.id).length === 0);
    runTimers();
    await new Promise((r) => setTimeout(r, 100));
    expect(polls()).toBe(2);
  });

  it('tells you when you connect, and when you must reconnect', async () => {
    const { jar, user, ghId } = await person();
    mock.addThread(ghId, { title: 'Hello' });
    const tab = await joinOffice(jar, (await createOffice(base)).id);
    await connectGithub(jar, ghId);
    await until(() => tab.github().length === 2);
    expect(tab.github()[0]).toEqual(['github:status', expect.objectContaining({ connected: true, needsReconnect: false })]);
    expect((tab.github()[1][1] as GithubInbox).items.map((i: GithubItem) => i.title)).toEqual(['Hello']);

    // The person revoked Workchop on GitHub.
    mock.forget(ghId);
    runTimers();
    await until(() => tab.github().length === 3);
    expect(tab.github()[2]).toEqual(['github:status', expect.objectContaining({ connected: true, needsReconnect: true })]);
    expect(await status(jar)).toMatchObject({ connected: true, needsReconnect: true });
    expect(await tab.socket.timeout(2000).emitWithAck('github:readAll')).toBe(false);

    await connectGithub(jar, ghId);
    await until(() => tab.github().length === 5);
    expect(tab.github()[3]).toEqual(['github:status', expect.objectContaining({ needsReconnect: false })]);
    expect(tab.github()[4][0]).toBe('github:inbox');
    expect((await links().get(user.id))!.needsReconnect).toBe(false);

    await api(jar, '/disconnect', { method: 'POST' });
    await until(() => tab.github().length === 6);
    expect(tab.github()[5]).toEqual(['github:status', expect.objectContaining({ connected: false })]);
    // Disconnected: no more polling.
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });
});
