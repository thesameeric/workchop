import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubBucket, GithubInbox, GithubItem } from '../shared/github';
import { fetchStatus } from '../client/src/features/github/api';
import { markAllRead, markDone, markRead } from '../client/src/features/github/data';
import { failedRunText } from '../client/src/features/github/format';
import { failureWatch, needsYou, useGithub } from '../client/src/features/github/state';

// The GitHub panel's client logic: which failed runs toast, the badge count, and (with a little of a
// browser and stand-ins for the office connection and the app's store) the inbox and marking things.

const fake = vi.hoisted(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { open: () => null, screenX: 0, screenY: 0, outerWidth: 1200, outerHeight: 800 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  // Back from connecting without a window (?github=…).
  vi.stubGlobal('location', { href: 'http://localhost:5173/office/abc?github=busy', origin: 'http://localhost:5173', pathname: '/office/abc', search: '?github=busy', hash: '', assign: () => {} });
  vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
  const stored = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) });
  return {
    toast: vi.fn(),
    /** The data module's office-session hook, and the session it is in. */
    hooks: [] as ((session: unknown) => () => void)[],
    session: null as unknown,
    app: { accountReady: false, account: null, officeId: null },
  };
});
vi.mock('../client/src/lib/session', () => ({
  getSession: () => fake.session,
  leaveOffice: () => {},
  onSession: (_id: string, hook: (session: unknown) => () => void) => void fake.hooks.push(hook),
}));
vi.mock('../client/src/state/store', () => {
  const useStore = { getState: () => fake.app, subscribe: () => () => {} };
  return { useStore, getState: useStore.getState, setState: () => {}, toast: fake.toast };
});

/** What the data module said when it loaded. */
const startup = { toasts: fake.toast.mock.calls.map((c) => c[0] as string), replaced: vi.mocked(history.replaceState).mock.calls.map((c) => c[2]) };

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 12);

function run(id: string, updatedAt: number, status: 'failure' | 'success' = 'failure', unread = true): GithubItem {
  return {
    id,
    bucket: 'actions',
    reason: 'ci_activity',
    subjectType: 'CheckSuite',
    title: `CI workflow run ${status === 'failure' ? 'failed' : 'succeeded'} for main branch`,
    repo: 'octo/hello',
    url: 'https://github.com/octo/hello/actions',
    updatedAt,
    unread,
    run: { status, workflow: 'CI', branch: 'main' },
  };
}

describe('the failed-run toast (client)', () => {
  it('is for new failed runs, not for those already in the inbox', () => {
    const watch = failureWatch();
    watch.inbox([run('1', NOW - 60_000), run('2', NOW - DAY, 'success')]);
    expect(watch.isNew(run('3', NOW))).toBe(true);
    expect(watch.isNew(run('4', NOW + 1000, 'success'))).toBe(false);
    expect(watch.isNew(run('5', NOW + 2000, 'failure', false))).toBe(false);
  });

  it('is for every failure that arrives together, whatever their order', () => {
    const watch = failureWatch();
    watch.inbox([run('1', NOW - 60_000)]);
    expect(watch.isNew(run('2', NOW))).toBe(true);
    expect(watch.isNew(run('3', NOW - 20_000))).toBe(true);
  });

  it('is for a newer run on a thread it already had', () => {
    const watch = failureWatch();
    watch.inbox([run('1', NOW - 60_000)]);
    expect(watch.isNew(run('1', NOW - 60_000))).toBe(false);
    expect(watch.isNew(run('1', NOW))).toBe(true);
  });

  it('is not for an old thread coming back into the newest 100 (after a Done)', () => {
    const watch = failureWatch();
    watch.inbox([run('1', NOW - 60_000), run('2', NOW - DAY)]);
    expect(watch.isNew(run('old', NOW - 30 * DAY))).toBe(false);
    // Nor for one that arrived as new, left the window and came back.
    expect(watch.isNew(run('3', NOW))).toBe(true);
    expect(watch.isNew(run('3', NOW))).toBe(false);
  });

  it('starting from an empty inbox, takes every failure as new', () => {
    const watch = failureWatch();
    watch.inbox([]);
    expect(watch.isNew(run('1', NOW - DAY))).toBe(true);
  });

  it('names the workflow and branch, or the title without a workflow', () => {
    expect(failedRunText(run('1', NOW))).toBe('CI failed on main');
    const item = run('2', NOW);
    item.run = { status: 'failure' };
    expect(failedRunText(item)).toBe('CI workflow run failed for main branch');
    item.run = { status: 'failure', workflow: 'Deploy' };
    expect(failedRunText(item)).toBe('Deploy failed');
  });
});

function item(id: string, bucket: GithubBucket, patch: Partial<GithubItem> = {}): GithubItem {
  return {
    id,
    bucket,
    reason: bucket === 'reviews' ? 'review_requested' : bucket === 'mentions' ? 'mention' : 'comment',
    subjectType: 'PullRequest',
    title: `Thread ${id}`,
    repo: 'octo/hello',
    url: `https://github.com/octo/hello/pull/${id}`,
    updatedAt: NOW,
    unread: true,
    ...patch,
  };
}

const NO_COUNTS = { reviewRequests: null, assigned: null };
const flush = () => new Promise((r) => setTimeout(r, 0));
const items = () => useGithub.getState().items;

/** In an office: a stand-in for its connection, which answers GitHub actions with `reply`. */
function office() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const sent: unknown[][] = [];
  const socket = {
    connected: true,
    on: (event: string, fn: (...args: unknown[]) => void) => void handlers.set(event, fn),
    off: (event: string) => void handlers.delete(event),
    timeout: () => ({
      emitWithAck: (event: string, ...args: unknown[]) => {
        sent.push([event, ...args]);
        return o.reply();
      },
    }),
  };
  const session = { socket, onJoined: () => () => {} };
  fake.session = session;
  const leave = fake.hooks[0](session);
  const o = {
    socket,
    sent,
    reply: (): Promise<boolean> => Promise.resolve(true),
    emit: (event: string, ...args: unknown[]) => handlers.get(event)!(...args),
    inbox: (inbox: Partial<GithubInbox>) => o.emit('github:inbox', { items: [], counts: NO_COUNTS, ...inbox }),
    leave() {
      leave();
      fake.session = null;
    },
  };
  return o;
}

describe('the GitHub badge (client)', () => {
  it('counts unread mentions, review requests and failed runs', () => {
    expect(needsYou(item('1', 'mentions'))).toBe(true);
    expect(needsYou(item('2', 'reviews'))).toBe(true);
    expect(needsYou(run('3', NOW))).toBe(true);
    expect(needsYou(item('4', 'mentions', { unread: false }))).toBe(false);
    expect(needsYou(run('5', NOW, 'failure', false))).toBe(false);
    expect(needsYou(run('6', NOW, 'success'))).toBe(false);
    expect(needsYou(item('7', 'activity'))).toBe(false);
  });
});

describe('the GitHub inbox (client)', () => {
  let o: ReturnType<typeof office>;
  beforeEach(() => {
    o = office();
    fake.toast.mockClear();
  });
  afterEach(() => {
    o.leave();
    vi.restoreAllMocks();
  });

  it('keeps what the server sends, and toasts failed runs that arrive', () => {
    o.inbox({ items: [item('1', 'mentions'), item('2', 'reviews')], counts: { reviewRequests: 3, assigned: 1 }, more: true });
    expect(useGithub.getState()).toMatchObject({ loaded: true, problem: null, more: true, counts: { reviewRequests: 3, assigned: 1 } });
    expect(Object.keys(items()).sort()).toEqual(['1', '2']);
    o.emit('github:item', item('1', 'mentions', { title: 'Changed' }));
    expect(items()['1'].title).toBe('Changed');
    expect(fake.toast).not.toHaveBeenCalled();
    o.emit('github:item', run('3', NOW + 1000));
    expect(fake.toast).toHaveBeenCalledWith('CI failed on main', expect.objectContaining({ kind: 'error', action: expect.objectContaining({ label: 'Open' }) }));
    o.emit('github:remove', '2');
    expect(Object.keys(items()).sort()).toEqual(['1', '3']);
    // GitHub can't be read (before any list): no items, and why.
    o.inbox({ problem: 'rate-limited' });
    expect(useGithub.getState()).toMatchObject({ items: {}, loaded: false, problem: 'rate-limited', more: false });
    // Leaving the office forgets the inbox.
    o.inbox({ items: [item('1', 'mentions')] });
    o.leave();
    expect(useGithub.getState()).toMatchObject({ items: {}, loaded: false, more: false });
    o = office();
  });

  it('marks read and done at once, putting them back when GitHub refuses', async () => {
    o.inbox({ items: [item('1', 'mentions'), item('2', 'reviews'), item('3', 'activity')] });
    markRead('1');
    expect(items()['1'].unread).toBe(false);
    markDone('3');
    expect(items()['3']).toBeUndefined();
    await flush();
    expect(o.sent).toEqual([
      ['github:read', '1'],
      ['github:done', '3'],
    ]);
    expect(items()['1'].unread).toBe(false);
    expect(fake.toast).not.toHaveBeenCalled();

    o.reply = () => Promise.resolve(false);
    markRead('2');
    expect(items()['2'].unread).toBe(false);
    await flush();
    expect(items()['2'].unread).toBe(true);
    expect(fake.toast).toHaveBeenLastCalledWith('Couldn’t mark it read on GitHub', 'error');
    o.reply = () => Promise.reject(new Error('operation has timed out'));
    markDone('2');
    expect(items()['2']).toBeUndefined();
    await flush();
    expect(items()['2']).toEqual(item('2', 'reviews'));
    expect(fake.toast).toHaveBeenLastCalledWith('Couldn’t mark it done on GitHub', 'error');
  });

  it("doesn't undo over what changed meanwhile", async () => {
    o.inbox({ items: [item('1', 'mentions'), item('2', 'reviews')] });
    let refuse!: () => void;
    o.reply = () => new Promise((resolve) => (refuse = () => resolve(false)));
    markRead('1');
    // New activity, read on GitHub already: what the server says counts.
    o.emit('github:item', item('1', 'mentions', { updatedAt: NOW + 1000, unread: false }));
    refuse();
    await flush();
    expect(items()['1']).toMatchObject({ updatedAt: NOW + 1000, unread: false });
    markDone('2');
    o.emit('github:item', item('2', 'reviews', { updatedAt: NOW + 1000 }));
    refuse();
    await flush();
    expect(items()['2'].updatedAt).toBe(NOW + 1000);
  });

  it('marks all read, putting back what GitHub refused unless it changed', async () => {
    o.inbox({ items: [item('1', 'mentions'), item('2', 'reviews'), item('3', 'activity', { unread: false })] });
    let refuse!: () => void;
    o.reply = () => new Promise((resolve) => (refuse = () => resolve(false)));
    markAllRead();
    expect(Object.values(items()).map((i) => i.unread)).toEqual([false, false, false]);
    expect(o.sent).toEqual([['github:readAll']]);
    o.emit('github:item', item('2', 'reviews', { updatedAt: NOW + 1000, unread: false }));
    refuse();
    await flush();
    expect(Object.values(items()).map((i) => [i.id, i.unread])).toEqual([
      ['1', true],
      ['2', false],
      ['3', false],
    ]);
  });

  it('puts things back at once without a connection', async () => {
    o.inbox({ items: [item('1', 'mentions')] });
    o.socket.connected = false;
    markRead('1');
    await flush();
    expect(items()['1'].unread).toBe(true);
    expect(o.sent).toEqual([]);
  });
});

describe('connecting GitHub (client)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says how it went, and tidies up the address', async () => {
    expect(startup.toasts).toEqual(['Too many tries to connect GitHub. Try again in a few minutes.']);
    expect(startup.replaced).toEqual(['/office/abc']);
    // From the connect window, which asks for the status again.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ available: true, guest: true }));
    fake.toast.mockClear();
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', data: { type: 'workchop-github', result: 'connected' } }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'http://localhost:5173', data: { type: 'workchop-github', result: 'cancelled' } }));
    expect(fake.toast.mock.calls.map((c) => c[0])).toEqual(['GitHub connection cancelled']);
    await vi.waitFor(() => expect(useGithub.getState().availability).toBe('guest'));
  });

  it('reads the status, as the server says it or from older answers', async () => {
    const answers = [
      Response.json({ available: false }),
      Response.json({ available: true, guest: true }),
      Response.json({ available: true, connected: true, login: 'octo', private: true, needsReconnect: false, clientId: 'abc' }),
      Response.json({ error: 'Not found' }, { status: 404 }),
      Response.json({ error: 'Sign in first' }, { status: 401 }),
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answers.shift()!);
    expect(await fetchStatus()).toBe('off');
    expect(await fetchStatus()).toBe('guest');
    expect(await fetchStatus()).toEqual({ connected: true, login: 'octo', avatarUrl: undefined, private: true, needsReconnect: false, clientId: 'abc' });
    expect(await fetchStatus()).toBe('off');
    expect(await fetchStatus()).toBe('guest');
  });
});
