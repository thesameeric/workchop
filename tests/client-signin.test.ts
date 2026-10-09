import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SignInProviders } from '../shared/account';

// Which sign-in methods the client offers, and what depends on there being one: the sign-in buttons,
// and the parts that need an account (GitHub, the desktop helper). With a stand-in for the app's store
// (React renders the real one's initial state on the server) and for the registries.

const fake = vi.hoisted(() => {
  vi.stubGlobal('location', { pathname: '/o/abc', search: '?x=1' });
  const fake = {
    state: {
      account: null as { id: string } | null,
      providers: { google: false, apple: false, github: false, dev: false, password: false, emailLinks: false } as SignInProviders,
    },
    listeners: new Set<(state: unknown, prev: unknown) => void>(),
    /** This server's sign-in methods, telling the store's subscribers. */
    setProviders(providers: Partial<SignInProviders>) {
      const prev = fake.state;
      fake.state = { ...prev, providers: { google: false, apple: false, github: false, dev: false, password: false, emailLinks: false, ...providers } };
      for (const listener of fake.listeners) listener(fake.state, prev);
    },
    /** Signs in or out, telling the store's subscribers. */
    setAccount(account: { id: string } | null) {
      const prev = fake.state;
      fake.state = { ...prev, account };
      for (const listener of fake.listeners) listener(fake.state, prev);
    },
    /** Whether the server has said how people can sign in yet. */
    known: true,
    /** What's in the dock and in Settings. */
    panels: new Set<string>(),
    sections: new Set<string>(),
  };
  return fake;
});
vi.mock('../client/src/state/store', async (importActual) => {
  const actual = await importActual<typeof import('../client/src/state/store')>();
  const useStore = Object.assign(<T>(selector: (s: typeof fake.state) => T) => selector(fake.state), {
    getState: () => fake.state,
    subscribe: (listener: (state: unknown, prev: unknown) => void) => {
      fake.listeners.add(listener);
      return () => void fake.listeners.delete(listener);
    },
  });
  return { ...actual, useStore, getState: useStore.getState, canSignIn: (s: Pick<typeof fake.state, 'providers'> = fake.state) => actual.canSignIn(s) };
});
vi.mock('../client/src/lib/session', () => ({ getSession: () => null, leaveOffice: () => {}, onSession: () => {} }));
vi.mock('../client/src/lib/account', async (importActual) => ({
  ...(await importActual<typeof import('../client/src/lib/account')>()),
  providersKnown: () => fake.known,
  useProvidersKnown: () => fake.known,
}));
vi.mock('../client/src/lib/theme', () => ({ getTheme: () => 'system', isTheme: () => false, setTheme: () => {} }));
vi.mock('../client/src/ui/panels', () => ({
  registerPanel: ({ id }: { id: string }) => {
    fake.panels.add(id);
    return () => void fake.panels.delete(id);
  },
}));
vi.mock('../client/src/ui/settings', () => ({
  registerSettingsSection: ({ id }: { id: string }) => {
    fake.sections.add(id);
    return () => void fake.sections.delete(id);
  },
}));
vi.mock('../client/src/features/github/ui/GithubPanel', () => ({ GithubPanel: () => null, useGithubBadge: () => 0 }));
vi.mock('../client/src/features/github/ui/GithubSettings', () => ({ GithubSettings: () => null }));
vi.mock('../client/src/features/presence/Settings', () => ({ HelperSection: () => null, StatusSection: () => null }));

const { canSignIn } = await vi.importActual<typeof import('../client/src/state/store')>('../client/src/state/store');
const { fetchProviders } = await import('../client/src/lib/api');
const { SignInButton, SignInOptions } = await import('../client/src/ui/Account');
const { useGithub } = await import('../client/src/features/github/state');

const none: SignInProviders = { google: false, apple: false, github: false, dev: false, password: false, emailLinks: false };
const render = (component: () => unknown) => renderToStaticMarkup(createElement(component as () => null));

describe('sign-in methods (client)', () => {
  it('counts GitHub as a way to sign in', () => {
    expect(canSignIn({ providers: none })).toBe(false);
    expect(canSignIn({ providers: { ...none, github: true } })).toBe(true);
    expect(canSignIn({ providers: { ...none, dev: true } })).toBe(true);
  });

  it("reads the server's methods, GitHub included, as booleans", async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ google: 'yes', github: true }));
    expect(await fetchProviders()).toEqual({ ...none, github: true });
    expect(fetch).toHaveBeenCalledWith('/api/auth/providers', expect.anything());
    fetch.mockRestore();
  });

  it('offers "Continue with GitHub", back to this page, when GitHub is the only method', () => {
    fake.setProviders({});
    expect(render(SignInButton)).toBe('');
    fake.setProviders({ github: true });
    expect(render(SignInButton)).toContain('Sign in');
    const options = render(SignInOptions);
    expect(options).toContain('href="/api/auth/github/start?return=%2Fo%2Fabc%3Fx%3D1"');
    expect(options).toContain('Continue with GitHub');
    expect(options).not.toContain('Google');
    expect(options).not.toContain('Apple');
  });

  it('says it is loading, rather than offering nothing, until the server has said', () => {
    fake.known = false;
    fake.setProviders({});
    const options = render(SignInOptions);
    expect(options).toContain('Loading sign-in options');
    expect(options).not.toContain('github');
    fake.known = true;
  });
});

describe('what needs an account (client)', () => {
  beforeAll(async () => {
    fake.setProviders({});
    await import('../client/src/features/github/ui/register');
    await import('../client/src/features/presence/index');
  });

  it('shows GitHub to guests only where they can sign in, GitHub sign-in included', () => {
    useGithub.setState({ availability: 'guest' });
    expect(fake.panels.has('github')).toBe(false);
    expect(fake.sections.has('integrations')).toBe(false);
    fake.setProviders({ github: true });
    expect(fake.panels.has('github')).toBe(true);
    expect(fake.sections.has('integrations')).toBe(true);
    fake.setProviders({});
    expect(fake.panels.has('github')).toBe(false);
    expect(fake.sections.has('integrations')).toBe(false);
  });

  it('has the desktop helper only where people can sign in', () => {
    fake.setProviders({});
    expect(fake.sections.has('presence')).toBe(true);
    expect(fake.sections.has('desktop-helper')).toBe(false);
    fake.setProviders({ github: true });
    expect(fake.sections.has('desktop-helper')).toBe(true);
    fake.setProviders({});
    expect(fake.sections.has('desktop-helper')).toBe(false);
  });

  it('keeps the desktop helper for someone signed in when the sign-in methods are unknown', () => {
    fake.setProviders({});
    fake.setAccount({ id: 'u1' });
    expect(fake.sections.has('desktop-helper')).toBe(true);
    fake.setAccount(null);
    expect(fake.sections.has('desktop-helper')).toBe(false);
  });
});
