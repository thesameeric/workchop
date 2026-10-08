import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { JumpButton } from './Attachments';
import { Message } from './Message';
import { dayLabel, sameDay, useMayEdit } from './parts';
import { isMine, reveal, useChat, type ListState, type UiMessage } from './state';

/** Messages by the same person this close together share one avatar and name. */
const GROUP_MS = 5 * 60_000;

const author = (m: UiMessage) => m.userId ?? `${m.playerId}|${m.name}`;

function grouped(prev: UiMessage | null, m: UiMessage): boolean {
  return !!prev && author(prev) === author(m) && m.createdAt - prev.createdAt < GROUP_MS && sameDay(prev.createdAt, m.createdAt) && !m.inChannel && !prev.inChannel;
}

function Skeleton() {
  return (
    <div className="chat-skeleton" aria-label="Loading messages">
      {[70, 45, 85].map((w, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton-avatar" />
          <span className="skeleton-lines">
            <i style={{ width: '30%' }} />
            <i style={{ width: `${w}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A scrolling list of messages, newest at the bottom: it stays at the bottom as messages arrive
 * (unless you've scrolled up, then a button offers to jump down), loads older pages as you scroll
 * up, and scrolls to (and highlights) a message you jumped to.
 */
export function MessageList({
  conv,
  list,
  head,
  intro,
  onOlder,
  onRetry,
  inThread,
}: {
  conv: string;
  list: ListState;
  /** Shown above the messages once there are no older ones (e.g. "This is the start of #general"). */
  intro: ReactNode;
  /** Shown first, above everything (a thread's parent). */
  head?: ReactNode;
  onOlder: () => void;
  onRetry: () => void;
  inThread?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const [showJump, setShowJump] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const jump = useChat((s) => s.jump);
  const canModerate = useMayEdit();
  const prev = useRef<{ first?: string; last?: string; height: number; count: number }>({ height: 0, count: 0 });
  const { messages } = list;

  // Keep the view where it was when older messages come in above, and at the bottom for new ones.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = messages[0]?.id;
    const last = messages[messages.length - 1];
    const p = prev.current;
    if (p.first && first !== p.first && last?.id === p.last) {
      el.scrollTop += el.scrollHeight - p.height;
    } else if (last && last.id !== p.last) {
      if (pinned.current || !p.last || isMine(last)) {
        el.scrollTop = el.scrollHeight;
        pinned.current = true;
      } else {
        setUnseen((n) => n + Math.max(1, messages.length - p.count));
        setShowJump(true);
      }
    }
    prev.current = { first, last: last?.id, height: el.scrollHeight, count: messages.length };
  }, [messages]);

  // Images loading (and other late layout changes) keep a pinned list at the bottom.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
      prev.current.height = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Jumping to a message: load back to it, scroll it into view and make it stand out for a moment.
  useEffect(() => {
    if (!jump || list.status !== 'ready') return;
    let stop = false;
    void (async () => {
      // A thread's replies are all loaded with it.
      const found = inThread || (await reveal(conv, jump.id));
      if (stop) return;
      requestAnimationFrame(() => {
        const row = found ? scroller.current?.querySelector(`[data-msg="${CSS.escape(jump.id)}"]`) : null;
        // Done either way: a message that can't be shown (deleted since, or too far back) isn't looked for again.
        useChat.setState((s) => (s.jump === jump ? { jump: null } : {}));
        if (!row) return;
        pinned.current = false;
        row.scrollIntoView({ block: 'center' });
        setFlash(jump.id);
        setTimeout(() => setFlash((f) => (f === jump.id ? null : f)), 2200);
      });
    })();
    return () => {
      stop = true;
    };
  }, [jump, list.status, conv, inThread, messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = atBottom;
    if (atBottom) {
      setUnseen(0);
      setShowJump(false);
    } else if (el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 1.5) setShowJump(true);
    if (el.scrollTop < 300 && list.hasMore && !list.loadingOlder && list.status === 'ready') onOlder();
  };

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinned.current = true;
    setUnseen(0);
    setShowJump(false);
  };

  const rows: ReactNode[] = [];
  let before: UiMessage | null = null;
  for (const m of messages) {
    if (!before || !sameDay(before.createdAt, m.createdAt)) {
      rows.push(
        <div key={`day-${m.id}`} className="day-divider" role="separator">
          <span>{dayLabel(m.createdAt)}</span>
        </div>,
      );
    }
    rows.push(<Message key={m.nonce ?? m.id} m={m} grouped={grouped(before, m)} inThread={inThread} highlight={flash === m.id} canModerate={canModerate} />);
    before = m;
  }

  return (
    <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        <div className="chat-content" ref={content}>
          {head}
          {list.status === 'ready' && !list.hasMore && intro}
          {list.loadingOlder && <div className="chat-loading-older">Loading older messages…</div>}
          {(list.status === 'loading' || list.status === 'idle') && <Skeleton />}
          {list.status === 'error' && (
            <div className="chat-error">
              <p>Couldn’t load messages.</p>
              <button type="button" className="btn small" onClick={onRetry}>
                Try again
              </button>
            </div>
          )}
          <Fragment>{rows}</Fragment>
        </div>
      </div>
      {showJump && <JumpButton count={unseen} onClick={toBottom} />}
    </div>
  );
}
