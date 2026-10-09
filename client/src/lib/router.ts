import { getState, setState, type AuthPage } from '../state/store';
import { pageFor } from '../ui/pages';
import { closeOffice } from './session';
import { choseHome, chooseHome, setGuestToken } from './storage';

const OFFICE_PATH = /^\/o\/([A-Za-z0-9_-]{1,40})\/?$/;
const AUTH_PAGES = new Map<string, AuthPage>([
  ['/signin', 'signin'],
  ['/signup', 'signup'],
  ['/forgot', 'forgot'],
  ['/reset', 'reset'],
  ['/confirm-email', 'confirm-email'],
  ['/invite', 'invite'],
]);

export function officeIdFromPath(path = location.pathname): string | null {
  return OFFICE_PATH.exec(path)?.[1] ?? null;
}

/**
 * A token from the address's fragment (an emailed link's `#t=…`, a guest link's `#guest=…`), taken out
 * of the address so it doesn't stay in the history or get shared with the address.
 */
function takeToken(name: string): string | null {
  const token = new URLSearchParams(location.hash.slice(1)).get(name);
  if (token === null) return null;
  history.replaceState(history.state, '', location.pathname + location.search);
  return token;
}

let features: Promise<void> | undefined;
let featuresSettled = false;

/**
 * Loads the features (client/src/features), once: they add the office's panels, the lobbies and pages
 * of their own. Only what needs them waits for them, so guests on the home page never do.
 */
export function loadFeatures(): Promise<void> {
  features ??= import('../features')
    .then(() => {})
    .finally(() => {
      featuresSettled = true;
    });
  return features;
}

/** Once the features have loaded, a page that waited for them shows (or home, if it's none of theirs). */
function again(): void {
  const { phase, page } = getState();
  // Routed again either way: the page shows when the store changes, which registering it doesn't do.
  if (phase === 'page' && page) route();
}

/** Sync the app phase with the URL. */
export function route(): void {
  const path = location.pathname.replace(/(.)\/$/, '$1');
  const id = officeIdFromPath();
  const token = takeToken('t');
  const { phase, officeId } = getState();
  if (phase === 'office' && id !== officeId) closeOffice();
  const authPage = AUTH_PAGES.get(path);
  if (id) {
    // A guest link: kept for this office, and sent when looking it up and joining (the lobby asks
    // again when one is opened while it shows).
    const guest = takeToken('guest');
    if (guest) setGuestToken(id, guest);
    if (getState().phase !== 'office' || id !== officeId) setState({ phase: 'lobby', officeId: id, linkToken: guest });
  } else if (authPage) {
    // Coming back to the same page (say, with Back) keeps its link.
    setState((s) => ({ phase: 'auth', officeId: null, authPage, linkToken: token ?? (s.phase === 'auth' && s.authPage === authPage ? s.linkToken : null) }));
  } else if (path === '/profile' || path === '/welcome') {
    setState({ phase: path === '/profile' ? 'profile' : 'welcome', officeId: null });
  } else if (pageFor(path) || (path !== '/' && !featuresSettled)) {
    // A feature's own page (ui/pages.ts). Before the features have loaded any other address may be
    // one: nothing shows until they have.
    setState({ phase: 'page', officeId: null, page: path });
    if (!pageFor(path)) void loadFeatures().then(again, again);
  } else {
    setState({ phase: 'landing', officeId: null });
  }
}

// Your default workspace: a fresh load of the home page while signed in, or signing in there, goes
// on to the workspace you used last (the first of /api/me/spaces), unless you chose home in this tab.
let toDefault = location.pathname === '/';
let defaultId: string | null = null;

/** Signed in from the home page: on to your default workspace, as after a fresh load. */
export function wantDefault(): void {
  toDefault = true;
}

/** The home page may still go on to your default workspace (so it waits before showing). */
export function defaultPending(): boolean {
  return toDefault && !choseHome();
}

/** Goes on to `spaceId` (your default workspace) when the home page should; asked once. */
export function openDefault(spaceId: string | undefined): boolean {
  const go = defaultPending() && !!spaceId;
  toDefault = false;
  if (!go) return false;
  defaultId = spaceId;
  navigate(`/o/${spaceId}`, { replace: true });
  return true;
}

/**
 * The default workspace's first lookup answered: when it turned you away (403/404), back home, and no
 * more trying in this tab; answers whether it did. Later refusals there (say, once it's paused) show.
 */
export function defaultAnswered(officeId: string, refused: boolean): boolean {
  if (defaultId !== officeId) return false;
  defaultId = null;
  if (refused) goHome('/', { replace: true });
  return refused;
}

/** Goes to a page of the app (a path, with a query if any); `replace` leaves no history entry behind. */
export function navigate(path: string, { replace = false } = {}): void {
  const to = new URL(path, location.origin).pathname;
  const moved = location.pathname !== to;
  // Gone elsewhere: coming back home is no fresh load.
  if (to !== '/') toDefault = false;
  if (location.pathname + location.search !== path) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
  }
  route();
  // Another page starts at its top.
  if (moved) scrollTo(0, 0);
}

/** A path within the app from untrusted input (a ?next= parameter), or `fallback`. */
export function safePath(v: string | null, fallback = '/'): string {
  // Control characters too: the browser drops some (making "/\t/x" another site's "//x") and
  // history refuses others.
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && !/[\u0000-\u001f\u007f]/.test(v) ? v : fallback;
}

/** The ?next= of this page: where to go once done here. */
export function nextParam(fallback = '/'): string {
  return safePath(new URLSearchParams(location.search).get('next'), fallback);
}

/** A page with ?next= set to `next` (left out when it's the home page). */
export function withNext(path: string, next: string): string {
  return next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
}

export function officeUrl(id: string): string {
  return `${location.origin}/o/${id}`;
}

const SITE = 'Homeoffice';
const AUTH_TITLES: Record<AuthPage, string> = {
  signin: 'Sign in',
  signup: 'Create account',
  forgot: 'Forgot password',
  reset: 'Choose a password',
  'confirm-email': 'Confirm your email',
  invite: 'Join a workspace',
};
/** Features' pages (ui/pages.ts), by path. */
const PAGE_TITLES: Record<string, string> = { '/billing/return': 'Payment', '/privacy': 'Privacy Policy', '/terms': 'Terms of Service' };

type TitleState = Pick<ReturnType<typeof getState>, 'phase' | 'authPage' | 'linkToken' | 'page' | 'account'>;

/**
 * The browser tab's title: what's showing (a workspace by its name, once known; null when there's no
 * such workspace), then Homeoffice. Null for guests on the home page, which keeps its own from
 * index.html (as search results show it).
 */
export function pageTitle({ phase, authPage, linkToken, page, account }: TitleState, officeName?: string | null): string | null {
  if (phase === 'landing' && !account) return null;
  const what = {
    landing: 'Your workspaces',
    lobby: officeName === null ? 'Office not found' : officeName,
    office: officeName ?? undefined,
    // The emailed sign-up link's page.
    auth: authPage === 'signup' && linkToken ? 'Finish signing up' : AUTH_TITLES[authPage],
    profile: 'Profile',
    welcome: 'Welcome',
    page: page ? PAGE_TITLES[page] : undefined,
  }[phase];
  return what ? `${what} · ${SITE}` : SITE;
}

/** Home, to stay: in this tab the home page no longer goes on to your default workspace. */
export function goHome(path = '/', { replace = false } = {}): void {
  chooseHome();
  navigate(path, { replace });
}
