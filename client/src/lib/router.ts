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
  } else if (pageFor(path)) {
    // A feature's own page (ui/pages.ts).
    setState({ phase: 'page', officeId: null, page: path });
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

/** Home, to stay: in this tab the home page no longer goes on to your default workspace. */
export function goHome(path = '/', { replace = false } = {}): void {
  chooseHome();
  navigate(path, { replace });
}
