import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  canInvite,
  canTransferTo,
  MAX_HELPERS,
  type Colleague,
  type OfferKind,
  type Ticket,
  type TicketEvent,
  type TicketOffer,
  type TakenDesk,
} from '../../../../shared/support';
import { serverNow } from '../../lib/clock';
import { local, remoteTargets } from '../../lib/positions';
import { ago } from '../../lib/time';
import { useStore } from '../../state/store';
import {
  BackIcon,
  CheckIcon,
  CloseIcon,
  HandOverIcon,
  HistoryIcon,
  InviteIcon,
  LeaveIcon,
  MailIcon,
  NextIcon,
  RemoveUserIcon,
  SearchIcon,
  StarIcon,
  SupportIcon,
  TicketIcon,
  WaitIcon,
} from '../../ui/icons';
import { Avatar } from '../chat/parts';
import { supportDesks } from './places';
import {
  callNext,
  cancelOffer,
  fetchHistory,
  leaveDesk,
  leaveHelping,
  nextUp,
  offerTicket,
  openPicker,
  removeHelper,
  removeVisitor,
  resolve,
  takeDesk,
  useMyDesk,
  useSupport,
  type StaffTab,
} from './state';
import { TicketChat } from './TicketChat';

// The staff's Support panel: your desk and the customer you're serving, the queue, and past tickets.

/** Re-renders every `ms`, for waiting times and distances. */
function useTick(ms: number): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** "4 min", "1 h 5 min": how long since `ts` (server time). */
export function waited(ts: number): string {
  const min = Math.max(0, Math.floor((serverNow() - ts) / 60_000));
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="sp-stars" aria-label={`Rated ${rating} of 5`} title={`Rated ${rating} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon key={n} size={12} className={n <= rating ? 'on' : ''} />
      ))}
    </span>
  );
}

// ---------- Desk ----------

function DeskList({ mine }: { mine: TakenDesk | undefined }) {
  const office = useStore((s) => s.office);
  const taken = useSupport((s) => s.queue.desks);
  const [busy, setBusy] = useState(false);
  const desks = office ? supportDesks(office) : [];
  if (!desks.length) return <p className="muted small pad">This workspace has no support desks yet. Owners and admins can add them in build mode.</p>;
  return (
    <ul className="sp-desks">
      {desks.map(({ item, label }) => {
        const who = taken.find((d) => d.itemId === item.id);
        return (
          <li key={item.id} className={who ? 'taken' : ''}>
            <span className="sp-desk-name">{label}</span>
            <span className="sp-desk-who muted small">{who ? `${who.name}${who.ticketId ? ' · serving' : ''}` : 'Free'}</span>
            {!who && !mine && (
              <button
                type="button"
                className="btn small primary"
                disabled={busy}
                aria-label={`Take ${label}`}
                onClick={async () => {
                  setBusy(true);
                  await takeDesk(item);
                  setBusy(false);
                }}
              >
                Take
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Where the customer is: on their way, at the desk, or gone for now. The desk is yours, or (helping)
 * `desk`, the one where they're served.
 */
function Whereabouts({ ticket, desk }: { ticket: Ticket; desk?: { x: number; z: number; label: string } }) {
  useTick(500);
  if (!ticket.present || !ticket.playerId) return <span className="sp-where away">Stepped away</span>;
  const t = remoteTargets.get(ticket.playerId);
  if (!t) return null;
  const at = desk ?? local;
  const d = Math.hypot(t.x - at.x, t.z - at.z);
  if (d < 3 && t.anim === 'sit') return <span className="sp-where here">{desk ? `At ${desk.label}` : 'At your desk'}</span>;
  return <span className="sp-where">Walking over · {Math.round(d)} m</span>;
}

/** "Remove visitor" (asked twice): for someone misusing the customer link. */
function RemoveVisitor({ playerId }: { playerId: string }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!sure) {
    return (
      <button type="button" className="sp-remove" onClick={() => setSure(true)}>
        <RemoveUserIcon size={14} /> Remove visitor
      </button>
    );
  }
  return (
    <span className="sp-remove-confirm" role="group" aria-label="Remove this visitor?">
      Remove them? Their ticket ends and they can’t come back for a while.
      <span>
        <button
          type="button"
          className="btn small danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            if (!(await removeVisitor(playerId))) setBusy(false);
          }}
        >
          Remove
        </button>
        <button type="button" className="btn small" onClick={() => setSure(false)}>
          Cancel
        </button>
      </span>
    </span>
  );
}

/** Seconds left until `at` (server time). */
const secondsTo = (at: number) => Math.max(0, Math.ceil((at - serverNow()) / 1000));

/** Your offer waiting for an answer, with a countdown and Cancel. */
function PendingOffer({ offer }: { offer: TicketOffer }) {
  const [busy, setBusy] = useState(false);
  useTick(1000);
  return (
    <div className="sp-pending" role="status">
      <WaitIcon size={16} />
      <span className="sp-pending-text">
        {offer.kind === 'transfer' ? `Waiting for ${offer.to.name} to take #${offer.number}…` : `Waiting for ${offer.to.name} to join…`}
      </span>
      <span className="sp-countdown" aria-hidden="true">
        {secondsTo(offer.expiresAt)} s
      </span>
      <button
        type="button"
        className="btn small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          if (!(await cancelOffer(offer.id))) setBusy(false);
        }}
      >
        Cancel
      </button>
    </div>
  );
}

/** The colleagues helping with your ticket, each with a button to end their part. */
function Helpers({ ticket }: { ticket: Ticket }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="sp-helpers">
      <span className="sp-helpers-label">Helping</span>
      {ticket.helpers.map((h) => (
        <span key={h.userId} className="sp-helper">
          <span className="sp-helper-name">
            {h.name}
            {h.playerId ? '' : ' · away'}
          </span>
          <button
            type="button"
            className="sp-helper-end"
            disabled={busy === h.userId}
            aria-label={`End ${h.name}’s part`}
            title={`End ${h.name}’s part`}
            onClick={async () => {
              setBusy(h.userId);
              await removeHelper(h.userId);
              setBusy(null);
            }}
          >
            <CloseIcon size={14} />
          </button>
        </span>
      ))}
    </div>
  );
}

const PICKER_TITLE: Record<OfferKind, string> = { transfer: 'Hand over to', invite: 'Invite a colleague' };
const NOBODY: Record<OfferKind, string> = { transfer: 'Nobody is free at a desk right now.', invite: 'Everyone is busy right now.' };

/** What a colleague is doing, as the picker says it. */
function colleagueLine(c: Colleague, ticketId: string, agentOf: (ticketId: string) => string | undefined): string {
  switch (c.state) {
    case 'free':
      return `${c.desk} · free`;
    case 'serving':
      return `${c.desk} · serving`;
    case 'away':
      return `${c.desk} · away`;
    case 'no-desk':
      return 'No desk';
    case 'helping':
      return c.helping === ticketId ? 'Helping you' : `Helping ${(c.helping && agentOf(c.helping)) || 'someone'}`;
  }
}

/** Choosing the colleague to hand your customer to, or to invite into the conversation. */
function Picker({ kind, ticket }: { kind: OfferKind; ticket: Ticket }) {
  const colleagues = useSupport((s) => s.queue.colleagues);
  const desks = useSupport((s) => s.queue.desks);
  const [busy, setBusy] = useState(false);
  const can = (c: Colleague) => (kind === 'transfer' ? canTransferTo(c, ticket.id) : canInvite(c, ticket));
  // Who you can ask first; otherwise as the server sorts them (by desk, then name).
  const list = [...colleagues.filter(can), ...colleagues.filter((c) => !can(c))];
  const agentOf = (id: string) => desks.find((d) => d.ticketId === id)?.name;
  const label = kind === 'transfer' ? 'Hand over' : 'Invite';
  return (
    <section className="sp-picker" aria-label={PICKER_TITLE[kind]}>
      <header className="sp-picker-head">
        <h3>{PICKER_TITLE[kind]}</h3>
        <button type="button" className="icon-btn" onClick={() => openPicker(null)} aria-label="Close" title="Close">
          <CloseIcon size={16} />
        </button>
      </header>
      <div className="sp-scroll">
        {list.length === 0 ? (
          <p className="muted small pad">Nobody else is here.</p>
        ) : (
          <>
            {!list.some(can) && <p className="muted small sp-picker-note">{NOBODY[kind]}</p>}
            <ul className="sp-colleagues">
              {list.map((c) => (
                <li key={c.userId}>
                  <Avatar name={c.name} size={32} />
                  <span className="sp-colleague-who">
                    <strong title={c.name}>{c.name}</strong>
                    <span className="muted small">{colleagueLine(c, ticket.id, agentOf)}</span>
                  </span>
                  <button
                    type="button"
                    className="btn small primary"
                    disabled={busy || !can(c)}
                    aria-label={kind === 'transfer' ? `Hand over to ${c.name}` : `Invite ${c.name}`}
                    onClick={async () => {
                      setBusy(true);
                      await offerTicket(kind, c.userId);
                      setBusy(false);
                    }}
                  >
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function Serving({ ticket }: { ticket: Ticket }) {
  const [busy, setBusy] = useState(false);
  const picker = useSupport((s) => s.picker);
  const outgoing = useSupport((s) => s.queue.offers.outgoing);
  const full = ticket.helpers.length >= MAX_HELPERS;
  useTick(30_000);
  return (
    <div className="sp-serving">
      <div className="sp-ticket">
        <div className="sp-ticket-top">
          <Avatar name={ticket.customerName} size={40} />
          <div className="sp-ticket-who">
            <strong title={ticket.customerName}>{ticket.customerName}</strong>
            <span className="muted small">
              #{ticket.number}
              {ticket.assignedAt ? ` · called ${ago(ticket.assignedAt)}` : ''}
            </span>
          </div>
          <button
            type="button"
            className="btn small primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await resolve();
              setBusy(false);
            }}
          >
            <CheckIcon size={16} /> Resolve
          </button>
        </div>
        <div className="sp-ticket-meta">
          <Whereabouts ticket={ticket} />
          {ticket.customerEmail && (
            <a className="sp-email" href={`mailto:${encodeURIComponent(ticket.customerEmail)}`} title={`Email ${ticket.customerEmail}`}>
              <MailIcon size={14} /> {ticket.customerEmail}
            </a>
          )}
          {ticket.present && ticket.playerId && <RemoveVisitor playerId={ticket.playerId} />}
        </div>
        <div className="sp-ticket-actions">
          <button
            type="button"
            className="btn small"
            disabled={!!outgoing}
            aria-expanded={picker === 'transfer'}
            title="Hand this visitor to a colleague at a desk"
            onClick={() => openPicker(picker === 'transfer' ? null : 'transfer')}
          >
            <HandOverIcon size={16} /> Hand over
          </button>
          <button
            type="button"
            className="btn small"
            disabled={!!outgoing || full}
            aria-expanded={picker === 'invite'}
            title={full ? 'Two colleagues are helping already.' : 'Invite a colleague into this conversation'}
            onClick={() => openPicker(picker === 'invite' ? null : 'invite')}
          >
            <InviteIcon size={16} /> Invite
          </button>
        </div>
        {ticket.helpers.length > 0 && <Helpers ticket={ticket} />}
        {outgoing && <PendingOffer offer={outgoing} />}
      </div>
      {picker ? <Picker kind={picker} ticket={ticket} /> : <TicketChat ticketId={ticket.id} placeholder={`Message ${ticket.customerName}`} />}
    </div>
  );
}

/** Helping a colleague with their customer: the conversation, and Leave. */
function Helping({ ticket }: { ticket: Ticket }) {
  const [busy, setBusy] = useState(false);
  const desk = useSupport((s) => s.queue.desks.find((d) => d.ticketId === ticket.id));
  const item = useStore((s) => s.office?.items.find((i) => i.id === ticket.deskItemId));
  const agent = desk?.name ?? ticket.assignee?.name ?? 'a colleague';
  return (
    <div className="sp-serving">
      <div className="sp-ticket">
        <div className="sp-ticket-top">
          <Avatar name={ticket.customerName} size={40} />
          <div className="sp-ticket-who">
            <strong title={`Helping ${agent}`}>Helping {agent}</strong>
            <span className="muted small">
              {ticket.customerName} · #{ticket.number}
              {desk ? ` · ${desk.label}` : ''}
            </span>
          </div>
          <button
            type="button"
            className="btn small"
            disabled={busy}
            aria-label="Leave this conversation"
            onClick={async () => {
              setBusy(true);
              if (!(await leaveHelping())) setBusy(false);
            }}
          >
            <LeaveIcon size={16} /> Leave
          </button>
        </div>
        <div className="sp-ticket-meta">
          <Whereabouts ticket={ticket} desk={item && desk ? { x: item.x, z: item.z, label: desk.label } : undefined} />
        </div>
      </div>
      <TicketChat ticketId={ticket.id} placeholder={`Message ${ticket.customerName}`} />
    </div>
  );
}

function NextUp({ onQueue }: { onQueue: () => void }) {
  const queue = useSupport((s) => s.queue);
  const [busy, setBusy] = useState(false);
  useTick(30_000);
  const next = nextUp(queue);
  const waiting = queue.waiting.length;
  return (
    <div className="sp-next">
      {next ? (
        <div className="sp-next-who">
          <span className="sp-label">Next up</span>
          <div className="sp-next-line">
            <Avatar name={next.customerName} size={34} />
            <div>
              <strong>{next.customerName}</strong>
              <span className="muted small">
                #{next.number} · waiting {waited(next.createdAt)}
              </span>
            </div>
          </div>
          <p className="sp-quote">{next.firstMessage}</p>
        </div>
      ) : (
        <div className="sp-empty">
          <WaitIcon size={26} />
          <strong>{waiting ? 'Everyone waiting has stepped away' : 'No one is waiting'}</strong>
          <span className="muted small">{waiting ? 'Next works again when one of them is back.' : 'New customers show up here.'}</span>
        </div>
      )}
      <button
        type="button"
        className="btn primary big wide"
        disabled={!next || busy}
        onClick={async () => {
          setBusy(true);
          await callNext();
          setBusy(false);
        }}
      >
        Call next <NextIcon size={18} />
      </button>
      {waiting > 0 && (
        <button type="button" className="link-btn sp-more" onClick={onQueue}>
          {waiting} waiting in all
        </button>
      )}
    </div>
  );
}

function DeskTab({ onQueue }: { onQueue: () => void }) {
  const mine = useSupport((s) => s.queue.mine);
  const helping = useSupport((s) => s.queue.helping);
  const desk = useMyDesk();
  const [busy, setBusy] = useState(false);
  if (!desk && helping && !mine) return <Helping ticket={helping} />;
  if (!desk) {
    return (
      <div className="sp-scroll">
        <div className="sp-empty">
          <SupportIcon size={28} />
          <strong>Take a desk to start helping</strong>
          <span className="muted small">You’ll call customers to it one at a time.</span>
        </div>
        <DeskList mine={desk} />
      </div>
    );
  }
  return (
    <>
      <div className="sp-desk-bar">
        <span>
          <strong>{desk.label}</strong>
          <span className="muted small">{mine ? ` · ticket #${mine.number}` : helping ? ' · helping' : ' · ready'}</span>
        </span>
        {!mine && !helping && (
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await leaveDesk();
              setBusy(false);
            }}
          >
            Leave desk
          </button>
        )}
      </div>
      {mine ? (
        <Serving ticket={mine} />
      ) : helping ? (
        <Helping ticket={helping} />
      ) : (
        <div className="sp-scroll">
          <NextUp onQueue={onQueue} />
        </div>
      )}
    </>
  );
}

// ---------- Queue ----------

function QueueTab() {
  const queue = useSupport((s) => s.queue);
  useTick(30_000);
  const next = nextUp(queue);
  return (
    <div className="sp-scroll">
      <h3 className="sp-heading">Waiting · {queue.waiting.length}</h3>
      {queue.waiting.length === 0 && <p className="muted small pad">No one is waiting.</p>}
      <ol className="sp-queue">
        {queue.waiting.map((t, i) => (
          <li key={t.id} className={t.present ? '' : 'away'}>
            <span className="sp-pos">{i + 1}</span>
            <div className="sp-queue-main">
              <div className="sp-queue-line">
                <strong title={t.customerName}>{t.customerName}</strong>
                {t === next && <span className="badge">Next</span>}
                {!t.present && <span className="badge neutral">Away</span>}
              </div>
              <span className="muted small">
                #{t.number} · waiting {waited(t.createdAt)}
              </span>
              <p className="sp-quote">{t.firstMessage}</p>
              {t.present && t.playerId && <RemoveVisitor playerId={t.playerId} />}
            </div>
          </li>
        ))}
      </ol>
      <h3 className="sp-heading">At the desks · {queue.desks.length}</h3>
      {queue.desks.length === 0 && <p className="muted small pad">No one has taken a desk.</p>}
      <ul className="sp-desks">
        {queue.desks.map((d) => (
          <li key={d.itemId}>
            <span className="sp-desk-name">{d.label}</span>
            <span className="sp-desk-who muted small">
              {d.name}
              {d.ticketId ? ' · serving' : ' · ready'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- History ----------

const STATUS: Record<Ticket['status'], string> = { waiting: 'Waiting', active: 'Being served', resolved: 'Resolved', abandoned: 'Left' };

function eventText(e: TicketEvent): string {
  switch (e.kind) {
    case 'transferred':
      return `${e.from} handed this to ${e.to}`;
    case 'joined':
      return `${e.helper} joined`;
    case 'left':
      return e.by ? `${e.by} ended ${e.helper}’s part` : `${e.helper} left`;
  }
}

function Transcript({ ticket, onBack }: { ticket: Ticket; onBack: () => void }) {
  return (
    <div className="sp-transcript">
      <header className="conv-head">
        <button type="button" className="icon-btn" onClick={onBack} title="Back">
          <BackIcon size={18} />
        </button>
        <div className="conv-title">
          <div className="conv-line">
            <span className="conv-name">
              #{ticket.number} {ticket.customerName}
            </span>
          </div>
          <span className="conv-sub">
            {STATUS[ticket.status]}
            {ticket.assignee ? ` by ${ticket.assignee.name}` : ''}
            {ticket.closedAt ? ` · ${ago(ticket.closedAt)}` : ''}
            {ticket.customerEmail ? ` · ${ticket.customerEmail}` : ''}
          </span>
        </div>
        {ticket.rating ? <Stars rating={ticket.rating} /> : null}
      </header>
      {!!ticket.events?.length && (
        <ul className="sp-events" aria-label="What happened">
          {ticket.events.map((e, i) => (
            <li key={i}>
              {eventText(e)} · {ago(e.at)}
            </li>
          ))}
        </ul>
      )}
      <TicketChat ticketId={ticket.id} placeholder="" closed={`Closed ${ticket.closedAt ? ago(ticket.closedAt) : ''}`} />
    </div>
  );
}

function HistoryTab() {
  const [query, setQuery] = useState('');
  const [list, setList] = useState<{ tickets: Ticket[]; more: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Ticket | null>(null);
  const asked = useRef(0);

  // Searches as you type (after a pause).
  useEffect(() => {
    const n = ++asked.current;
    const t = setTimeout(
      async () => {
        setLoading(true);
        const res = await fetchHistory({ query: query.trim() || undefined });
        if (n !== asked.current) return;
        setLoading(false);
        if (res) setList(res);
      },
      query ? 300 : 0,
    );
    return () => clearTimeout(t);
  }, [query]);

  const more = async () => {
    const last = list?.tickets[list.tickets.length - 1];
    if (!last) return;
    const n = asked.current;
    setLoading(true);
    const res = await fetchHistory({ query: query.trim() || undefined, before: last.number });
    if (n !== asked.current) return;
    setLoading(false);
    if (res) setList((l) => ({ tickets: [...(l?.tickets ?? []), ...res.tickets], more: res.more }));
  };

  if (open) return <Transcript ticket={open} onBack={() => setOpen(null)} />;
  return (
    <div className="sp-scroll">
      <label className="sp-search">
        <SearchIcon size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, email or #number" aria-label="Search past tickets" />
      </label>
      {list?.tickets.length === 0 && !loading && <p className="muted small pad">{query ? 'No tickets match.' : 'No closed tickets yet.'}</p>}
      <ul className="sp-history">
        {list?.tickets.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => setOpen(t)}>
              <span className="sp-history-line">
                <strong title={t.customerName}>
                  #{t.number} {t.customerName}
                </strong>
                {t.rating ? <Stars rating={t.rating} /> : null}
              </span>
              <span className="muted small">
                {STATUS[t.status]}
                {t.assignee ? ` by ${t.assignee.name}` : ''}
                {t.closedAt ? ` · ${ago(t.closedAt)}` : ''}
              </span>
              <span className="sp-quote">{t.firstMessage}</span>
            </button>
          </li>
        ))}
      </ul>
      {loading && <p className="muted small pad">Loading…</p>}
      {list?.more && !loading && (
        <button type="button" className="btn small sp-load-more" onClick={() => void more()}>
          Show older
        </button>
      )}
    </div>
  );
}

// ---------- The panel ----------

const TABS: { id: StaffTab; label: string; icon: ReactNode }[] = [
  { id: 'desk', label: 'Desk', icon: <SupportIcon size={16} /> },
  { id: 'queue', label: 'Queue', icon: <TicketIcon size={16} /> },
  { id: 'history', label: 'History', icon: <HistoryIcon size={16} /> },
];

export function StaffPanel() {
  const tab = useSupport((s) => s.tab);
  const waiting = useSupport((s) => s.queue.waiting.length);
  const setTab = (t: StaffTab) => useSupport.setState({ tab: t });
  return (
    <div className="support-panel">
      <div className="sp-tabs" role="tablist" aria-label="Support">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.icon}
            {t.label}
            {t.id === 'queue' && waiting > 0 && <span className="sp-count">{waiting}</span>}
          </button>
        ))}
      </div>
      {tab === 'desk' && <DeskTab onQueue={() => setTab('queue')} />}
      {tab === 'queue' && <QueueTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}

/** The Support button's badge: customers here and waiting. */
export function useStaffBadge(): number | null {
  return useSupport((s) => s.queue.waiting.filter((t) => t.present).length) || null;
}
