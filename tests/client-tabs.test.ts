import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountUser } from '../shared/account';

// One browser, several tabs: signing in or out in one, the others follow (they ask the server who is
// signed in now). Inside an office that means coming back in as the account, or going back to the
// lobby when signed out, so staff never stay in as a customer. And this browser's id (JoinRequest.browser).

/** localStorage: the keys are the object's own properties, as a browser's are. */
class FakeStorage {
  getItem(key: string): string | null {
    return Object.hasOwn(this, key) ? (this as unknown as Record<string, string>)[key] : null;
  }
  setItem(key: string, value: string): void {
    (this as unknown as Record<string, string>)[key] = String(value);
  }
  removeItem(key: string): void {
    delete (this as unknown as Record<string, string>)[key];
  }
}

const fake = vi.hoisted(() => {
  vi.stubGlobal('location', { pathname: '/', search: '', hash: '', origin: 'http://localhost' });
  const fake = {
    /** Who GET /api/me says is signed in. */
    me: null as unknown,
    asked: 0,
    /** This tab's office session, if it's in one. */
    session: null as { parked: boolean; isParked: () => boolean; reconnect: ReturnType<typeof vi.fn> } | null,
    backToLobby: vi.fn(),
  };
  return fake;
});
vi.mock('../client/src/lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../client/src/lib/api')>()),
  fetchMe: async () => {
    fake.asked++;
    return fake.me;
  },
  devSignIn: async () => fake.me,
  signOutRequest: async () => {},
}));
vi.mock('../client/src/lib/session', () => ({ backToLobby: fake.backToLobby, closeOffice: () => {}, getSession: () => fake.session }));
vi.mock('../client/src/lib/theme', () => ({ getTheme: () => 'system', isTheme: () => false, setTheme: () => {} }));

const user = (id: string, name: string) => ({ id, name, email: `${id}@example.com`, profile: { avatar: { hat: id } } }) as unknown as AccountUser;
const ada = user('ada', 'Ada');
const bob = user('bob', 'Bob');

vi.stubGlobal('localStorage', new FakeStorage());
localStorage.setItem('workchop:profile', JSON.stringify({ name: 'Guest me', avatar: { hat: 'none' } }));

const { followAccount, signInWithDev, signOut } = await import('../client/src/lib/account');
const { getState, setState } = await import('../client/src/state/store');
const { browserId, forgetVisits } = await import('../client/src/lib/storage');

/** Another tab of this browser. */
const otherTab = new BroadcastChannel('workchop:account');
const heard: unknown[] = [];
otherTab.onmessage = (e) => heard.push(e.data);
afterAll(() => otherTab.close());

/** Another tab says who is signed in now; answers once this tab has dealt with it. */
async function said(account: string | null): Promise<void> {
  const asked = fake.asked;
  otherTab.postMessage({ account });
  await vi.waitFor(() => expect(fake.asked).toBe(asked + 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** This tab's office session. */
function inOffice(parked = false) {
  const session = { parked, isParked: () => session.parked, reconnect: vi.fn() };
  fake.session = session;
  setState({ phase: 'office', officeId: 'o1' });
  return session;
}

beforeEach(() => {
  fake.session = null;
  fake.backToLobby.mockReset();
  // Like the real one: the office closes, its lobby shows.
  fake.backToLobby.mockImplementation(() => setState({ phase: 'lobby' }));
  heard.length = 0;
  setState({ account: ada, accountReady: true, phase: 'landing', officeId: null, toasts: [], me: { name: 'Ada', avatar: { hat: 'ada' } as never, status: 'available' } });
  fake.me = ada;
});

describe('signing in or out in another tab', () => {
  it('in an office, signed out: back to the lobby as this browser’s own character', async () => {
    inOffice();
    fake.me = null;
    await said(null);
    expect(fake.backToLobby).toHaveBeenCalledOnce();
    expect(getState()).toMatchObject({ account: null, phase: 'lobby', me: { name: 'Guest me' } });
    expect(getState().toasts.map((t) => t.text)).toEqual(['You were signed out.']);
  });

  it('the server ended the session (say, from another device): the same, without blaming a tab', async () => {
    inOffice();
    fake.me = null;
    expect(await followAccount()).toBe(true);
    expect(fake.backToLobby).toHaveBeenCalledOnce();
    expect(getState()).toMatchObject({ account: null, phase: 'lobby', me: { name: 'Guest me' } });
    expect(getState().toasts.map((t) => t.text)).toEqual(['You were signed out.']);
    // The other tab's word, if it comes too, finds nothing changed.
    expect(await followAccount()).toBe(false);
    expect(getState().toasts).toHaveLength(1);
  });

  it('in an office, signed in (or as someone else): back in as the account, without taking over', async () => {
    const session = inOffice();
    setState({ account: null });
    fake.me = bob;
    await said('bob');
    expect(session.reconnect.mock.calls).toEqual([[]]);
    expect(getState()).toMatchObject({ account: { id: 'bob' }, me: { name: 'Bob' }, phase: 'office' });
    expect(getState().toasts.map((t) => t.text)).toEqual(['Signed in as Bob.']);
    expect(fake.backToLobby).not.toHaveBeenCalled();
  });

  it('stepped aside for another tab: signed in, stays aside; signed out, back to the lobby', async () => {
    const session = inOffice(true);
    fake.me = bob;
    await said('bob');
    expect(session.reconnect).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({ account: { id: 'bob' }, phase: 'office', toasts: [] });

    fake.me = null;
    await said(null);
    expect(fake.backToLobby).toHaveBeenCalledOnce();
    expect(getState()).toMatchObject({ account: null, phase: 'lobby' });
  });

  it('elsewhere, just takes in who is signed in', async () => {
    setState({ phase: 'lobby', officeId: 'o1' });
    fake.me = null;
    await said(null);
    expect(getState()).toMatchObject({ account: null, phase: 'lobby', me: { name: 'Guest me' }, toasts: [] });
    fake.me = bob;
    await said('bob');
    expect(getState()).toMatchObject({ account: { id: 'bob' }, phase: 'lobby', toasts: [] });
    expect(fake.backToLobby).not.toHaveBeenCalled();
  });

  it('does nothing when the server says nothing changed, or it’s already this account', async () => {
    const session = inOffice();
    await said('bob');
    expect(session.reconnect).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({ account: { id: 'ada' }, toasts: [] });

    const asked = fake.asked;
    otherTab.postMessage({ account: 'ada' });
    otherTab.postMessage({ account: 42 });
    setState({ accountReady: false });
    otherTab.postMessage({ account: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.asked).toBe(asked);
  });

  it('tells the other tabs when you sign in or out here', async () => {
    setState({ account: null });
    fake.me = bob;
    await signInWithDev('Bob', 'bob@example.com');
    await vi.waitFor(() => expect(heard).toEqual([{ account: 'bob' }]));
    await signOut();
    await vi.waitFor(() => expect(heard).toEqual([{ account: 'bob' }, { account: null }]));
  });
});

describe('this browser’s id', () => {
  it('is a 32-character secret, kept, and stays when signing out', () => {
    const id = browserId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(browserId()).toBe(id);
    expect(JSON.parse(localStorage.getItem('workchop:browser')!)).toBe(id);
    forgetVisits();
    expect(browserId()).toBe(id);
  });

  it('is this page’s own without storage', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const storage = await import('../client/src/lib/storage');
    const id = storage.browserId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(storage.browserId()).toBe(id);
  });
});
