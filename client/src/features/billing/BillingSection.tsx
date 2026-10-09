import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FREE_SEATS, GRACE_DAYS, MIN_CHARGE, formatMoney, type BillingDetails, type BillingReceipt, type BillingView } from '../../../../shared/billing';
import { may } from '../../../../shared/workspace';
import { errorText } from '../../lib/account';
import { ApiError } from '../../lib/api';
import { setState, toast, useStore } from '../../state/store';
import { Logo } from '../../ui/Brand';
import { AlertIcon, CreditCardIcon, ExternalIcon, PrintIcon } from '../../ui/icons';
import { cancelPlan, changeSeats, resumePlan, retryPayment, startCheckout } from './api';
import { addSeatsCost, chargeStatus, day, listed, per, PLAN_NAMES, plural, problemOf, PURPOSES } from './format';
import { SeatPicker } from './SeatPicker';
import { pricesOf, refreshBilling, useBilling } from './state';

// Settings > Billing: the plan and its seats for the owner and admins; the owner also pays, changes
// seats and the card, cancels, and prints receipts. Paying happens on Paystack, which sends people
// back to /billing/return (ReturnPage).

const CARD_HINT = 'Use a Visa or Mastercard, or a Verve card that allows recurring payments.';
const DAY = 86_400_000;

/** An active plan whose period has ended: its renewal is due (and not tried yet). */
const renewalDue = (v: BillingView) => v.status === 'active' && v.periodEnd !== null && v.periodEnd <= Date.now();

function pillOf(v: BillingView): { tone: 'ok' | 'warn' | 'bad' | 'neutral'; text: string } | null {
  if (v.plan === 'comp') return null;
  switch (v.status) {
    case 'incomplete':
      return { tone: 'warn', text: 'Not paid' };
    case 'active':
      return v.cancelAtPeriodEnd ? { tone: 'neutral', text: 'Cancelled' } : { tone: 'ok', text: 'Active' };
    case 'past_due':
      return { tone: 'warn', text: v.graceReason === 'launch' ? 'Choose a plan' : 'Payment due' };
    case 'locked':
      return { tone: 'bad', text: 'Paused' };
    default:
      return null;
  }
}

/** "Visa •••• 4081" (Paystack's card types are lower case, sometimes with spaces). */
function cardName(card: { brand: string | null; last4: string | null }): string {
  const brand = card.brand?.trim() ?? '';
  return `${brand.charAt(0).toUpperCase()}${brand.slice(1)} •••• ${card.last4 ?? ''}`.trim();
}

/** The plan, its seats and dates: for the owner and admins. */
function Plan({ view }: { view: BillingView }) {
  const pill = pillOf(view);
  const d = view.details;
  const lines: string[] = [];
  if (view.seats === null) lines.push(`${plural(view.seatsUsed, 'seat')} used, no limit`);
  else if (view.seatsUsed > view.seats) lines.push(`${plural(view.seatsUsed, 'seat')} used, ${view.seats} included`);
  else lines.push(`${view.seatsUsed} of ${plural(view.seats, 'seat')} used`);
  if (view.plan === 'comp') lines.push('Free of charge');
  else if (renewalDue(view)) lines.push('Renewal due');
  else if (view.status === 'active' && view.periodEnd) {
    if (view.cancelAtPeriodEnd) lines.push(`Ends ${day(view.periodEnd)}`);
    else if (d && !d.autoRenew) lines.push(`Paid until ${day(view.periodEnd)}`);
    else lines.push(`Renews ${day(view.periodEnd)}`);
  }
  return (
    <section className="billing-plan">
      <div className="billing-plan-head">
        <strong>{PLAN_NAMES[view.plan]} plan</strong>
        {pill && <span className={`billing-pill ${pill.tone}`}>{pill.text}</span>}
      </div>
      <p className="muted small">{lines.join(' · ')}</p>
      {view.seatsNext !== null && view.status === 'active' && !view.cancelAtPeriodEnd && view.periodEnd && (
        <p className="muted small">
          {renewalDue(view) ? 'At the renewal' : `From ${day(view.periodEnd)}`}: {plural(view.seatsNext, 'seat')}
        </p>
      )}
      {d && view.status === 'active' && view.periodEnd && !view.cancelAtPeriodEnd && d.autoRenew && d.nextAmount !== null && (
        <p className="muted small">
          Next payment: {formatMoney(d.nextAmount)} {renewalDue(view) ? 'now' : `on ${day(view.periodEnd)}`}
        </p>
      )}
      {d && d.carry < 0 && <p className="muted small">Credit: {formatMoney(-d.carry)} off your next payment</p>}
      {d && d.carry > 0 && <p className="muted small">{formatMoney(d.carry)} goes on your next payment</p>}
    </section>
  );
}

/** Upgrading from Free, paying for a help desk, opening a paused workspace again, or choosing a plan at launch. */
function Subscribe({ view, busy, onPay }: { view: BillingView; busy: boolean; onPay: (seats: number) => void }) {
  const support = useStore((s) => s.kind === 'support');
  const prices = useBilling(pricesOf);
  const oneMore = useBilling((s) => s.oneMore);
  const min = Math.max(view.seatsUsed, 1);
  // From "Add seats": room for the person who didn't fit. Never paid for: the seats in use. Otherwise
  // what it had (or was lowered to).
  const start =
    oneMore && view.seats !== null && view.seatsUsed >= view.seats
      ? view.seatsUsed + 1
      : view.status === 'incomplete' || view.graceReason === 'launch'
        ? min
        : Math.max(min, view.seatsNext ?? view.seats ?? min);
  const [seats, setSeats] = useState(start);
  // Again when the plan changes (people added or removed meanwhile).
  const [was, setWas] = useState(start);
  if (was !== start) {
    setWas(start);
    setSeats(start);
  }
  if (!prices) return null;
  const unit = support ? prices.prices.support : prices.prices.team;
  const count = Math.max(seats, min);
  const total = unit * count;
  const heading =
    view.status === 'free' ? 'Upgrade to Team' : view.status === 'incomplete' ? 'Pay to open your help desk' : view.status === 'locked' ? 'Pay to open it again' : 'Choose a plan';
  return (
    <section className="billing-block">
      <h4>{heading}</h4>
      <p className="muted small">
        {support
          ? `${formatMoney(Math.round(unit / 12))} per seat a month, billed yearly. A seat is for each of your staff, you included; customers don’t need one.`
          : `${formatMoney(unit)} per seat a month. Every seat is charged, yours included, and up to ${prices.guestCaps.team} guests can come in at once.`}
      </p>
      {!support && view.status !== 'free' && (
        <p className="muted small">Or keep it free: remove people until {FREE_SEATS} or fewer are left (open invitations count).</p>
      )}
      <div className="billing-seats">
        <SeatPicker value={count} min={min} onChange={setSeats} />
        <span className="small">{support ? `${formatMoney(unit)} × ${count} = ${formatMoney(total)} a year` : `${formatMoney(total)} a month`}</span>
      </div>
      <button className="btn primary" disabled={busy} onClick={() => onPay(count)}>
        {view.status === 'free' ? `Upgrade for ${formatMoney(total)}` : `Pay ${formatMoney(total)}`}
      </button>
      <p className="muted small">{CARD_HINT} You pay on Paystack, then come back here.</p>
    </section>
  );
}

/**
 * A payment that's due: a failed renewal, one the bank must confirm, no card, or a cancelled plan
 * (which can be resumed while its renewal hasn't been tried). `busy` also covers an unconfirmed email,
 * which paying needs (trying the saved card again and resuming don't).
 */
function PayDue({
  view,
  details,
  busy,
  changing,
  onPay,
  onRetry,
  onResume,
}: {
  view: BillingView;
  details: BillingDetails;
  busy: boolean;
  changing: boolean;
  onPay: () => void;
  onRetry: () => void;
  onResume: () => void;
}) {
  const reason = view.graceReason;
  // A failed renewal can try the saved card again.
  const retry = reason === 'payment_failed' ? details.card : null;
  const confirmUrl = reason === 'action_needed' ? details.actionUrl : null;
  const another = reason === 'payment_failed' || reason === 'action_needed';
  // Resumed, the saved card pays the renewal.
  const resume = reason === 'cancelled' && !!details.card;
  const due = details.due;
  // The seats the renewal is for: the lowered number, never fewer than are in use.
  const seats = Math.max(view.seatsNext ?? view.seats ?? 1, view.seatsUsed, 1);
  return (
    <section className="billing-block">
      {due !== null && (
        <p>
          <strong>{formatMoney(due)}</strong> {reason === 'cancelled' ? 'keeps it going' : 'is due'}, for {plural(seats, 'seat')}.
        </p>
      )}
      <div className="billing-actions">
        {confirmUrl && (
          <a className="btn primary" href={confirmUrl} target="_blank" rel="noopener noreferrer">
            Confirm with your bank <ExternalIcon size={16} />
          </a>
        )}
        {retry && (
          <button className="btn primary" disabled={changing} onClick={onRetry}>
            Try {cardName(retry)} again
          </button>
        )}
        <button className={`btn${retry || confirmUrl ? '' : ' primary'}`} disabled={busy} onClick={onPay}>
          {another ? 'Pay with another card' : due === null ? 'Pay' : `Pay ${formatMoney(due)}`}
        </button>
        {resume && (
          <button className="btn" disabled={changing} onClick={onResume}>
            Resume plan
          </button>
        )}
      </div>
      <p className="muted small">{CARD_HINT}</p>
    </section>
  );
}

/** More seats (charged now for the rest of the period) or fewer (from the renewal). */
function Seats({ view, details, busy, onChange }: { view: BillingView; details: BillingDetails; busy: boolean; onChange: (seats: number) => void }) {
  const support = useStore((s) => s.kind === 'support');
  const oneMore = useBilling((s) => s.oneMore);
  const bought = view.seats ?? 1;
  const min = Math.max(view.seatsUsed, 1);
  // The seats from the renewal on.
  const planned = Math.max(view.seatsNext ?? bought, min);
  // From "Add seats": room for the person who didn't fit.
  const start = oneMore && view.seatsUsed >= bought ? view.seatsUsed + 1 : planned;
  const [seats, setSeats] = useState(start);
  // After a change, here or elsewhere (people added or removed too).
  const [was, setWas] = useState(start);
  if (was !== start) {
    setWas(start);
    setSeats(start);
  }
  const unit = details.unitAmount;
  const each = per(view.interval);
  const renewal = view.periodEnd && !renewalDue(view) ? day(view.periodEnd) : 'the renewal';
  let note: string | null = null;
  let label: string | null = null;
  if (seats > bought) {
    const added = plural(seats - bought, 'seat');
    const cost = addSeatsCost(view, seats - bought, unit);
    label = `Add ${added}`;
    if (cost === 'renewal') note = renewalDue(view) ? 'Added now; the renewal that’s due includes them.' : `Added now; your next payment on ${renewal} includes them.`;
    else if ('carry' in cost) note = `Added now; ${formatMoney(cost.carry)} goes on your next payment.`;
    else {
      // The card is charged on this tap: the button says how much.
      note = `Charged to your card now, for the rest of this period. Then ${formatMoney(seats * unit)} ${each}.`;
      label = `Pay ${formatMoney(cost.now)} and add ${added}`;
    }
  } else if (seats !== planned) {
    note = `From ${renewal}: ${plural(seats, 'seat')}, ${formatMoney(seats * unit)} ${each}. If more people are in by then, the renewal charges for them.`;
    label = seats === bought ? `Keep ${plural(seats, 'seat')}` : `Lower to ${plural(seats, 'seat')}`;
  }
  const needsCard = seats > bought && !details.card;
  return (
    <section className="billing-block">
      <h4>Seats</h4>
      <p className="muted small">
        One for each member and open invitation; {support ? 'customers' : 'guests'} don’t need one. {formatMoney(unit)} per seat {each}.
      </p>
      <SeatPicker value={seats} min={min} onChange={setSeats} />
      {note && <p className="small">{note}</p>}
      {needsCard && <p className="muted small">Add a card first.</p>}
      {label && (
        <button className="btn primary" disabled={busy || needsCard} onClick={() => onChange(seats)}>
          {label}
        </button>
      )}
    </section>
  );
}

function Card({ view, details, busy, onPay }: { view: BillingView; details: BillingDetails; busy: boolean; onPay: () => void }) {
  const card = details.card;
  return (
    <section className="billing-block">
      <h4>Card</h4>
      {card ? (
        <p className="billing-card">
          <CreditCardIcon size={20} />
          <strong>{cardName(card)}</strong>
          <span className="muted small">
            Expires {String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}
          </span>
        </p>
      ) : (
        <p className="muted small">No card yet{view.status === 'active' ? ': add one so the plan renews.' : '.'}</p>
      )}
      {details.paystackEmail && <p className="muted small">Billing email: {details.paystackEmail}</p>}
      {view.status === 'active' && (
        <>
          <button className="btn small" disabled={busy} onClick={onPay}>
            {card ? 'Update card' : 'Add a card'}
          </button>
          <p className="muted small">
            {formatMoney(MIN_CHARGE)} to check the card, taken off your next payment. {CARD_HINT}
          </p>
        </>
      )}
    </section>
  );
}

/** Cancel the plan (it runs to the end of the period), or resume it before then. */
function Ending({ view, busy, onCancel, onResume }: { view: BillingView; busy: boolean; onCancel: () => void; onResume: () => void }) {
  const support = useStore((s) => s.kind === 'support');
  const end = view.periodEnd ? day(view.periodEnd) : 'the end of the period';
  if (view.cancelAtPeriodEnd) {
    return (
      <section className="billing-block">
        <p className="muted small">The plan ends on {end}.</p>
        <button className="btn small" disabled={busy} onClick={onResume}>
          Resume plan
        </button>
      </section>
    );
  }
  // Its renewal due, cancelling ends it now: the renewal isn't charged.
  const due = renewalDue(view);
  const pauses = due && view.periodEnd ? `on ${day(view.periodEnd + GRACE_DAYS * DAY)}` : `${GRACE_DAYS} days later`;
  const after = support
    ? `The help desk pauses ${pauses}.`
    : `Then the workspace is free again if it has ${FREE_SEATS} people or fewer; otherwise it pauses ${pauses}.`;
  const ask = due ? `Cancel the plan? It ends now, and your card isn’t charged for the renewal. ${after}` : `Cancel the plan? It stays on until ${end}. ${after}`;
  return (
    <section className="billing-block">
      <button className="btn small danger" disabled={busy} onClick={() => confirm(ask) && onCancel()}>
        Cancel plan
      </button>
    </section>
  );
}

function History({ charges, onPrint }: { charges: BillingReceipt[]; onPrint: (charge: BillingReceipt) => void }) {
  // Paystack wouldn't refund a payment we're giving back: it's refunded by hand.
  const refused = charges.some((c) => c.refund === 'refused');
  return (
    <section className="billing-block">
      <h4>Payments</h4>
      {refused && <p className="muted small">Paystack didn’t refund a payment we owe you. Contact support to get it back.</p>}
      <ul className="billing-history">
        {charges.map((c) => (
          <li key={c.reference}>
            <span className="billing-history-what">
              <strong>{PURPOSES[c.purpose]}</strong>
              <span className="muted small">{[day(c.settledAt ?? c.createdAt), seatsOf(c)].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="billing-history-amount">
              <strong>{formatMoney(c.amount)}</strong>
              <span className="muted small">{chargeStatus(c)}</span>
            </span>
            {(c.status === 'succeeded' || c.status === 'refunded') && (
              <button className="icon-btn" title="Print receipt" aria-label={`Print the receipt for ${formatMoney(c.amount)}`} onClick={() => onPrint(c)}>
                <PrintIcon size={18} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The seats a charge was for: added seats are charged for the rest of the period, a card check for none. */
function seatsOf(c: BillingReceipt): string | null {
  if (c.purpose === 'card_update') return null;
  return c.purpose === 'seats' ? `${plural(c.seats, 'seat')} in all` : plural(c.seats, 'seat');
}

/** A receipt, printed on its own (the rest of the page is hidden while printing). */
function Receipt({ charge, email }: { charge: BillingReceipt; email: string | null }) {
  const office = useStore((s) => s.office?.settings.name ?? '');
  const date = (ts: number) => new Date(ts).toLocaleDateString(undefined, { dateStyle: 'long' });
  const until = charge.periodEnd ? date(charge.periodEnd) : null;
  let what = PURPOSES[charge.purpose];
  if (charge.purpose === 'seats') what += `: ${charge.seats} seats in all${until ? `, to ${until}` : ''}`;
  else if (charge.purpose !== 'card_update') {
    what += `: ${plural(charge.seats, 'seat')} × ${formatMoney(charge.unitAmount)}`;
    if (charge.periodStart && until) what += `, ${date(charge.periodStart)} to ${until}`;
  }
  return createPortal(
    <div className="billing-receipt">
      <p className="billing-receipt-brand">
        <span className="brand">
          <Logo size={18} />
        </span>
      </p>
      <h1>Receipt</h1>
      <dl>
        <dt>Workspace</dt>
        <dd>{office}</dd>
        <dt>Date</dt>
        <dd>{date(charge.settledAt ?? charge.createdAt)}</dd>
        <dt>For</dt>
        <dd>{what}</dd>
        <dt>Amount</dt>
        <dd>{formatMoney(charge.amount)}</dd>
        {charge.card && (
          <>
            <dt>Paid with</dt>
            <dd>{cardName(charge.card)}</dd>
          </>
        )}
        {email && (
          <>
            <dt>Billed to</dt>
            <dd>{email}</dd>
          </>
        )}
        <dt>Reference</dt>
        <dd>{charge.reference}</dd>
        <dt>Status</dt>
        <dd>{chargeStatus(charge)}</dd>
      </dl>
    </div>,
    document.body,
  );
}

/** The owner's controls. */
function OwnerBilling({ officeId, view, details }: { officeId: string; view: BillingView; details: BillingDetails }) {
  const verified = useStore((s) => !!s.account?.emailVerified);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const [printing, setPrinting] = useState<BillingReceipt | null>(null);

  // An error about the plan as it was (a declined retry, before it paused) no longer applies.
  useEffect(() => setError(null), [view.status, view.graceReason]);

  useEffect(() => {
    if (!printing) return;
    const done = () => {
      document.body.classList.remove('billing-printing');
      setPrinting(null);
    };
    document.body.classList.add('billing-printing');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => window.removeEventListener('afterprint', done);
  }, [printing]);

  const failed = (err: unknown) => {
    setError(
      err instanceof ApiError && err.code === 'action-needed' && err.url ? (
        <>
          {err.message}{' '}
          <a href={err.url} target="_blank" rel="noopener noreferrer">
            Confirm with your bank
          </a>
        </>
      ) : (
        errorText(err)
      ),
    );
    setBusy(false);
    // It may have moved on meanwhile (a renewal, someone added).
    void refreshBilling();
  };
  /** A change that answers the plan as it is now. */
  const change = async (run: () => Promise<BillingView>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      useBilling.setState({ view: await run() });
      if (done) toast(done);
      setBusy(false);
    } catch (err) {
      failed(err);
    }
  };
  /** Off to Paystack (busy until the page goes). */
  const pay = async (seats?: number) => {
    setBusy(true);
    setError(null);
    try {
      location.assign((await startCheckout(officeId, seats)).url);
    } catch (err) {
      failed(err);
    }
  };

  const subscribing = view.status === 'free' || view.status === 'incomplete' || view.status === 'locked' || view.graceReason === 'launch';
  const charges = details.charges.filter(listed);
  const paying = busy || !verified;
  return (
    <>
      {!verified && (
        <p className="ws-note">
          <AlertIcon size={16} />
          <span>
            Confirm your email address in your{' '}
            <button className="link-btn" onClick={() => setState({ modal: 'profile' })}>
              profile
            </button>{' '}
            to pay.
          </span>
        </p>
      )}
      {subscribing ? (
        <Subscribe view={view} busy={paying} onPay={(seats) => void pay(seats)} />
      ) : view.status === 'past_due' ? (
        <PayDue
          view={view}
          details={details}
          busy={paying}
          changing={busy}
          onPay={() => void pay()}
          onRetry={() => void change(() => retryPayment(officeId))}
          onResume={() => void change(() => resumePlan(officeId), 'Plan resumed')}
        />
      ) : (
        <Seats view={view} details={details} busy={paying} onChange={(seats) => void change(() => changeSeats(officeId, seats), 'Seats updated')} />
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!subscribing && <Card view={view} details={details} busy={paying} onPay={() => void pay()} />}
      {view.status === 'active' && (
        <Ending
          view={view}
          busy={busy}
          onCancel={() => void change(() => cancelPlan(officeId), 'Plan cancelled')}
          onResume={() => void change(() => resumePlan(officeId), 'Plan resumed')}
        />
      )}
      {charges.length > 0 && <History charges={charges} onPrint={setPrinting} />}
      {printing && <Receipt charge={printing} email={details.paystackEmail} />}
    </>
  );
}

export function BillingSection() {
  const officeId = useStore((s) => s.officeId);
  const owner = useStore((s) => may(s.role, 'billing'));
  const view = useBilling((s) => s.view);
  const failed = useBilling((s) => s.error);
  // Fresh each time it opens (people may have come and gone).
  useEffect(() => void refreshBilling(), []);
  if (!officeId) return null;
  if (!view) return failed ? <p className="form-error">{failed}</p> : <p className="muted">Loading…</p>;
  const problem = problemOf(view, owner);
  return (
    <div className="billing">
      <Plan view={view} />
      {problem && (
        <p className={`billing-notice${view.status === 'locked' ? ' locked' : ''}`} role="status">
          <AlertIcon size={18} />
          <span>{problem}</span>
        </p>
      )}
      {!owner ? (
        <p className="muted small">Only the owner can change billing.</p>
      ) : view.details && view.plan !== 'comp' ? (
        <OwnerBilling officeId={officeId} view={view} details={view.details} />
      ) : null}
    </div>
  );
}
