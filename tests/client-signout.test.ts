import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountUser } from '../shared/account';

// Signing out on the client: off the home page (and elsewhere outside a workspace) at once, so it
// doesn't show your workspaces meanwhile; a workspace's lobby waits for the server. Either way this
// browser forgets the workspaces you were in.

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
  return {
    signOut: { resolve: () => {}, reject: (_err: Error) => {} },
    me: null as unknown,
  };
});
vi.mock('../client/src/lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../client/src/lib/api')>()),
  signOutRequest: () =>
    new Promise<void>((resolve, reject) => {
      fake.signOut = { resolve, reject };
    }),
  fetchMe: async () => fake.me,
}));
vi.mock('../client/src/lib/session', () => ({ backToLobby: () => {}, closeOffice: () => {}, getSession: () => null }));
vi.mock('../client/src/lib/theme', () => ({ getTheme: () => 'system', isTheme: () => false, setTheme: () => {} }));

const user = { id: 'u1', name: 'Ada', email: 'ada@example.com', profile: {} } as unknown as AccountUser;

const { signOut } = await import('../client/src/lib/account');
const { getState, setState } = await import('../client/src/state/store');

const KEPT = ['workchop:theme', 'workchop:profile', 'workchop:guest-links'];
const VISITS = ['workchop:recent', 'workchop:entered', 'workchop:chat:abc'];

beforeEach(() => {
  const storage = new FakeStorage();
  for (const key of [...KEPT, ...VISITS]) storage.setItem(key, '"x"');
  vi.stubGlobal('localStorage', storage);
  setState({ account: user, accountReady: true, phase: 'landing', officeId: null, toasts: [] });
  fake.me = user;
});

const left = () => Object.keys(localStorage).sort();

describe('signing out', () => {
  it('shows the home page signed out at once, and forgets the workspaces you were in', async () => {
    const done = signOut();
    expect(getState()).toMatchObject({ account: null, accountReady: true });
    expect(left()).toEqual([...KEPT].sort());
    fake.signOut.resolve();
    await done;
    expect(getState()).toMatchObject({ account: null, accountReady: true });
    expect(getState().toasts).toEqual([]);
  });

  it('signs you back in when the server says no', async () => {
    const done = signOut();
    expect(getState().account).toBeNull();
    fake.signOut.reject(new Error('Offline'));
    await done;
    await vi.waitFor(() => expect(getState().account?.id).toBe('u1'));
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Couldn’t sign out: Offline' });
  });

  it('in a lobby, waits for the server before showing you as a guest', async () => {
    setState({ phase: 'lobby', officeId: 'abc' });
    const done = signOut();
    expect(getState()).toMatchObject({ account: { id: 'u1' }, accountReady: false });
    fake.signOut.resolve();
    await done;
    expect(getState()).toMatchObject({ account: null, accountReady: true });
    expect(left()).toEqual([...KEPT].sort());
  });
});
