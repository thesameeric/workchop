// Billing: what workspaces cost and what their owner and admins see about it. Payments go through
// Paystack, in naira (amounts are in kobo, the smallest unit). Billing is off, and everything free and
// unlimited, when the server has no Paystack key.

export const CURRENCY = 'NGN';
/** Team workspaces are free for up to this many seats; upgrading charges every seat. */
export const FREE_SEATS = 3;
/** Guests (guest link) in a team workspace at once. Support customers aren't counted. */
export const GUEST_CAPS = { free: 3, team: 25 } as const;
/** People at once in a locked or unpaid workspace (its owner and admins; the owner always gets in). */
export const LOCKED_STAFF_CAP = 3;
/** Days to pay after a failed renewal or a cancelled plan, before the workspace locks. */
export const GRACE_DAYS = 7;
/** Days workspaces that existed when billing was switched on have to choose a plan. */
export const LAUNCH_DAYS = 30;
/** After a failed renewal, it's tried again this many days later (then it locks on GRACE_DAYS). */
export const RETRY_DAYS = [1, 3, 6] as const;
/** Paystack's smallest charge (₦50); smaller amounts are added to the next renewal. */
export const MIN_CHARGE = 5000;
/** The most seats one workspace can buy. */
export const MAX_SEATS = 500;
/** Default prices in kobo: Team per seat per month, Support per seat per year (₦15,000 a month). */
export const DEFAULT_PRICES = { team: 750_000, support: 18_000_000 } as const;

/** ₦7,500 or ₦7,500.50 (kobo in, naira out). */
export function formatMoney(kobo: number): string {
  const naira = kobo / 100;
  const cents = kobo % 100 !== 0;
  return `₦${naira.toLocaleString('en-NG', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** comp: complimentary (set by the operator), never charged or limited. */
export type BillingPlan = 'free' | 'team' | 'support' | 'comp';
/** incomplete: a support workspace that hasn't been paid for yet; past_due: in its grace period. */
export type BillingStatus = 'free' | 'incomplete' | 'active' | 'past_due' | 'locked';
/** Why a workspace is in its grace period. */
export type GraceReason = 'payment_failed' | 'action_needed' | 'no_card' | 'cancelled' | 'launch';
export type ChargePurpose = 'subscribe' | 'pay_due' | 'renewal' | 'seats' | 'card_update';
export type ChargeStatus = 'pending' | 'succeeded' | 'failed' | 'abandoned' | 'action_needed' | 'superseded' | 'refunded';
/** A superseded charge's refund: due (Paystack will be asked again), asked of Paystack, or refused by it (refund it in the dashboard). */
export type RefundState = 'due' | 'requested' | 'refused';

/** GET /api/billing/status. */
export type BillingStatusAnswer =
  | { available: false }
  | {
      available: true;
      currency: typeof CURRENCY;
      /** Kobo: Team per seat per month, Support per seat per year. */
      prices: { team: number; support: number };
      freeSeats: number;
      guestCaps: { free: number; team: number };
    };

/** What the owner and admins see (GET /api/offices/:id/billing, and the 'billing:state' event). */
export interface BillingSummary {
  officeId: string;
  plan: BillingPlan;
  status: BillingStatus;
  graceReason: GraceReason | null;
  /** Members plus open invitations. */
  seatsUsed: number;
  /** Seats bought (FREE_SEATS on the Free plan; null when unlimited). */
  seats: number | null;
  /** Seats from the next renewal on, when the owner lowered them. */
  seatsNext: number | null;
  interval: 'month' | 'year' | null;
  /** The paid period (an added seat is charged for what's left of it). */
  periodStart: number | null;
  periodEnd: number | null;
  /** When it locks, while past_due. */
  graceEndsAt: number | null;
  cancelAtPeriodEnd: boolean;
}

/** One charge, for the owner's history and printable receipts. */
export interface BillingReceipt {
  reference: string;
  purpose: ChargePurpose;
  status: ChargeStatus;
  seats: number;
  unitAmount: number;
  amount: number;
  currency: string;
  periodStart: number | null;
  periodEnd: number | null;
  card: { brand: string | null; last4: string | null } | null;
  createdAt: number;
  settledAt: number | null;
  /** Only for a payment for something already paid ('superseded'): where its refund is. */
  refund: RefundState | null;
}

/** Only for the owner. */
export interface BillingDetails {
  /** Kobo per seat per interval. */
  unitAmount: number;
  currency: string;
  /** What the next renewal will charge, when one is coming. */
  nextAmount: number | null;
  /**
   * What paying now would charge while a payment is overdue (past_due or locked), else null: the
   * overdue period with what's carried (at least MIN_CHARGE), or, paused or choosing a plan at launch,
   * a new period for the seats it had (at least those in use).
   */
  due: number | null;
  /** Kobo owed at the next renewal (positive) or credit (negative). */
  carry: number;
  autoRenew: boolean;
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  paystackEmail: string | null;
  /** Paystack's page to confirm a charge with the bank (when graceReason is 'action_needed'). */
  actionUrl: string | null;
  charges: BillingReceipt[];
}

export type BillingView = BillingSummary & { details?: BillingDetails };

/** POST /api/offices/:id/billing/checkout: where to send the owner to pay. */
export interface CheckoutAnswer {
  url: string;
}

/** POST /api/billing/verify, from the page Paystack sends people back to. */
export interface VerifyAnswer {
  status: 'succeeded' | 'pending' | 'failed' | 'abandoned';
  officeId?: string;
  officeName?: string;
}

/** The `code` of billing errors ({ error, code }). */
export type BillingErrorCode =
  | 'seats-full'
  | 'locked'
  | 'unverified'
  | 'seats'
  | 'below-used'
  | 'card-declined'
  | 'action-needed'
  | 'no-card'
  | 'pay-first'
  | 'busy'
  | 'paystack';

declare module './types' {
  interface ServerToClientEvents {
    /** To the owner and admins in the office, whenever its billing changes. */
    'billing:state': (summary: BillingSummary) => void;
  }
}
