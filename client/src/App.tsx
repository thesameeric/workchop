import { useEffect } from 'react';
import { refreshAccount } from './lib/account';
import { route } from './lib/router';
import { getState, useStore } from './state/store';
import { Landing } from './ui/Landing';
import { Lobby } from './ui/Lobby';
import { OfficeView } from './ui/OfficeView';
import { Toasts } from './ui/Toasts';

export default function App() {
  const phase = useStore((s) => s.phase);

  useEffect(() => {
    route();
    window.addEventListener('popstate', route);
    return () => window.removeEventListener('popstate', route);
  }, []);

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
      {phase === 'office' ? <OfficeView /> : phase === 'lobby' ? <Lobby /> : <Landing />}
      <Toasts />
    </>
  );
}
