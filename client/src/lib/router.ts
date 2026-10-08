import { getState, setState, type AuthPage } from '../state/store';
import { leaveOffice } from './session';

const OFFICE_PATH = /^\/o\/([A-Za-z0-9_-]{1,40})\/?$/;
const AUTH_PAGES = new Map<string, AuthPage>([
  ['/signin', 'signin'],
  ['/signup', 'signup'],
  ['/forgot', 'forgot'],
  ['/reset', 'reset'],
  ['/confirm-email', 'confirm-email'],
]);

export function officeIdFromPath(path = location.pathname): string | null {
  return OFFICE_PATH.exec(path)?.[1] ?? null;
}

/**
 * The token of an emailed link (`#t=…`), taken out of the address so it doesn't stay in the history
 * or get shared with the address.
 */
function takeLinkToken(): string | null {
  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  if (token === null) return null;
  history.replaceState(history.state, '', location.pathname + location.search);
  return token;
}

/** Sync the app phase with the URL. */
export function route(): void {
  const path = location.pathname.replace(/(.)\/$/, '$1');
  const id = officeIdFromPath();
  const token = takeLinkToken();
  const { phase, officeId } = getState();
  if (phase === 'office' && id !== officeId) leaveOffice();
  const authPage = AUTH_PAGES.get(path);
  if (id) {
    if (getState().phase !== 'office' || id !== officeId) setState({ phase: 'lobby', officeId: id });
  } else if (authPage) {
    // Coming back to the same page (say, with Back) keeps its link.
    setState((s) => ({ phase: 'auth', officeId: null, authPage, linkToken: token ?? (s.phase === 'auth' && s.authPage === authPage ? s.linkToken : null) }));
  } else if (path === '/profile' || path === '/welcome') {
    setState({ phase: path === '/profile' ? 'profile' : 'welcome', officeId: null });
  } else {
    setState({ phase: 'landing', officeId: null });
  }
}

/** Goes to a page of the app (a path, with a query if any); `replace` leaves no history entry behind. */
export function navigate(path: string, { replace = false } = {}): void {
  const moved = location.pathname !== new URL(path, location.origin).pathname;
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
