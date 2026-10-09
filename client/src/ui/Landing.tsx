import { useStore } from '../state/store';
import { Home, HomeFrame } from './landing/Home';
import { Marketing } from './landing/Marketing';
import { wasSignedIn } from './landing/signedIn';

// The home page: for guests the landing page (ui/landing/), signed in your workspaces. A fresh load
// while signed in goes on to your default workspace (lib/router.ts).

export function Landing() {
  const ready = useStore((s) => s.accountReady);
  const account = useStore((s) => s.account);
  // Until we know who you are, signed in last time (or signing out): neither the landing page nor your
  // workspaces, as one would flash.
  if (!ready && (wasSignedIn || account)) {
    return (
      <HomeFrame>
        <div aria-busy="true" />
      </HomeFrame>
    );
  }
  if (account) {
    return (
      <HomeFrame>
        <Home key={account.id} account={account} />
      </HomeFrame>
    );
  }
  return <Marketing />;
}
