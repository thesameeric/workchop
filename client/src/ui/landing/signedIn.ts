import { fetchMe } from '../../lib/api';
import { useStore } from '../../state/store';

// Whether this browser was signed in last time. A fresh load of the home page then waits for the
// account (so the landing page doesn't flash before your workspaces); guests see the landing page at
// once.

const KEY = 'workchop:signed-in';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function keep(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Not kept: the next load shows the landing page until the account is known.
  }
}

/** As it was when the page loaded. */
export const wasSignedIn = read();

let kept: boolean | null = null;
useStore.subscribe((s) => {
  if (!s.accountReady) return;
  const signedIn = !!s.account;
  if (signedIn === kept) return;
  const first = kept === null;
  kept = signedIn;
  if (first && !signedIn && wasSignedIn) {
    // No account at startup, though there was one last time: signed out meanwhile, or the server
    // didn't answer (then it's unknown, not gone). Only the server saying "nobody" clears the hint.
    fetchMe()
      .then((user) => {
        if (!user && !useStore.getState().account) keep(false);
      })
      .catch(() => {});
    return;
  }
  keep(signedIn);
});
