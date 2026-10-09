import { describe, expect, it, vi } from 'vitest';

// The client's router: which page an address shows (features' pages wait for the features, which load
// only when needed) and the browser tab's title for each page.

const fake = vi.hoisted(() => {
  const fake = { featuresLoaded: false };
  vi.stubGlobal('location', { pathname: '/', search: '', hash: '', origin: 'http://localhost' });
  return fake;
});
vi.mock('../client/src/lib/session', () => ({ closeOffice: () => {} }));
// The features: loading them adds billing's page, as the real ones do.
vi.mock('../client/src/features', async () => {
  const { registerPage } = await import('../client/src/ui/pages');
  registerPage({ path: '/billing/return', Component: () => null });
  fake.featuresLoaded = true;
  return {};
});

const { loadFeatures, pageTitle, route } = await import('../client/src/lib/router');
const { getState } = await import('../client/src/state/store');
const { pageFor } = await import('../client/src/ui/pages');

const at = (pathname: string) => {
  location.pathname = pathname;
  route();
  return getState();
};

describe('routing before the features load', () => {
  it('shows the home page without loading them', () => {
    expect(at('/').phase).toBe('landing');
    expect(fake.featuresLoaded).toBe(false);
  });

  it('waits for them at any other address, as it may be one of their pages, then shows it', async () => {
    const s = at('/billing/return');
    expect(s.phase).toBe('page');
    expect(s.page).toBe('/billing/return');
    expect(pageFor('/billing/return')).toBeUndefined();
    await loadFeatures();
    expect(fake.featuresLoaded).toBe(true);
    expect(getState().phase).toBe('page');
    expect(pageFor('/billing/return')).toBeDefined();
    // The store changed, so the app looks for the page again.
    expect(getState()).not.toBe(s);
  });

  it('shows the home page at an address that is nobody’s page, once they have loaded', () => {
    expect(at('/nowhere').phase).toBe('landing');
    expect(at('/signin')).toMatchObject({ phase: 'auth', authPage: 'signin' });
  });
});

describe('tab titles', () => {
  const base = { phase: 'landing', authPage: 'signin', linkToken: null, page: null, account: null } as const;
  const account = { id: 'u1' } as unknown as NonNullable<ReturnType<typeof getState>['account']>;

  it("keeps index.html's title on the home page for guests", () => {
    expect(pageTitle(base)).toBeNull();
    expect(pageTitle({ ...base, account })).toBe('Your workspaces · Homeoffice');
  });

  it('names the page', () => {
    expect(pageTitle({ ...base, phase: 'auth', authPage: 'signin' })).toBe('Sign in · Homeoffice');
    expect(pageTitle({ ...base, phase: 'auth', authPage: 'signup' })).toBe('Create account · Homeoffice');
    expect(pageTitle({ ...base, phase: 'auth', authPage: 'signup', linkToken: 'tok' })).toBe('Finish signing up · Homeoffice');
    expect(pageTitle({ ...base, phase: 'auth', authPage: 'invite' })).toBe('Join a workspace · Homeoffice');
    expect(pageTitle({ ...base, phase: 'profile' })).toBe('Profile · Homeoffice');
    expect(pageTitle({ ...base, phase: 'welcome' })).toBe('Welcome · Homeoffice');
    expect(pageTitle({ ...base, phase: 'page', page: '/privacy' })).toBe('Privacy Policy · Homeoffice');
    expect(pageTitle({ ...base, phase: 'page', page: '/terms' })).toBe('Terms of Service · Homeoffice');
    expect(pageTitle({ ...base, phase: 'page', page: '/billing/return' })).toBe('Payment · Homeoffice');
  });

  it('names a workspace, in its lobby and inside, once its name is known', () => {
    expect(pageTitle({ ...base, phase: 'lobby' })).toBe('Homeoffice');
    expect(pageTitle({ ...base, phase: 'lobby' }, 'Acme HQ')).toBe('Acme HQ · Homeoffice');
    expect(pageTitle({ ...base, phase: 'office', account }, 'Acme HQ')).toBe('Acme HQ · Homeoffice');
  });

  it('says when there is no such workspace', () => {
    expect(pageTitle({ ...base, phase: 'lobby' }, null)).toBe('Office not found · Homeoffice');
  });
});

describe('the legal pages', () => {
  it('are pages of their own, which can load ahead (before the first paint, or when the browser is idle)', async () => {
    await import('../client/src/ui/legal');
    expect(at('/privacy')).toMatchObject({ phase: 'page', page: '/privacy' });
    expect(pageFor('/privacy')?.Component.preload).toBeTypeOf('function');
    expect(pageFor('/terms')?.Component.preload).toBeTypeOf('function');
  });
});
