import { useEffect, type ReactNode } from 'react';
import { ticketConv } from '../../../../shared/support';
import { Composer } from '../chat/Composer';
import { editLast } from '../chat/Message';
import { MessageList } from '../chat/MessageList';
import { emptyList, loadConv, loadOlder, markRead, useChat } from '../chat/state';

/** The ticket chats on screen right now (the chat counts their messages as seen). */
export const ticketsOnScreen = new Set<string>();

/** A ticket's chat (`t:<id>`, kept by the chat feature): its messages, and where you write or why you can't. */
export function TicketChat({ ticketId, placeholder, closed, intro }: { ticketId: string; placeholder: string; closed?: ReactNode; intro?: ReactNode }) {
  const conv = ticketConv(ticketId);
  const list = useChat((s) => s.convs[conv]) ?? emptyList();
  useEffect(() => void loadConv(conv), [conv]);

  // On screen: what's in it is read, now and when the tab is seen again.
  useEffect(() => {
    ticketsOnScreen.add(conv);
    markRead(conv);
    const onVisible = () => !document.hidden && markRead(conv);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      ticketsOnScreen.delete(conv);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [conv]);

  return (
    <div className="chat-panel ticket-chat">
      <section className="chat-main" aria-label="Messages">
        <MessageList key={`${conv}:list`} conv={conv} list={list} intro={intro ?? null} onOlder={() => void loadOlder(conv)} onRetry={() => void loadConv(conv)} />
        {closed ? (
          <div className="chat-footer-note">{closed}</div>
        ) : (
          <Composer key={`${conv}:composer`} conv={conv} placeholder={placeholder} label={placeholder} onEditLast={() => editLast(list.messages)} />
        )}
      </section>
    </div>
  );
}

/** Unread messages in a ticket's chat. */
export const useTicketUnread = (ticketId: string | null | undefined) => useChat((s) => (ticketId ? (s.counts[ticketConv(ticketId)]?.unread ?? 0) : 0));
