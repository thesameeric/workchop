import { useEffect, useState, type FormEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { local } from '../../lib/positions';
import { leaveOffice } from '../../lib/session';
import { getState, setState, useStore } from '../../state/store';
import { ChatIcon, ChevronDownIcon, StarIcon, SupportIcon, TicketIcon, WaitIcon, WalkIcon } from '../../ui/icons';
import { isTyping } from '../../world/input';
import { composerHandle } from '../chat/Composer';
import { Avatar } from '../chat/parts';
import { cleanQuestion, questionProblem, QuestionFields } from './CustomerLobby';
import { sightsIn, walkUpTo } from './places';
import { askAgain, askAnother, checkArrived, enter, lastDetails, leaveQueue, rate, useSupport, type Question } from './state';
import { TicketChat, useTicketUnread } from './TicketChat';

// What a customer sees in the office: their place in the queue (with things to look at meanwhile),
// who calls them, the chat of their ticket, and a rating at the end.

/** Re-renders every `ms` (for things read from the moving world, like where you sit). */
function useTick(ms: number): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const openChat = () => setState({ panel: 'chat', mode: 'play' });

function ChatButton({ ticketId, label, primary }: { ticketId: string; label: string; primary?: boolean }) {
  const unread = useTicketUnread(ticketId);
  return (
    <button type="button" className={`sc-btn${primary ? ' primary' : ''}`} onClick={openChat}>
      <ChatIcon size={17} />
      {label}
      {unread > 0 && <span className="sc-unread">{unread > 9 ? '9+' : unread}</span>}
    </button>
  );
}

/** The things to go and look at while you wait. */
function Sights() {
  // The nearest of each kind, from where you were when the card opened.
  const [sights] = useState(() => {
    const office = getState().office;
    return office ? sightsIn(office, local) : [];
  });
  if (!sights.length) return null;
  return (
    <div className="sc-sights">
      <span className="sc-label">While you wait</span>
      <div className="sc-chips">
        {sights.map((s) => (
          <button key={s.id} type="button" className="sc-chip" onClick={() => walkUpTo(s.item)}>
            <s.icon size={15} />
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Leave the queue", asked twice: once to start, once to be sure. */
function LeaveQueue() {
  const [sure, setSure] = useState(false);
  if (!sure) {
    return (
      <button type="button" className="sc-link" onClick={() => setSure(true)}>
        Leave the queue
      </button>
    );
  }
  return (
    <span className="sc-confirm" role="group" aria-label="Leave the queue?">
      Leave the queue?
      <button type="button" className="sc-link danger" onClick={() => void leaveQueue()}>
        Leave
      </button>
      <button type="button" className="sc-link" onClick={() => setSure(false)}>
        Stay
      </button>
    </span>
  );
}

function Waiting({ number, ahead, ticketId }: { number: number; ahead: number; ticketId: string }) {
  const [open, setOpen] = useState(true);
  const next = ahead === 0;
  return (
    <div className={`support-card waiting${next ? ' next' : ''}`} role="status">
      <button type="button" className="sc-top" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? 'Fold away' : 'Show more'}>
        <span className="sc-number">
          <small>Your number</small>#{number}
        </span>
        <span className="sc-status">
          <strong>{next ? 'You’re next' : `${ahead} ahead of you`}</strong>
          <span>{next ? 'Stay close, we’ll call you soon.' : 'We’ll call you when it’s your turn.'}</span>
        </span>
        <ChevronDownIcon size={16} className={`sc-fold${open ? ' open' : ''}`} />
      </button>
      {open && (
        <>
          <Sights />
          <div className="sc-actions">
            <ChatButton ticketId={ticketId} label="Add details" />
            <LeaveQueue />
          </div>
        </>
      )}
    </div>
  );
}

/** "Ada is here too", "Ada and Ben are here too": the colleagues helping your agent. */
const alsoHere = (names: string[]) => `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} here too`;

function Serving({
  ticketId,
  number,
  agent,
  here,
  deskItemId,
  desk,
  helpers,
}: {
  ticketId: string;
  number: number;
  agent: string;
  here: boolean;
  deskItemId: string;
  desk: string;
  helpers: string[];
}) {
  useTick(500);
  useEffect(checkArrived);
  const moved = useSupport((s) => s.moved);
  const seated = local.seat?.itemId === deskItemId;
  // Your agent's connection dropped (or they reloaded): their desk and your ticket wait for them.
  const title = !here
    ? `${agent} stepped away`
    : seated
      ? `You’re with ${agent}`
      : moved
        ? `${agent} at ${desk} will help you now`
        : `${agent} at ${desk} is ready`;
  return (
    <div className="support-card active" role="status">
      <div className="sc-top">
        <Avatar name={agent} size={40} className="sc-avatar" />
        <span className="sc-status">
          <strong>{title}</strong>
          <span>
            {!here ? (
              'We’ll be right back.'
            ) : seated ? (
              `${desk} · ticket #${number}`
            ) : (
              <>
                <WalkIcon size={14} /> Walking you over…
              </>
            )}
          </span>
          {helpers.length > 0 && <span>{alsoHere(helpers)}</span>}
        </span>
      </div>
      <div className="sc-actions">
        <ChatButton ticketId={ticketId} label="Chat" primary />
      </div>
    </div>
  );
}

function Rating({ rating }: { rating: number | null }) {
  const [hover, setHover] = useState(0);
  const shown = rating ?? hover;
  return (
    <div className="sc-rating">
      <div className="sc-stars" role="radiogroup" aria-label="Your rating" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            className={n <= shown ? 'on' : ''}
            disabled={rating !== null}
            onMouseEnter={() => setHover(n)}
            onClick={() => void rate(n)}
          >
            <StarIcon size={24} />
          </button>
        ))}
      </div>
      <span className="sc-note">{rating ? 'Thanks for telling us.' : 'How did we do?'}</span>
    </div>
  );
}

/** After a ticket (resolved, left or expired): what's next. */
function Closed({ title, text, rating, again }: { title: string; text?: string; rating?: number | null; again?: boolean }) {
  return (
    <div className="support-card done" role="status">
      <div className="sc-top">
        <span className="sc-icon">
          <SupportIcon size={22} />
        </span>
        <span className="sc-status">
          <strong>{title}</strong>
          {text && <span>{text}</span>}
        </span>
      </div>
      {rating !== undefined && <Rating rating={rating} />}
      <div className="sc-actions">
        <button type="button" className="sc-btn primary" onClick={() => (again ? askAgain() : askAnother())}>
          {again ? 'Ask again' : rating !== undefined ? 'Another question?' : 'Ask a question'}
        </button>
        <button type="button" className="sc-link" onClick={() => leaveOffice()}>
          Leave
        </button>
      </div>
    </div>
  );
}

/** "How can we help?" inside the office: a first question after a failed one, or another one. */
function Ask() {
  const officeId = useStore((s) => s.officeId)!;
  const hasTicket = useSupport((s) => !!s.ticket);
  const [again] = useState(() => !!useSupport.getState().draft);
  const [q, setQ] = useState<Question>(() => ({ ...lastDetails(officeId), message: useSupport.getState().draft }));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = cleanQuestion(q);
    const why = questionProblem(clean);
    setProblem(why);
    if (why) return;
    setBusy(true);
    if (!(await enter(clean))) setBusy(false);
  };
  return (
    <form className="support-card ask" onSubmit={submit} noValidate>
      <div className="sc-top">
        <span className="sc-icon">
          <TicketIcon size={22} />
        </span>
        <span className="sc-status">
          <strong>{again ? 'Ask again' : hasTicket ? 'Another question' : 'Tell us what you need'}</strong>
          <span>We’ll call you to a desk when it’s your turn.</span>
        </span>
      </div>
      <QuestionFields
        q={q}
        onChange={(next) => {
          setQ(next);
          setProblem(null);
        }}
        autoFocus
      />
      {problem && (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
      <div className="sc-actions">
        <button className="sc-btn primary" disabled={busy}>
          {busy ? 'Joining…' : 'Join the queue'}
        </button>
        {hasTicket && (
          <button type="button" className="sc-link" onClick={() => useSupport.setState({ asking: false })}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** The customer's card, in the office's top bar under its name. */
export function CustomerCard() {
  const { as, ticket, entering, asking, left } = useSupport(
    useShallow((s) => ({ as: s.as, ticket: s.ticket, entering: s.entering, asking: s.asking, left: s.left })),
  );
  if (as !== 'customer') return null;
  if (entering && !ticket) {
    return (
      <div className="support-card" role="status">
        <div className="sc-top">
          <span className="sc-icon">
            <WaitIcon size={22} />
          </span>
          <span className="sc-status">
            <strong>Getting you in line…</strong>
          </span>
        </div>
      </div>
    );
  }
  if (asking || !ticket) return <Ask />;
  switch (ticket.status) {
    case 'waiting':
      return <Waiting number={ticket.number} ahead={ticket.ahead ?? 0} ticketId={ticket.id} />;
    case 'active':
      return ticket.agent ? (
        <Serving
          ticketId={ticket.id}
          number={ticket.number}
          agent={ticket.agent.name}
          here={!!ticket.agent.playerId}
          deskItemId={ticket.agent.deskItemId}
          desk={ticket.agent.desk}
          helpers={ticket.helpers.map((h) => h.name)}
        />
      ) : null;
    case 'resolved':
      return <Closed title="Thanks for coming by!" rating={ticket.rating} />;
    case 'abandoned':
      return left === ticket.id ? (
        <Closed title="You left the queue" text="Ask again whenever you like." />
      ) : (
        <Closed title="Your place in the queue ran out" text="You were away for a while." again />
      );
  }
}

/** Customers' Chat panel: their ticket's chat, and nothing else. */
export function CustomerChat() {
  const ticket = useSupport((s) => s.ticket);
  const agent = ticket?.status === 'active' ? ticket.agent : null;
  useEffect(() => {
    // The office's Enter (which opens this panel) also puts you in the composer.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.defaultPrevented && !isTyping()) requestAnimationFrame(() => composerHandle.current?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!ticket) {
    return (
      <div className="panel-body">
        <p className="muted center pad">Your chat with us shows here once you’re in the queue.</p>
      </div>
    );
  }
  const open = ticket.status === 'waiting' || ticket.status === 'active';
  return (
    <div className="support-chat">
      <header className="conv-head">
        {agent ? (
          <Avatar name={agent.name} size={30} />
        ) : (
          <span className="sc-icon small">
            <TicketIcon size={18} />
          </span>
        )}
        <div className="conv-title">
          <div className="conv-line">
            <span className="conv-name">{agent ? agent.name : `Ticket #${ticket.number}`}</span>
          </div>
          <span className="conv-sub">
            {agent
              ? `${agent.desk} · ticket #${ticket.number}${ticket.helpers.length ? ` · with ${ticket.helpers.map((h) => h.name).join(' and ')}` : ''}`
              : open
                ? 'Add anything that helps. Whoever helps you sees it.'
                : 'Closed'}
          </span>
        </div>
      </header>
      <TicketChat
        ticketId={ticket.id}
        placeholder={agent ? `Message ${agent.name}` : 'Add details'}
        closed={open ? undefined : 'This conversation is closed.'}
        intro={
          <div className="chat-intro">
            <span className="chat-intro-icon">
              <SupportIcon size={22} />
            </span>
            <h3>Ticket #{ticket.number}</h3>
            <p>Only you and the people helping you see this chat.</p>
          </div>
        }
      />
    </div>
  );
}

/** The dock's Chat badge for customers: unread messages in their ticket. */
export function useCustomerBadge(): number | string | null {
  const unread = useTicketUnread(useSupport((s) => s.ticket?.id));
  return unread > 9 ? '9+' : unread || null;
}
