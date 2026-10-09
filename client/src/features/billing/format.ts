import { FREE_SEATS, MIN_CHARGE, type BillingPlan, type BillingReceipt, type BillingSummary, type ChargePurpose, type ChargeStatus, type RefundState } from '../../../../shared/billing';

export const PLAN_NAMES: Record<BillingPlan, string> = { free: 'Free', team: 'Team', support: 'Customer support', comp: 'Complimentary' };

export const PURPOSES: Record<ChargePurpose, string> = {
  subscribe: 'New plan',
  pay_due: 'Overdue payment',
  renewal: 'Renewal',
  seats: 'Added seats',
  card_update: 'New card',
};

const CHARGE_STATUSES: Record<ChargeStatus, string> = {
  pending: 'Pending',
  succeeded: 'Paid',
  failed: 'Failed',
  abandoned: 'Not finished',
  action_needed: 'Needs your bank',
  superseded: 'Paid twice',
  refunded: 'Refunded',
};

const REFUNDS: Record<RefundState, string> = {
  due: 'Paid twice · refund due',
  requested: 'Paid twice · refunding',
  refused: 'Paid twice · refund needs attention',
};

/** What became of a charge; a payment made twice says where its refund is. */
export const chargeStatus = (c: BillingReceipt) => (c.status === 'superseded' && c.refund ? REFUNDS[c.refund] : CHARGE_STATUSES[c.status]);

/** "12 Nov", with the year when it isn't this one. */
export function day(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year });
}

export const per = (interval: 'month' | 'year' | null) => (interval === 'year' ? 'a year' : 'a month');

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What needs doing about a workspace's plan, for its owner (`owner`, who pays) and admins (who can't);
 * null when nothing.
 */
export function problemOf(s: BillingSummary, owner: boolean): string | null {
  if (s.status === 'incomplete') return `Customers can’t come in until ${owner ? 'you pay' : 'the owner pays'}.`;
  if (s.status === 'locked') return 'Paused: only the owner and admins can come in.';
  if (s.status !== 'past_due' || !s.graceEndsAt) return null;
  const by = day(s.graceEndsAt);
  // Unpaid by then, a team small enough for the Free plan goes on it instead of pausing.
  const then = s.plan === 'team' && s.seatsUsed <= FREE_SEATS ? `It goes on the Free plan on ${by}.` : `Locks on ${by}.`;
  switch (s.graceReason) {
    case 'payment_failed':
      return `Payment failed. ${then}`;
    case 'action_needed':
      return `${owner ? 'Your' : 'The owner’s'} bank needs to confirm the payment. ${then}`;
    case 'no_card':
      return owner ? `Add a card before ${by}.` : `The owner needs to add a card before ${by}.`;
    case 'cancelled':
      return `Plan ended. Locks on ${by}.`;
    case 'launch':
      return owner ? `Choose a plan by ${by}.` : `The owner needs to choose a plan by ${by}.`;
    default:
      // Renewing right now.
      return null;
  }
}

/**
 * What adding `added` seats now costs, as the server works it out: the rest of the period, rounded up
 * to the kobo; 'renewal' in its last hour (the renewal bills them), `carry` under ₦50 (added to it).
 */
export function addSeatsCost(s: BillingSummary, added: number, unit: number, now = Date.now()): { now: number } | { carry: number } | 'renewal' {
  const { periodStart: start, periodEnd: end } = s;
  if (start === null || end === null || end - now < 3_600_000) return 'renewal';
  const len = BigInt(Math.max(1, end - start));
  const left = BigInt(Math.min(end - now, end - start));
  const cost = Number((BigInt(added) * BigInt(unit) * left + len - 1n) / len);
  return cost < MIN_CHARGE ? { carry: cost } : { now: cost };
}

// Checkouts are paid on Paystack's page: until one is, nothing was charged.
const CHECKOUTS = new Set<ChargePurpose>(['subscribe', 'pay_due', 'card_update']);

/**
 * Whether a charge belongs in the payments list: all but checkouts that weren't paid (left on Paystack's
 * page, or Paystack couldn't be reached). Renewals and added seats go on the saved card, so a failed
 * one is listed.
 */
export const listed = (c: BillingReceipt) => !CHECKOUTS.has(c.purpose) || c.status === 'succeeded' || c.status === 'superseded' || c.status === 'refunded';
