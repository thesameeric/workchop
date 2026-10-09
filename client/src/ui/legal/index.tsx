// The legal pages, /privacy and /terms. main.tsx imports this module, so they're registered before the
// first route(). Their text loads when one is opened, or ahead: before the first paint when the page
// opens at one (App.tsx's pageLoaded), and once the browser is idle.
import { lazyPage } from '../lazyPage';
import { registerPage } from '../pages';

export const PRIVACY_PATH = '/privacy';
export const TERMS_PATH = '/terms';

/** Who "we" are in the pages and the footer's copyright. TODO: the company's registered name. */
export const LEGAL_ENTITY = 'Homeoffice';

/**
 * Whether the app links to the pages (the footer's Legal group, the sign-up pages' consent line and
 * the customer lobby's Privacy link). Off until LEGAL_ENTITY is the company's registered name and the
 * contact address (CONTACT in LegalPage.tsx) receives mail. Until then the pages are reachable only at
 * their address, and ask search engines not to list them.
 */
export const LEGAL_LINKED: boolean = false;

registerPage({ path: PRIVACY_PATH, Component: lazyPage(() => import('./Privacy').then((m) => m.default)) });
registerPage({ path: TERMS_PATH, Component: lazyPage(() => import('./Terms').then((m) => m.default)) });
