import { useEffect } from 'react';
import { refreshAccount, welcomeIfNeeded } from './lib/account';
import { route } from './lib/router';
import { getState, useStore } from './state/store';
import { AuthPage } from './ui/AuthPage';
import { Landing } from './ui/Landing';
import { Lobby } from './ui/Lobby';
import { OfficeView } from './ui/OfficeView';
import { ProfilePage } from './ui/Profile';
import { Toasts } from './ui/Toasts';
import { Welcome } from './ui/Welcome';

function Page() {
  const phase = useStore((s) => s.phase);
  const officeId = useStore((s) => s.officeId);
  if (phase === 'office') return <OfficeView />;
  // Another office's lobby starts afresh.
  if (phase === 'lobby') return <Lobby key={officeId} />;
  if (phase === 'auth') return <AuthPage />;
  if (phase === 'profile') return <ProfilePage />;
  if (phase === 'welcome') return <Welcome />;
  return <Landing />;
}

export default function App() {
  const accountReady = useStore((s) => s.accountReady);
  const phase = useStore((s) => s.phase);

  useEffect(() => {
    route();
    window.addEventListener('popstate', route);
    // An emailed link pasted into this tab while on its page changes only the #t=….
    window.addEventListener('hashchange', route);
    return () => {
      window.removeEventListener('popstate', route);
      window.removeEventListener('hashchange', route);
    };
  }, []);

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
      <Page />
      <Toasts />
    </>
  );
}
