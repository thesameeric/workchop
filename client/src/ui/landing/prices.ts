import { formatMoney, type BillingStatusAnswer } from '../../../../shared/billing';

/** The prices from GET /api/billing/status, when this server charges. */
export type Billing = Extract<BillingStatusAnswer, { available: true }>;

/** What the landing page shows of the plans. */
export type PlanPrices = ReturnType<typeof planPrices>;

// Display strings for the plans, from GET /api/billing/status.
export function planPrices(s: Billing) {
  return {
    team: formatMoney(s.prices.team),
    supportMonthly: formatMoney(Math.round(s.prices.support / 12)),
    supportYearly: formatMoney(s.prices.support),
    freeSeats: s.freeSeats,
    guestCaps: s.guestCaps,
  };
}
