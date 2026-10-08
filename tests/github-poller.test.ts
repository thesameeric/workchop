import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GithubInbox, GithubItem } from '../shared/github';
import type { Db } from '../server/db';
import { collectMigrations, migrate } from '../server/db/migrations';
import { createApi, NeedsReconnect } from '../server/features/github/api';
import { decryptToken, encryptToken } from '../server/features/github/crypto';
import { Links, migrations, normalizeScopes, type Tokens } from '../server/features/github/links';
import { createOAuth } from '../server/features/github/oauth';
import { createPoller, type Schedule } from '../server/features/github/poller';
import { createTestDb, TEST_DATABASE_URL } from './helpers/db';
import { startMockGithub, type MockGithub } from './helpers/github';
import { until } from './helpers/http';

let mock: MockGithub;
let db: Db;
const key = crypto.randomBytes(32);
/** Added to the clock the code under test sees. */
let offset = 0;
const now = () => Date.now() + offset;
let n = 0;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  mock = await startMockGithub();
  db = await createTestDb();
  await migrate(db, collectMigrations([{ name: 'github', migrations }]));
}, 60_000);

afterAll(async () => {
  await mock?.close();
});

afterEach(() => {
  offset = 0;
  mock.failure = null;
  mock.pollInterval = 60;
  mock.refreshDelay = 0;
  mock.accessTtl = 8 * 3600;
  mock.redirects.clear();
  vi.restoreAllMocks();
});

const tokensOf = (issued: ReturnType<MockGithub['issue']>, at = now()): Tokens => ({
  accessToken: issued.access_token,
  refreshToken: issued.refresh_token ?? null,
  accessExpiresAt: issued.expires_in ? at + issued.expires_in * 1000 : null,
  refreshExpiresAt: issued.refresh_token_expires_in ? at + issued.refresh_token_expires_in * 1000 : null,
  scopes: normalizeScopes(issued.scope),
});

/** A Workchop user connected to a new GitHub user, and a poller (with timers the test runs) for them. */
async function connected(opts: { scope?: string; storedScope?: string; expiresIn?: number; fetch?: typeof fetch } = {}) {
  const i = ++n;
  const userId = `user-${i}-${crypto.randomBytes(3).toString('hex')}`;
  const ghId = 7000 + i;
  await db.query('INSERT INTO users (id, name) VALUES ($1, $2)', [userId, `User ${i}`]);
  mock.addUser(ghId, `dev${i}`);
  const issued = mock.issue(ghId, opts.scope ?? 'notifications');
  const tokens = tokensOf(issued);
  if (opts.expiresIn !== undefined) tokens.accessExpiresAt = now() + opts.expiresIn;
  if (opts.storedScope !== undefined) tokens.scopes = opts.storedScope;
  const links = new Links(db, key);
  await links.link(userId, { id: String(ghId), login: `dev${i}` }, tokens);
  return { userId, ghId, issued, links, ...tools(userId, links, opts.fetch ?? fetch) };
}

/** The API client and poller for a user, as the feature wires them. */
function tools(userId: string, links: Links, fetchFn: typeof fetch) {
  const events: [string, ...unknown[]][] = [];
  const reconnects: string[] = [];
  const scopeChanges: string[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const oauth = createOAuth({
    fetch: fetchFn,
    clientId: mock.clientId,
    clientSecret: mock.clientSecret,
    oauthBase: mock.base,
    apiBase: mock.apiBase,
    redirectUri: 'http://localhost:5173/api/integrations/github/callback',
    now,
  });
  const api = createApi({
    fetch: fetchFn,
    apiBase: mock.apiBase,
    links,
    oauth,
    now,
    onNeedsReconnect: (u) => reconnects.push(u),
    onScopes: (u) => scopeChanges.push(u),
  });
  const poller = createPoller({
    api,
    bases: { apiBase: mock.apiBase, webBase: mock.base },
    now,
    schedule,
    emitToUser: (u, event, ...args) => {
      expect(u).toBe(userId);
      events.push([event, ...args]);
    },
  });
  /** Runs the next poll (without waiting for it). */
  const poll = () => {
    const timer = timers.at(-1)!;
    expect(timer.cancelled).toBe(false);
    timer.fn();
  };
  return {
    api,
    poller,
    events,
    reconnects,
    scopeChanges,
    timers,
    poll,
    /** Starts polling and waits for the first poll to schedule the next; returns the wait until then (ms). */
    async start() {
      const count = timers.length;
      poller.start(userId);
      await until(() => timers.length > count);
      return timers.at(-1)!.ms;
    },
    /** Runs the next poll and waits for it to schedule the one after; returns the wait until then (ms). */
    async tick() {
      const count = timers.length;
      poll();
      await until(() => timers.length > count);
      return timers.at(-1)!.ms;
    },
    take() {
      return events.splice(0);
    },
  };
}

const notificationCalls = () => mock.calls('/api/notifications');

/** A fetch that holds GitHub's answers to addresses with `part` (notification lists) while `holding`, until released. */
function gated(part = '/api/notifications?') {
  const waiting: (() => void)[] = [];
  const gate = {
    holding: true,
    waiting,
    release: () => waiting.splice(0).forEach((resolve) => resolve()),
    fetch: (async (input, init) => {
      const res = await fetch(input, init);
      if (!gate.holding || !String(input).includes(part)) return res;
      const body = res.status === 304 ? null : await res.text();
      await new Promise<void>((resolve) => waiting.push(resolve));
      return new Response(body, { status: res.status, headers: res.headers });
    }) as typeof fetch,
  };
  return gate;
}

describe('the poller', () => {
  it('sends the inbox after the first poll, then waits for X-Poll-Interval', async () => {
    const u = await connected();
    mock.addThread(u.ghId, { reason: 'mention', title: 'Look at this', repo: 'octo/app', number: 3 });
    mock.addThread(u.ghId, { reason: 'review_requested', title: 'Please review', repo: 'octo/app', number: 4 });
    mock.addThread(u.ghId, { reason: 'ci_activity', type: 'CheckSuite', title: 'CI workflow run failed for main branch', repo: 'octo/app', noUrl: true });
    mock.addThread(u.ghId, { reason: 'comment', type: 'Issue', title: 'Bug', repo: 'octo/lib', number: 9 });
    mock.addThread(u.ghId, { reason: 'mention', title: 'Already read', unread: false });
    mock.counts.set(u.ghId, { reviewRequests: 2, assigned: 5 });
    const before = notificationCalls().length;

    expect(await u.start()).toBe(60_000);
    const [[event, inbox], ...rest] = u.take() as [[string, GithubInbox]];
    expect(rest).toEqual([]);
    expect(event).toBe('github:inbox');
    expect(inbox.counts).toEqual({ reviewRequests: 2, assigned: 5 });
    expect(inbox.items.map((i) => [i.bucket, i.reason, i.title, i.repo, i.url, i.unread])).toEqual([
      ['activity', 'comment', 'Bug', 'octo/lib', `${mock.base}/octo/lib/issues/9`, true],
      ['actions', 'ci_activity', 'CI workflow run failed for main branch', 'octo/app', `${mock.base}/octo/app/actions?query=workflow%3A%22CI%22+is%3Afailure+branch%3Amain`, true],
      ['reviews', 'review_requested', 'Please review', 'octo/app', `${mock.base}/octo/app/pull/4`, true],
      ['mentions', 'mention', 'Look at this', 'octo/app', `${mock.base}/octo/app/pull/3`, true],
    ]);
    expect(inbox.items[1].run).toEqual({ status: 'failure', workflow: 'CI', branch: 'main' });

    const [call] = notificationCalls().slice(before);
    expect(call.path).toBe('/api/notifications?all=false&participating=false&per_page=50');
    expect(call.headers).toMatchObject({
      authorization: `Bearer ${u.issued.access_token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'Workchop',
    });
    expect(call.headers['if-modified-since']).toBeUndefined();
    const searches = mock.calls('/api/search/issues').slice(-2).map((r) => new URL(r.path, mock.base).searchParams);
    expect(searches.map((q) => [q.get('q'), q.get('per_page')])).toEqual([
      ['is:open is:pr review-requested:@me archived:false', '1'],
      ['is:open assignee:@me archived:false', '1'],
    ]);
    // Joining sockets get it at once from now on.
    expect(u.poller.inbox(u.userId)).toEqual(inbox);
    u.poller.stop(u.userId);
  });

  it('asks with If-Modified-Since and sends only what changed', async () => {
    const u = await connected();
    const a = mock.addThread(u.ghId, { title: 'A' });
    const b = mock.addThread(u.ghId, { title: 'B' });
    const c = mock.addThread(u.ghId, { title: 'C' });
    await u.start();
    u.take();

    // Nothing new: 304 (free for rate limits), nothing sent.
    expect(await u.tick()).toBe(60_000);
    const conditional = notificationCalls().at(-1)!;
    expect(conditional.headers['if-modified-since']).toBe(mock.lastModified(u.ghId));
    expect(u.take()).toEqual([]);

    const d = mock.addThread(u.ghId, { title: 'D', reason: 'review_requested' });
    mock.updateThread(u.ghId, a.id, { title: 'A, again' });
    mock.removeThread(u.ghId, b.id);
    await u.tick();
    const events = u.take();
    expect(events.filter(([e]) => e === 'github:item').map(([, item]) => (item as GithubItem).title).sort()).toEqual(['A, again', 'D']);
    expect(events.filter(([e]) => e === 'github:remove')).toEqual([['github:remove', b.id]]);
    expect(u.poller.inbox(u.userId)!.items.map((i) => i.id).sort()).toEqual([a.id, c.id, d.id].sort());

    // Read on GitHub: gone from the unread list.
    mock.threadsOf(u.ghId).find((t) => t.id === c.id)!.unread = false;
    mock.touch(u.ghId);
    await u.tick();
    expect(u.take()).toEqual([['github:remove', c.id]]);
    u.poller.stop(u.userId);
  });

  it('never polls sooner than X-Poll-Interval or a minute', async () => {
    const u = await connected();
    mock.pollInterval = 120;
    expect(await u.start()).toBe(120_000);
    mock.pollInterval = 5;
    expect(await u.tick()).toBe(60_000);
    mock.pollInterval = 300;
    expect(await u.tick()).toBe(300_000);
    u.poller.stop(u.userId);
    expect(u.timers.at(-1)!.cancelled).toBe(true);
  });

  it('reads at most two pages, saying when GitHub has more', async () => {
    const u = await connected();
    const t0 = Date.now() - 1000_000;
    for (let i = 0; i < 130; i++) mock.addThread(u.ghId, { title: `T${i}`, updated: t0 + i * 1000 });
    const before = notificationCalls().length;
    await u.start();
    const [[, inbox]] = u.take() as [[string, GithubInbox]];
    expect(inbox.items).toHaveLength(100);
    expect(inbox.items[0].title).toBe('T129');
    expect(inbox.more).toBe(true);
    const calls = notificationCalls().slice(before);
    expect(calls.map((c) => new URL(c.path, mock.base).searchParams.get('page'))).toEqual([null, '2']);

    // Down to 100 unread: items don't say so, so the whole inbox comes again.
    for (const thread of mock.threadsOf(u.ghId).slice(100)) thread.unread = false;
    mock.touch(u.ghId);
    await u.tick();
    const [[event, again], ...rest] = u.take() as [[string, GithubInbox]];
    expect(rest).toEqual([]);
    expect(event).toBe('github:inbox');
    expect(again.items).toHaveLength(100);
    expect('more' in again).toBe(false);
    u.poller.stop(u.userId);
  });

  it("doesn't follow a next page on another host", async () => {
    let page2 = 0;
    const u = await connected({
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        if (!String(input).includes('/api/notifications?')) return res;
        if (String(input).includes('page=2')) page2++;
        const headers = new Headers(res.headers);
        headers.set('Link', '<https://evil.example/api/notifications?page=2>; rel="next"');
        return new Response(res.status === 304 ? null : await res.text(), { status: res.status, headers });
      },
    });
    mock.addThread(u.ghId, { title: 'One' });
    await u.start();
    expect((u.take()[0][1] as GithubInbox).items).toHaveLength(1);
    expect(page2).toBe(0);
    u.poller.stop(u.userId);
  });

  it('backs off on rate limits and errors, without retrying in a loop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = await connected();
    mock.addThread(u.ghId);
    await u.start();
    u.take();

    const reset = Math.floor(Date.now() / 1000) + 900;
    mock.failure = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } };
    const wait = (await u.tick())!;
    expect(wait).toBeGreaterThan(890_000);
    expect(wait).toBeLessThanOrEqual(900_000);

    mock.failure = { status: 429, headers: { 'retry-after': '300' } };
    expect(await u.tick()).toBeCloseTo(300_000, -3);

    // Secondary limits without a time: a minute or more.
    mock.failure = { status: 429 };
    expect(await u.tick()).toBeGreaterThanOrEqual(60_000);
    expect(await u.tick()).toBe(60_000);

    // Errors double the wait, up to 15 minutes; one success resets it.
    mock.failure = { status: 502, times: 6 };
    const waits = [];
    for (let i = 0; i < 6; i++) waits.push(await u.tick());
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await u.tick()).toBe(60_000);
    // A 403 that isn't about rate limits (say, an organization's policy) is an error too.
    mock.failure = { status: 403 };
    expect(await u.tick()).toBe(60_000);
    expect(await u.tick()).toBe(60_000);
    expect(u.take()).toEqual([]);
    u.poller.stop(u.userId);
  });

  it('marks threads read and done, and everything read', async () => {
    const u = await connected();
    const a = mock.addThread(u.ghId, { title: 'A' });
    const b = mock.addThread(u.ghId, { title: 'B' });
    const c = mock.addThread(u.ghId, { title: 'C' });
    await u.start();
    u.take();

    expect(await u.poller.read(u.userId, a.id)).toBe(true);
    expect(mock.calls(`/api/notifications/threads/${a.id}`, 'PATCH')).toHaveLength(1);
    expect(mock.threadsOf(u.ghId).find((t) => t.id === a.id)!.unread).toBe(false);
    expect(u.take()).toEqual([['github:item', expect.objectContaining({ id: a.id, unread: false })]]);

    expect(await u.poller.done(u.userId, b.id)).toBe(true);
    expect(mock.calls(`/api/notifications/threads/${b.id}`, 'DELETE')).toHaveLength(1);
    expect(mock.threadsOf(u.ghId).map((t) => t.id)).not.toContain(b.id);
    expect(u.take()).toEqual([['github:remove', b.id]]);

    expect(await u.poller.readAll(u.userId)).toBe(true);
    const put = mock.calls('/api/notifications', 'PUT').at(-1)!;
    expect(Date.parse(JSON.parse(put.body).last_read_at)).toBeGreaterThan(Date.now() - 5000);
    const [[event, inbox]] = u.take() as [[string, GithubInbox]];
    expect(event).toBe('github:inbox');
    expect(inbox.items.map((i) => [i.id, i.unread])).toEqual([
      [c.id, false],
      [a.id, false],
    ]);
    expect(mock.threadsOf(u.ghId).every((t) => !t.unread)).toBe(true);

    // GitHub doesn't know the thread.
    expect(await u.poller.read(u.userId, '999999')).toBe(false);
    expect(await u.poller.done(u.userId, '999999')).toBe(false);
    u.poller.stop(u.userId);
  });

  it("doesn't bring back a thread marked done by a poll that was already under way", async () => {
    const gate = gated();
    const u = await connected({ fetch: gate.fetch });
    const a = mock.addThread(u.ghId, { title: 'A' });
    mock.addThread(u.ghId, { title: 'B' });
    gate.holding = false;
    await u.start();
    u.take();
    // The list as it was is delivered only after the thread was marked done.
    gate.holding = true;
    mock.touch(u.ghId);
    const count = u.timers.length;
    u.timers.at(-1)!.fn();
    await until(() => gate.waiting.length > 0);
    expect(await u.poller.done(u.userId, a.id)).toBe(true);
    gate.release();
    await until(() => u.timers.length > count);
    expect(u.take()).toEqual([['github:remove', a.id]]);
    expect(u.poller.inbox(u.userId)!.items.map((i) => i.title)).toEqual(['B']);
    u.poller.stop(u.userId);
  });

  it('keeps marks made while a poll looks up pages', async () => {
    const gate = gated('/api/repos/');
    const u = await connected({ scope: 'notifications,repo', fetch: gate.fetch });
    const a = mock.addThread(u.ghId, { title: 'A' });
    const b = mock.addThread(u.ghId, { title: 'B' });
    gate.holding = false;
    await u.start();
    u.take();
    gate.holding = true;

    // A new thread's page is looked up; meanwhile one thread is marked done and another read.
    const c = mock.addThread(u.ghId, { title: 'C' });
    let count = u.timers.length;
    u.poll();
    await until(() => gate.waiting.length > 0);
    expect(await u.poller.done(u.userId, a.id)).toBe(true);
    expect(await u.poller.read(u.userId, b.id)).toBe(true);
    gate.release();
    await until(() => u.timers.length > count);
    expect(u.take()).toEqual([
      ['github:remove', a.id],
      ['github:item', expect.objectContaining({ id: b.id, unread: false })],
      ['github:item', expect.objectContaining({ id: c.id, unread: true })],
    ]);
    expect(u.poller.inbox(u.userId)!.items.map((i) => [i.id, i.unread])).toEqual([
      [c.id, true],
      [b.id, false],
    ]);

    // Everything marked read meanwhile: what the poll brings that is newer stays unread.
    const d = mock.addThread(u.ghId, { title: 'D', updated: Date.now() + 1000 });
    count = u.timers.length;
    u.poll();
    await until(() => gate.waiting.length > 0);
    expect(await u.poller.readAll(u.userId)).toBe(true);
    gate.release();
    await until(() => u.timers.length > count);
    expect(u.take()).toEqual([
      ['github:inbox', expect.objectContaining({ items: [expect.objectContaining({ id: c.id, unread: false }), expect.objectContaining({ id: b.id, unread: false })] })],
      ['github:item', expect.objectContaining({ id: d.id, unread: true })],
      // Read on GitHub, so no longer in its unread list.
      ['github:remove', b.id],
    ]);
    expect(u.poller.inbox(u.userId)!.items.map((i) => [i.id, i.unread])).toEqual([
      [d.id, true],
      [c.id, false],
    ]);
    expect(mock.threadsOf(u.ghId).find((t) => t.id === d.id)!.unread).toBe(true);
    u.poller.stop(u.userId);
  });

  it('marks read only what the last poll listed', async () => {
    const u = await connected();
    // Before A, which is stamped with the time it's added.
    const before = now();
    const a = mock.addThread(u.ghId, { title: 'A' });
    await u.start();
    const after = now();
    u.take();
    // Arrived after that poll: never seen, so it stays unread.
    const b = mock.addThread(u.ghId, { title: 'B', updated: Date.now() + 1000 });
    expect(await u.poller.readAll(u.userId)).toBe(true);
    const at = Date.parse(JSON.parse(mock.calls('/api/notifications', 'PUT').at(-1)!.body).last_read_at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(u.take()).toEqual([['github:inbox', expect.objectContaining({ items: [expect.objectContaining({ id: a.id, unread: false })] })]]);
    expect(mock.threadsOf(u.ghId).map((t) => [t.id, t.unread])).toEqual([
      [b.id, true],
      [a.id, false],
    ]);
    await u.tick();
    expect(u.poller.inbox(u.userId)!.items.map((i) => [i.id, i.unread])).toEqual([[b.id, true]]);
    // No list, nothing to mark.
    u.poller.stop(u.userId);
    const puts = mock.calls('/api/notifications', 'PUT').length;
    expect(await u.poller.readAll(u.userId)).toBe(false);
    expect(mock.calls('/api/notifications', 'PUT')).toHaveLength(puts);
  });

  it('keeps the last X-Poll-Interval when an answer comes without one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = await connected();
    mock.pollInterval = 180;
    expect(await u.start()).toBe(180_000);
    mock.pollInterval = null;
    mock.failure = { status: 502 };
    expect(await u.tick()).toBe(180_000);
    mock.failure = { status: 502, headers: { 'X-Poll-Interval': 'soon' } };
    expect(await u.tick()).toBe(360_000);
    expect(await u.tick()).toBe(180_000);
    u.poller.stop(u.userId);
  });

  it("says why there's no inbox while GitHub can't be read, until a list arrives", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = await connected();
    mock.addThread(u.ghId, { title: 'A' });
    const none = { items: [], counts: { reviewRequests: null, assigned: null } };
    mock.failure = { status: 502 };
    await u.start();
    expect(u.take()).toEqual([['github:inbox', { ...none, problem: 'unavailable' }]]);
    // Tabs joining now get it too; the same problem isn't sent again.
    expect(u.poller.inbox(u.userId)).toEqual({ ...none, problem: 'unavailable' });
    mock.failure = { status: 502 };
    await u.tick();
    expect(u.take()).toEqual([]);
    mock.failure = { status: 403 };
    await u.tick();
    expect(u.take()).toEqual([['github:inbox', { ...none, problem: 'forbidden' }]]);
    mock.failure = { status: 429, headers: { 'retry-after': '60' } };
    await u.tick();
    expect(u.take()).toEqual([['github:inbox', { ...none, problem: 'rate-limited' }]]);

    await u.tick();
    const [[event, inbox], ...rest] = u.take() as [[string, GithubInbox]];
    expect(rest).toEqual([]);
    expect(event).toBe('github:inbox');
    expect('problem' in inbox).toBe(false);
    expect(inbox.items.map((i) => i.title)).toEqual(['A']);
    // Once there's a list, failing polls keep it as it is.
    mock.failure = { status: 502 };
    await u.tick();
    expect(u.take()).toEqual([]);
    expect(u.poller.inbox(u.userId)).toEqual(inbox);
    u.poller.stop(u.userId);
  });

  it('takes a 403 about a secondary rate limit as a rate limit, waiting longer each time', async () => {
    const u = await connected();
    mock.addThread(u.ghId, { title: 'A' });
    // It may come without retry-after, and with requests left in the hourly limit.
    const message = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
    mock.failure = { status: 403, headers: { 'x-ratelimit-remaining': '4000' }, message, times: 3 };
    expect(await u.start()).toBe(60_000);
    expect(u.take()).toEqual([['github:inbox', { items: [], counts: { reviewRequests: null, assigned: null }, problem: 'rate-limited' }]]);
    expect(await u.tick()).toBe(120_000);
    expect(await u.tick()).toBe(240_000);
    expect(await u.tick()).toBe(60_000);
    expect((u.take()[0][1] as GithubInbox).items.map((i) => i.title)).toEqual(['A']);
    expect(u.reconnects).toEqual([]);
    u.poller.stop(u.userId);
  });

  it('looks up page addresses only with the repo scope, asking again with the ETag', async () => {
    const plain = await connected();
    const full = await connected({ scope: 'notifications,repo' });
    for (const u of [plain, full]) {
      mock.addThread(u.ghId, { repo: 'octo/secret', number: 5, title: 'Private PR' });
    }
    mock.pages.set(`${mock.apiBase}/repos/octo/secret/pulls/5`, `${mock.base}/octo/secret/pull/5#issuecomment-9`);
    const lookups = () => mock.calls('/api/repos/octo/secret/pulls/5');
    const before = lookups().length;

    await plain.start();
    expect((plain.take()[0][1] as GithubInbox).items[0].url).toBe(`${mock.base}/octo/secret/pull/5`);
    expect(lookups().length).toBe(before);

    await full.start();
    expect((full.take()[0][1] as GithubInbox).items[0].url).toBe(`${mock.base}/octo/secret/pull/5#issuecomment-9`);
    expect(lookups().length).toBe(before + 1);
    expect(lookups().at(-1)!.headers['if-none-match']).toBeUndefined();

    // New activity: asked again with the ETag (a 304 costs nothing), keeping the page.
    const id = mock.threadsOf(full.ghId)[0].id;
    mock.updateThread(full.ghId, id);
    await full.tick();
    expect(lookups().length).toBe(before + 2);
    expect(lookups().at(-1)!.headers['if-none-match']).toMatch(/^".+"$/);
    expect(full.take()).toEqual([['github:item', expect.objectContaining({ url: `${mock.base}/octo/secret/pull/5#issuecomment-9` })]]);

    // A page elsewhere is never used.
    mock.pages.set(`${mock.apiBase}/repos/octo/secret/pulls/5`, 'https://evil.example/phish');
    mock.updateThread(full.ghId, id);
    await full.tick();
    expect(full.take()).toEqual([['github:item', expect.objectContaining({ url: `${mock.base}/octo/secret/pull/5` })]]);
    plain.poller.stop(plain.userId);
    full.poller.stop(full.userId);
  });

  it('counts open review requests and assignments every five minutes', async () => {
    const u = await connected();
    mock.counts.set(u.ghId, { reviewRequests: 1, assigned: 0 });
    await u.start();
    expect((u.take()[0][1] as GithubInbox).counts).toEqual({ reviewRequests: 1, assigned: 0 });
    const searches = () => mock.calls('/api/search/issues').length;
    const before = searches();
    mock.counts.set(u.ghId, { reviewRequests: 4, assigned: 2 });
    await u.tick();
    expect(searches()).toBe(before);
    offset = 5 * 60_000;
    await u.tick();
    expect(searches()).toBe(before + 2);
    expect(u.take()).toEqual([['github:inbox', expect.objectContaining({ counts: { reviewRequests: 4, assigned: 2 } })]]);
    // Unchanged counts aren't sent again.
    offset = 10 * 60_000;
    await u.tick();
    expect(searches()).toBe(before + 4);
    expect(u.take()).toEqual([]);
    u.poller.stop(u.userId);
  });

  it('refreshes after a 401, and stops when the user must reconnect', async () => {
    const u = await connected();
    mock.addThread(u.ghId);
    await u.start();
    u.take();
    const refreshes = mock.refreshes;
    mock.expire(u.issued.access_token);
    expect(await u.tick()).toBe(60_000);
    expect(mock.refreshes).toBe(refreshes + 1);
    const link = (await u.links.get(u.userId))!;
    expect(link.accessToken).not.toBe(u.issued.access_token);
    expect(mock.valid(link.accessToken!)).toBe(true);

    // The person revoked Workchop on GitHub: no token works any more.
    mock.forget(u.ghId);
    const count = u.timers.length;
    u.poll();
    await until(() => u.reconnects.length > 0);
    await pause(50);
    expect(u.timers.length).toBe(count);
    expect(u.poller.inbox(u.userId)).toBeNull();
    expect(u.reconnects).toEqual([u.userId]);
    expect((await u.links.get(u.userId))!.needsReconnect).toBe(true);
    expect(u.take()).toEqual([]);
    // Joining again doesn't poll a link that needs reconnecting.
    const calls = notificationCalls().length;
    u.poller.start(u.userId);
    await pause(100);
    expect(u.timers.length).toBe(count);
    expect(u.poller.inbox(u.userId)).toBeNull();
    expect(notificationCalls().length).toBe(calls);
  });

  it("stops at once, and a poll under way doesn't send anything", async () => {
    const gate = gated();
    const u = await connected({ fetch: gate.fetch });
    mock.addThread(u.ghId);
    u.poller.start(u.userId);
    await until(() => gate.waiting.length > 0);
    u.poller.stop(u.userId);
    gate.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(u.events).toEqual([]);
    expect(u.timers).toEqual([]);
    expect(u.poller.inbox(u.userId)).toBeNull();
  });

  it('keeps the inbox for a while after you leave, polling again only when due', async () => {
    const u = await connected();
    mock.addThread(u.ghId, { title: 'Kept' });
    await u.start();
    const [[, inbox]] = u.take() as [[string, GithubInbox]];
    const calls = notificationCalls().length;
    const searches = mock.calls('/api/search/issues').length;

    u.poller.leave(u.userId);
    expect(u.timers.at(-2)!.cancelled).toBe(true);
    expect(u.timers.at(-1)!.ms).toBe(10 * 60_000);
    // Back (say, after a reload): the inbox is there at once, and the poll waits for its time.
    offset = 20_000;
    u.poller.start(u.userId);
    expect(u.poller.inbox(u.userId)).toEqual(inbox);
    expect(u.timers.at(-2)!.cancelled).toBe(true);
    expect(u.timers.at(-1)!.ms).toBeGreaterThan(39_000);
    expect(u.timers.at(-1)!.ms).toBeLessThanOrEqual(40_000);
    expect(await u.tick()).toBe(60_000);
    expect(notificationCalls().length).toBe(calls + 1);
    expect(mock.calls('/api/search/issues').length).toBe(searches);

    // Gone for good after a while.
    const next = u.timers.at(-1)!;
    u.poller.leave(u.userId);
    expect(next.cancelled).toBe(true);
    u.timers.at(-1)!.fn();
    expect(u.poller.inbox(u.userId)).toBeNull();
  });

  it('finishes a poll that was under way when you left, polling again only if you come back', async () => {
    const gate = gated();
    const u = await connected({ fetch: gate.fetch });
    gate.holding = false;
    await u.start();
    gate.holding = true;
    let count = u.timers.length;
    u.timers.at(-1)!.fn();
    await until(() => gate.waiting.length > 0);
    u.poller.leave(u.userId);
    gate.release();
    await new Promise((r) => setTimeout(r, 100));
    // Only the timer that forgets the inbox.
    expect(u.timers.slice(count).map((t) => [t.ms, t.cancelled])).toEqual([[10 * 60_000, false]]);

    // Back while a poll is under way: that poll schedules the next, and there's no second one.
    count = u.timers.length;
    u.poller.start(u.userId);
    u.timers.at(-1)!.fn();
    await until(() => gate.waiting.length > 0);
    u.poller.leave(u.userId);
    u.poller.start(u.userId);
    gate.release();
    await until(() => u.timers.length > count + 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(u.timers.slice(count).map((t) => [t.ms, t.cancelled])).toEqual([
      [expect.any(Number), false],
      [10 * 60_000, true],
      [60_000, false],
    ]);
    u.poller.stop(u.userId);
  });

  it("doesn't poll people without GitHub", async () => {
    const userId = `nobody-${crypto.randomBytes(3).toString('hex')}`;
    await db.query('INSERT INTO users (id, name) VALUES ($1, $2)', [userId, 'Nobody']);
    const t = tools(userId, new Links(db, key), fetch);
    t.poller.start(userId);
    await pause(100);
    expect(t.timers).toEqual([]);
    expect(t.poller.inbox(userId)).toBeNull();
  });
});

describe('tokens', () => {
  it('refresh once for many callers', async () => {
    mock.refreshDelay = 150;
    const u = await connected({ expiresIn: 2 * 60_000 });
    const old = (await u.links.get(u.userId))!;
    const refreshes = mock.refreshes;
    const results = await Promise.all([...Array(5)].map(() => u.api.token(u.userId)));
    expect(mock.refreshes).toBe(refreshes + 1);
    const fresh = (await u.links.get(u.userId))!;
    expect(new Set(results.map((r) => r.token))).toEqual(new Set([fresh.accessToken]));
    expect(fresh.accessToken).not.toBe(old.accessToken);
    expect(fresh.refreshToken).not.toBe(old.refreshToken);
    expect(fresh.accessExpiresAt).toBeGreaterThan(now() + 7 * 3600_000);
    expect(fresh.refreshExpiresAt).toBeGreaterThan(now() + 100 * 24 * 3600_000);
    expect(mock.valid(fresh.accessToken!)).toBe(true);
    expect(mock.valid(old.accessToken!)).toBe(false);
    // Stored encrypted, bound to the user.
    const row = (await db.query<{ access_token_enc: string; refresh_token_enc: string }>('SELECT * FROM github_links WHERE user_id = $1', [u.userId])).rows[0];
    expect(JSON.stringify(row)).not.toContain(fresh.accessToken);
    expect(JSON.stringify(row)).not.toContain(fresh.refreshToken);
    expect(decryptToken(key, u.userId, 'refresh', row.refresh_token_enc)).toBe(fresh.refreshToken);
    // Fresh tokens aren't refreshed again.
    await u.api.token(u.userId);
    expect(mock.refreshes).toBe(refreshes + 1);
  });

  // Only Postgres can be shared: PGlite's directory is locked to one process.
  it.skipIf(!TEST_DATABASE_URL)('refresh once across servers sharing the database', async () => {
    mock.refreshDelay = 150;
    const u = await connected({ expiresIn: 2 * 60_000 });
    const other = tools(u.userId, new Links(db, key), fetch);
    const refreshes = mock.refreshes;
    const results = await Promise.all([...Array(3)].map(() => u.api.token(u.userId)).concat([...Array(3)].map(() => other.api.token(u.userId))));
    expect(mock.refreshes).toBe(refreshes + 1);
    const fresh = (await u.links.get(u.userId))!;
    expect(new Set(results.map((r) => r.token))).toEqual(new Set([fresh.accessToken]));
    expect(u.reconnects).toEqual([]);
    expect(other.reconnects).toEqual([]);
  });

  it("doesn't hold the database while GitHub answers a refresh", async () => {
    mock.refreshDelay = 300;
    const u = await connected({ expiresIn: 60_000 });
    const refreshes = mock.refreshes;
    const pending = u.api.token(u.userId);
    await until(() => mock.refreshes > refreshes);
    const started = Date.now();
    await db.query('SELECT 1');
    expect(Date.now() - started).toBeLessThan(150);
    expect((await pending).token).toBe((await u.links.get(u.userId))!.accessToken);
  });

  it("doesn't hold the database while GitHub answers many refreshes at once", async () => {
    mock.refreshDelay = 2000;
    const users = [];
    for (let i = 0; i < 8; i++) users.push(await connected({ expiresIn: 60_000 }));
    const refreshes = mock.refreshes;
    const pending = users.map((u) => u.api.token(u.userId));
    // All under way at once, more than there are Postgres connections in the pool (5).
    await until(() => mock.refreshes === refreshes + 8, 1500);
    const started = Date.now();
    await db.query('SELECT 1');
    expect(Date.now() - started).toBeLessThan(500);
    const results = await Promise.all(pending);
    for (const [i, u] of users.entries()) expect(results[i].token).toBe((await u.links.get(u.userId))!.accessToken);
    expect(mock.refreshes).toBe(refreshes + 8);
  });

  // Only Postgres can be shared: PGlite's directory is locked to one process.
  it.skipIf(!TEST_DATABASE_URL)('waits for a refresh another server has under way, and takes over a lease that ran out', async () => {
    const u = await connected({ expiresIn: 60_000 });
    const elsewhere = createOAuth({ fetch, clientId: mock.clientId, clientSecret: mock.clientSecret, oauthBase: mock.base, apiBase: mock.apiBase, redirectUri: 'x', now });
    // Another server has started refreshing.
    const lease = (await u.links.leaseRefresh(u.userId)) as string;
    const refreshes = mock.refreshes;
    const pending = u.api.token(u.userId);
    await pause(600);
    expect(mock.refreshes).toBe(refreshes);
    const tokens = await elsewhere.refresh((await u.links.get(u.userId))!.refreshToken!);
    await u.links.withLock(u.userId, (tx) => u.links.saveTokens(tx, u.userId, tokens));
    await u.links.releaseRefresh(u.userId, lease);
    expect((await pending).token).toBe(tokens.accessToken);
    expect(mock.refreshes).toBe(refreshes + 1);

    // A server stopped while refreshing: once its lease runs out, the refresh happens here.
    await db.query(`UPDATE github_links SET access_expires_at = now() + interval '1 minute', refresh_lease_until = now() + interval '700 milliseconds' WHERE user_id = $1`, [u.userId]);
    expect((await u.api.token(u.userId)).token).not.toBe(tokens.accessToken);
    expect(mock.refreshes).toBe(refreshes + 2);
    expect((await db.query('SELECT refresh_lease_until FROM github_links WHERE user_id = $1', [u.userId])).rows).toEqual([{ refresh_lease_until: null }]);
    expect(u.reconnects).toEqual([]);
  });

  it('marks the link for reconnecting when GitHub refuses the refresh token', async () => {
    const u = await connected({ expiresIn: 60_000 });
    mock.forget(u.ghId);
    await expect(u.api.token(u.userId)).rejects.toBeInstanceOf(NeedsReconnect);
    expect(u.reconnects).toEqual([u.userId]);
    expect((await u.links.get(u.userId))!.needsReconnect).toBe(true);
    const refreshes = mock.refreshes;
    await expect(u.api.token(u.userId)).rejects.toBeInstanceOf(NeedsReconnect);
    expect(mock.refreshes).toBe(refreshes);
  });

  it("keeps using a token that still works while GitHub can't refresh it, and refreshes later", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let down = true;
    const u = await connected({
      expiresIn: 4 * 60_000,
      fetch: (input, init) => (down && String(input).includes('/login/oauth/access_token') ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init)),
    });
    const before = (await u.links.get(u.userId))!;
    expect((await u.api.token(u.userId)).token).toBe(before.accessToken);
    expect(await u.links.get(u.userId)).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
    // Not tried again for a minute: every call meanwhile uses the token as it is.
    for (let i = 0; i < 5; i++) expect((await u.api.token(u.userId)).token).toBe(before.accessToken);
    expect(warn).toHaveBeenCalledTimes(1);
    offset = 61_000;
    expect((await u.api.token(u.userId)).token).toBe(before.accessToken);
    expect(warn).toHaveBeenCalledTimes(2);
    // Expired, it can't be used any more.
    offset = 5 * 60_000;
    await expect(u.api.token(u.userId)).rejects.toThrow('fetch failed');
    expect(await u.links.get(u.userId)).toEqual(before);
    expect(u.reconnects).toEqual([]);
    down = false;
    expect((await u.api.token(u.userId)).token).not.toBe(before.accessToken);
  });

  it('uses tokens refreshed or connected meanwhile instead of asking to reconnect', async () => {
    const elsewhere = createOAuth({ fetch, clientId: mock.clientId, clientSecret: mock.clientSecret, oauthBase: mock.base, apiBase: mock.apiBase, redirectUri: 'x', now });
    let meanwhile: (() => Promise<void>) | null = null;
    const u = await connected({
      expiresIn: 60_000,
      fetch: async (input, init) => {
        const run = meanwhile;
        if (run && String(input).includes('/login/oauth/access_token')) {
          meanwhile = null;
          await run();
        }
        return fetch(input, init);
      },
    });

    // Refreshed elsewhere while GitHub answered: it refuses the old refresh token.
    let refreshed = '';
    meanwhile = async () => {
      const tokens = await elsewhere.refresh((await u.links.get(u.userId))!.refreshToken!);
      await u.links.saveTokens(db, u.userId, tokens);
      refreshed = tokens.accessToken;
    };
    const refreshes = mock.refreshes;
    expect((await u.api.token(u.userId)).token).toBe(refreshed);
    expect(mock.refreshes).toBe(refreshes + 2);
    expect(await u.links.get(u.userId)).toMatchObject({ accessToken: refreshed, needsReconnect: false });
    expect(u.reconnects).toEqual([]);

    // Connected again while GitHub answered: the new connection stays, and the token just refreshed is revoked.
    await db.query(`UPDATE github_links SET access_expires_at = now() + interval '1 minute' WHERE user_id = $1`, [u.userId]);
    let connected2 = '';
    meanwhile = async () => {
      const issued = mock.issue(u.ghId);
      await u.links.link(u.userId, { id: String(u.ghId), login: 'again' }, tokensOf(issued));
      connected2 = issued.access_token;
    };
    const revoked = mock.revoked.length;
    expect((await u.api.token(u.userId)).token).toBe(connected2);
    expect(await u.links.get(u.userId)).toMatchObject({ accessToken: connected2, needsReconnect: false });
    await until(() => mock.revoked.length > revoked);
    expect(mock.revoked.at(-1)).not.toBe(connected2);
    expect(mock.valid(connected2)).toBe(true);
    expect(u.reconnects).toEqual([]);
  });

  it("doesn't ask to reconnect when the token GitHub refused was replaced meanwhile", async () => {
    let sends = 0;
    let replacement = '';
    const u = await connected({
      fetch: async (input, init) => {
        if (!String(input).endsWith('/api/user')) return fetch(input, init);
        // The retry with a refreshed token is refused too: the person connected again meanwhile, which revoked it.
        if (++sends === 2) {
          const issued = mock.issue(u.ghId);
          await u.links.link(u.userId, { id: String(u.ghId), login: 'again' }, tokensOf(issued));
          replacement = issued.access_token;
        }
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      },
    });
    // An ordinary error: the next try uses the new token.
    const err = await u.api.call(u.userId, '/user').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NeedsReconnect);
    expect(err).toMatchObject({ message: 'GitHub refused a token that has been replaced since' });
    expect(sends).toBe(2);
    expect(u.reconnects).toEqual([]);
    expect(await u.links.get(u.userId)).toMatchObject({ accessToken: replacement, needsReconnect: false });
  });

  it('uses tokens that never expire as they are, and asks to reconnect after a 401', async () => {
    mock.accessTtl = null;
    const u = await connected();
    const link = (await u.links.get(u.userId))!;
    expect(link.refreshToken).toBeNull();
    expect(link.accessExpiresAt).toBeNull();
    expect((await u.api.token(u.userId)).token).toBe(u.issued.access_token);
    const refreshes = mock.refreshes;
    mock.forget(u.ghId);
    await expect(u.api.call(u.userId, '/user')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(mock.refreshes).toBe(refreshes);
    expect(u.reconnects).toEqual([u.userId]);
  });

  it("asks to reconnect when a stored token can't be decrypted", async () => {
    const u = await connected();
    // Another user's ciphertext, copied over.
    await db.query('UPDATE github_links SET access_token_enc = $2 WHERE user_id = $1', [u.userId, encryptToken(key, 'someone-else', 'access', 'gho_x')]);
    expect(await u.links.get(u.userId)).toMatchObject({ accessToken: null, needsReconnect: true });
    await expect(u.api.token(u.userId)).rejects.toBeInstanceOf(NeedsReconnect);
    // Or a different key.
    const v = await connected();
    expect(await new Links(db, crypto.randomBytes(32)).get(v.userId)).toMatchObject({ needsReconnect: true });
  });

  it('follows the scopes GitHub reports', async () => {
    const u = await connected({ scope: 'notifications,repo', storedScope: 'notifications' });
    const res = await u.api.call(u.userId, '/user');
    await res.body?.cancel();
    expect((await u.links.get(u.userId))!.scopes).toBe('notifications,repo');
    expect(u.scopeChanges).toEqual([u.userId]);
  });

  it('forgets connections people never finished', async () => {
    const u = await connected();
    const l = new Links(db, key);
    await l.startTx('fresh-hash', u.userId, 'verifier', '/', 10);
    await l.startTx('old-hash', u.userId, 'verifier', '/', 10);
    await db.query(`UPDATE github_oauth_tx SET expires_at = now() - interval '1 minute' WHERE state_hash = 'old-hash'`);
    await l.cleanupTx();
    expect((await db.query<{ state_hash: string }>('SELECT state_hash FROM github_oauth_tx WHERE user_id = $1', [u.userId])).rows).toEqual([{ state_hash: 'fresh-hash' }]);
    expect(await l.takeTx('fresh-hash')).toEqual({ userId: u.userId, codeVerifier: 'verifier', returnTo: '/', fresh: true });
    expect(await l.takeTx('fresh-hash')).toBeNull();
  });

  it('follows redirects only within the API', async () => {
    const elsewhere = await startMockGithub();
    try {
      const u = await connected();
      const thread = mock.addThread(u.ghId, { title: 'Moved' });
      // A renamed repository: followed, and a 307 asks for the same request again.
      mock.redirects.set('/api/repos/octo/old/pulls/5', { status: 301, location: `${mock.apiBase}/repos/octo/new/pulls/5` });
      mock.pages.set(`${mock.apiBase}/repos/octo/new/pulls/5`, `${mock.base}/octo/new/pull/5`);
      expect(await (await u.api.call(u.userId, '/repos/octo/old/pulls/5')).json()).toEqual({ html_url: `${mock.base}/octo/new/pull/5` });
      mock.redirects.set('/api/notifications/threads/1', { status: 307, location: `/api/notifications/threads/${thread.id}` });
      expect((await u.api.call(u.userId, '/notifications/threads/1', { method: 'PATCH' })).status).toBe(205);
      expect(mock.threadsOf(u.ghId).find((t) => t.id === thread.id)!.unread).toBe(false);
      // Anywhere else, or round in circles: the redirect is the answer.
      mock.redirects.set('/api/repos/octo/away/pulls/6', { status: 307, location: `${elsewhere.apiBase}/repos/octo/away/pulls/6` });
      expect((await u.api.call(u.userId, '/repos/octo/away/pulls/6', { method: 'PATCH', body: { x: 1 } })).status).toBe(307);
      mock.redirects.set('/api/repos/octo/loop/pulls/7', { status: 301, location: '/api/repos/octo/loop/pulls/7' });
      expect((await u.api.call(u.userId, '/repos/octo/loop/pulls/7')).status).toBe(301);
      expect(mock.calls('/api/repos/octo/loop/pulls/7')).toHaveLength(4);
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it('sends an action again as it was after a 301 or 302, as fetch does', async () => {
    const u = await connected();
    const a = mock.addThread(u.ghId, { title: 'A' });
    const b = mock.addThread(u.ghId, { title: 'B' });
    await u.start();
    u.take();
    mock.redirects.set('/api/notifications/threads/9001', { status: 301, location: `/api/notifications/threads/${a.id}` });
    mock.redirects.set('/api/notifications/threads/9002', { status: 302, location: `/api/notifications/threads/${b.id}` });
    expect(await u.poller.read(u.userId, '9001')).toBe(true);
    expect(await u.poller.done(u.userId, '9002')).toBe(true);
    expect(mock.calls(`/api/notifications/threads/${a.id}`, 'PATCH')).toHaveLength(1);
    expect(mock.calls(`/api/notifications/threads/${b.id}`, 'DELETE')).toHaveLength(1);
    expect(mock.threadsOf(u.ghId).map((t) => [t.id, t.unread])).toEqual([[a.id, false]]);

    // A PUT keeps its body; a 303, or a 301 or 302 after a POST, is followed with a GET.
    mock.redirects.set('/api/repos/octo/old/thing', { status: 301, location: '/api/repos/octo/new/thing' });
    await (await u.api.call(u.userId, '/repos/octo/old/thing', { method: 'PUT', body: { x: 1 } })).body?.cancel();
    expect(mock.calls('/api/repos/octo/new/thing', 'PUT').map((r) => r.body)).toEqual(['{"x":1}']);
    mock.pages.set(`${mock.apiBase}/repos/octo/new/pulls/8`, `${mock.base}/octo/new/pull/8`);
    for (const [status, method] of [[303, 'PATCH'], [301, 'POST'], [302, 'POST']] as const) {
      mock.redirects.set('/api/repos/octo/old/pulls/8', { status, location: '/api/repos/octo/new/pulls/8' });
      const res = await u.api.call(u.userId, '/repos/octo/old/pulls/8', { method, body: { x: 1 } });
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
    expect(mock.calls('/api/repos/octo/new/pulls/8', 'GET').map((r) => [r.body, r.headers['content-type']])).toEqual(Array(3).fill(['', undefined]));
    u.poller.stop(u.userId);
  });

  it('never follows a redirect with the client secret or a token', async () => {
    const elsewhere = await startMockGithub();
    try {
      const oauth = createOAuth({ fetch, clientId: mock.clientId, clientSecret: mock.clientSecret, oauthBase: mock.base, apiBase: mock.apiBase, redirectUri: 'x', now });
      for (const path of ['/login/oauth/access_token', `/api/applications/${mock.clientId}/token`, '/api/user']) {
        mock.redirects.set(path, { status: 307, location: `${elsewhere.base}${path}` });
      }
      await expect(oauth.exchange('code', 'verifier')).rejects.toThrow();
      await expect(oauth.refresh('ghr_refresh')).rejects.toThrow();
      await expect(oauth.revoke('gho_token')).rejects.toThrow();
      await expect(oauth.user('gho_token')).rejects.toThrow();
      expect(mock.calls('/login/oauth/access_token', 'POST')).not.toHaveLength(0);
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it('only ever sends tokens to the API', async () => {
    const u = await connected();
    const sent: string[] = [];
    const spy = tools(u.userId, u.links, async (input, init) => {
      sent.push(String(input));
      return fetch(input, init);
    });
    for (const url of ['https://evil.example/notifications', `${mock.apiBase}.evil.example/x`, `${mock.base}/notifications`, 'javascript:alert(1)']) {
      await expect(spy.api.call(u.userId, url)).rejects.toThrow();
    }
    expect(sent).toEqual([]);
  });
});
