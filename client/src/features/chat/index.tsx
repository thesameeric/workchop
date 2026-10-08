import { onSession } from '../../lib/session';
import { ChatIcon } from '../../ui/icons';
import { registerPanel } from '../../ui/panels';
import { ChatPanel } from './ChatPanel';
import { clearDrafts } from './Composer';
import {
  isSaved,
  loadChannels,
  loadConv,
  loadThread,
  onChannel,
  onMention,
  onMessage,
  onSeen,
  onUpdated,
  openLinkedMessage,
  resetChat,
  useBadge,
  useChat,
  watchApp,
} from './state';
import './chat.css';

// Chat 2.0: channels, direct messages, threads, mentions, reactions and files.

registerPanel({ id: 'chat', title: 'Chat', icon: ChatIcon, Component: ChatPanel, order: 10, shortcut: 'Enter', useBadge });

/** A link to a message (…/o/<office>?msg=<id>), taken out of the address once followed. */
function takeLinkedMessage(): string | null {
  const url = new URL(location.href);
  const id = url.searchParams.get('msg');
  if (!id) return null;
  url.searchParams.delete('msg');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return id;
}

onSession('chat', (session) => {
  resetChat();
  const s = session.socket;
  s.on('chat:message', onMessage);
  s.on('chat:updated', onUpdated);
  s.on('chat:deleted', onUpdated);
  s.on('chat:mention', onMention);
  s.on('chat:seen', onSeen);
  s.on('channel:created', onChannel);
  s.on('channel:updated', onChannel);
  let linked = takeLinkedMessage();
  const offJoined = session.onJoined((rejoin) => {
    void loadChannels().then(() => {
      if (rejoin) {
        // Catch up on what was said while the connection was down.
        const { convs, thread } = useChat.getState();
        for (const [conv, list] of Object.entries(convs)) if (isSaved(conv) && list.status === 'ready') void loadConv(conv, true);
        if (thread) void loadThread(thread);
      }
      if (linked) {
        void openLinkedMessage(linked);
        linked = null;
      }
    });
  });
  const unwatch = watchApp();
  return () => {
    s.off('chat:message', onMessage);
    s.off('chat:updated', onUpdated);
    s.off('chat:deleted', onUpdated);
    s.off('chat:mention', onMention);
    s.off('chat:seen', onSeen);
    s.off('channel:created', onChannel);
    s.off('channel:updated', onChannel);
    offJoined();
    unwatch();
    resetChat();
    clearDrafts();
  };
});
