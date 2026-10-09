import type { BillingStatusAnswer, BillingView, CheckoutAnswer, VerifyAnswer } from '../../../../shared/billing';
import { ApiError, load, send } from '../../lib/api';

// The server's billing routes (README: "Billing"). Errors are ApiErrors with a `code` (BillingErrorCode).

const office = (id: string, path: string) => `/api/offices/${encodeURIComponent(id)}/billing${path}`;

/** Whether this server charges for workspaces, and its prices; a server without billing doesn't. */
export async function fetchStatus(): Promise<BillingStatusAnswer> {
  try {
    return await load<BillingStatusAnswer>('/api/billing/status');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { available: false };
    throw err;
  }
}

/** A workspace's plan (owner and admins; amounts, card and history only for the owner). */
export const fetchBilling = (officeId: string) => load<BillingView>(office(officeId, ''));

/** Where to pay on Paystack: a new plan with `seats`, what's due, or a new card (the server decides). */
export const startCheckout = (officeId: string, seats?: number) => send<CheckoutAnswer>(office(officeId, '/checkout'), { seats });

/** More seats (charged now, prorated) or fewer (from the next renewal). */
export const changeSeats = (officeId: string, seats: number) => send<BillingView>(office(officeId, '/seats'), { seats });

/** Ends the plan at the end of the period. */
export const cancelPlan = (officeId: string) => send<BillingView>(office(officeId, '/cancel'));

/** Keeps a cancelled plan going (before it ends). */
export const resumePlan = (officeId: string) => send<BillingView>(office(officeId, '/resume'));

/** Tries the saved card again for a failed renewal. */
export const retryPayment = (officeId: string) => send<BillingView>(office(officeId, '/retry'));

/** How a Paystack payment went, from the page it sends people back to. */
export const verifyPayment = (reference: string) => send<VerifyAnswer>('/api/billing/verify', { reference });
