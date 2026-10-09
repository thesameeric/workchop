import { FREE_SEATS, GRACE_DAYS, GUEST_CAPS, LAUNCH_DAYS, LOCKED_STAFF_CAP, RETRY_DAYS, type BillingPlan, type BillingStatus, type GraceReason } from '../../../shared/billing';
import type { OfficeKind } from '../../../shared/workspace';
import type { SeatLimit } from '../../features';

// What an office's plan means right now: worked out from its stored row and the time, never from a
// timer having run, so a missed renewal run can't let anyone in or keep them out by mistake. Pure
// functions only (tests/billing.test.ts).

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export type Interval = 'month' | 'year';

/** A billing_accounts row, with times in ms and amounts as numbers. */
export interface Account {
  status: BillingStatus;
  comp: boolean;
  seats: number;
  seatsNext: number | null;
  unitAmount: number | null;
  interval: Interval | null;
  anchorAt: number | null;
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  autoRenew: boolean;
  graceReason: GraceReason | null;
  graceEndsAt: number | null;
  retryCount: number;
  nextRetryAt: number | null;
  carry: number;
  payerUserId: string | null;
  /** A saved card (its authorization code) to charge. */
  hasCard: boolean;
}

export interface Facts {
  kind: OfficeKind;
  /** Seats in use (members and open invitations). */
  used: number;
  ownerId: string | null;
  now: number;
  /** Made before billing was switched on, and still within LAUNCH_DAYS of it. */
  preLaunch: boolean;
}

export interface Effective {
  plan: BillingPlan;
  status: BillingStatus;
  /** Why it's past due (null while a renewal is simply due). */
  graceReason: GraceReason | null;
  graceEndsAt: number | null;
  /** The period is over and the saved card is to be charged (not a problem to show). */
  renewing: boolean;
  seatLimit: SeatLimit;
  /** Guests at once; null: the server's default (support customers always get that). */
  guestCap: number | null;
  /** Only the owner and admins may come in. */
  locked: boolean;
}

const free = (f: Facts): Effective => ({
  plan: 'free',
  status: 'free',
  graceReason: null,
  graceEndsAt: null,
  renewing: false,
  seatLimit: FREE_SEATS,
  // Workspaces from before billing keep their guests while they choose a plan.
  guestCap: f.preLaunch ? null : GUEST_CAPS.free,
  locked: false,
});

/**
 * An office's plan now. In order: no row (team: free; support: unpaid), complimentary, paid up, then
 * a period that ended (cancelled, no card to renew with, or due for renewal) with GRACE_DAYS to pay,
 * past due until the grace ends, then locked. A renewal that hasn't been tried yet never locks (a
 * missed run mustn't keep anyone out). A team that has FREE_SEATS or fewer people is free instead of
 * locked, or of past due when the plan simply ended (cancelled, no card, or never chosen); a failed
 * renewal keeps its retries until the grace ends.
 */
export function effective(a: Account | null, f: Facts): Effective {
  const team = f.kind === 'team';
  if (!a) {
    if (team) return free(f);
    return { plan: 'support', status: 'incomplete', graceReason: null, graceEndsAt: null, renewing: false, seatLimit: FREE_SEATS, guestCap: null, locked: true };
  }
  if (a.comp) return { plan: 'comp', status: 'active', graceReason: null, graceEndsAt: null, renewing: false, seatLimit: null, guestCap: null, locked: false };
  let status = a.status;
  let graceReason = a.graceReason;
  let graceEndsAt = a.graceEndsAt;
  let renewing = false;
  if (status === 'active' && a.periodEnd !== null && f.now >= a.periodEnd) {
    status = 'past_due';
    graceEndsAt = a.periodEnd + GRACE_DAYS * DAY;
    if (a.cancelAtPeriodEnd) graceReason = 'cancelled';
    // Never charged to anyone but the owner (after a transfer, the new owner adds a card).
    else if (!a.hasCard || !a.autoRenew || !f.ownerId || a.payerUserId !== f.ownerId) graceReason = 'no_card';
    else {
      graceReason = null;
      renewing = true;
    }
  }
  if (status === 'past_due' && !renewing && (graceEndsAt === null || f.now >= graceEndsAt)) status = 'locked';
  const ended = status === 'past_due' && (graceReason === 'cancelled' || graceReason === 'no_card' || graceReason === 'launch');
  if (team && (status === 'locked' || ended) && f.used <= FREE_SEATS) return free(f);
  if (status === 'free') return free(f);
  const plan: BillingPlan = team ? 'team' : 'support';
  const locked = status === 'locked' || status === 'incomplete';
  const paidSeats = a.seats > 0 ? a.seats : FREE_SEATS;
  return {
    plan,
    status,
    graceReason: status === 'past_due' ? graceReason : null,
    graceEndsAt: status === 'past_due' ? graceEndsAt : null,
    renewing: renewing && status === 'past_due',
    seatLimit: status === 'locked' ? 'locked' : status === 'incomplete' ? FREE_SEATS : paidSeats,
    guestCap: team && !locked && !f.preLaunch ? GUEST_CAPS.team : null,
    locked,
  };
}

/** People at once while locked or unpaid (the owner always gets in). */
export const staffCapOf = (e: Effective) => (e.locked ? LOCKED_STAFF_CAP : null);

/** Whether a pre-launch office is still within its launch window. */
export const inLaunchWindow = (officeCreatedAt: number, launchedAt: number | null, now: number) =>
  launchedAt !== null && officeCreatedAt <= launchedAt && now < launchedAt + LAUNCH_DAYS * DAY;

const monthsOf = (interval: Interval) => (interval === 'year' ? 12 : 1);

/**
 * `n` intervals after `anchor` (UTC), keeping the anchor's day of the month where the month has it and
 * the month's last day where it doesn't: Jan 31 + 1 month is Feb 28 (or 29), + 2 months is Mar 31.
 */
export function addInterval(anchor: number, n: number, interval: Interval): number {
  const d = new Date(anchor);
  const month = d.getUTCMonth() + n * monthsOf(interval);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** The end of the period after the one ending at `periodEnd`, counted from the anchor (no drift). */
export function nextPeriodEnd(anchor: number, periodEnd: number, interval: Interval): number {
  const a = new Date(anchor);
  const e = new Date(periodEnd);
  const months = (e.getUTCFullYear() - a.getUTCFullYear()) * 12 + e.getUTCMonth() - a.getUTCMonth();
  return addInterval(anchor, Math.round(months / monthsOf(interval)) + 1, interval);
}

/**
 * What `seats` more seats cost for the rest of the period [start, end) from `now`, rounded up to the
 * kobo. In BigInt: 500 seats × ₦180,000 × the milliseconds in a year is far past 2^53.
 */
export function prorate(seats: number, unit: number, now: number, start: number, end: number): number {
  const length = BigInt(Math.max(1, end - start));
  const left = BigInt(Math.min(Math.max(0, end - now), end - start));
  return Number((BigInt(seats) * BigInt(unit) * left + length - 1n) / length);
}

/**
 * When to try a failed renewal again: the next of RETRY_DAYS after T0 (when its grace started) that is
 * still to come, so an extra try by the owner doesn't use one up; null after the last.
 */
export function nextRetry(t0: number, now: number): number | null {
  for (const days of RETRY_DAYS) if (t0 + days * DAY > now) return t0 + days * DAY;
  return null;
}

/** Declines that trying again won't fix. */
export const hardDecline = (gatewayResponse: string) => /expired|lost|stolen|invalid card|restricted/i.test(gatewayResponse);

/** Seats a renewal charges for: the lowered number if there is one, never fewer than are in use, at least 1. */
export const renewalSeats = (a: Pick<Account, 'seats' | 'seatsNext'>, used: number) => Math.max(a.seatsNext ?? a.seats, used, 1);
