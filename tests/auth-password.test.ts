import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeEmail, passwordProblem, type AccountUser, type SignInMethods, type SignInProviders } from '../shared/account';
import { DEFAULT_AVATAR } from '../shared/avatar';
import type { PlayerPatch } from '../shared/types';
import { Accounts, type Identity } from '../server/accounts';
import { Passwords, PasswordsBusy, SCRYPT } from '../server/auth/passwords';
import type { Db } from '../server/db';
import { coreMigrations, migrate } from '../server/db/migrations';
import { startServer } from '../server/index';
import { noMail, type Mailer, type MailMessage } from '../server/mail';
import { createTestDb, freshDb, TEST_DATABASE_URL } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, until, type Client } from './helpers/http';

let server: Awaited<ReturnType<typeof startServer>>;
let db: Db;
let base: string;
/** Every email sent, like the dev outbox but without its limit of 50. */
const sent: MailMessage[] = [];
const recorder: Mailer = { kind: 'outbox', send: (message) => void sent.push(message), close: async () => {} };
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery';

beforeAll(async () => {
  db = await createTestDb();
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    db,
    quiet: true,
    iceServers: [],
    publicUrl: ORIGIN,
    auth: { google: null, apple: null, devLogin: true },
    mailer: recorder,
    // Each test signs in from an address of its own, so the per-visitor limits don't add up.
    clientIpHeader: 'x-forwarded-for',
  });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  await server?.close();
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
let visitors = 0;

/** A browser at an address of its own (on `at`, another server). */
function browser(at = () => base) {
  const jar = new Jar();
  const ip = `10.0.${Math.floor(++visitors / 250)}.${visitors % 250}`;
  const send = (method: string, path: string, body?: unknown) =>
    jar.fetch(`${at()}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    jar,
    post: (path: string, body: unknown = {}) => send('POST', path, body),
    get: (path: string) => send('GET', path),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
    del: (path: string) => send('DELETE', path),
    me: async () => ((await (await send('GET', '/api/me')).json()) as { user: AccountUser | null }).user,
  };
}

const mailsTo = (to: string) => sent.filter((m) => m.to === to);
const tokenIn = (mail: MailMessage | undefined, path: string) => mail?.text.match(new RegExp(`${ORIGIN}${path}#t=([\\w-]{43})`))?.[1];

/** The token in the newest link to `path` mailed to `to`. */
function mailedToken(to: string, path: string): string {
  const token = tokenIn(mailsTo(to).at(-1), path);
  if (!token) throw new Error(`no ${path} link mailed to ${to}`);
  return token;
}

/** Makes a request that answers before emailing `to`; waits for that email and returns its `path` token. */
async function emailed(to: string, path: string, request: () => Promise<Response>): Promise<string> {
  const before = mailsTo(to).length;
  const res = await request();
  expect(res.status).toBe(202);
  await until(() => mailsTo(to).length > before);
  return mailedToken(to, path);
}

/** Lets work done after answering finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/** Signs up through the emailed link; returns the signed-in browser. */
async function signUp(email: string, fields: Record<string, unknown> = {}) {
  const b = browser();
  expect((await b.post('/api/auth/signup', { email })).status).toBe(202);
  const res = await b.post('/api/auth/signup/finish', { token: mailedToken(email, '/signup'), name: 'Nia', password: PASSWORD, ...fields });
  expect(res.status).toBe(200);
  return { ...b, user: ((await res.json()) as { user: AccountUser }).user };
}

const once = <T extends unknown[]>(socket: Client, event: string) =>
  new Promise<T>((resolve) => (socket as unknown as { once(e: string, fn: (...args: T) => void): void }).once(event, (...args: T) => resolve(args)));

const identity = (provider: Identity['provider'], subject: string, email: string | null, emailVerified: boolean, label: string | null = null): Identity => ({
  provider,
  subject,
  email,
  emailVerified,
  isPrivateEmail: false,
  name: `${provider} ${subject}`,
  avatarUrl: null,
  label,
});

describe('passwords', () => {
  it('are hashed with scrypt, checked in constant time, and rehashed after the parameters change', async () => {
    const cheap = new Passwords({ params: { N: 2 ** 10, r: 8, p: 1 } });
    const hash = await cheap.hash('ﬁne password');
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(await cheap.hash('ﬁne password')).not.toBe(hash);
    expect(await cheap.verify('ﬁne password', hash)).toEqual({ ok: true, rehash: false });
    // The same characters, typed differently (NFKC).
    expect(await cheap.verify('fine password', hash)).toEqual({ ok: true, rehash: false });
    expect(await cheap.verify('fine passworD', hash)).toEqual({ ok: false, rehash: false });
    // Today's parameters.
    const passwords = new Passwords();
    expect(await passwords.verify('fine password', hash)).toEqual({ ok: true, rehash: true });
    expect(await passwords.hash('x')).toMatch(new RegExp(`^scrypt\\$${SCRYPT.N}\\$${SCRYPT.r}\\$${SCRYPT.p}\\$`));
    for (const broken of ['', 'plain', 'scrypt$1024$8$1$short$short', hash.replace('$1024$', '$1048576$'), hash.slice(0, -2)]) {
      expect(await cheap.verify('fine password', broken), broken).toEqual({ ok: false, rehash: false });
    }
  });

  it('take as long without an account, and at most two are hashed at once', async () => {
    const passwords = new Passwords();
    const stored = await passwords.hash(PASSWORD);
    await passwords.verify('warm up the made-up hash', null);
    const median = async (check: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await check();
        times.push(performance.now() - t);
      }
      return times.sort((a, b) => a - b)[2];
    };
    const known = await median(() => passwords.verify('wrong password', stored));
    expect(await median(() => passwords.verify(PASSWORD, null))).toBeGreaterThan(known / 3);
    // Past the budget for unknown addresses, a pretend check takes about as long, without the work.
    expect(await median(() => passwords.pretend())).toBeGreaterThan(known / 3);

    const small = new Passwords({ params: { N: 2 ** 12, r: 8, p: 1 }, concurrency: 2, queue: 1 });
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => small.hash(`password ${i}`)));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
    expect((results[3] as PromiseRejectedResult).reason).toBeInstanceOf(PasswordsBusy);
    // And then free again.
    expect(await small.hash('later')).toMatch(/^scrypt\$/);
  });

  it('follow simple rules, and addresses are kept in lower case', () => {
    expect(passwordProblem('short', null)).toBe('Use at least 10 characters.');
    expect(passwordProblem('x'.repeat(199) + 'y', null)).toBeNull();
    expect(passwordProblem('x'.repeat(200) + 'y', null)).toBe('Use at most 200 characters.');
    expect(passwordProblem('Jane.Doe@Example.com', 'jane.doe@example.com')).toMatch(/email address/);
    expect(passwordProblem('jane.doe.1', 'jane.doe.1@example.com')).toMatch(/email address/);
    expect(passwordProblem('aaaaaaaaaaaa', null)).toMatch(/less predictable/);
    expect(passwordProblem('no composition rules', 'jane@example.com')).toBeNull();
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
    for (const bad of ['jane', 'jane@example', 'ja ne@example.com', '@example.com', 'a@b@c.com', 'a\u0000@b.com', 42, null]) expect(normalizeEmail(bad), String(bad)).toBeNull();
  });
});

describe('signing up and in with email and a password', () => {
  it('says that email sign-up is on', async () => {
    expect((await (await browser().get('/api/auth/providers')).json()) as SignInProviders).toEqual({
      google: false,
      apple: false,
      github: false,
      dev: true,
      password: true,
      emailLinks: true,
    });
  });

  it('signs up from an emailed link, then signs in with the password', async () => {
    const b = browser();
    expect(await (await b.post('/api/auth/signup', { email: '  New.Person@Example.com ' })).json()).toEqual({ ok: true });
    const [mail] = mailsTo('new.person@example.com');
    expect(mail.subject).toBe('Finish signing up');
    const token = mailedToken('new.person@example.com', '/signup');
    expect(mail.html).toContain(`href="${ORIGIN}/signup#t=${token}"`);
    // Only a hash of the token is stored, for a day.
    const stored = await db.query<{ purpose: string; hours: number }>(
      'SELECT purpose, round(extract(epoch FROM expires_at - now()) / 3600)::int AS hours FROM email_tokens WHERE token_hash = $1',
      [sha256(token)],
    );
    expect(stored.rows).toEqual([{ purpose: 'signup', hours: 24 }]);
    expect(JSON.stringify((await db.query('SELECT * FROM email_tokens')).rows)).not.toContain(token);

    // The page can say which address it's for, without using the link up.
    expect(await (await b.post('/api/auth/link/peek', { token })).json()).toEqual({ email: 'new.person@example.com', purpose: 'signup' });

    // Mistakes don't use the link up.
    const finish = (fields: Record<string, unknown>) => b.post('/api/auth/signup/finish', { token, name: 'Nia', password: PASSWORD, ...fields });
    expect(await (await finish({ name: '  ' })).json()).toEqual({ error: 'Enter your name.' });
    expect(await (await finish({ password: 'short' })).json()).toEqual({ error: 'Use at least 10 characters.' });
    expect((await finish({ password: 'new.person@example.com' })).status).toBe(400);
    expect((await finish({ password: 42 })).status).toBe(400);

    const done = await finish({ name: '  Nia \u0007 Ng ', avatar: { hair: 'bun', skin: 'not a colour' } });
    expect(done.status).toBe(200);
    const user = ((await done.json()) as { user: AccountUser }).user;
    expect(user).toMatchObject({
      name: 'Nia Ng',
      email: 'new.person@example.com',
      emailVerified: true,
      hasPassword: true,
      profile: { avatar: { ...DEFAULT_AVATAR, hair: 'bun' } },
    });
    expect(b.jar.cookies.has('wc_session')).toBe(true);
    expect(await b.me()).toEqual(user);
    expect(JSON.stringify(await (await b.get('/api/me')).json())).not.toContain('scrypt');
    const hash = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    expect(hash.rows[0].password_hash).toMatch(/^scrypt\$32768\$8\$3\$/);

    // Once only.
    expect(await (await finish({})).json()).toEqual({ error: 'This link has expired or was already used.', code: 'expired' });
    expect((await b.post('/api/auth/link/peek', { token })).status).toBe(400);

    await b.post('/api/auth/logout');
    expect(await b.me()).toBeNull();
    const wrong = await b.post('/api/auth/password', { email: 'new.person@example.com', password: 'wrong password' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Wrong email or password.' });
    const right = await b.post('/api/auth/password', { email: 'NEW.PERSON@example.com ', password: PASSWORD });
    expect(right.status).toBe(200);
    expect(((await right.json()) as { user: AccountUser }).user.id).toBe(user.id);
    expect((await b.me())?.id).toBe(user.id);
  });

  it("doesn't take expired or unknown links", async () => {
    const b = browser();
    await b.post('/api/auth/signup', { email: 'late@example.com' });
    const token = mailedToken('late@example.com', '/signup');
    await db.query("UPDATE email_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [sha256(token)]);
    for (const t of [token, 'x'.repeat(43), 'not a token', undefined]) {
      const res = await b.post('/api/auth/signup/finish', { token: t, name: 'Late', password: PASSWORD });
      expect(res.status, String(t)).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe('expired');
      expect((await b.post('/api/auth/link/peek', { token: t })).status).toBe(400);
    }
    // A reset link isn't a sign-up link.
    await signUp('kinds@example.com');
    const reset = await emailed('kinds@example.com', '/reset', () => browser().post('/api/auth/password/forgot', { email: 'kinds@example.com' }));
    expect(await (await b.post('/api/auth/link/peek', { token: reset })).json()).toEqual({ email: 'kinds@example.com', purpose: 'reset' });
    expect((await b.post('/api/auth/signup/finish', { token: reset, name: 'X', password: PASSWORD })).status).toBe(400);
    expect((await b.post('/api/auth/password/reset', { token: reset, password: 'another good password' })).status).toBe(200);
  });

  it('answers the same whether or not an address has an account', async () => {
    const { user } = await signUp('taken@example.com');
    const b = browser();
    const fresh = await b.post('/api/auth/signup', { email: 'free@example.com' });
    const existing = await b.post('/api/auth/signup', { email: 'Taken@example.com' });
    expect([fresh.status, await fresh.json()]).toEqual([202, { ok: true }]);
    expect([existing.status, await existing.json()]).toEqual([202, { ok: true }]);
    // The owner learns they already have an account, with a link to set a password.
    const mail = mailsTo('taken@example.com').at(-1)!;
    expect(mail.subject).toBe('You already have an account');
    const token = mailedToken('taken@example.com', '/reset');
    const reset = await b.post('/api/auth/password/reset', { token, password: 'a brand new password' });
    expect(((await reset.json()) as { user: AccountUser }).user.id).toBe(user.id);

    // Password resets answer before looking the address up.
    const nobody = await b.post('/api/auth/password/forgot', { email: 'nobody@example.com' });
    expect([nobody.status, await nobody.json()]).toEqual([202, { ok: true }]);
    await emailed('taken@example.com', '/reset', () => b.post('/api/auth/password/forgot', { email: 'taken@example.com' }));
    expect(mailsTo('taken@example.com').at(-1)?.subject).toBe('Reset your password');
    await settle();
    expect(mailsTo('nobody@example.com')).toEqual([]);
    for (const path of ['/api/auth/signup', '/api/auth/password/forgot']) {
      expect(await (await b.post(path, { email: 'not an address' })).json()).toEqual({ error: 'Enter a valid email address.' });
    }
    const unknown = await b.post('/api/auth/password', { email: 'nobody@example.com', password: PASSWORD });
    expect([unknown.status, await unknown.json()]).toEqual([401, { error: 'Wrong email or password.' }]);
  });

  it('limits wrong passwords per address and visitor, emails per address, and sign-in requests per visitor', async () => {
    await signUp('limited@example.com');
    const b = browser();
    for (let i = 0; i < 10; i++) expect((await b.post('/api/auth/password', { email: 'limited@example.com', password: `wrong password ${i}` })).status).toBe(401);
    const blocked = await b.post('/api/auth/password', { email: 'limited@example.com', password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // The owner, somewhere else, isn't locked out; nor are other addresses.
    expect((await browser().post('/api/auth/password', { email: 'limited@example.com', password: PASSWORD })).status).toBe(200);
    await signUp('unlimited@example.com');
    expect((await b.post('/api/auth/password', { email: 'unlimited@example.com', password: PASSWORD })).status).toBe(200);

    // Sign-up requests don't use up the password reset emails.
    await signUp('flood@example.com');
    const mails = browser();
    for (let i = 0; i < 4; i++) expect((await mails.post('/api/auth/signup', { email: 'flood@example.com' })).status).toBe(202);
    expect((await mails.post('/api/auth/signup', { email: 'flood@example.com' })).status).toBe(429);
    await emailed('flood@example.com', '/reset', () => mails.post('/api/auth/password/forgot', { email: 'flood@example.com' }));
    expect((await mails.post('/api/auth/password/forgot', { email: 'flood@example.com' })).status).toBe(429);

    const visitor = browser();
    for (let i = 0; i < 60; i++) expect((await visitor.post('/api/auth/signup', { email: 'nope' })).status).toBe(400);
    expect((await visitor.post('/api/auth/password', { email: 'unlimited@example.com', password: PASSWORD })).status).toBe(429);
    expect((await browser().post('/api/auth/password', { email: 'unlimited@example.com', password: PASSWORD })).status).toBe(200);
  });
});

describe('changing passwords and addresses', () => {
  it('resets a forgotten password, signing out every other session and its sockets', async () => {
    const owner = await signUp('reset.me@example.com');
    const laptop = browser();
    await laptop.post('/api/auth/password', { email: 'reset.me@example.com', password: PASSWORD });
    const { id } = await createOffice(base);
    const { socket } = await join(base, id, 'Nia', { jar: laptop.jar });
    const dropped = new Promise((resolve) => socket.on('disconnect', resolve));

    const b = browser();
    const token = await emailed('reset.me@example.com', '/reset', () => b.post('/api/auth/password/forgot', { email: 'reset.me@example.com' }));
    expect(mailsTo('reset.me@example.com').at(-1)?.subject).toBe('Reset your password');
    expect(await (await b.post('/api/auth/password/reset', { token, password: 'short' })).json()).toEqual({ error: 'Use at least 10 characters.' });
    const res = await b.post('/api/auth/password/reset', { token, password: 'my new password!' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: AccountUser }).user.id).toBe(owner.user.id);
    expect(await dropped).toBe('io server disconnect');
    expect(await laptop.me()).toBeNull();
    expect(await owner.me()).toBeNull();
    expect((await b.me())?.id).toBe(owner.user.id);

    expect((await b.post('/api/auth/password/reset', { token, password: 'again a new password' })).status).toBe(400);
    expect((await b.post('/api/auth/password', { email: 'reset.me@example.com', password: PASSWORD })).status).toBe(401);
    expect((await b.post('/api/auth/password', { email: 'reset.me@example.com', password: 'my new password!' })).status).toBe(200);
  });

  it('changes the password and signs out other sessions', async () => {
    const owner = await signUp('change.me@example.com');
    const phone = browser();
    await phone.post('/api/auth/password', { email: 'change.me@example.com', password: PASSWORD });
    // A reset link sent before the change won't work after it.
    const oldLink = await emailed('change.me@example.com', '/reset', () => browser().post('/api/auth/password/forgot', { email: 'change.me@example.com' }));

    expect(await (await owner.post('/api/me/password', { current: 'not my password', password: 'another password' })).json()).toEqual({ error: 'Wrong password.' });
    expect((await owner.post('/api/me/password', { current: PASSWORD, password: 'short' })).status).toBe(400);
    const changed = await owner.post('/api/me/password', { current: PASSWORD, password: 'another password' });
    expect([changed.status, await changed.json()]).toEqual([200, { ok: true }]);
    expect((await owner.me())?.id).toBe(owner.user.id);
    expect(await phone.me()).toBeNull();
    expect((await browser().post('/api/auth/password/reset', { token: oldLink, password: 'sneaky password' })).status).toBe(400);
    expect((await browser().post('/api/auth/password', { email: 'change.me@example.com', password: 'another password' })).status).toBe(200);

    // Sign out everywhere else.
    const tablet = browser();
    await tablet.post('/api/auth/password', { email: 'change.me@example.com', password: 'another password' });
    expect(await (await owner.post('/api/auth/logout-others')).json()).toEqual({ ended: 2 });
    expect(await tablet.me()).toBeNull();
    expect((await owner.me())?.id).toBe(owner.user.id);
    expect((await browser().post('/api/auth/logout-others')).status).toBe(401);
    expect((await browser().post('/api/me/password', { current: 'x', password: 'y' })).status).toBe(401);
  });

  it('changes the email address with the password and a link opened while signed in', async () => {
    const owner = await signUp('before@example.com', { name: 'Bea Fore' });
    const phone = browser();
    await phone.post('/api/auth/password', { email: 'before@example.com', password: PASSWORD });
    expect(await (await owner.post('/api/me/email', { email: 'after@example.com' })).json()).toEqual({ error: 'Enter your current password.', code: 'current-password' });
    expect(await (await owner.post('/api/me/email', { email: 'after@example.com', current: 'not my password' })).json()).toEqual({ error: 'Wrong password.' });

    // A first request, with a typo, then the right one: only the newest link works.
    const typo = await emailed('after@exmaple.com', '/confirm-email', () => owner.post('/api/me/email', { email: 'after@exmaple.com', current: PASSWORD }));
    const token = await emailed('after@example.com', '/confirm-email', () => owner.post('/api/me/email', { email: 'After@Example.com', current: PASSWORD }));
    const mail = mailsTo('after@example.com').at(-1)!;
    expect(mail.subject).toBe('Confirm your email address');
    // It says which account asked, and what to do if it wasn't you.
    expect(mail.text).toContain('Bea Fore (before@example.com)');
    expect(mail.text).toMatch(/If you didn’t ask for this, ignore this email/);
    expect((await owner.post('/api/auth/email/confirm', { token: typo })).status).toBe(400);
    // Nothing changes until it's confirmed.
    expect(await owner.me()).toMatchObject({ email: 'before@example.com', emailVerified: true });

    // Only while signed in to the account that asked; trying otherwise doesn't use the link up, and
    // to anyone else the link looks like an unknown one.
    for (const other of [browser(), await signUp('someone.else@example.com')]) {
      const refused = await other.post('/api/auth/email/confirm', { token });
      expect([refused.status, ((await refused.json()) as { code?: string }).code]).toEqual([401, 'sign-in']);
      expect(await (await other.post('/api/auth/link/peek', { token })).json()).toEqual({ error: 'This link has expired or was already used.', code: 'expired' });
    }
    expect(await (await owner.post('/api/auth/link/peek', { token })).json()).toEqual({ email: 'after@example.com', purpose: 'email' });
    const confirmed = await owner.post('/api/auth/email/confirm', { token });
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { user: AccountUser }).user).toMatchObject({ id: owner.user.id, email: 'after@example.com', emailVerified: true });
    expect((await owner.post('/api/auth/email/confirm', { token })).status).toBe(400);
    // The old address hears of it, and the other devices are signed out.
    expect(mailsTo('before@example.com').at(-1)).toMatchObject({ subject: 'Your email address was changed' });
    expect(mailsTo('before@example.com').at(-1)?.text).toContain('after@example.com');
    expect(await phone.me()).toBeNull();
    expect((await owner.me())?.email).toBe('after@example.com');
    expect((await browser().post('/api/auth/password', { email: 'after@example.com', password: PASSWORD })).status).toBe(200);
    expect((await browser().post('/api/auth/password', { email: 'before@example.com', password: PASSWORD })).status).toBe(401);
    expect(await (await owner.post('/api/me/email', { email: 'after@example.com', current: PASSWORD })).json()).toEqual({ error: 'That’s already your email address.' });
  });

  it("doesn't say whether another account has an address, and never moves it there", async () => {
    const owner = await signUp('asker@example.com');
    await signUp('other.owner@example.com');
    const before = mailsTo('other.owner@example.com').length;
    const res = await owner.post('/api/me/email', { email: 'other.owner@example.com', current: PASSWORD });
    expect([res.status, await res.json()]).toEqual([202, { ok: true }]);
    await settle();
    expect(mailsTo('other.owner@example.com')).toHaveLength(before);

    // Two accounts ask for the same new address; whoever confirms first gets it.
    const other = await signUp('second.asker@example.com');
    const first = await emailed('contested@example.com', '/confirm-email', () => owner.post('/api/me/email', { email: 'contested@example.com', current: PASSWORD }));
    const second = await emailed('contested@example.com', '/confirm-email', () => other.post('/api/me/email', { email: 'contested@example.com', current: PASSWORD }));
    expect((await other.post('/api/auth/email/confirm', { token: second })).status).toBe(200);
    const late = await owner.post('/api/auth/email/confirm', { token: first });
    expect([late.status, ((await late.json()) as { code?: string }).code]).toEqual([409, 'taken']);
    expect((await owner.me())?.email).toBe('asker@example.com');
  });

  it('verifies an unconfirmed address, then mails a link to set a first password, keeping the sessions', async () => {
    const dev = browser();
    await dev.post('/api/auth/dev', { name: 'Dee', email: 'dee@example.com' });
    expect(await dev.me()).toMatchObject({ email: 'dee@example.com', emailVerified: false, hasPassword: false });
    expect(await (await dev.post('/api/me/password/link')).json()).toEqual({ error: 'Confirm your email address first.' });
    expect((await dev.post('/api/me/password', { current: '', password: 'a good password' })).status).toBe(400);
    const noEmail = browser();
    await noEmail.post('/api/auth/dev', { name: 'Nemo' });
    expect(await (await noEmail.post('/api/me/password/link')).json()).toEqual({ error: 'Add an email address first.' });

    // Without a password, no password is asked for.
    const confirm = await emailed('dee@example.com', '/confirm-email', () => dev.post('/api/me/email', { email: 'dee@example.com' }));
    expect(mailsTo('dee@example.com').at(-1)?.text).toContain('Dee (dee@example.com)');
    expect((await dev.post('/api/auth/email/confirm', { token: confirm })).status).toBe(200);
    expect(await dev.me()).toMatchObject({ email: 'dee@example.com', emailVerified: true });

    expect((await dev.post('/api/me/password/link')).status).toBe(202);
    expect(mailsTo('dee@example.com').at(-1)?.subject).toBe('Set a password');
    const set = await browser().post('/api/auth/password/reset', { token: mailedToken('dee@example.com', '/reset'), password: 'dee has a password' });
    expect(((await set.json()) as { user: AccountUser }).user).toMatchObject({ name: 'Dee', hasPassword: true });
    // A first password doesn't sign anyone out.
    expect(await (await dev.get('/api/me/sign-in')).json()).toEqual({ methods: [], hasPassword: true } satisfies SignInMethods);
  });

  it('sets the password of an account that verified the address after the sign-up link was sent', async () => {
    const b = browser();
    await b.post('/api/auth/signup', { email: 'meanwhile@example.com' });
    const token = mailedToken('meanwhile@example.com', '/signup');
    const accounts = new Accounts(db);
    const google = await accounts.signIn(identity('google', 'meanwhile', 'meanwhile@example.com', true));
    const res = await b.post('/api/auth/signup/finish', { token, name: 'Someone', password: PASSWORD });
    expect(((await res.json()) as { user: AccountUser }).user).toMatchObject({ id: google.id, name: google.name, hasPassword: true });
  });
});

describe('without email', () => {
  it('turns off what needs it, and offers passwords only once someone has one', async () => {
    const offDb = await freshDb();
    const off = await startServer({ port: 0, host: '127.0.0.1', db: offDb, quiet: true, iceServers: [], publicUrl: ORIGIN, auth: { google: null, apple: null, devLogin: true }, mailer: noMail() });
    try {
      const b = browser(() => `http://127.0.0.1:${off.port}`);
      const providers = async () => (await (await b.get('/api/auth/providers')).json()) as SignInProviders;
      expect(await providers()).toMatchObject({ password: false, emailLinks: false });
      const mailOff = async (res: Response) => [res.status, ((await res.json()) as { code?: string }).code];
      for (const path of ['/api/auth/signup', '/api/auth/password/forgot']) expect(await mailOff(await b.post(path, { email: 'anyone@example.com' }))).toEqual([503, 'mail-off']);
      await b.post('/api/auth/dev', { name: 'Offline', email: 'offline@example.com' });
      expect(await mailOff(await b.post('/api/me/email', { email: 'new@example.com' }))).toEqual([503, 'mail-off']);
      expect(await mailOff(await b.post('/api/me/password/link'))).toEqual([503, 'mail-off']);

      // An account with a password (made before email was turned off, say) can still sign in.
      const accounts = new Accounts(offDb);
      await accounts.createWithPassword({ email: 'kept@example.com', name: 'Kept', passwordHash: await new Passwords().hash(PASSWORD) });
      expect(await providers()).toMatchObject({ password: true, emailLinks: false });
      expect((await b.post('/api/auth/password', { email: 'kept@example.com', password: PASSWORD })).status).toBe(200);
    } finally {
      await off.close();
    }
  });
});

describe('one account per verified email address', () => {
  it('links a new sign-in only by an address its provider verified', async () => {
    const accounts = new Accounts(db);
    const google = await accounts.signIn(identity('google', 'link-1', 'link@example.com', true));
    expect(google).toMatchObject({ email: 'link@example.com', emailVerified: true });
    expect((await accounts.signIn(identity('github', 'link-1', 'link@example.com', true))).id).toBe(google.id);
    // Unverified, or the dev login (which checks nothing): accounts of their own, never merged.
    const unverified = await accounts.signIn(identity('apple', 'link-1', 'link@example.com', false));
    const dev = await accounts.signIn(identity('dev', 'link@example.com', 'link@example.com', true));
    expect(new Set([google.id, unverified.id, dev.id]).size).toBe(3);
    expect(dev.emailVerified).toBe(false);
    // Known identities stay where they are.
    expect((await accounts.signIn(identity('apple', 'link-1', 'link@example.com', true))).id).toBe(unverified.id);

    // A password account gets the provider's sign-in too.
    const password = await signUp('password.first@example.com');
    expect((await accounts.signIn(identity('google', 'password-first', 'password.first@example.com', true))).id).toBe(password.user.id);
    expect(await (await password.get('/api/me/sign-in')).json()).toEqual({
      methods: [{ provider: 'google', subject: 'password-first', label: 'password.first@example.com', email: 'password.first@example.com', emailVerified: true }],
      hasPassword: true,
    });
    // Which can then go, since the password remains.
    expect((await password.del('/api/me/sign-in/google/password-first')).status).toBe(200);
  });

  it('lists and removes each sign-in on its own, even two at one provider', async () => {
    const accounts = new Accounts(db);
    const owner = await signUp('two.githubs@example.com');
    await accounts.signIn(identity('github', '9001', 'two.githubs@example.com', true, 'octo-work'));
    await accounts.signIn(identity('github', '9002', 'two.githubs@example.com', true, 'octo-home'));
    const { methods } = (await (await owner.get('/api/me/sign-in')).json()) as SignInMethods;
    expect(methods.map((m) => [m.provider, m.subject, m.label])).toEqual([
      ['github', '9001', 'octo-work'],
      ['github', '9002', 'octo-home'],
    ]);
    const removed = await owner.del('/api/me/sign-in/github/9001');
    expect(((await removed.json()) as SignInMethods).methods.map((m) => m.label)).toEqual(['octo-home']);
    expect((await owner.del('/api/me/sign-in/github/9001')).status).toBe(404);
    expect((await owner.del('/api/me/sign-in/github/nobody')).status).toBe(404);
    // Without an address or a login, it's named after its provider.
    const apple = await accounts.signIn(identity('apple', 'apple.9003', null, false));
    expect((await accounts.signInMethods(apple.id)).methods).toEqual([{ provider: 'apple', subject: 'apple.9003', label: 'Apple account', email: null, emailVerified: false }]);
  });

  // PGlite runs one transaction at a time, so the sign-ins can't race there.
  it.skipIf(!TEST_DATABASE_URL)('makes one account when two sign-ins with the same new address arrive at once', async () => {
    const accounts = new Accounts(db);
    const users = await Promise.all(['a', 'b', 'c'].map((s) => accounts.signIn(identity(s === 'b' ? 'github' : 'google', `race-${s}`, 'race@example.com', true))));
    expect(new Set(users.map((u) => u.id)).size).toBe(1);
    const owners = await db.query("SELECT id FROM users WHERE email = 'race@example.com'");
    expect(owners.rowCount).toBe(1);
  });

  it('verifies the address of an account from before email sign-in when its provider vouches for it', { timeout: 60_000 }, async () => {
    const old = await freshDb();
    await migrate(old, coreMigrations.filter((m) => m.id < 4));
    // Signed in with GitHub before: the public profile email, unverified.
    await old.query("INSERT INTO users (id, name, email) VALUES ('old-gh', 'Old', 'old@example.com'), ('other-gh', 'Other', 'other@example.com')");
    await old.query(
      `INSERT INTO auth_identities (provider, subject, user_id, email, email_verified) VALUES
         ('github', '501', 'old-gh', 'old@example.com', false), ('github', '502', 'other-gh', 'other@example.com', false)`,
    );
    await migrate(old, coreMigrations);
    const accounts = new Accounts(old);
    expect(await accounts.get('old-gh')).toMatchObject({ emailVerified: false });

    // Now GitHub vouches for it: verified, so a later Google sign-in with it lands there too.
    expect(await accounts.signIn(identity('github', '501', 'old@example.com', true, 'old-login'))).toMatchObject({ id: 'old-gh', emailVerified: true });
    expect((await accounts.signIn(identity('google', 'old-google', 'old@example.com', true))).id).toBe('old-gh');
    // Not an address the account doesn't have, nor one another account verified first.
    expect(await accounts.signIn(identity('github', '502', 'elsewhere@example.com', true))).toMatchObject({ email: 'other@example.com', emailVerified: false });
    await accounts.signIn(identity('google', 'first', 'other@example.com', true));
    expect(await accounts.signIn(identity('github', '502', 'other@example.com', true))).toMatchObject({ id: 'other-gh', emailVerified: false });
  });
});

describe('name and character in the office', () => {
  it('come from the account, change only with it, and show live in open offices', async () => {
    const nia = await signUp('nia.office@example.com', { name: 'Nia Office', avatar: { ...DEFAULT_AVATAR, hair: 'bun' } });
    const { id } = await createOffice(base);
    const guest = await join(base, id, 'Guest');
    const mine = await join(base, id, 'Someone Else', { jar: nia.jar });
    const me = mine.res.ok ? mine.res.players.find((p) => p.id === mine.res.selfId)! : null;
    expect(me).toMatchObject({ name: 'Nia Office', avatar: { hair: 'bun' }, userId: nia.user.id });

    // The socket can't change them, only the rest; with nothing else, nothing is sent.
    const updates: PlayerPatch[] = [];
    guest.socket.on('player:updated', (_id, patch) => updates.push(patch));
    mine.socket.emit('profile', { name: 'Hacker', avatar: DEFAULT_AVATAR });
    mine.socket.emit('profile', { name: 'Hacker', avatar: DEFAULT_AVATAR, status: 'busy' });
    await until(() => updates.length > 0);
    await settle();
    expect(updates).toEqual([{ status: 'busy' }]);

    // Profile edits do, everywhere they are.
    let patch = once<[string, PlayerPatch]>(guest.socket, 'player:updated');
    await nia.patch('/api/me', { name: 'Nia Renamed', profile: { avatar: { ...DEFAULT_AVATAR, hair: 'long' } } });
    expect(await patch).toEqual([mine.res.ok && mine.res.selfId, { name: 'Nia Renamed', avatar: { ...DEFAULT_AVATAR, hair: 'long' } }]);
    await until(() => server.realtime.rooms.get(id)?.players.get(mine.socket.id!)?.name === 'Nia Renamed');

    // Guests still choose their own.
    patch = once<[string, PlayerPatch]>(mine.socket, 'player:updated');
    guest.socket.emit('profile', { name: 'Guest Renamed' });
    expect((await patch)[1]).toEqual({ name: 'Guest Renamed' });
  });

  it('keeps the character someone came in with when their account has none yet', async () => {
    const dev = browser();
    await dev.post('/api/auth/dev', { name: 'Newbie' });
    expect((await dev.me())?.profile.avatar).toBeUndefined();
    const { id } = await createOffice(base);
    const { socket } = await join(base, id, 'Newbie', { jar: dev.jar });
    expect((await dev.me())?.profile.avatar).toEqual(DEFAULT_AVATAR);
    socket.disconnect();
  });

  it("refuses a signed-in join when the account can't be loaded", async () => {
    // A database that fails to load accounts, and only that.
    let failing = false;
    const flaky: Db = {
      kind: db.kind,
      description: db.description,
      query: async <T,>(sql: string, params?: unknown[]) => {
        if (failing && /FROM users WHERE id = \$1$/.test(sql)) throw new Error('database is away');
        return db.query<T>(sql, params);
      },
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    const other = await startServer({ port: 0, host: '127.0.0.1', db: flaky, quiet: true, iceServers: [], publicUrl: ORIGIN, auth: { google: null, apple: null, devLogin: true }, mailer: noMail() });
    const error = console.error;
    try {
      const otherBase = `http://127.0.0.1:${other.port}`;
      const dev = browser(() => otherBase);
      await dev.post('/api/auth/dev', { name: 'Ghost' });
      const { id } = await createOffice(otherBase);
      console.error = () => {};
      failing = true;
      await expect(join(otherBase, id, 'Not Ghost', { jar: dev.jar })).rejects.toThrow('Could not load your account right now. Please try again.');
    } finally {
      failing = false;
      console.error = error;
      await other.close();
    }
  });
});
