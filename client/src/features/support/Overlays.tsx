import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { TicketOffer } from '../../../../shared/support';
import type { OfficeItem } from '../../../../shared/types';
import { useAnchor } from '../../lib/anchors';
import { serverNow } from '../../lib/clock';
import { local, rendered } from '../../lib/positions';
import { useStore } from '../../state/store';
import { CloseIcon, DeskIcon, HandOverIcon, InviteIcon, SupportIcon } from '../../ui/icons';
import { supportDesks } from './places';
import { answerOffer, leaveDesk, sitAtDesk, takeDesk, useMyDesk, useSupport } from './state';

// Over the office: the card of a clicked support desk, an offer from a colleague (staff), and (for
// staff) customers' real names over their "Visitor #N" name tags.

const NARROW = window.matchMedia('(max-width: 720px)');
const onNarrow = (fn: () => void) => {
  NARROW.addEventListener('change', fn);
  return () => NARROW.removeEventListener('change', fn);
};
const useNarrow = () => useSyncExternalStore(onNarrow, () => NARROW.matches);

const closeCard = () => useSupport.setState({ deskCard: null });

/** Opens a support desk's card (clicking it again closes it). */
export function toggleDeskCard(item: OfficeItem): void {
  useSupport.setState((s) => ({ deskCard: s.deskCard === item.id ? null : item.id }));
}

function Action({ children, primary, run }: { children: ReactNode; primary?: boolean; run: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn small${primary ? ' primary' : ''}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await run();
        setBusy(false);
      }}
    >
      {children}
    </button>
  );
}

/** What the desk is and what you can do there: staff take it or leave it; customers wait to be called. */
function DeskInfo({ item, label }: { item: OfficeItem; label: string }) {
  const as = useSupport((s) => s.as);
  const taken = useSupport((s) => s.queue.desks.find((d) => d.itemId === item.id));
  const serving = useSupport((s) => s.board.serving.find((b) => b.desk === label));
  const myTicket = useSupport((s) => (s.ticket?.status === 'active' && s.ticket.agent?.deskItemId === item.id ? s.ticket : null));
  const mine = useMyDesk();
  const busy = useSupport((s) => !!s.queue.mine);
  const helping = useSupport((s) => !!s.queue.helping);
  let subtitle: string;
  let body: ReactNode = null;
  if (as === 'staff') {
    if (mine?.itemId === item.id) {
      subtitle = busy ? 'Your desk · serving a customer' : helping ? 'Your desk · helping' : 'Your desk · ready';
      body = (
        <div className="sdc-actions">
          {local.seat?.itemId !== item.id && (
            <Action primary run={() => sitAtDesk(item)}>
              Sit down
            </Action>
          )}
          {!busy && !helping && <Action run={leaveDesk}>Leave desk</Action>}
        </div>
      );
    } else if (taken) {
      subtitle = `${taken.name}’s desk${taken.ticketId ? ' · serving' : ''}`;
    } else {
      subtitle = 'Free';
      body = busy ? (
        <p className="sdc-text">Resolve your ticket at {mine?.label} before you move.</p>
      ) : (
        <div className="sdc-actions">
          <Action primary run={() => takeDesk(item)}>
            {mine ? `Move here from ${mine.label}` : 'Take this desk'}
          </Action>
        </div>
      );
    }
  } else {
    subtitle = myTicket ? `${myTicket.agent!.name} is helping you here` : serving ? `Now serving #${serving.number}` : taken ? 'Open' : 'Closed for now';
    body = !myTicket && <p className="sdc-text">When it’s your turn, we’ll walk you to a desk. Until then, have a look around.</p>;
  }
  return (
    <>
      <header className="sdc-head">
        <span className="sdc-icon">{as === 'staff' ? <DeskIcon size={20} /> : <SupportIcon size={20} />}</span>
        <div className="sdc-title">
          <h3>{label}</h3>
          <p>{subtitle}</p>
        </div>
        <button className="icon-btn" onClick={closeCard} title="Close (Esc)" aria-label="Close">
          <CloseIcon size={16} />
        </button>
      </header>
      {body}
    </>
  );
}

function DeskCardFor({ item, label }: { item: OfficeItem; label: string }) {
  const narrow = useNarrow();
  const anchor = useAnchor(`support-desk:${item.id}`, () => ({ x: item.x, y: 1.9, z: item.z }));
  const point = useRef<HTMLElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      point.current = el;
      anchor(el);
    },
    [anchor],
  );
  const cardRef = useRef<HTMLDivElement>(null);

  // Above the desk, but kept on screen: clear of the top bar's column (a customer's card is there,
  // top left) and of the dock.
  useEffect(() => {
    if (narrow) return;
    let frame = 0;
    const place = () => {
      const p = point.current?.getBoundingClientRect();
      const card = cardRef.current;
      if (p && card) {
        const w = card.offsetWidth;
        const h = card.offsetHeight;
        let left = Math.max(12, Math.min(innerWidth - w - 12, p.left - w / 2));
        let top = Math.max(64, Math.min(innerHeight - h - 88, p.top - h - 12));
        const bar = document.querySelector('.topbar')?.getBoundingClientRect();
        if (bar && left < bar.right + 12 && top < bar.bottom + 12) {
          if (bar.right + 24 + w <= innerWidth) left = bar.right + 12;
          else top = bar.bottom + 12;
        }
        card.style.transform = `translate(${Math.round(left - p.left)}px, ${Math.round(top - p.top)}px)`;
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [narrow]);

  // Esc closes it (before it closes a side panel); walking away does too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeCard();
    };
    const far = Math.max(8, Math.hypot(item.x - local.x, item.z - local.z) + 3);
    const t = setInterval(() => Math.hypot(item.x - local.x, item.z - local.z) > far && closeCard(), 300);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearInterval(t);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [item]);

  const card = (
    <div ref={cardRef} className={`support-desk-card${narrow ? ' sheet' : ''}`} role="dialog" aria-label={label}>
      <DeskInfo item={item} label={label} />
    </div>
  );
  // Phones show it as a sheet above the dock; elsewhere it stands over the desk.
  if (narrow) return card;
  return (
    <div ref={ref} className="world-label support-desk-anchor">
      {card}
    </div>
  );
}

export function DeskCard() {
  const id = useSupport((s) => s.deskCard);
  const mode = useStore((s) => s.mode);
  const office = useStore((s) => s.office);
  const desk = useMemo(() => (id && office ? supportDesks(office).find((d) => d.item.id === id) : undefined), [id, office]);
  if (!desk || mode !== 'play') return null;
  return <DeskCardFor key={desk.item.id} item={desk.item} label={desk.label} />;
}

const TAG_Y = 2.46;
const SIT_DROP = 0.22;

function RealName({ playerId, name }: { playerId: string; name: string }) {
  const ref = useAnchor(`support-name:${playerId}`, () => {
    const r = rendered.get(playerId);
    return r ? { x: r.x, y: TAG_Y - (r.sit ? SIT_DROP : 0), z: r.z } : null;
  });
  return (
    <div ref={ref} className="world-label">
      <div className="support-realname">{name}</div>
    </div>
  );
}

/** Staff see who's behind the visitor numbers they're waiting for, serving or helping with. */
export function CustomerNames() {
  const customers = useSupport(
    useShallow((s) =>
      s.as === 'staff' ? [...s.queue.waiting, s.queue.mine, s.queue.helping].filter((t) => !!t && t.present && !!t.playerId).map((t) => t!) : [],
    ),
  );
  if (!customers.length) return null;
  return (
    <div className="world-labels" aria-hidden="true">
      {customers.map((t) => (
        <RealName key={t.id} playerId={t.playerId!} name={t.customerName} />
      ))}
    </div>
  );
}

// ---------- An offer from a colleague ----------

const offerTitle = (o: TicketOffer) =>
  o.kind === 'transfer' ? `${o.from.name} wants to hand you Visitor #${o.number}` : `${o.from.name} wants your help with Visitor #${o.number}`;

function OfferCardFor({ offer }: { offer: TicketOffer }) {
  const narrow = useNarrow();
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((offer.expiresAt - serverNow()) / 1000));
  const title = offerTitle(offer);
  const answer = async (accept: boolean) => {
    setBusy(true);
    if (!(await answerOffer(offer.id, accept))) setBusy(false);
  };
  const Icon = offer.kind === 'transfer' ? HandOverIcon : InviteIcon;
  return (
    <div className={`support-offer${narrow ? ' sheet' : ''}`} role="region" aria-label={title}>
      <header className="so-head">
        <span className="sdc-icon">
          <Icon size={20} />
        </span>
        <div className="so-title">
          <h3>{title}</h3>
          <p>
            {offer.customerName} · {offer.from.desk}
          </p>
        </div>
        <span className="so-left" aria-hidden="true">
          {left} s left
        </span>
      </header>
      <p className="so-quote" title={offer.firstMessage}>
        {offer.firstMessage}
      </p>
      <div className="so-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void answer(true)}>
          Accept
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>
          Decline
        </button>
      </div>
    </div>
  );
}

/** Staff: a colleague offers you the customer they're serving, or asks for your help with them. */
export function OfferCard() {
  const staff = useSupport((s) => s.as === 'staff');
  const offer = useSupport((s) => (s.as === 'staff' ? s.queue.offers.incoming : null));
  if (!staff) return null;
  return (
    <>
      {/* Said when it appears (the region is there before, so it's announced). */}
      <p className="support-offer-live" aria-live="polite">
        {offer ? offerTitle(offer) : ''}
      </p>
      {offer && <OfferCardFor key={offer.id} offer={offer} />}
    </>
  );
}
