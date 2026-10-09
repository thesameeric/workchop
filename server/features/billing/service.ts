import crypto from 'node:crypto';
import type { AccountUser, SpaceBilling } from '../../../shared/account';
import {
  FREE_SEATS,
  GRACE_DAYS,
  LOCKED_STAFF_CAP,
  MAX_SEATS,
  MIN_CHARGE,
  type BillingErrorCode,
  type BillingReceipt,
  type BillingSummary,
  type BillingView,
  type ChargePurpose,
  type ChargeStatus,
  type CheckoutAnswer,
} from '../../../shared/billing';
import { may } from '../../../shared/workspace';
import type { Db } from '../../db';
import type { WorkspacePolicy } from '../../features';
import { windowLimiter } from '../../limits';
import type { Mailer } from '../../mail';
import type { MailContent } from '../../mailTemplates';
import type { OfficeStore } from '../../officeStore';
import type { IO, RealtimeApi } from '../../realtime';
import { lockSeats } from '../../workspaces';
import { intervalOf, type BillingConfig } from './config';
import { billingMail } from './mail';
import { metadataOf, PaystackRefused, PaystackUnreachable, type Paystack, type PaystackTx } from './paystack';
import { addInterval, DAY, effective, hardDecline, HOUR, inLaunchWindow, nextPeriodEnd, nextRetry, prorate, renewalSeats, staffCapOf, type Effective } from './state';
import { BillingStore, type AccountPatch, type Charge, type OfficeFacts, type StoredAccount } from './store';

// Billing's rules: checkouts, settling payments (from the return page, the webhook and the
// reconciliation), renewals and their retries, seats, cancelling, a new owner, and the scheduled run.
// Paystack is never called inside a database transaction (PGlite has one connection): a charge is
// recorded as pending first, Paystack is asked, and the result is applied in a second transaction.

const MINUTE = 60_000;
/** Charges still unknown after this long are checked with Paystack. */
const RECONCILE_AFTER = 15 * MINUTE;
const RECONCILE_BATCH = 50;
const HISTORY = 24;
/** Payments left unpaid this long are given up (a renewal waiting for the bank: at the end of its grace). */
const ABANDON_AFTER = DAY;
const FINAL: ChargeStatus[] = ['succeeded', 'refunded', 'superseded'];
const CLEAR_GRACE: AccountPatch = { graceReason: null, graceEndsAt: null, retryCount: 0, nextRetryAt: null, actionUrl: null };

/** A refusal for the person asking, with an HTTP status and (for the client) a code. */
export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly code: BillingErrorCode | null,
    message: string,
    readonly url?: string,
  ) {
    super(message);
  }
}

export interface TickSummary {
  reconciled: number;
  renewed: number;
  failed: number;
  locked: number;
  freed: number;
  refunded: number;
  mailed: number;
}

/** What charging a saved card came to. */
type Outcome = 'succeeded' | 'failed' | 'action_needed' | 'pending';

/** What a checkout charges for (see Billing.quote). */
interface Quote {
  purpose: ChargePurpose;
  seats: number;
  unit: number;
  amount: number;
  carryApplied: number;
  period: [number, number] | [null, null];
}

export interface BillingDeps {
  db: Db;
  offices: OfficeStore;
  realtime: RealtimeApi;
  io: IO;
  mailer: Mailer;
  publicOrigin: string;
  config: BillingConfig;
  paystack: Paystack;
  now: () => number;
}

/** wc-<office>-<random>: Paystack takes only letters, digits, '-', '.' and '='. */
const newReference = (officeId: string) => `wc-${officeId.replace(/[^A-Za-z0-9]/g, '')}-${crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '0')}`;

const amountOf = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));

/** A team small enough for the Free plan, which it goes on instead of pausing. */
const smallTeam = (facts: OfficeFacts) => facts.kind === 'team' && facts.used <= FREE_SEATS;

/**
 * When a renewal's grace (and its retries) started: when the period ended, or, when the first try came
 * more than a day after that (no run meanwhile: the server was down), at that try.
 */
function graceStart(charge: Charge, account: StoredAccount): number {
  if ((account.graceReason === 'payment_failed' || account.graceReason === 'action_needed') && account.graceEndsAt !== null) return account.graceEndsAt - GRACE_DAYS * DAY;
  const t0 = charge.periodStart!;
  return charge.createdAt - t0 > DAY ? charge.createdAt : t0;
}

export class Billing {
  readonly store: BillingStore;
  private launchedAt: number | null = null;
  /** Work started in the background (webhooks, syncs, runs), awaited when the server closes. */
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly syncs = new Map<string, ReturnType<typeof setTimeout>>();
  private running: Promise<TickSummary> | null = null;
  private mailed = 0;
  private readonly cardUpdates = windowLimiter(3, DAY);

  constructor(private readonly deps: BillingDeps) {
    this.store = new BillingStore(deps.db);
  }

  private get now() {
    return this.deps.now();
  }

  /** Billing was switched on: the launch window starts the first time. */
  async start(): Promise<void> {
    this.launchedAt = await this.store.launch(this.now);
  }

  /** Runs `work` in the background; failures are logged. */
  track(work: Promise<unknown>): void {
    const task = work.catch((err) => console.error('[billing] background work failed:', err));
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  /** Waits for the work in the background (closing, and tests). */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  close(): void {
    for (const timer of this.syncs.values()) clearTimeout(timer);
    this.syncs.clear();
  }

  private stateOf(facts: OfficeFacts, account: StoredAccount | null, now = this.now): Effective {
    return effective(account, { kind: facts.kind, used: facts.used, ownerId: facts.ownerId, now, preLaunch: inLaunchWindow(facts.createdAt, this.launchedAt, now) });
  }

  private nameOf(facts: OfficeFacts): string {
    return this.deps.offices.peek(facts.officeId)?.office.settings.name ?? facts.name;
  }

  private link(officeId: string): string {
    return `${this.deps.publicOrigin}/o/${officeId}?billing`;
  }

  summaryOf(facts: OfficeFacts, account: StoredAccount | null, e = this.stateOf(facts, account)): BillingSummary {
    const paid = e.plan === 'team' || e.plan === 'support';
    return {
      officeId: facts.officeId,
      plan: e.plan,
      // A renewal that is due is still a paid plan until the card says otherwise.
      status: e.renewing ? 'active' : e.status,
      graceReason: e.graceReason,
      seatsUsed: facts.used,
      seats: e.plan === 'comp' ? null : paid && account?.seats ? account.seats : FREE_SEATS,
      seatsNext: paid ? (account?.seatsNext ?? null) : null,
      interval: paid ? intervalOf(facts.kind) : null,
      periodStart: paid ? (account?.periodStart ?? null) : null,
      periodEnd: paid ? (account?.periodEnd ?? null) : null,
      graceEndsAt: e.renewing ? null : e.graceEndsAt,
      cancelAtPeriodEnd: paid && !!account?.cancelAtPeriodEnd,
    };
  }

  /** What the owner (with `details`) or an admin sees. */
  async view(officeId: string, owner: boolean): Promise<BillingView | null> {
    const [row] = await this.store.load([officeId]);
    if (!row) return null;
    const { facts, account } = row;
    const e = this.stateOf(facts, account);
    const summary = this.summaryOf(facts, account, e);
    if (!owner) return summary;
    const unit = account?.unitAmount ?? this.deps.config.prices[facts.kind];
    const renews = !!account && (e.status === 'active' || e.renewing) && account.autoRenew && account.hasCard && !account.cancelAtPeriodEnd && e.plan !== 'comp';
    const overdue = summary.status === 'past_due' || summary.status === 'locked';
    const charges = await this.store.charges(officeId, HISTORY);
    return {
      ...summary,
      details: {
        unitAmount: unit,
        currency: this.deps.config.currency,
        nextAmount: renews && account ? Math.max(0, renewalSeats(account, facts.used) * unit + account.carry) : null,
        due: overdue && account ? this.quote(facts, account, e).amount : null,
        carry: account?.carry ?? 0,
        autoRenew: account?.autoRenew ?? false,
        card:
          account?.authorizationCode && account.cardLast4
            ? { brand: account.cardBrand ?? 'card', last4: account.cardLast4, expMonth: account.cardExpMonth ?? 0, expYear: account.cardExpYear ?? 0 }
            : null,
        paystackEmail: account?.paystackEmail ?? null,
        actionUrl: e.graceReason === 'action_needed' ? (account?.actionUrl ?? null) : null,
        charges: charges.map(receiptOf),
      },
    };
  }

  /** Tells the owner and admins in the office (billing:state). */
  async emit(officeId: string): Promise<void> {
    const { realtime } = this.deps;
    const ids = realtime
      .players(officeId)
      .map((p) => p.id)
      .filter((id) => {
        const s = realtime.contextOf(id);
        return !!s && (s.isOwner() || may(s.role(), 'see-billing'));
      });
    if (!ids.length) return;
    const [row] = await this.store.load([officeId]);
    if (row) this.deps.io.to(ids).emit('billing:state', this.summaryOf(row.facts, row.account));
  }

  /** Who may come in and how many people the office may have (see WorkspacePolicy). */
  readonly policy: WorkspacePolicy = {
    access: async (officeId) => {
      const [row] = await this.store.load([officeId]);
      if (!row) return { locked: false, guestCap: null, staffCap: null };
      const e = this.stateOf(row.facts, row.account);
      // The dates say it's free now, or locked: store that (and take people out) soon.
      if ((e.status === 'free' && row.account && row.account.status !== 'free') || (e.status === 'locked' && row.account?.status !== 'locked')) this.syncSoon(officeId);
      return { locked: e.locked, guestCap: e.guestCap, staffCap: staffCapOf(e) };
    },
    seatLimit: async (tx, officeId) => {
      const facts = await this.store.facts(tx, officeId);
      return facts ? this.stateOf(facts, await this.store.forUpdate(tx, officeId)).seatLimit : null;
    },
    notes: async (offices) => {
      const rows = await this.store.load(offices.map((o) => o.id));
      const notes = new Map<string, SpaceBilling>();
      for (const { facts, account } of rows) {
        const role = offices.find((o) => o.id === facts.officeId)?.role;
        const e = this.stateOf(facts, account);
        const staff = role === 'owner' || role === 'admin';
        if (e.status === 'locked' || (e.status === 'incomplete' && !staff)) notes.set(facts.officeId, 'locked');
        else if (staff && e.status === 'incomplete') notes.set(facts.officeId, 'unpaid');
        else if (staff && e.status === 'past_due' && e.graceReason) notes.set(facts.officeId, 'past-due');
      }
      return notes;
    },
    ownerChanged: (officeId, from, to) => this.ownerChanged(officeId, from, to),
  };

  private syncSoon(officeId: string): void {
    if (this.syncs.has(officeId)) return;
    this.syncs.set(
      officeId,
      setTimeout(() => {
        this.syncs.delete(officeId);
        this.track(this.advance(officeId, { charge: false }));
      }, 0),
    );
  }

  /**
   * What a checkout pays for, which is the server's choice: on a plan that's paid up, MIN_CHARGE to
   * save a new card (credited to the next renewal); past due, the overdue period from where the last
   * one ended (no free days), with what's carried and at least MIN_CHARGE; otherwise (free, unpaid,
   * locked, or a workspace from before billing) a new plan for `seats`, by default the seats it had
   * and at least those in use.
   */
  private quote(facts: OfficeFacts, account: StoredAccount, e: Effective, seats?: number): Quote {
    if ((e.status === 'active' || e.renewing) && account.unitAmount) {
      return { purpose: 'card_update', seats: account.seats, unit: account.unitAmount, amount: MIN_CHARGE, carryApplied: 0, period: [null, null] };
    }
    if (e.status === 'past_due' && account.periodEnd !== null && account.unitAmount && account.interval) {
      const n = renewalSeats(account, facts.used);
      const unit = account.unitAmount;
      const carryApplied = Math.max(account.carry, MIN_CHARGE - n * unit);
      const period: [number, number] = [account.periodEnd, nextPeriodEnd(account.anchorAt ?? account.periodEnd, account.periodEnd, account.interval)];
      return { purpose: 'pay_due', seats: n, unit, amount: n * unit + carryApplied, carryApplied, period };
    }
    const unit = this.deps.config.prices[facts.kind];
    const n = seats ?? Math.max(facts.used, 1, account.seatsNext ?? account.seats);
    return { purpose: 'subscribe', seats: n, unit, amount: n * unit, carryApplied: 0, period: [null, null] };
  }

  /** Starts a payment through Paystack's checkout page, for what quote() says (`wanted`: the seats of a new plan). */
  async checkout(officeId: string, user: AccountUser, wanted: unknown): Promise<CheckoutAnswer> {
    const now = this.now;
    const email = user.email!;
    const charge = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, officeId);
      const account = await this.store.ensure(tx, officeId, now);
      const facts = await this.store.facts(tx, officeId);
      if (!account || !facts) throw new BillingError(404, null, 'Office not found');
      const e = this.stateOf(facts, account, now);
      if (e.plan === 'comp') throw new BillingError(409, null, 'This workspace is free of charge.');
      let q = this.quote(facts, account, e);
      if (q.purpose === 'card_update' && this.cardUpdates.wait(officeId)) throw new BillingError(429, null, 'You’ve changed the card a few times today. Try again tomorrow.');
      if (q.purpose === 'subscribe') {
        const least = Math.max(facts.used, 1);
        const asked = wanted === undefined ? q.seats : wanted;
        if (typeof asked !== 'number' || !Number.isInteger(asked) || asked < least || asked > MAX_SEATS) {
          throw new BillingError(400, 'seats', least > 1 ? `Pick from ${least} to ${MAX_SEATS} seats: ${least} are in use.` : `Pick from 1 to ${MAX_SEATS} seats.`);
        }
        q = this.quote(facts, account, e, asked);
      }
      return this.store.insertCharge(tx, {
        reference: newReference(officeId),
        officeId,
        officeName: this.nameOf(facts),
        purpose: q.purpose,
        seats: q.seats,
        seatsFrom: null,
        unitAmount: q.unit,
        amount: q.amount,
        currency: this.deps.config.currency,
        carryApplied: q.carryApplied,
        periodStart: q.period[0],
        periodEnd: q.period[1],
        attempt: 1,
        actorUserId: user.id,
        payerEmail: email,
        createdAt: now,
      });
    });
    if (!charge) throw new BillingError(409, 'busy', 'Something else is happening with billing. Try again.');
    if (charge.purpose === 'card_update') this.cardUpdates(officeId);
    const origin = this.deps.publicOrigin;
    try {
      const { authorization_url } = await this.deps.paystack.initialize({
        email,
        amount: charge.amount,
        currency: charge.currency,
        reference: charge.reference,
        callback_url: `${origin}/billing/return`,
        // A card that can be charged again for renewals.
        channels: ['card'],
        metadata: {
          app: 'workchop',
          office_id: officeId,
          purpose: charge.purpose,
          seats: charge.seats,
          cancel_action: `${origin}/o/${officeId}?billing`,
          custom_filters: { recurring: true },
        },
      });
      await this.store.markCharge(this.deps.db, charge.reference, 'pending', ['pending'], { authorizationUrl: authorization_url });
      return { url: authorization_url };
    } catch (err) {
      if (!(err instanceof PaystackUnreachable || err instanceof PaystackRefused)) throw err;
      console.warn(`[billing] could not start a checkout: ${err.message}`);
      await this.store.markCharge(this.deps.db, charge.reference, 'failed', ['pending'], { gatewayResponse: 'checkout not started' });
      throw new BillingError(502, 'paystack', 'Paystack isn’t answering. Try again in a moment.');
    }
  }

  /** Why a successful transaction doesn't match its charge, or null when it does. */
  private mismatch(charge: Charge, tx: PaystackTx): string | null {
    if (tx.reference !== charge.reference) return 'reference';
    if (tx.currency !== charge.currency) return 'currency';
    if (amountOf(tx.requested_amount ?? tx.amount) !== charge.amount) return 'amount';
    if (metadataOf(tx).office_id !== charge.officeId) return 'office';
    if ((tx.customer?.email ?? '').toLowerCase() !== charge.payerEmail.toLowerCase()) return 'email';
    // Paystack's only success code since June 2026; charges of a saved card (and older transactions) have none.
    if (typeof tx.gateway_response_code === 'string' && tx.gateway_response_code !== 'approved') return 'gateway';
    return null;
  }

  /**
   * Settles a charge from Paystack's word on it (`given`, from charging a card; otherwise it asks):
   * once, whoever asks first (the return page, the webhook, the reconciliation). Null for a reference
   * that isn't ours.
   */
  async settle(reference: string, given?: PaystackTx): Promise<Charge | null> {
    const charge = await this.store.charge(this.deps.db, reference);
    if (!charge || FINAL.includes(charge.status)) return charge;
    let tx: PaystackTx | null | undefined = given;
    if (!tx) {
      try {
        tx = await this.deps.paystack.verify(reference);
      } catch (err) {
        if (!(err instanceof PaystackUnreachable || err instanceof PaystackRefused)) throw err;
        console.warn(`[billing] could not check a payment: ${err.message}`);
        return charge;
      }
    }
    const age = this.now - charge.createdAt;
    const open: ChargeStatus[] = ['pending', 'action_needed'];
    if (!tx) {
      // Paystack never got it: another attempt may be made.
      if (age > RECONCILE_AFTER) await this.store.markCharge(this.deps.db, reference, 'failed', open, { gatewayResponse: 'not received' });
    } else if (tx.status === 'success') {
      const problem = this.mismatch(charge, tx);
      if (!problem) await this.apply(charge, tx);
      else {
        // Money was taken but can't be applied: give it back, and (a saved card) don't charge it by
        // itself again, or the next run would take the money again. The owner pays from Billing.
        console.error(`[billing] payment ${reference} doesn't match its charge (${problem}): not applied, refunding it`);
        const refund = await this.deps.db.transaction(async (q) => {
          const marked = await this.store.markCharge(q, reference, 'failed', ['pending', 'action_needed', 'failed', 'abandoned'], { gatewayResponse: `mismatch: ${problem}` });
          if (!marked || charge.refund) return false;
          await this.store.setRefund(q, reference, 'due');
          if (charge.purpose === 'renewal' || charge.purpose === 'seats') {
            const account = await this.store.forUpdate(q, charge.officeId);
            if (account?.autoRenew) await this.store.change(q, account, { autoRenew: false }, { now: this.now, actor: null, action: 'mismatch' });
          }
          return true;
        });
        if (refund) await this.refund(reference);
      }
    } else if (tx.status === 'failed' || tx.status === 'reversed') {
      if (await this.store.markCharge(this.deps.db, reference, 'failed', open, { gatewayResponse: tx.gateway_response ?? tx.status })) {
        if (charge.purpose === 'renewal') await this.renewalFailed(charge, tx.gateway_response ?? '');
      }
    } else if (age > ABANDON_AFTER && (charge.purpose !== 'renewal' || tx.status === 'abandoned' || age > GRACE_DAYS * DAY)) {
      // Never paid (or never confirmed with the bank): given up, though a late payment still counts.
      await this.store.markCharge(this.deps.db, reference, 'abandoned', open);
    }
    return this.store.charge(this.deps.db, reference);
  }

  /** A successful payment: applied to the office once, in one transaction; then refunds, events and the receipt. */
  private async apply(charge: Charge, paid: PaystackTx): Promise<void> {
    const now = this.now;
    const paidAtRaw = paid.paid_at ? Date.parse(paid.paid_at) : NaN;
    const paidAt = Number.isFinite(paidAtRaw) && paidAtRaw <= now ? paidAtRaw : now;
    const auth = paid.authorization ?? null;
    const done = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, charge.officeId);
      const settled = await this.store.succeed(tx, charge.reference, {
        txId: paid.id === undefined || paid.id === null ? null : String(paid.id),
        fees: amountOf(paid.fees),
        at: now,
        gatewayResponse: paid.gateway_response ?? null,
        cardLast4: auth?.last4 ?? null,
        cardBrand: auth?.brand?.trim() || auth?.card_type?.trim() || null,
      });
      if (!settled) return null;
      const account = await this.store.ensure(tx, charge.officeId, now);
      const facts = await this.store.facts(tx, charge.officeId);
      // The office is gone: the payment stays in the ledger.
      if (!account || !facts) return null;
      const before = this.stateOf(facts, account, now);
      const interval = intervalOf(facts.kind);
      // A period is for at least the seats in use: people added while the owner was paying get theirs,
      // and the next renewal charges for them.
      const seats = Math.max(charge.seats, facts.used);
      const carry = account.carry - charge.carryApplied + (seats - charge.seats) * charge.unitAmount;
      const fresh = (): AccountPatch => ({
        status: 'active',
        seats,
        seatsNext: null,
        unitAmount: charge.unitAmount,
        interval,
        anchorAt: paidAt,
        periodStart: paidAt,
        periodEnd: addInterval(paidAt, 1, interval),
        cancelAtPeriodEnd: false,
        autoRenew: true,
        carry,
        ...CLEAR_GRACE,
      });
      let patch: AccountPatch | null = null;
      let superseded = false;
      if (charge.purpose === 'subscribe') {
        // Paid twice (two checkouts): the plan is running already.
        if (before.status === 'active' && !before.renewing) superseded = true;
        else patch = fresh();
      } else if (charge.purpose === 'pay_due' || charge.purpose === 'renewal') {
        if (account.periodEnd !== charge.periodStart || before.plan === 'comp') superseded = true;
        // Locked meanwhile: a new period from now, not the time it was locked.
        else if (before.status === 'locked') patch = fresh();
        else
          patch = {
            status: 'active',
            seats,
            seatsNext: null,
            periodStart: charge.periodStart,
            periodEnd: charge.periodEnd,
            // A renewal charged as the owner cancelled: this period is paid for, and the plan still ends with it.
            cancelAtPeriodEnd: charge.purpose === 'renewal' && account.cancelAtPeriodEnd,
            autoRenew: true,
            carry,
            ...CLEAR_GRACE,
          };
      } else if (charge.purpose === 'seats') {
        // Only onto the seats it was priced from: otherwise they were added another way (or by another payment).
        if (account.status !== 'active' || account.periodStart !== charge.periodStart || account.periodEnd !== charge.periodEnd || account.seats !== charge.seatsFrom) {
          superseded = true;
        } else patch = { seats: charge.seats, seatsNext: null };
      } else {
        patch = { carry: account.carry - charge.amount, autoRenew: true };
      }
      // The receipt shows the period actually paid for (a new one starts when it's paid).
      const start = patch?.periodStart;
      const end = patch?.periodEnd;
      if (typeof start === 'number' && typeof end === 'number' && (start !== charge.periodStart || end !== charge.periodEnd)) {
        await this.store.setChargePeriod(tx, charge.reference, start, end);
      }
      // A card that can be charged again, saved for the owner who paid with it (never for someone else).
      const code = auth?.authorization_code;
      if (!superseded && code && auth.reusable === true && (paid.channel ?? auth.channel) === 'card' && charge.actorUserId && charge.actorUserId === facts.ownerId) {
        patch = {
          ...patch,
          authorizationCode: code,
          cardSignature: auth.signature ?? null,
          cardBrand: auth.brand?.trim() || auth.card_type?.trim() || null,
          cardLast4: auth.last4 ?? null,
          cardExpMonth: amountOf(auth.exp_month),
          cardExpYear: amountOf(auth.exp_year),
          cardBank: auth.bank ?? null,
          paystackEmail: paid.customer?.email?.toLowerCase() ?? charge.payerEmail,
          customerCode: paid.customer?.customer_code ?? null,
          payerUserId: charge.actorUserId,
        };
      }
      const how = { now, actor: charge.actorUserId, action: superseded ? `superseded:${charge.purpose}` : `paid:${charge.purpose}` };
      if (superseded) {
        await this.store.supersede(tx, charge.reference);
        await this.store.log(tx, charge.officeId, how, null, { reference: charge.reference });
      }
      const next = patch ? await this.store.change(tx, account, patch, how) : account;
      return { facts, next, superseded, unlocked: before.locked && !this.stateOf(facts, next, now).locked, oldCard: account.authorizationCode };
    });
    if (!done) return;
    const { facts, next, superseded } = done;
    if (superseded) {
      await this.refund(charge.reference);
      return;
    }
    if (done.oldCard && done.oldCard !== next.authorizationCode) this.forgetCard(done.oldCard);
    if (done.unlocked) this.deps.realtime.lockChanged(charge.officeId, false);
    await this.emit(charge.officeId);
    await this.notify(facts, 'receipt', charge.reference, (link, w) =>
      billingMail.receipt(link, w, {
        amount: charge.amount,
        seats: charge.purpose === 'card_update' ? 0 : charge.seats,
        reference: charge.reference,
        periodEnd: charge.purpose === 'card_update' ? null : next.periodEnd,
        card: auth?.last4 ?? null,
      }),
    );
  }

  /**
   * Refunds a payment for something already paid (the only refund made by itself). One Paystack
   * doesn't answer stays due, and the scheduled run asks again; true once it's asked.
   */
  private async refund(reference: string): Promise<boolean> {
    try {
      await this.deps.paystack.refund(reference);
    } catch (err) {
      if (err instanceof PaystackUnreachable) {
        console.warn(`[billing] could not refund ${reference}: ${err.message}; it will be asked again`);
        return false;
      }
      if (!(err instanceof PaystackRefused)) throw err;
      console.error(`[billing] Paystack refused to refund ${reference} (${err.message}): refund it in Paystack's dashboard`);
      await this.store.setRefund(this.deps.db, reference, 'refused');
      return false;
    }
    await this.store.setRefund(this.deps.db, reference, 'requested');
    return true;
  }

  private forgetCard(code: string): void {
    this.track(this.deps.paystack.deactivate(code).catch((err) => console.warn(`[billing] could not remove a card at Paystack: ${(err as Error).message}`)));
  }

  /**
   * Charges the saved card for a charge recorded as pending (a renewal or seats): then settles it, or
   * marks it failed or waiting for the bank. Paystack's answer may never come (a timeout): the charge
   * then stays pending until the reconciliation asks.
   */
  private async chargeCard(charge: Charge, authorizationCode: string): Promise<Outcome> {
    const origin = this.deps.publicOrigin;
    let tx: PaystackTx;
    try {
      tx = await this.deps.paystack.chargeAuthorization({
        email: charge.payerEmail,
        amount: charge.amount,
        authorization_code: authorizationCode,
        reference: charge.reference,
        currency: charge.currency,
        // Where the bank sends the payer back when it wants them to confirm.
        callback_url: `${origin}/billing/return`,
        metadata: { app: 'workchop', office_id: charge.officeId, purpose: charge.purpose, seats: charge.seats, cancel_action: `${origin}/o/${charge.officeId}?billing` },
      });
    } catch (err) {
      if (err instanceof PaystackUnreachable) {
        console.warn(`[billing] charging a card: ${err.message}; it will be checked again`);
        return 'pending';
      }
      if (!(err instanceof PaystackRefused)) throw err;
      // Refused outright (a card that was removed, say): as a decline.
      tx = { status: 'failed', reference: charge.reference, gateway_response: err.message };
    }
    if (tx.paused && tx.authorization_url) {
      await this.store.markCharge(this.deps.db, charge.reference, 'action_needed', ['pending'], { authorizationUrl: tx.authorization_url });
      if (charge.purpose === 'renewal') await this.actionNeeded(charge, tx.authorization_url);
      return 'action_needed';
    }
    if (tx.status === 'success') {
      const settled = await this.settle(charge.reference, tx);
      return settled?.status === 'succeeded' ? 'succeeded' : 'failed';
    }
    if (tx.status === 'failed') {
      await this.store.markCharge(this.deps.db, charge.reference, 'failed', ['pending'], { gatewayResponse: tx.gateway_response ?? 'failed' });
      if (charge.purpose === 'renewal') await this.renewalFailed(charge, tx.gateway_response ?? '');
      return 'failed';
    }
    return 'pending';
  }

  /**
   * A declined renewal: past due, tried again RETRY_DAYS after its grace started (not after a decline
   * that won't change), and locking (or, for a small team, going on the Free plan) GRACE_DAYS after.
   * Not when the owner cancelled meanwhile: the plan just ends.
   */
  private async renewalFailed(charge: Charge, why: string): Promise<void> {
    const now = this.now;
    const t0 = charge.periodStart!;
    const done = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, charge.officeId);
      const account = await this.store.forUpdate(tx, charge.officeId);
      const facts = await this.store.facts(tx, charge.officeId);
      // Paid meanwhile (or another way), or cancelled: nothing to do.
      if (!account || !facts || account.periodEnd !== t0 || account.cancelAtPeriodEnd) return null;
      const start = graceStart(charge, account);
      const next = await this.store.change(
        tx,
        account,
        {
          status: 'past_due',
          graceReason: 'payment_failed',
          graceEndsAt: start + GRACE_DAYS * DAY,
          retryCount: (account.graceReason === 'payment_failed' ? account.retryCount : 0) + 1,
          nextRetryAt: hardDecline(why) ? null : nextRetry(start, now),
          actionUrl: null,
        },
        { now, actor: null, action: 'renewal_failed' },
      );
      return { facts, next };
    });
    if (!done) return;
    const { facts, next } = done;
    await this.emit(charge.officeId);
    await this.notify(facts, 'payment_failed', String(t0), (link, w) => billingMail.paymentFailed(link, w, charge.amount, next.graceEndsAt!, next.nextRetryAt !== null, smallTeam(facts)));
  }

  /** The bank wants the owner to confirm a renewal: past due until they do (no retries meanwhile), unless the owner cancelled. */
  private async actionNeeded(charge: Charge, url: string): Promise<void> {
    const now = this.now;
    const t0 = charge.periodStart!;
    const facts = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, charge.officeId);
      const account = await this.store.forUpdate(tx, charge.officeId);
      const facts = await this.store.facts(tx, charge.officeId);
      if (!account || !facts || account.periodEnd !== t0 || account.cancelAtPeriodEnd) return null;
      await this.store.change(
        tx,
        account,
        { status: 'past_due', graceReason: 'action_needed', graceEndsAt: graceStart(charge, account) + GRACE_DAYS * DAY, nextRetryAt: null, actionUrl: url },
        { now, actor: null, action: 'action_needed' },
      );
      return facts;
    });
    if (!facts) return;
    await this.emit(charge.officeId);
    await this.notify(facts, 'action_needed', charge.reference, (_link, w) => billingMail.actionNeeded(url, w, charge.amount));
  }

  /**
   * Brings an office's stored plan up to date with its dates (free, past due, locked: taking people
   * out when it locks), and with `charge`, charges a renewal that is due (or, `force`, a failed one
   * again now).
   */
  async advance(officeId: string, opts: { charge: boolean; force?: boolean }): Promise<{ outcome: Outcome | 'renewed' | null; became: 'free' | 'locked' | null; reference?: string }> {
    const now = this.now;
    const step = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, officeId);
      const account = await this.store.forUpdate(tx, officeId);
      const facts = account && (await this.store.facts(tx, officeId));
      if (!account || !facts) return null;
      const e = this.stateOf(facts, account, now);
      let next = account;
      let became: 'free' | 'locked' | null = null;
      if (e.status === 'free' && account.status !== 'free' && !account.comp) {
        next = await this.store.change(tx, next, { status: 'free', cancelAtPeriodEnd: false, seatsNext: null, ...CLEAR_GRACE }, { now, actor: null, action: 'free' });
        became = 'free';
      } else if (e.status === 'locked' && account.status !== 'locked') {
        next = await this.store.change(tx, next, { status: 'locked', nextRetryAt: null }, { now, actor: null, action: 'locked' });
        became = 'locked';
      } else if (e.status === 'past_due' && !e.renewing && account.status === 'active') {
        next = await this.store.change(tx, next, { status: 'past_due', graceReason: e.graceReason, graceEndsAt: e.graceEndsAt, nextRetryAt: null }, { now, actor: null, action: 'past_due' });
      }
      if (!opts.charge || became) return { facts, next, became, charge: null, renewed: false, changed: next !== account };
      const failedBefore = e.status === 'past_due' && e.graceReason === 'payment_failed';
      const due = e.renewing || (failedBefore && (opts.force || (account.nextRetryAt !== null && account.nextRetryAt <= now)));
      if (!due) {
        if (opts.force) throw new BillingError(409, 'pay-first', 'There’s no payment to try again.');
        return { facts, next, became, charge: null, renewed: false, changed: next !== account };
      }
      if (!next.authorizationCode || !next.paystackEmail || next.payerUserId !== facts.ownerId || !next.unitAmount || !next.interval || next.periodEnd === null) {
        if (opts.force) throw new BillingError(409, 'no-card', 'Add a card first.');
        return { facts, next, became, charge: null, renewed: false, changed: next !== account };
      }
      const seats = renewalSeats(next, facts.used);
      const amount = seats * next.unitAmount + next.carry;
      const periodStart = next.periodEnd;
      const periodEnd = nextPeriodEnd(next.anchorAt ?? periodStart, periodStart, next.interval);
      if (amount < MIN_CHARGE) {
        // Less than Paystack can charge (credit, say): renewed now, the rest carried to the next renewal.
        next = await this.store.change(
          tx,
          next,
          { status: 'active', seats, seatsNext: null, periodStart, periodEnd, carry: amount, cancelAtPeriodEnd: false, ...CLEAR_GRACE },
          { now, actor: null, action: 'renewed' },
        );
        return { facts, next, became, charge: null, renewed: true, changed: true };
      }
      const charge = await this.store.insertCharge(tx, {
        reference: newReference(officeId),
        officeId,
        officeName: this.nameOf(facts),
        purpose: 'renewal',
        seats,
        seatsFrom: null,
        unitAmount: next.unitAmount,
        amount,
        currency: this.deps.config.currency,
        carryApplied: next.carry,
        periodStart,
        periodEnd,
        attempt: (failedBefore ? next.retryCount : 0) + 1,
        actorUserId: next.payerUserId,
        payerEmail: next.paystackEmail,
        createdAt: now,
      });
      // Null: a renewal for this period is under way (another server, or still unknown).
      return { facts, next, became, charge, renewed: false, changed: next !== account };
    });
    if (!step) return { outcome: null, became: null };
    if (step.became === 'locked') {
      this.deps.realtime.lockChanged(officeId, true, LOCKED_STAFF_CAP);
      await this.notify(step.facts, 'locked', String(step.next.graceEndsAt ?? now), (link, w) => billingMail.locked(link, w), true);
    }
    if (step.changed) await this.emit(officeId);
    if (step.renewed) return { outcome: 'renewed', became: step.became };
    if (!step.charge) return { outcome: null, became: step.became };
    return { outcome: await this.chargeCard(step.charge, step.next.authorizationCode!), became: step.became, reference: step.charge.reference };
  }

  /** The owner tries the failed renewal again now. */
  async retry(officeId: string): Promise<void> {
    const { outcome, reference } = await this.advance(officeId, { charge: true, force: true });
    const charge = outcome === 'action_needed' && reference ? await this.store.charge(this.deps.db, reference) : null;
    this.throwFor(outcome, charge?.authorizationUrl ?? undefined);
  }

  private throwFor(outcome: Outcome | 'renewed' | null, url?: string): void {
    if (outcome === 'failed') throw new BillingError(402, 'card-declined', 'Your card was declined. Nothing was charged.');
    if (outcome === 'action_needed') throw new BillingError(409, 'action-needed', 'Your bank wants you to confirm this payment.', url);
    if (outcome === 'pending') throw new BillingError(502, 'paystack', 'Paystack didn’t answer. We’ll check the payment again shortly.');
  }

  /**
   * Changes the seats of a paid plan. More: charged at once for the rest of the period (seats given
   * when it succeeds), or added to the next renewal when that's under MIN_CHARGE or the period is
   * nearly over. Fewer: from the next renewal on, never below the seats in use.
   */
  async setSeats(officeId: string, user: AccountUser, wanted: unknown): Promise<void> {
    if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1 || wanted > MAX_SEATS) throw new BillingError(400, 'seats', `Pick from 1 to ${MAX_SEATS} seats.`);
    const now = this.now;
    const step = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, officeId);
      const account = await this.store.forUpdate(tx, officeId);
      const facts = account && (await this.store.facts(tx, officeId));
      if (!account || !facts) throw new BillingError(409, 'pay-first', 'Choose a plan first.');
      const e = this.stateOf(facts, account, now);
      if (e.plan === 'comp') throw new BillingError(409, null, 'This workspace is free of charge.');
      // The period ended and the next run charges the renewal.
      if (e.renewing) throw new BillingError(409, 'busy', 'Your plan is renewing. Try again once it has.');
      if (e.status !== 'active' || account.periodStart === null || account.periodEnd === null || !account.unitAmount) {
        throw new BillingError(409, 'pay-first', 'Pay for the plan first.');
      }
      if (wanted < facts.used) throw new BillingError(400, 'below-used', `${facts.used} seats are in use. Remove people or invitations first.`);
      const how = { now, actor: user.id, action: 'seats' };
      if (wanted <= account.seats) {
        const seatsNext = wanted === account.seats ? null : wanted;
        if (seatsNext === account.seatsNext) return null;
        await this.store.change(tx, account, { seatsNext }, how);
        return { facts, charge: null, seats: wanted, from: seatsNext === null ? null : account.periodEnd };
      }
      // One seats charge at a time: a second for the same seats would be paid twice.
      const open = await this.store.openSeats(tx, officeId);
      if (open?.status === 'action_needed') throw new BillingError(409, 'action-needed', 'Confirm the seats you added with your bank first.', open.authorizationUrl ?? undefined);
      if (open) throw new BillingError(409, 'busy', 'Seats are being added already. Try again in a moment.');
      const amount = prorate(wanted - account.seats, account.unitAmount, now, account.periodStart, account.periodEnd);
      // Nearly at the renewal, or less than Paystack can charge: given now, and paid with the renewal.
      if (now >= account.periodEnd - HOUR || amount < MIN_CHARGE) {
        const carry = now >= account.periodEnd - HOUR ? account.carry : account.carry + amount;
        await this.store.change(tx, account, { seats: wanted, seatsNext: null, carry }, how);
        return { facts, charge: null, seats: wanted, from: null };
      }
      if (!account.authorizationCode || !account.paystackEmail || account.payerUserId !== facts.ownerId) throw new BillingError(409, 'no-card', 'Add a card first.');
      const charge = await this.store.insertCharge(tx, {
        reference: newReference(officeId),
        officeId,
        officeName: this.nameOf(facts),
        purpose: 'seats',
        seats: wanted,
        seatsFrom: account.seats,
        unitAmount: account.unitAmount,
        amount,
        currency: this.deps.config.currency,
        carryApplied: 0,
        periodStart: account.periodStart,
        periodEnd: account.periodEnd,
        attempt: 1,
        actorUserId: user.id,
        payerEmail: account.paystackEmail,
        createdAt: now,
      });
      if (!charge) throw new BillingError(409, 'busy', 'Seats are being added already. Try again in a moment.');
      return { facts, charge, code: account.authorizationCode, seats: wanted, from: null };
    });
    if (!step) return;
    if (step.charge) {
      const outcome = await this.chargeCard(step.charge, step.code!);
      const after = outcome === 'action_needed' ? await this.store.charge(this.deps.db, step.charge.reference) : null;
      this.throwFor(outcome, after?.authorizationUrl ?? undefined);
    } else await this.emit(officeId);
    await this.notify(step.facts, 'seats', String(now), (link, w) => billingMail.seatsChanged(link, w, step.seats, step.from));
  }

  /**
   * Ends the plan at the end of the period (or, once the period has ended, now: the renewal that's due
   * isn't charged, and past due, the card isn't tried again).
   */
  async cancel(officeId: string, user: AccountUser): Promise<void> {
    const now = this.now;
    const done = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, officeId);
      const account = await this.store.forUpdate(tx, officeId);
      const facts = account && (await this.store.facts(tx, officeId));
      if (!account || !facts) throw new BillingError(409, null, 'There’s no plan to cancel.');
      const e = this.stateOf(facts, account, now);
      const how = { now, actor: user.id, action: 'cancel' };
      let next = account;
      if ((e.status === 'active' || e.renewing) && e.plan !== 'comp') {
        if (!account.cancelAtPeriodEnd) next = await this.store.change(tx, account, { cancelAtPeriodEnd: true }, how);
      } else if (e.status === 'past_due' && (e.graceReason === 'payment_failed' || e.graceReason === 'action_needed')) {
        next = await this.store.change(tx, account, { cancelAtPeriodEnd: true, graceReason: 'cancelled', nextRetryAt: null, actionUrl: null }, how);
      } else throw new BillingError(409, null, 'There’s no plan to cancel.');
      return { facts, next };
    });
    await this.emit(officeId);
    const { facts, next } = done;
    const end = next.periodEnd;
    if (end === null) return;
    if (now < end) await this.notify(facts, 'cancelled', String(end), (link, w) => billingMail.cancelled(link, w, end));
    else {
      // The period is over: it pauses at the end of its grace (a small team is on the Free plan now).
      const e = this.stateOf(facts, next, now);
      const pausesAt = e.status === 'past_due' ? e.graceEndsAt : null;
      await this.notify(facts, 'cancelled', String(end), (link, w) => billingMail.renewalStopped(link, w, pausesAt));
    }
  }

  /**
   * Keeps a cancelled plan renewing: until its period ends, or after that until it pauses, as long
   * as its renewal wasn't tried (it's then charged at the next run). A plan cancelled after a failed
   * payment is paid with a checkout instead.
   */
  async resume(officeId: string, user: AccountUser): Promise<void> {
    const now = this.now;
    await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, officeId);
      const account = await this.store.forUpdate(tx, officeId);
      const facts = account && (await this.store.facts(tx, officeId));
      const gone = () => new BillingError(409, 'pay-first', 'The plan has ended. Pay to start it again.');
      if (!account || !facts || account.periodEnd === null || account.comp) throw gone();
      const e = this.stateOf(facts, account, now);
      const running = account.status === 'active' && now < account.periodEnd;
      const untried = e.status === 'past_due' && e.graceReason === 'cancelled' && !(await this.store.renewalTried(tx, officeId, account.periodEnd));
      if (!running && !untried) throw gone();
      if (!account.cancelAtPeriodEnd) return;
      await this.store.change(tx, account, { cancelAtPeriodEnd: false, ...(account.status === 'active' ? {} : { status: 'active', ...CLEAR_GRACE }) }, { now, actor: user.id, action: 'resume' });
    });
    await this.emit(officeId);
  }

  /**
   * The owner made someone else the owner: the paid period stays, but the old owner's card is
   * removed and nothing renews until the new owner adds a card.
   */
  async ownerChanged(officeId: string, from: string, to: string): Promise<void> {
    const now = this.now;
    const done = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, officeId);
      const account = await this.store.forUpdate(tx, officeId);
      const facts = account && (await this.store.facts(tx, officeId));
      if (!account || !facts || account.comp || facts.ownerId !== to) return null;
      await this.store.change(
        tx,
        account,
        {
          authorizationCode: null,
          cardSignature: null,
          cardBrand: null,
          cardLast4: null,
          cardExpMonth: null,
          cardExpYear: null,
          cardBank: null,
          paystackEmail: null,
          customerCode: null,
          payerUserId: null,
          autoRenew: false,
        },
        { now, actor: from, action: 'owner_changed' },
      );
      const plan = this.stateOf(facts, account, now).plan;
      return { facts, account, paid: plan === 'team' || plan === 'support' };
    });
    if (!done) return;
    if (done.account.authorizationCode) this.forgetCard(done.account.authorizationCode);
    await this.emit(officeId);
    if (done.paid) await this.notify(done.facts, 'add_card', `${to}:${now}`, (link, w) => billingMail.addCard(link, w, done.account.periodEnd));
  }

  /** A card payment was disputed with the bank: noted, and the owner told. */
  async disputed(reference: string): Promise<void> {
    const charge = await this.store.charge(this.deps.db, reference);
    if (!charge) return;
    const now = this.now;
    const facts = await this.deps.db.transaction(async (tx) => {
      await lockSeats(tx, charge.officeId);
      const account = await this.store.forUpdate(tx, charge.officeId);
      const facts = account && (await this.store.facts(tx, charge.officeId));
      if (!account || !facts) return null;
      await this.store.change(tx, account, { disputedAt: now }, { now, actor: null, action: `disputed:${reference}` });
      return facts;
    });
    if (facts) await this.notify(facts, 'disputed', reference, (link, w) => billingMail.disputed(link, w));
  }

  /**
   * Sends an email once (claimed in billing_notices first), to the owner's verified address (and,
   * with `admins`, the admins'). Nothing when mail is off, or there's nobody to send it to.
   */
  private async notify(facts: OfficeFacts, kind: string, key: string, build: (link: string, workspace: string) => MailContent, admins = false): Promise<void> {
    const { mailer } = this.deps;
    if (mailer.kind === 'off') return;
    const to = new Set([facts.ownerEmail, ...(admins ? await this.store.adminEmails(facts.officeId) : [])].filter((e): e is string => !!e));
    if (!to.size || !(await this.store.notice(facts.officeId, kind, key, this.now))) return;
    const content = build(this.link(facts.officeId), this.nameOf(facts));
    for (const address of to) mailer.send({ to: address, ...content });
    this.mailed++;
  }

  /** The reminders that depend on the date: launch, renewal coming, card expiring, payment overdue. */
  private async remind(facts: OfficeFacts, account: StoredAccount): Promise<void> {
    const now = this.now;
    const e = this.stateOf(facts, account, now);
    if (e.status === 'past_due' && e.graceEndsAt !== null && e.graceReason) {
      const ends = e.graceEndsAt;
      if (e.graceReason === 'launch') await this.notify(facts, 'launch', 'launch', (link, w) => billingMail.launch(link, w, ends));
      const free = smallTeam(facts);
      if (now >= ends - DAY) await this.notify(facts, 'locks_tomorrow', String(ends), (link, w) => billingMail.locksTomorrow(link, w, free));
      else if (now >= ends - 4 * DAY) await this.notify(facts, 'reminder', String(ends), (link, w) => billingMail.reminder(link, w, ends, free));
      return;
    }
    if (e.status !== 'active' || e.renewing || !account.autoRenew || !account.hasCard || account.cancelAtPeriodEnd || account.periodEnd === null) return;
    const end = account.periodEnd;
    const left = end - now;
    const card = account.cardLast4;
    if (facts.kind === 'support' && account.unitAmount) {
      const amount = Math.max(0, renewalSeats(account, facts.used) * account.unitAmount + account.carry);
      if (left <= 7 * DAY) await this.notify(facts, 'renews_7', String(end), (link, w) => billingMail.renewsSoon(link, w, amount, end, card));
      else if (left <= 30 * DAY) await this.notify(facts, 'renews_30', String(end), (link, w) => billingMail.renewsSoon(link, w, amount, end, card));
    }
    // A card that expires before the renewal (it's good until the end of its month).
    if (account.cardExpYear && account.cardExpMonth && left <= 30 * DAY && Date.UTC(account.cardExpYear, account.cardExpMonth, 1) <= end) {
      await this.notify(facts, 'card_expiring', String(end), (link, w) => billingMail.cardExpiring(link, w, end));
    }
  }

  /**
   * The scheduled run (the hourly loop, and the daily tick from the Worker's cron): payments still
   * unknown, refunds still due, renewals and retries, locks, and reminders. One at a time, and awaited
   * when the server closes; safe to run on two servers at once (each office's changes are claimed
   * under its lock).
   */
  runDue(): Promise<TickSummary> {
    if (!this.running) {
      this.running = this.run().finally(() => (this.running = null));
      this.track(this.running);
    }
    return this.running;
  }

  private async run(): Promise<TickSummary> {
    const now = this.now;
    const mailedBefore = this.mailed;
    const summary: TickSummary = { reconciled: 0, renewed: 0, failed: 0, locked: 0, freed: 0, refunded: 0, mailed: 0 };
    for (const reference of await this.store.unsettled(now - RECONCILE_AFTER, now - ABANDON_AFTER, RECONCILE_BATCH)) {
      try {
        await this.store.checked(reference, now);
        const charge = await this.settle(reference);
        if (charge && charge.status !== 'pending' && charge.status !== 'action_needed') summary.reconciled++;
      } catch (err) {
        console.error('[billing] could not settle a payment:', err);
      }
    }
    for (const reference of await this.store.refundsDue(RECONCILE_BATCH)) {
      try {
        if (await this.refund(reference)) summary.refunded++;
      } catch (err) {
        console.error('[billing] could not refund a payment:', err);
      }
    }
    for (const officeId of await this.store.due(now)) {
      try {
        const { outcome, became } = await this.advance(officeId, { charge: true });
        if (outcome === 'succeeded' || outcome === 'renewed') summary.renewed++;
        if (outcome === 'failed') summary.failed++;
        if (became === 'locked') summary.locked++;
        if (became === 'free') summary.freed++;
      } catch (err) {
        console.error('[billing] could not bring a plan up to date:', err);
      }
    }
    for (const officeId of await this.store.open()) {
      const [row] = await this.store.load([officeId]);
      if (row?.account) await this.remind(row.facts, row.account).catch((err) => console.error('[billing] could not send a reminder:', err));
    }
    summary.mailed = this.mailed - mailedBefore;
    return summary;
  }
}

function receiptOf(c: Charge): BillingReceipt {
  return {
    reference: c.reference,
    purpose: c.purpose,
    status: c.status,
    seats: c.seats,
    unitAmount: c.unitAmount,
    amount: c.amount,
    currency: c.currency,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    card: c.cardLast4 ? { brand: c.cardBrand, last4: c.cardLast4 } : null,
    createdAt: c.createdAt,
    settledAt: c.settledAt,
    refund: c.status === 'superseded' ? c.refund : null,
  };
}
