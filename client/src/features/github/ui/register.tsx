// GitHub's place in the interface: its panel (with the dock badge) and Settings > Integrations, both
// only on servers that have GitHub. Importing data.ts (through these) starts the rest.
import { canSignIn, useStore } from '../../../state/store';
import { GithubIcon, PlugIcon } from '../../../ui/icons';
import { registerPanel } from '../../../ui/panels';
import { registerSettingsSection } from '../../../ui/settings';
import { useGithub } from '../state';
import { GithubPanel, useGithubBadge } from './GithubPanel';
import { GithubSettings } from './GithubSettings';
import './github.css';

let unregister: (() => void) | null = null;

/** Shown when this server has GitHub; for guests only if they can sign in here to use it. */
function visible(): boolean {
  const { availability } = useGithub.getState();
  return availability === 'on' || (availability === 'guest' && canSignIn());
}

function update(): void {
  const show = visible();
  if (show && !unregister) {
    const offPanel = registerPanel({ id: 'github', title: 'GitHub', icon: GithubIcon, Component: GithubPanel, order: 45, inMore: true, useBadge: useGithubBadge, badgeTone: 'alert' });
    const offSettings = registerSettingsSection({ id: 'integrations', title: 'Integrations', icon: PlugIcon, order: 45, Component: GithubSettings });
    unregister = () => {
      offPanel();
      offSettings();
    };
  } else if (!show && unregister) {
    unregister();
    unregister = null;
  }
}

useGithub.subscribe((s, prev) => {
  if (s.availability !== prev.availability) update();
});
useStore.subscribe((s, prev) => {
  if (s.providers !== prev.providers) update();
});
update();
