import { useEffect } from 'react';
import { route } from './lib/router';
import { useStore } from './state/store';
import { Landing } from './ui/Landing';
import { Lobby } from './ui/Lobby';
import { OfficeView } from './ui/OfficeView';

export default function App() {
  const phase = useStore((s) => s.phase);

  useEffect(() => {
    route();
    window.addEventListener('popstate', route);
    return () => window.removeEventListener('popstate', route);
  }, []);

  if (phase === 'office') return <OfficeView />;
  if (phase === 'lobby') return <Lobby />;
  return <Landing />;
}
