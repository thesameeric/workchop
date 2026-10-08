import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { Events, OAuth2Server } from 'oauth2-mock-server';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUser, Space } from '../shared/account';
import { DEFAULT_AVATAR } from '../shared/avatar';
import { Accounts } from '../server/accounts';
import { authOptionsFromEnv, createAuth, safeReturnPath } from '../server/auth';
import { parsePrivateKey } from '../server/auth/oidc';
import type { Db } from '../server/db';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, json, until } from './helpers/http';

let oauth: OAuth2Server;
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let dataDir: string;
/** Claims the mock provider puts into its next tokens. */
let claims: Record<string, unknown> = {};
const tokenRequests: Record<string, string>[] = [];
const appleKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

beforeAll(async () => {
  oauth = new OAuth2Server();
  await oauth.issuer.keys.generate('RS256');
  await oauth.start(0, 'localhost');
  oauth.service.on(Events.BeforeTokenSigning, (token) => Object.assign(token.payload, claims));
  oauth.service.on(Events.BeforeResponse, (_res, req) => tokenRequests.push(req.body as Record<string, string>));
  const issuer = oauth.issuer.url!;
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-auth-'));
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    db: await createTestDb(),
    dataDir,
    quiet: true,
    iceServers: [],
    // What the browser would see (Vite); redirects are built from it, never from the request.
    publicUrl: 'http://localhost:5173',
    auth: {
      google: { clientId: 'google-client', clientSecret: 'google-secret', issuer },
      // As a one-line environment variable would have it.
      apple: { clientId: 'com.example.workchop', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: appleKey.trim().replace(/\n/g, '\\n'), issuer },
      devLogin: true,
    },
  });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  await server?.close();
  await oauth?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function me(jar: Jar): Promise<AccountUser | null> {
  return ((await (await jar.fetch(`${base}/api/me`)).json()) as { user: AccountUser | null }).user;
}

/** Runs the Google sign-in up to the provider's redirect back; returns the callback path. */
async function googleUntilCallback(jar: Jar, returnTo = '/') {
  const start = await jar.fetch(`${base}/api/auth/google/start?return=${encodeURIComponent(returnTo)}`);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  const back = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(back.headers.get('location')!);
  return { authorize, callback: callback.pathname + callback.search };
}

async function appleLogin(user?: string) {
  const jar = new Jar();
  const start = await jar.fetch(`${base}/api/auth/apple/start?return=/after`);
  const location = start.headers.get('location')!;
  const txCookie = start.headers.getSetCookie().find((c) => c.startsWith('__Host-wc_auth_apple='))!;
  const back = new URL((await fetch(location, { redirect: 'manual' })).headers.get('location')!);
  // Apple posts the answer from the browser as a form; the mock answers with a redirect, so post it ourselves.
  const form = new URLSearchParams({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! });
  if (user) form.set('user', user);
  const done = await jar.fetch(`${base}/api/auth/apple/callback`, { method: 'POST', body: form });
  return { jar, location, txCookie, done, user: await me(jar) };
}

describe('sign-in', () => {
  it('lists the providers that are set up', async () => {
    expect(await (await fetch(`${base}/api/auth/providers`)).json()).toEqual({ google: true, apple: true, dev: true });
  });

  it('signs in with Google, with a fresh hashed session each time', async () => {
    claims = { sub: 'google-1', email: 'Gina@Example.com', email_verified: true, name: 'Gina Google', picture: 'https://example.com/g.png' };
    const jar = new Jar();
    const { authorize, callback } = await googleUntilCallback(jar, '/o/abc?x=1');
    expect(authorize.origin).toBe(new URL(oauth.issuer.url!).origin);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'google-client',
      redirect_uri: 'http://localhost:5173/api/auth/google/callback',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      response_type: 'code',
    });
    expect(jar.cookies.has('wc_auth')).toBe(true);

    const done = await jar.fetch(`${base}${callback}`);
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/o/abc?x=1');
    const cookie = done.headers.getSetCookie().find((c) => c.startsWith('wc_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/i);
    expect(jar.cookies.has('wc_auth')).toBe(false);

    const user = await me(jar);
    expect(user).toMatchObject({ name: 'Gina Google', email: 'gina@example.com', avatarUrl: 'https://example.com/g.png', profile: {} });
    const token = jar.cookies.get('wc_session')!;
    const stored = (await server.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = $1', [user!.id])).rows;
    expect(stored.map((r) => r.token_hash)).toEqual([sha256(token)]);

    // Signing in again finds the same account, with a new session id.
    const again = new Jar();
    const second = await googleUntilCallback(again);
    await again.fetch(`${base}${second.callback}`);
    expect((await me(again))?.id).toBe(user!.id);
    expect(again.cookies.get('wc_session')).not.toBe(token);

    // The answer can't be used twice.
    const replay = await again.fetch(`${base}${second.callback}`);
    expect(replay.headers.get('location')).toBe('/?auth_error=expired');
  });

  it('goes back with an error when the person cancels or the answer is forged', async () => {
    const jar = new Jar();
    await jar.fetch(`${base}/api/auth/google/start?return=/somewhere`);
    const cancelled = await jar.fetch(`${base}/api/auth/google/callback?error=access_denied`);
    expect(cancelled.headers.get('location')).toBe('/somewhere?auth_error=cancelled');

    const { callback } = await googleUntilCallback(jar, '/somewhere');
    const forged = await jar.fetch(`${base}${callback.replace(/state=[^&]+/, 'state=forged')}`);
    expect(forged.headers.get('location')).toBe('/somewhere?auth_error=failed');
    expect(jar.cookies.has('wc_session')).toBe(false);
  });

  it('signs in with Apple (form_post) and keeps the name from the first sign-in', async () => {
    claims = { sub: 'apple-1', email: 'abc123@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true' };
    const first = await appleLogin(JSON.stringify({ name: { firstName: 'Ada', lastName: 'Love\u0007lace' }, email: 'abc123@privaterelay.appleid.com' }));
    expect(first.location).toContain('scope=name%20email');
    expect(first.location).toContain('response_mode=form_post');
    expect(new URL(first.location).searchParams.has('code_challenge')).toBe(false);
    expect(first.txCookie).toMatch(/SameSite=None/i);
    expect(first.txCookie).toMatch(/Secure/i);
    expect(first.done.headers.get('location')).toBe('/after');
    expect(first.user).toMatchObject({ name: 'Ada Lovelace', email: 'abc123@privaterelay.appleid.com' });

    // The client secret is a short-lived ES256 JWT for the Services ID.
    const secretRequest = tokenRequests.at(-1)!;
    expect(secretRequest.client_id).toBe('com.example.workchop');
    expect(decodeProtectedHeader(secretRequest.client_secret)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decodeJwt(secretRequest.client_secret)).toMatchObject({ iss: 'TEAM123456', sub: 'com.example.workchop', aud: 'https://appleid.apple.com' });

    const identity = await server.db.query("SELECT email_verified, is_private_email FROM auth_identities WHERE provider = 'apple'");
    expect(identity.rows).toEqual([{ email_verified: true, is_private_email: true }]);

    // Later sign-ins don't rename the account, whatever the browser sends.
    const second = await appleLogin(JSON.stringify({ name: { firstName: 'Mallory', lastName: 'X' } }));
    expect(second.user).toMatchObject({ id: first.user!.id, name: 'Ada Lovelace' });
  });

  it('never links accounts by email address', async () => {
    claims = { sub: 'google-2', email: 'same@example.com', email_verified: true, name: 'Same' };
    const jar = new Jar();
    const { callback } = await googleUntilCallback(jar);
    await jar.fetch(`${base}${callback}`);
    const dev = new Jar();
    await dev.fetch(`${base}/api/auth/dev`, json({ name: 'Same', email: 'same@example.com' }));
    expect((await me(jar))!.id).not.toBe((await me(dev))!.id);
  });

  it('dev login, profile changes and logout', async () => {
    const jar = new Jar();
    const res = await jar.fetch(`${base}/api/auth/dev`, json({ name: '  Dev   Person ', email: 'Dev@Example.com' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: AccountUser }).user).toMatchObject({ name: 'Dev Person', email: 'dev@example.com' });

    const patched = await jar.fetch(
      `${base}/api/me`,
      json({ name: 'New Name', profile: { avatar: { skin: 'not a colour', hair: 'bun' }, status: 'busy', settings: { theme: 'dark', 'bad key!': 1, long: 'x'.repeat(500) }, junk: 1 } }, 'PATCH'),
    );
    expect(((await patched.json()) as { user: AccountUser }).user).toMatchObject({
      name: 'New Name',
      profile: { avatar: { ...DEFAULT_AVATAR, hair: 'bun' }, status: 'busy', settings: { theme: 'dark', long: 'x'.repeat(200) } },
    });
    // Other parts of the profile are kept.
    await jar.fetch(`${base}/api/me`, json({ profile: { status: 'away' } }, 'PATCH'));
    expect((await me(jar))?.profile).toMatchObject({ status: 'away', settings: { theme: 'dark' } });
    expect((await jar.fetch(`${base}/api/me`, json({ name: ' ' }, 'PATCH'))).status).toBe(400);
    expect((await fetch(`${base}/api/me`, json({ name: 'x' }, 'PATCH'))).status).toBe(401);

    // Signing in again replaces the browser's session.
    const before = jar.cookies.get('wc_session')!;
    await jar.fetch(`${base}/api/auth/dev`, json({ name: 'Dev Person', email: 'dev@example.com' }));
    expect(jar.cookies.get('wc_session')).not.toBe(before);
    expect((await server.db.query('SELECT 1 FROM sessions WHERE token_hash = $1', [sha256(before)])).rowCount).toBe(0);

    expect(await (await jar.fetch(`${base}/api/auth/logout`, { method: 'POST' })).json()).toEqual({ ok: true });
    expect(jar.cookies.has('wc_session')).toBe(false);
    expect(await me(jar)).toBeNull();
  });

  it('uses __Host- Secure cookies when PUBLIC_URL is https', async () => {
    const secure = await startServer({ port: 0, host: '127.0.0.1', db: server.db, dataDir, quiet: true, iceServers: [], publicUrl: 'https://office.example.com', auth: { google: null, apple: null, devLogin: true } });
    try {
      const res = await fetch(`http://127.0.0.1:${secure.port}/api/auth/dev`, json({ name: 'Sec' }));
      const cookie = res.headers.getSetCookie()[0];
      expect(cookie).toMatch(/^__Host-wc_session=/);
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/Path=\//);
    } finally {
      await secure.close();
    }
  });

  it('only allows dev login in production when asked to, and only same-site return paths', () => {
    expect(authOptionsFromEnv({ DEV_LOGIN: 'true' }).devLogin).toBe(true);
    const quiet = console.warn;
    console.warn = () => {};
    expect(authOptionsFromEnv({ DEV_LOGIN: 'true', NODE_ENV: 'production' }).devLogin).toBe(false);
    // The built server counts as production even without NODE_ENV (npm start).
    expect(authOptionsFromEnv({ DEV_LOGIN: 'true' }, true).devLogin).toBe(false);
    console.warn = quiet;
    expect(authOptionsFromEnv({ DEV_LOGIN: 'true', NODE_ENV: 'production', DEV_LOGIN_IN_PRODUCTION: 'true' }).devLogin).toBe(true);
    const bad = ['https://evil.example/', '//evil.example', '/\\evil.example', 'relative', ''];
    // Dot segments that only become "//evil.example" once resolved.
    bad.push('/.//evil.example', '/..//evil.example', '/a/..//evil.example', '/./\\evil.example', '/%2e//evil.example', '/x/../\\evil.example');
    for (const path of bad) expect(safeReturnPath(path), path).toBe('/');
    expect(safeReturnPath('/o/abc?x=1#y')).toBe('/o/abc?x=1#y');
    expect(safeReturnPath('/a/../o/abc')).toBe('/o/abc');
  });

  it('refuses changes asked for by other sites, and lets them sign no one out', async () => {
    const jar = new Jar();
    await jar.fetch(`${base}/api/auth/dev`, json({ name: 'Ola' }));
    const post = (headers: Record<string, string>) =>
      jar.fetch(`${base}/api/offices`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    expect((await post({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post({ 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await post({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost:5173' })).status).toBe(201);
    expect((await post({ Origin: 'http://localhost:5173' })).status).toBe(201);
    // A form posted from another site carries no SameSite=Lax cookie; it must not clear it either.
    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
    expect(logout.status).toBe(200);
    expect(logout.headers.getSetCookie()).toEqual([]);
    expect((await me(jar))?.name).toBe('Ola');
  });

  it('signs out sockets whose session expired', async () => {
    const jar = new Jar();
    await jar.fetch(`${base}/api/auth/dev`, json({ name: 'Eve' }));
    const hash = sha256(jar.cookies.get('wc_session')!);
    await server.db.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [hash]);
    // The periodic cleanup, as a second server sharing the database would run it on start.
    const ended: string[] = [];
    const auth = createAuth({ db: server.db, accounts: new Accounts(server.db), publicOrigin: null, options: { google: null, apple: null, devLogin: false }, onLogout: (h) => ended.push(h), quiet: true });
    await auth.close();
    expect(ended).toContain(hash);
    expect((await server.db.query('SELECT 1 FROM sessions WHERE token_hash = $1', [hash])).rowCount).toBe(0);
  });

  it('accepts the Apple key as PEM, with \\n escapes, or base64', () => {
    expect(parsePrivateKey(appleKey)).toBe(appleKey.trim());
    expect(parsePrivateKey(appleKey.trim().replace(/\n/g, '\\n'))).toBe(appleKey.trim());
    expect(parsePrivateKey(Buffer.from(appleKey).toString('base64'))).toBe(appleKey.trim());
  });
});

describe('accounts in the office', () => {
  it('knows who is connected, records memberships and lists spaces', async () => {
    const jar = new Jar();
    await jar.fetch(`${base}/api/auth/dev`, json({ name: 'Mia', email: 'mia@example.com' }));
    const mia = (await me(jar))!;
    // Created while signed in: Mia owns it.
    const mine = await createOffice(base, jar, 'Mia HQ');
    // Someone else's, which Mia visits.
    const other = await createOffice(base, undefined, 'Other HQ');

    const a = await join(base, other.id, 'Mia', { jar });
    expect(a.res.ok && a.res.isOwner).toBe(false);
    expect(server.io.sockets.sockets.get(a.socket.id!)?.data.user).toEqual({ id: mia.id, name: 'Mia' });
    const guest = await join(base, other.id, 'Guest');
    expect(server.io.sockets.sockets.get(guest.socket.id!)?.data.user).toBeNull();
    const players = guest.res.ok ? guest.res.players : [];
    expect(players.find((p) => p.name === 'Mia')?.userId).toBe(mia.id);
    expect(players.find((p) => p.name === 'Guest')?.userId).toBeUndefined();

    const spaces = (await (await jar.fetch(`${base}/api/me/spaces`)).json()) as Space[];
    expect(spaces.map((s) => [s.id, s.name, s.role, s.online])).toEqual([
      [other.id, 'Other HQ', 'member', 2],
      [mine.id, 'Mia HQ', 'owner', 0],
    ]);
    expect(spaces[0].lastVisitAt).toBeGreaterThan(Date.now() - 60_000);
    expect((await fetch(`${base}/api/me/spaces`)).status).toBe(401);

    // The owner key makes her an owner, which then holds without the key.
    a.socket.disconnect();
    const withKey = await join(base, other.id, 'Mia', { jar, ownerKey: other.ownerKey });
    expect(withKey.res.ok && withKey.res.isOwner).toBe(true);
    withKey.socket.disconnect();
    const later = await join(base, other.id, 'Mia', { jar });
    expect(later.res.ok && later.res.isOwner).toBe(true);
    const roles = (await (await jar.fetch(`${base}/api/me/spaces`)).json()) as Space[];
    expect(roles.find((s) => s.id === other.id)?.role).toBe('owner');
    // Guests leave no trace.
    const members = await server.db.query('SELECT user_id FROM memberships WHERE office_id = $1', [other.id]);
    expect(members.rows).toEqual([{ user_id: mia.id }]);

    // Logging out disconnects that session's sockets.
    const dropped = new Promise((resolve) => later.socket.on('disconnect', resolve));
    await jar.fetch(`${base}/api/auth/logout`, { method: 'POST' });
    expect(await dropped).toBe('io server disconnect');
    expect(guest.socket.connected).toBe(true);
  });

  it('keeps a signed-in visitor working who arrives just as the office empties', async () => {
    // Recording the visit waits on the database; meanwhile the last person leaves and the office is
    // dropped from memory. The newcomer must still end up in the office that gets saved.
    let delay = 0;
    const db = server.db;
    const slow: Db = {
      kind: db.kind,
      description: db.description,
      query: async <T,>(sql: string, params?: unknown[]) => {
        if (delay && sql.includes('INSERT INTO memberships')) await new Promise((r) => setTimeout(r, delay));
        return db.query<T>(sql, params);
      },
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    const other = await startServer({ port: 0, host: '127.0.0.1', db: slow, quiet: true, iceServers: [], auth: { google: null, apple: null, devLogin: true } });
    try {
      const otherBase = `http://127.0.0.1:${other.port}`;
      const office = await createOffice(otherBase);
      const last = await join(otherBase, office.id, 'Last');
      const jar = new Jar();
      await jar.fetch(`${otherBase}/api/auth/dev`, json({ name: 'Newcomer' }));
      delay = 200;
      const joining = join(otherBase, office.id, 'Newcomer', { jar });
      await new Promise((r) => setTimeout(r, 100));
      last.socket.disconnect();
      const { socket } = await joining;
      delay = 0;
      expect(other.store.peek(office.id)).toBeDefined();
      socket.emit('office:op', { t: 'add', item: { id: 'sofa1', type: 'sofa', x: 5, z: 5, rot: 0 } });
      await until(() => !!other.store.peek(office.id)?.office.items.some((i) => i.id === 'sofa1'));
      socket.disconnect();
    } finally {
      await other.close();
    }
  });

  it('refuses socket connections from other sites', async () => {
    const attempt = (origin: string) => {
      const socket = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { origin } });
      return new Promise<boolean>((resolve) => {
        socket.on('connect', () => resolve(true));
        socket.on('connect_error', () => resolve(false));
      }).finally(() => socket.disconnect());
    };
    expect(await attempt('https://evil.example')).toBe(false);
    expect(await attempt('http://localhost:5173')).toBe(true);
  });
});
