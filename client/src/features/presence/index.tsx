import type { PresenceState } from '../../../../shared/presence';
import { onSession } from '../../lib/session';
import { useStore } from '../../state/store';
import { icon } from '../../ui/icons';
import { registerSettingsSection } from '../../ui/settings';
import { HelperSection, StatusSection } from './Settings';
import { sharingPrefs, usePresence } from './state';
import './presence.css';

// The current-app indicator: "In Figma" next to people's names, picked by hand or reported by the
// desktop helper (helper/workchop-presence.cjs). The server is server/features/presence.

registerSettingsSection({ id: 'presence', title: 'Privacy & status', icon: icon('user-status'), order: 30, Component: StatusSection });
registerSettingsSection({ id: 'desktop-helper', title: 'Desktop helper', icon: icon('laptop-programming'), order: 35, Component: HelperSection });

onSession('presence', (session) => {
  const onState = (self: PresenceState) => usePresence.setState({ self });
  session.socket.on('presence:state', onState);
  // Each (re)join tells the server your sharing settings. After reconnecting, your status is offered
  // back too, for a guest's new connection or a server that restarted.
  const offJoined = session.onJoined((rejoin) => {
    const manual = usePresence.getState().self?.manual;
    session.socket.emit('presence:set', { ...sharingPrefs(), ...(rejoin && manual ? { manual, restore: true } : {}) });
  });
  // Settings changed in another tab or on another device.
  let last = JSON.stringify(sharingPrefs());
  const offAccount = useStore.subscribe((s, prev) => {
    if (s.account === prev.account) return;
    const prefs = sharingPrefs();
    if (JSON.stringify(prefs) === last) return;
    last = JSON.stringify(prefs);
    if (session.selfId()) session.socket.emit('presence:set', prefs);
  });
  return () => {
    session.socket.off('presence:state', onState);
    offJoined();
    offAccount();
    usePresence.setState({ self: null });
  };
});
