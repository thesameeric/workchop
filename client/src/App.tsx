import { Suspense, useEffect, useState } from 'react';
import { refreshAccount, welcomeIfNeeded } from './lib/account';
import { fetchOfficeInfo } from './lib/api';
import { loadFeatures, pageTitle, route } from './lib/router';
import { getGuestToken } from './lib/storage';
import { getState, useStore } from './state/store';
import { Landing } from './ui/Landing';
import { lazyPage } from './ui/lazyPage';
import { LoadBoundary } from './ui/LoadBoundary';
import { allPages, pageFor } from './ui/pages';
import { Toasts } from './ui/Toasts';

// A workspace's lobby and its office load together, as one leads to the other, and with the features
// (their panels, and support's lobby for customers).
const Workspace = lazyPage(async () => {
  const [{ OfficeView }, { Lobby }, { Elsewhere }] = await Promise.all([import('./ui/OfficeView'), import('./ui/Lobby'), import('./ui/Elsewhere'), loadFeatures()]);
  return function Workspace() {
    const inside = useStore((s) => s.phase === 'office');
    const elsewhere = useStore((s) => s.elsewhere);
    const officeId = useStore((s) => s.officeId);
    // Another workspace's lobby starts afresh.
    return elsewhere ? <Elsewhere /> : inside ? <OfficeView /> : <Lobby key={officeId} />;
  };
});
const AuthPage = lazyPage(() => import('./ui/AuthPage').then((m) => m.AuthPage));
const ProfilePage = lazyPage(() => import('./ui/Profile').then((m) => m.ProfilePage));
const Welcome = lazyPage(() => import('./ui/Welcome').then((m) => m.Welcome));

const PAGES = { office: Workspace, lobby: Workspace, auth: AuthPage, profile: ProfilePage, welcome: Welcome };

/** The page for this address, loaded (main.tsx waits for it, so the first paint isn't blank). */
export function pageLoaded(): Promise<unknown> {
  const { phase, page } = getState();
  if (phase === 'landing') return Promise.resolve();
  if (phase === 'page') {
    const found = page ? pageFor(page) : undefined;
    // A feature's page may still be on its way with the features (lib/router.ts).
    if (!found) return page ? loadFeatures() : Promise.resolve();
    return found.Component.preload?.() ?? Promise.resolve();
  }
  return PAGES[phase].preload();
}

/** Runs `run` once the browser is idle; answers how to cancel. */
function whenIdle(run: () => void): () => void {
  if ('requestIdleCallback' in window) {
    const id = requestIdleCallback(run, { timeout: 5000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 2000);
  return () => clearTimeout(id);
}

function Page() {
  const phase = useStore((s) => s.phase);
  const page = useStore((s) => (s.phase === 'page' && s.page ? pageFor(s.page) : undefined));
  if (phase === 'landing') return <Landing />;
  // Nothing while a feature's page may still be on its way.
  if (phase === 'page') return page ? <page.Component key={page.path} /> : null;
  const Lazy = PAGES[phase];
  return <Lazy />;
}

/** The home page's title, from index.html. */
const HOME_TITLE = document.title;

/**
 * The workspace's name while in its lobby, for the tab, or null when there's no such workspace (asked
 * separately: the lobby keeps its answer).
 */
function useLobbyName(): string | null | undefined {
  const officeId = useStore((s) => s.officeId);
  const inLobby = useStore((s) => s.phase === 'lobby');
  const [known, setKnown] = useState<{ id: string; name: string | null }>();
  useEffect(() => {
    if (!inLobby || !officeId) return;
    let alive = true;
    fetchOfficeInfo(officeId, getGuestToken(officeId)).then(
      (info) => alive && setKnown(info === null ? { id: officeId, name: null } : 'denied' in info ? undefined : { id: officeId, name: info.name }),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [inLobby, officeId]);
  return known?.id === officeId ? known.name : undefined;
}

/** The tab's title follows the page (lib/router.ts). */
function useTitle(): void {
  const lobbyName = useLobbyName();
  const title = useStore((s) => pageTitle(s, s.office?.settings.name || lobbyName));
  useEffect(() => {
    document.title = title ?? HOME_TITLE;
  }, [title]);
}

export default function App() {
  const accountReady = useStore((s) => s.accountReady);
  const phase = useStore((s) => s.phase);
  // Each page by its address: when one didn't load, the next is tried afresh.
  const view = useStore((s) => `${s.phase}:${s.phase === 'page' ? s.page : s.phase === 'auth' ? s.authPage : (s.officeId ?? '')}`);
  const signedIn = useStore((s) => !!s.account);
  useTitle();

  // main.tsx routes once before the first paint; from then on the address changes here.
  useEffect(() => {
    window.addEventListener('popstate', route);
    // An emailed link pasted into this tab while on its page changes only the #t=….
    window.addEventListener('hashchange', route);
    return () => {
      window.removeEventListener('popstate', route);
      window.removeEventListener('hashchange', route);
    };
  }, []);

  // What's likely next loads while the browser is idle: from the home page, signing in; signed in,
  // your workspaces; and pages that load their own part, like the legal ones.
  useEffect(() => {
    const next = [...(signedIn ? [Workspace, ProfilePage] : [AuthPage, Welcome]), ...allPages().map((p) => p.Component)];
    return whenIdle(() => next.forEach((page) => page.preload?.().catch(() => {})));
  }, [signedIn]);

  // Coming back signed in for the first time (from Google, Apple or GitHub), or leaving the office
  // you signed in from: the welcome first.
  useEffect(() => {
    if (accountReady) welcomeIfNeeded();
  }, [accountReady, phase]);

  // Back on the page, you may have signed in or out, or changed your character, elsewhere. (In an
  // office the server tells us right away.)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && getState().accountReady && getState().phase !== 'office') void refreshAccount();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return (
    <>
      <LoadBoundary key={view} what="This page">
        <Suspense fallback={<div aria-busy="true" />}>
          <Page />
        </Suspense>
      </LoadBoundary>
      <Toasts />
    </>
  );
}
