import { CURRENCY, DEFAULT_PRICES, MIN_CHARGE } from '../../../shared/billing';
import type { OfficeKind } from '../../../shared/workspace';

// Billing's settings: prices in kobo (Team per seat per month, Support per seat per year), and the
// secret the scheduler's tick shows.

export const MAX_PRICE = 10_000_000_000;
/** The tick route's secret must be at least this long; shorter, the route stays off. */
export const MIN_TOKEN = 32;

export interface BillingConfig {
  currency: typeof CURRENCY;
  prices: { team: number; support: number };
  /** Null: the tick route answers 404. */
  internalToken: string | null;
}

/** A price setting in kobo; throws when it isn't a whole number from MIN_CHARGE to MAX_PRICE. */
export function parsePrice(raw: string | number | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < MIN_CHARGE || value > MAX_PRICE) {
    throw new Error(`${name} must be a whole number of kobo from ${MIN_CHARGE} to ${MAX_PRICE} (got "${raw}")`);
  }
  return value;
}

export function billingConfig(opts: { teamPrice?: string | number; supportPrice?: string | number; internalToken?: string | null }): BillingConfig {
  const token = opts.internalToken?.trim() || null;
  if (token && token.length < MIN_TOKEN) console.warn(`[billing] BILLING_INTERNAL_TOKEN must be at least ${MIN_TOKEN} characters; the scheduler's tick is off`);
  return {
    currency: CURRENCY,
    prices: {
      team: parsePrice(opts.teamPrice, DEFAULT_PRICES.team, 'BILLING_TEAM_SEAT_PRICE'),
      support: parsePrice(opts.supportPrice, DEFAULT_PRICES.support, 'BILLING_SUPPORT_SEAT_PRICE'),
    },
    internalToken: token && token.length >= MIN_TOKEN ? token : null,
  };
}

/** Team workspaces are billed monthly, support ones yearly. */
export const intervalOf = (kind: OfficeKind) => (kind === 'support' ? 'year' : 'month');
