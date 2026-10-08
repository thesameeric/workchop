import { onSession } from '../../lib/session';
import { getState, toast } from '../../state/store';
import { TapIcon } from '../../ui/icons';
import { screenConfetti } from './confetti';
import { playKnock, resetFocus, setFocus } from './focus';

// Headphones (focus mode) per office visit: shoulder taps, keeping them on across reconnects, and
// taking them off when you leave. The dock button, banner and badges are in Headphones.tsx, the
// reaction particles in Reactions.tsx.
onSession('audio', (session) => {
  const onTapped = (_from: string, name: string) => {
    playKnock();
    toast(`${name} tapped you on the shoulder`, {
      icon: TapIcon,
      action: getState().focus ? { label: 'Take headphones off', run: () => setFocus(false) } : undefined,
      duration: 8000,
    });
  };
  // Popping confetti also showers your own screen a little.
  const onEmote = (id: string, emoji: string) => {
    if (emoji === '🎉' && id === session.selfId()) screenConfetti();
  };
  session.socket.on('focus:tapped', onTapped);
  session.socket.on('emote', onEmote);
  // After a reconnect the server has a fresh player for us: tell it the headphones are still on.
  const offJoined = session.onJoined((rejoin) => {
    if (rejoin && getState().focus) session.socket.emit('profile', { focus: true });
  });
  return () => {
    session.socket.off('focus:tapped', onTapped);
    session.socket.off('emote', onEmote);
    offJoined();
    resetFocus();
  };
});
