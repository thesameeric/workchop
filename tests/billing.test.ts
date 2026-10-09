import { describe, expect, it } from 'vitest';
import { addSeatsCost } from '../client/src/features/billing/format';
import { DEFAULT_PRICES, formatMoney, FREE_SEATS, GRACE_DAYS, GUEST_CAPS, LAUNCH_DAYS, MIN_CHARGE, type BillingSummary } from '../shared/billing';
import { billingConfig, parsePrice } from '../server/features/billing/config';
import { addInterval, DAY, effective, hardDecline, inLaunchWindow, nextPeriodEnd, nextRetry, prorate, renewalSeats, staffCapOf, type Account, type Facts } from '../server/features/billing/state';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe('periods', () => {
  it('add months and years from an anchor, keeping the day where the month has it', () => {
    const jan31 = at('2026-01-31T10:00:00.000Z');
    expect(iso(addInterval(jan31, 1, 'month'))).toBe('2026-02-28T10:00:00.000Z');
    expect(iso(addInterval(jan31, 2, 'month'))).toBe('2026-03-31T10:00:00.000Z');
    expect(iso(addInterval(jan31, 3, 'month'))).toBe('2026-04-30T10:00:00.000Z');
    expect(iso(addInterval(at('2027-12-31T00:00:00.000Z'), 2, 'month'))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(addInterval(at('2028-02-29T08:30:00.000Z'), 1, 'year'))).toBe('2029-02-28T08:30:00.000Z');
    expect(iso(addInterval(at('2028-02-29T08:30:00.000Z'), 4, 'year'))).toBe('2032-02-29T08:30:00.000Z');
    expect(iso(addInterval(at('2026-11-15T00:00:00.000Z'), 2, 'month'))).toBe('2027-01-15T00:00:00.000Z');
  });

  it('count the next period from the anchor, so a short month never shifts the day', () => {
    const anchor = at('2026-01-31T10:00:00.000Z');
    let end = addInterval(anchor, 1, 'month');
    const ends = [];
    for (let i = 0; i < 4; i++) {
      end = nextPeriodEnd(anchor, end, 'month');
      ends.push(iso(end).slice(0, 10));
    }
    expect(ends).toEqual(['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    const leap = at('2028-02-29T00:00:00.000Z');
    expect(iso(nextPeriodEnd(leap, addInterval(leap, 3, 'year'), 'year')).slice(0, 10)).toBe('2032-02-29');
  });
});

describe('prorating added seats', () => {
  const start = at('2026-01-01T00:00:00.000Z');
  const end = at('2027-01-01T00:00:00.000Z');

  it('is exact for big numbers (worked out in BigInt)', () => {
    const now = start + 1;
    const exact = (500n * 18_000_000n * BigInt(end - now) + BigInt(end - start) - 1n) / BigInt(end - start);
    expect(BigInt(prorate(500, 18_000_000, now, start, end))).toBe(exact);
    // In plain numbers the product is past 2^53.
    expect(500 * 18_000_000 * (end - now)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(prorate(500, 18_000_000, start, start, end)).toBe(9_000_000_000);
  });

  it('rounds up to the kobo, and is nothing at the end', () => {
    const mid = start + (end - start) / 2;
    expect(prorate(1, 750_000, mid, start, end)).toBe(375_000);
    expect(prorate(1, 3, mid, start, end)).toBe(2);
    expect(prorate(3, 750_000, end, start, end)).toBe(0);
    expect(prorate(3, 750_000, end + DAY, start, end)).toBe(0);
  });

  it('can come to less than Paystack charges near the end (added to the next renewal)', () => {
    const month = { start: at('2026-03-01T00:00:00.000Z'), end: at('2026-04-01T00:00:00.000Z') };
    expect(prorate(1, 750_000, month.end - 3 * 3600_000, month.start, month.end)).toBeLessThan(MIN_CHARGE);
    expect(prorate(1, 750_000, month.end - 3 * DAY, month.start, month.end)).toBeGreaterThanOrEqual(MIN_CHARGE);
  });
});

describe('renewals', () => {
  it('are tried again after 1, 3 and 6 days, then not', () => {
    const t0 = at('2026-05-01T06:00:00.000Z');
    expect([t0, t0 + DAY, t0 + 3 * DAY, t0 + 6 * DAY].map((now) => nextRetry(t0, now))).toEqual([t0 + DAY, t0 + 3 * DAY, t0 + 6 * DAY, null]);
    // A try in between (the owner's) doesn't use one up.
    expect(nextRetry(t0, t0 + 2 * 3600_000)).toBe(t0 + DAY);
    // The last try is before the lock.
    expect(t0 + 6 * DAY).toBeLessThan(t0 + GRACE_DAYS * DAY);
  });

  it('charge for the lowered seats, never fewer than are in use', () => {
    expect(renewalSeats({ seats: 6, seatsNext: null }, 4)).toBe(6);
    expect(renewalSeats({ seats: 6, seatsNext: 4 }, 3)).toBe(4);
    expect(renewalSeats({ seats: 6, seatsNext: 4 }, 5)).toBe(5);
    expect(renewalSeats({ seats: 0, seatsNext: null }, 0)).toBe(1);
  });

  it('stop retrying cards that won’t work again', () => {
    expect(hardDecline('Expired Card')).toBe(true);
    expect(hardDecline('Lost card, pick up')).toBe(true);
    expect(hardDecline('Insufficient Funds')).toBe(false);
  });
});

describe('the plan an office is on', () => {
  const now = at('2026-06-15T12:00:00.000Z');
  const owner = 'u-owner';
  const facts = (more: Partial<Facts> = {}): Facts => ({ kind: 'team', used: 5, ownerId: owner, now, preLaunch: false, ...more });
  const paid = (more: Partial<Account> = {}): Account => ({
    status: 'active',
    comp: false,
    seats: 6,
    seatsNext: null,
    unitAmount: 750_000,
    interval: 'month',
    anchorAt: at('2026-05-20T00:00:00.000Z'),
    periodStart: at('2026-05-20T00:00:00.000Z'),
    periodEnd: at('2026-06-20T00:00:00.000Z'),
    cancelAtPeriodEnd: false,
    autoRenew: true,
    graceReason: null,
    graceEndsAt: null,
    retryCount: 0,
    nextRetryAt: null,
    carry: 0,
    payerUserId: owner,
    hasCard: true,
    ...more,
  });
  const ended = at('2026-06-10T00:00:00.000Z');

  it.each<[string, Account | null, Partial<Facts>, Record<string, unknown>]>([
    ['a team without a row is free', null, {}, { plan: 'free', status: 'free', seatLimit: FREE_SEATS, guestCap: GUEST_CAPS.free, locked: false }],
    ['a support workspace without a row is unpaid and locked', null, { kind: 'support' }, { plan: 'support', status: 'incomplete', seatLimit: FREE_SEATS, guestCap: null, locked: true }],
    ['a paid team', paid(), {}, { plan: 'team', status: 'active', seatLimit: 6, guestCap: GUEST_CAPS.team, locked: false, renewing: false }],
    ['a paid support workspace (customers aren’t capped)', paid({ interval: 'year' }), { kind: 'support' }, { plan: 'support', status: 'active', guestCap: null }],
    ['complimentary', paid({ comp: true, status: 'free' }), {}, { plan: 'comp', status: 'active', seatLimit: null, guestCap: null, locked: false }],
    ['comp never locks', paid({ comp: true, status: 'locked' }), {}, { plan: 'comp', locked: false }],
    ['a period that ended is renewing (no banner)', paid({ periodEnd: ended }), {}, { status: 'past_due', renewing: true, graceReason: null, graceEndsAt: ended + GRACE_DAYS * DAY, locked: false }],
    ['ended and cancelled', paid({ periodEnd: ended, cancelAtPeriodEnd: true }), {}, { status: 'past_due', graceReason: 'cancelled', renewing: false }],
    ['ended without a card', paid({ periodEnd: ended, hasCard: false }), {}, { status: 'past_due', graceReason: 'no_card' }],
    ['ended with auto-renew off', paid({ periodEnd: ended, autoRenew: false }), {}, { status: 'past_due', graceReason: 'no_card' }],
    ['ended with a card that isn’t the owner’s', paid({ periodEnd: ended, payerUserId: 'u-old' }), {}, { status: 'past_due', graceReason: 'no_card' }],
    ['a renewal never tried doesn’t lock, however late', paid({ periodEnd: now - (GRACE_DAYS + 1) * DAY }), {}, { status: 'past_due', renewing: true, locked: false }],
    ['ended without a card more than the grace ago: locked', paid({ periodEnd: now - (GRACE_DAYS + 1) * DAY, hasCard: false }), {}, { status: 'locked', seatLimit: 'locked', locked: true, guestCap: null }],
    ['past due', paid({ status: 'past_due', graceReason: 'payment_failed', graceEndsAt: now + DAY, periodEnd: ended }), {}, { status: 'past_due', graceReason: 'payment_failed', seatLimit: 6, locked: false }],
    ['past due past its grace: locked', paid({ status: 'past_due', graceReason: 'payment_failed', graceEndsAt: now - 1 }), {}, { status: 'locked', graceReason: null, locked: true }],
    ['a small team whose renewal failed keeps its plan while it’s tried again', paid({ status: 'past_due', graceReason: 'payment_failed', graceEndsAt: now + DAY }), { used: 3 }, { plan: 'team', status: 'past_due' }],
    ['a small team waiting for the bank keeps its plan', paid({ status: 'past_due', graceReason: 'action_needed', graceEndsAt: now + DAY }), { used: 1 }, { plan: 'team', status: 'past_due' }],
    ['a small team that cancelled while past due is free', paid({ status: 'past_due', graceReason: 'cancelled', graceEndsAt: now + DAY }), { used: 3 }, { plan: 'free', status: 'free' }],
    ['a small team whose grace ran out is free', paid({ status: 'past_due', graceReason: 'payment_failed', graceEndsAt: now - 1 }), { used: 3 }, { plan: 'free', status: 'free' }],
    ['a small team locked is free', paid({ status: 'locked' }), { used: 2 }, { plan: 'free', status: 'free', seatLimit: FREE_SEATS }],
    ['a small team that cancelled is free at the end', paid({ periodEnd: ended, cancelAtPeriodEnd: true }), { used: 3 }, { status: 'free' }],
    ['a small team without a card is free at the end', paid({ periodEnd: ended, hasCard: false }), { used: 2 }, { status: 'free' }],
    ['a small team renewing is still on its plan', paid({ periodEnd: ended }), { used: 1 }, { plan: 'team', renewing: true }],
    ['a small support workspace stays locked', paid({ status: 'locked' }), { kind: 'support', used: 1 }, { plan: 'support', status: 'locked' }],
    [
      'a launch grace',
      paid({ status: 'past_due', seats: 0, graceReason: 'launch', graceEndsAt: now + 10 * DAY, periodEnd: null, unitAmount: null, hasCard: false }),
      { preLaunch: true },
      { status: 'past_due', graceReason: 'launch', seatLimit: FREE_SEATS, guestCap: null },
    ],
    ['a launch grace that ran out', paid({ status: 'past_due', seats: 0, graceReason: 'launch', graceEndsAt: now - 1, periodEnd: null }), {}, { status: 'locked' }],
    ['a free team made before launch keeps its guests in the window', null, { preLaunch: true }, { status: 'free', guestCap: null }],
    ['an unpaid support row', paid({ status: 'incomplete', seats: 0, periodEnd: null }), { kind: 'support' }, { status: 'incomplete', locked: true, seatLimit: FREE_SEATS }],
  ])('%s', (_name, account, more, expected) => {
    expect(effective(account, facts(more))).toMatchObject(expected);
  });

  it('lets a few staff into a locked or unpaid office', () => {
    expect(staffCapOf(effective(null, facts({ kind: 'support' })))).toBe(3);
    expect(staffCapOf(effective(paid(), facts()))).toBeNull();
  });

  it('knows the launch window of offices from before billing', () => {
    const launched = at('2026-06-01T00:00:00.000Z');
    expect(inLaunchWindow(launched - DAY, launched, launched + DAY)).toBe(true);
    expect(inLaunchWindow(launched - DAY, launched, launched + LAUNCH_DAYS * DAY)).toBe(false);
    expect(inLaunchWindow(launched + 1, launched, launched + DAY)).toBe(false);
    expect(inLaunchWindow(launched - DAY, null, launched)).toBe(false);
  });
});

describe('settings', () => {
  it('take prices in kobo, or the defaults', () => {
    expect(billingConfig({}).prices).toEqual(DEFAULT_PRICES);
    expect(billingConfig({ teamPrice: ' 500000 ', supportPrice: 9_000_000 }).prices).toEqual({ team: 500_000, support: 9_000_000 });
    expect(parsePrice('', 123_456, 'X')).toBe(123_456);
  });

  it('refuse a price that isn’t a whole number of kobo in range', () => {
    for (const bad of ['7500.50', 'abc', '-750000', '4999', '10000000001', '1e6']) expect(() => parsePrice(bad, 1, 'BILLING_TEAM_SEAT_PRICE')).toThrow(/BILLING_TEAM_SEAT_PRICE/);
    expect(() => parsePrice(1.5, 1, 'X')).toThrow();
  });

  it('turn the tick off without a long enough secret', () => {
    expect(billingConfig({ internalToken: 'x'.repeat(32) }).internalToken).toBe('x'.repeat(32));
    expect(billingConfig({ internalToken: null }).internalToken).toBeNull();
  });
});

describe('money', () => {
  it('shows naira, with kobo only when there are some', () => {
    expect(formatMoney(750_000)).toBe('₦7,500');
    expect(formatMoney(18_000_000)).toBe('₦180,000');
    expect(formatMoney(750_050)).toBe('₦7,500.50');
    expect(formatMoney(5000)).toBe('₦50');
    expect(formatMoney(0)).toBe('₦0');
  });
});

describe('the price shown for added seats', () => {
  const summary = (start: number, interval: 'month' | 'year'): BillingSummary => ({
    officeId: 'o',
    plan: interval === 'year' ? 'support' : 'team',
    status: 'active',
    graceReason: null,
    seatsUsed: 4,
    seats: 4,
    seatsNext: null,
    interval,
    periodStart: start,
    periodEnd: addInterval(start, 1, interval),
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
  });

  it('is what the server charges for the rest of the period', () => {
    const start = at('2026-03-10T09:00:00.000Z');
    const month = summary(start, 'month');
    const end = month.periodEnd!;
    const now = start + 10 * DAY;
    expect(addSeatsCost(month, 2, 750_000, now)).toEqual({ now: prorate(2, 750_000, now, start, end) });
    const year = summary(start, 'year');
    expect(addSeatsCost(year, 3, 18_000_000, now)).toEqual({ now: prorate(3, 18_000_000, now, start, year.periodEnd!) });
  });

  it('goes on the next renewal under ₦50 or in the last hour', () => {
    const start = at('2026-03-10T09:00:00.000Z');
    const month = summary(start, 'month');
    const end = month.periodEnd!;
    const late = end - 2 * 3600_000;
    expect(addSeatsCost(month, 1, 750_000, late)).toEqual({ carry: prorate(1, 750_000, late, start, end) });
    expect(prorate(1, 750_000, late, start, end)).toBeLessThan(MIN_CHARGE);
    expect(addSeatsCost(month, 1, 750_000, end - 30 * 60_000)).toBe('renewal');
  });
});
