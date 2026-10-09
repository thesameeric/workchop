import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Asking the server how people can sign in, at startup and until it answers. A server restarting says
// 503 for a moment: the sign-in page mustn't lose GitHub and the email form until a reload.

vi.mock('../client/src/lib/session', () => ({ backToLobby: () => {}, closeOffice: () => {}, getSession: () => null }));
vi.mock('../client/src/lib/theme', () => ({ getTheme: () => 'system', isTheme: () => false, setTheme: () => {} }));

/** The page's visibility, which the test changes. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

let doc: FakeDocument;
let win: EventTarget;
/** What GET /api/auth/providers answers, in turn (then 200). */
let statuses: number[];
/** When it was asked (ms on the fake clock). */
let asked: number[];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  doc = new FakeDocument();
  win = new EventTarget();
  statuses = [];
  asked = [];
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { pathname: '/signin', search: '', hash: '', origin: 'http://localhost' });
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/api/me') return Response.json({ user: null });
    asked.push(Date.now());
    const status = statuses.shift() ?? 200;
    return status === 200 ? Response.json({ github: true, password: true, emailLinks: true }) : Response.json({ error: 'Starting up' }, { status });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function start() {
  const account = await import('../client/src/lib/account');
  const { getState } = await import('../client/src/state/store');
  await account.loadAccount();
  return { known: account.providersKnown, providers: () => getState().providers, ready: () => getState().accountReady };
}

describe('sign-in options', () => {
  it('come in on a later try when the first one fails', async () => {
    statuses = [503];
    const { known, providers, ready } = await start();
    // The page goes on meanwhile, knowing it doesn't know yet.
    expect(ready()).toBe(true);
    expect(known()).toBe(false);
    expect(providers().github).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked).toHaveLength(2);
    expect(known()).toBe(true);
    expect(providers()).toMatchObject({ github: true, password: true, emailLinks: true });

    // Known: no more asking, on a timer or coming back to the page.
    await vi.advanceTimersByTimeAsync(120_000);
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(2);
  });

  it('are asked for again after 1, 2, 4, 8 and 16 s, then every 30 s', async () => {
    statuses = Array<number>(8).fill(503);
    const { known } = await start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(known()).toBe(true);
    expect(asked.slice(1).map((t, i) => t - asked[i])).toEqual([1000, 2000, 4000, 8000, 16000, 30_000, 30_000, 30_000]);
  });

  it('wait while the page is hidden, and are asked for at once when it’s shown or focused', async () => {
    statuses = [503, 503];
    const { known, providers } = await start();
    doc.visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(1);

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(2);
    expect(known()).toBe(false);

    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(3);
    expect(known()).toBe(true);
    expect(providers().github).toBe(true);
  });

  it('are known at once when the server answers the first time', async () => {
    const { known, providers } = await start();
    expect(known()).toBe(true);
    expect(providers().password).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(1);
  });
});
