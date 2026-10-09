import { FREE_SEATS, LAUNCH_DAYS, type ChargePurpose, type ChargeStatus, type GraceReason, type RefundState } from '../../../shared/billing';
import type { OfficeKind } from '../../../shared/workspace';
import { jsonb, type Db, type Tx } from '../../db';
import type { Account, Interval } from './state';

// Billing's SQL. Every time comes from billing's clock (options.now), passed in as a parameter: billing
// SQL never asks the database for now(), so tests can move the clock. (Open invitations, which count
// as seats, expire by the database's time.)

/** Times as the database takes them. */
const ts = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const msOf = (d: Date | string | null) => (d === null ? null : new Date(d).getTime());
const num = (v: string | number | null) => (v === null ? null : Number(v));

/** An office's billing row, as stored. */
export interface StoredAccount extends Account {
  officeId: string;
  paystackEmail: string | null;
  customerCode: string | null;
  authorizationCode: string | null;
  cardSignature: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  cardBank: string | null;
  actionUrl: string | null;
  disputedAt: number | null;
}

/** What can be changed (hasCard follows authorizationCode). */
export type AccountPatch = Partial<Omit<StoredAccount, 'officeId' | 'hasCard' | 'comp'>>;

const COLUMNS: Record<keyof AccountPatch, string> = {
  status: 'status',
  seats: 'seats',
  seatsNext: 'seats_next',
  unitAmount: 'unit_amount',
  interval: 'interval',
  anchorAt: 'anchor_at',
  periodStart: 'period_start',
  periodEnd: 'period_end',
  cancelAtPeriodEnd: 'cancel_at_period_end',
  autoRenew: 'auto_renew',
  graceReason: 'grace_reason',
  graceEndsAt: 'grace_ends_at',
  retryCount: 'retry_count',
  nextRetryAt: 'next_retry_at',
  carry: 'carry_amount',
  payerUserId: 'payer_user_id',
  paystackEmail: 'paystack_email',
  customerCode: 'customer_code',
  authorizationCode: 'authorization_code',
  cardSignature: 'card_signature',
  cardBrand: 'card_brand',
  cardLast4: 'card_last4',
  cardExpMonth: 'card_exp_month',
  cardExpYear: 'card_exp_year',
  cardBank: 'card_bank',
  actionUrl: 'action_url',
  disputedAt: 'disputed_at',
};
const TIMES = new Set<keyof AccountPatch>(['anchorAt', 'periodStart', 'periodEnd', 'graceEndsAt', 'nextRetryAt', 'disputedAt']);

interface AccountRow {
  office_id: string;
  status: Account['status'];
  comp: boolean;
  seats: number;
  seats_next: number | null;
  unit_amount: string | null;
  interval: Interval | null;
  anchor_at: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  cancel_at_period_end: boolean;
  auto_renew: boolean;
  grace_reason: GraceReason | null;
  grace_ends_at: Date | null;
  retry_count: number;
  next_retry_at: Date | null;
  carry_amount: string;
  payer_user_id: string | null;
  paystack_email: string | null;
  customer_code: string | null;
  authorization_code: string | null;
  card_signature: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  card_bank: string | null;
  action_url: string | null;
  disputed_at: Date | null;
}

const ACCOUNT_COLUMNS = `b.office_id, b.status, b.comp, b.seats, b.seats_next, b.unit_amount, b.interval, b.anchor_at, b.period_start,
  b.period_end, b.cancel_at_period_end, b.auto_renew, b.grace_reason, b.grace_ends_at, b.retry_count, b.next_retry_at, b.carry_amount,
  b.payer_user_id, b.paystack_email, b.customer_code, b.authorization_code, b.card_signature, b.card_brand, b.card_last4,
  b.card_exp_month, b.card_exp_year, b.card_bank, b.action_url, b.disputed_at`;

function toAccount(r: AccountRow): StoredAccount {
  return {
    officeId: r.office_id,
    status: r.status,
    comp: r.comp,
    seats: r.seats,
    seatsNext: r.seats_next,
    unitAmount: num(r.unit_amount),
    interval: r.interval,
    anchorAt: msOf(r.anchor_at),
    periodStart: msOf(r.period_start),
    periodEnd: msOf(r.period_end),
    cancelAtPeriodEnd: r.cancel_at_period_end,
    autoRenew: r.auto_renew,
    graceReason: r.grace_reason,
    graceEndsAt: msOf(r.grace_ends_at),
    retryCount: r.retry_count,
    nextRetryAt: msOf(r.next_retry_at),
    carry: Number(r.carry_amount),
    payerUserId: r.payer_user_id,
    hasCard: !!r.authorization_code,
    paystackEmail: r.paystack_email,
    customerCode: r.customer_code,
    authorizationCode: r.authorization_code,
    cardSignature: r.card_signature,
    cardBrand: r.card_brand,
    cardLast4: r.card_last4,
    cardExpMonth: r.card_exp_month,
    cardExpYear: r.card_exp_year,
    cardBank: r.card_bank,
    actionUrl: r.action_url,
    disputedAt: msOf(r.disputed_at),
  };
}

/** An office as billing needs to know it. */
export interface OfficeFacts {
  officeId: string;
  kind: OfficeKind;
  name: string;
  createdAt: number;
  used: number;
  ownerId: string | null;
  /** The owner's address, when verified. */
  ownerEmail: string | null;
}

const FACTS = `o.id AS office_id_, o.kind, coalesce(o.data->'settings'->>'name', '') AS name, o.created_at AS office_created_at,
  (SELECT count(*) FROM memberships m WHERE m.office_id = o.id)::int
    + (SELECT count(*) FROM office_invites i WHERE i.office_id = o.id AND i.expires_at > now())::int AS used,
  w.user_id AS owner_id, CASE WHEN u.email_verified_at IS NOT NULL THEN u.email END AS owner_email`;
const FACTS_FROM = `offices o LEFT JOIN memberships w ON w.office_id = o.id AND w.role = 'owner' LEFT JOIN users u ON u.id = w.user_id`;

interface FactsRow {
  office_id_: string;
  kind: OfficeKind;
  name: string;
  office_created_at: Date;
  used: number;
  owner_id: string | null;
  owner_email: string | null;
}

const toFacts = (r: FactsRow): OfficeFacts => ({
  officeId: r.office_id_,
  kind: r.kind,
  name: r.name,
  createdAt: msOf(r.office_created_at)!,
  used: r.used,
  ownerId: r.owner_id,
  ownerEmail: r.owner_email,
});

export interface Charge {
  reference: string;
  officeId: string;
  officeName: string;
  purpose: ChargePurpose;
  status: ChargeStatus;
  seats: number;
  /** A seats charge: the seats it adds to (null for the other purposes). */
  seatsFrom: number | null;
  unitAmount: number;
  amount: number;
  currency: string;
  carryApplied: number;
  periodStart: number | null;
  periodEnd: number | null;
  attempt: number;
  actorUserId: string | null;
  payerEmail: string;
  gatewayResponse: string | null;
  authorizationUrl: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  createdAt: number;
  settledAt: number | null;
  refund: RefundState | null;
}

interface ChargeRow {
  reference: string;
  office_id: string;
  office_name: string;
  purpose: ChargePurpose;
  status: ChargeStatus;
  seats: number;
  seats_from: number | null;
  unit_amount: string;
  amount: string;
  currency: string;
  carry_applied: string;
  period_start: Date | null;
  period_end: Date | null;
  attempt: number;
  actor_user_id: string | null;
  payer_email: string;
  gateway_response: string | null;
  authorization_url: string | null;
  card_last4: string | null;
  card_brand: string | null;
  created_at: Date;
  settled_at: Date | null;
  refund: RefundState | null;
}

const CHARGE_COLUMNS = `reference, office_id, office_name, purpose, status, seats, seats_from, unit_amount, amount, currency, carry_applied,
  period_start, period_end, attempt, actor_user_id, payer_email, gateway_response, authorization_url, card_last4, card_brand, created_at,
  settled_at, refund`;

const toCharge = (r: ChargeRow): Charge => ({
  reference: r.reference,
  officeId: r.office_id,
  officeName: r.office_name,
  purpose: r.purpose,
  status: r.status,
  seats: r.seats,
  seatsFrom: r.seats_from,
  unitAmount: Number(r.unit_amount),
  amount: Number(r.amount),
  currency: r.currency,
  carryApplied: Number(r.carry_applied),
  periodStart: msOf(r.period_start),
  periodEnd: msOf(r.period_end),
  attempt: r.attempt,
  actorUserId: r.actor_user_id,
  payerEmail: r.payer_email,
  gatewayResponse: r.gateway_response,
  authorizationUrl: r.authorization_url,
  cardLast4: r.card_last4,
  cardBrand: r.card_brand,
  createdAt: msOf(r.created_at)!,
  settledAt: msOf(r.settled_at),
  refund: r.refund,
});

export type NewCharge = Omit<Charge, 'status' | 'gatewayResponse' | 'authorizationUrl' | 'cardLast4' | 'cardBrand' | 'settledAt' | 'refund'>;

export class BillingStore {
  constructor(private readonly db: Db) {}

  /** These offices with their billing rows (null where there's none). */
  async load(officeIds: string[]): Promise<{ facts: OfficeFacts; account: StoredAccount | null }[]> {
    if (!officeIds.length) return [];
    const res = await this.db.query<FactsRow & AccountRow>(
      `SELECT ${FACTS}, ${ACCOUNT_COLUMNS} FROM ${FACTS_FROM} LEFT JOIN billing_accounts b ON b.office_id = o.id WHERE o.id = ANY($1::text[])`,
      [officeIds],
    );
    return res.rows.map((r) => ({ facts: toFacts(r), account: r.office_id ? toAccount(r) : null }));
  }

  async facts(q: Tx, officeId: string): Promise<OfficeFacts | null> {
    const res = await q.query<FactsRow>(`SELECT ${FACTS} FROM ${FACTS_FROM} WHERE o.id = $1`, [officeId]);
    return res.rows[0] ? toFacts(res.rows[0]) : null;
  }

  /** Makes the office's row (as it is without one: free, or unpaid for support), locked until the transaction ends. */
  async ensure(tx: Tx, officeId: string, now: number): Promise<StoredAccount | null> {
    await tx.query(
      `INSERT INTO billing_accounts (office_id, status, created_at, updated_at)
       SELECT id, CASE kind WHEN 'support' THEN 'incomplete' ELSE 'free' END, $2::timestamptz, $2::timestamptz FROM offices WHERE id = $1
       ON CONFLICT (office_id) DO NOTHING`,
      [officeId, ts(now)],
    );
    return this.forUpdate(tx, officeId);
  }

  /** The office's row, locked until the transaction ends; null when there's none. */
  async forUpdate(tx: Tx, officeId: string): Promise<StoredAccount | null> {
    const res = await tx.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM billing_accounts b WHERE b.office_id = $1 FOR UPDATE`, [officeId]);
    return res.rows[0] ? toAccount(res.rows[0]) : null;
  }

  /** Changes the row and logs who did it, with what the changed fields were before. */
  async change(tx: Tx, account: StoredAccount, patch: AccountPatch, how: { now: number; actor: string | null; action: string }): Promise<StoredAccount> {
    const keys = Object.keys(patch) as (keyof AccountPatch)[];
    const values = keys.map((k) => (TIMES.has(k) ? ts(patch[k] as number | null) : patch[k]));
    const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 3}`);
    await tx.query(`UPDATE billing_accounts SET ${[...sets, 'updated_at = $2'].join(', ')} WHERE office_id = $1`, [account.officeId, ts(how.now), ...values]);
    // The card's authorization code (it can be charged) stays out of the log: only whether there is one.
    const logged = (values: AccountPatch) => ('authorizationCode' in values ? { ...values, authorizationCode: values.authorizationCode ? 'saved' : null } : values);
    const before = Object.fromEntries(keys.map((k) => [k, account[k]])) as AccountPatch;
    await this.log(tx, account.officeId, how, logged(before), logged(patch));
    const next = { ...account, ...patch };
    return { ...next, hasCard: !!next.authorizationCode };
  }

  async log(q: Tx, officeId: string, how: { now: number; actor: string | null; action: string }, before: unknown = null, after: unknown = null): Promise<void> {
    await q.query('INSERT INTO billing_log (office_id, at, actor_user_id, action, before, after) VALUES ($1, $2::timestamptz, $3, $4, $5::jsonb, $6::jsonb)', [
      officeId,
      ts(how.now),
      how.actor,
      how.action,
      before === null ? null : jsonb(before),
      after === null ? null : jsonb(after),
    ]);
  }

  /** Records a charge before asking Paystack for it; null when the office already has one like it (one renewal per period, one seats charge). */
  async insertCharge(tx: Tx, c: NewCharge): Promise<Charge | null> {
    const res = await tx.query<ChargeRow>(
      `INSERT INTO billing_charges (reference, office_id, office_name, purpose, status, seats, seats_from, unit_amount, amount, currency,
         carry_applied, period_start, period_end, attempt, actor_user_id, payer_email, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $16, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12, $13, $14, $15::timestamptz)
       ON CONFLICT DO NOTHING RETURNING ${CHARGE_COLUMNS}`,
      [
        c.reference,
        c.officeId,
        c.officeName,
        c.purpose,
        c.seats,
        c.unitAmount,
        c.amount,
        c.currency,
        c.carryApplied,
        ts(c.periodStart),
        ts(c.periodEnd),
        c.attempt,
        c.actorUserId,
        c.payerEmail,
        ts(c.createdAt),
        c.seatsFrom,
      ],
    );
    return res.rows[0] ? toCharge(res.rows[0]) : null;
  }

  async charge(q: Tx, reference: string): Promise<Charge | null> {
    const res = await q.query<ChargeRow>(`SELECT ${CHARGE_COLUMNS} FROM billing_charges WHERE reference = $1`, [reference]);
    return res.rows[0] ? toCharge(res.rows[0]) : null;
  }

  /** Moves a charge on from one of `from`; false when it wasn't in one of those any more. */
  async markCharge(q: Tx, reference: string, status: ChargeStatus, from: ChargeStatus[], extra: { gatewayResponse?: string | null; authorizationUrl?: string | null } = {}): Promise<boolean> {
    const res = await q.query(
      `UPDATE billing_charges SET status = $2, gateway_response = coalesce($4, gateway_response), authorization_url = coalesce($5, authorization_url)
       WHERE reference = $1 AND status = ANY($3::text[])`,
      [reference, status, from, extra.gatewayResponse?.slice(0, 200) ?? null, extra.authorizationUrl ?? null],
    );
    return res.rowCount > 0;
  }

  /** Marks a charge paid, once: null when it was already (or was refunded or superseded). */
  async succeed(
    tx: Tx,
    reference: string,
    paid: { txId: string | null; fees: number | null; at: number; gatewayResponse: string | null; cardLast4: string | null; cardBrand: string | null },
  ): Promise<Charge | null> {
    const res = await tx.query<ChargeRow>(
      `UPDATE billing_charges SET status = 'succeeded', paystack_tx_id = $2::bigint, fees = $3, settled_at = $4::timestamptz,
         gateway_response = coalesce($5, gateway_response), card_last4 = coalesce($6, card_last4), card_brand = coalesce($7, card_brand)
       WHERE reference = $1 AND status NOT IN ('succeeded', 'refunded', 'superseded') RETURNING ${CHARGE_COLUMNS}`,
      [reference, paid.txId, paid.fees, ts(paid.at), paid.gatewayResponse?.slice(0, 200) ?? null, paid.cardLast4, paid.cardBrand],
    );
    return res.rows[0] ? toCharge(res.rows[0]) : null;
  }

  /** A payment for something already paid: kept, with its refund due. */
  async supersede(q: Tx, reference: string): Promise<void> {
    await q.query("UPDATE billing_charges SET status = 'superseded', refund = 'due' WHERE reference = $1", [reference]);
  }

  async setRefund(q: Tx, reference: string, refund: RefundState): Promise<void> {
    await q.query('UPDATE billing_charges SET refund = $2 WHERE reference = $1', [reference, refund]);
  }

  /** Refunds due (Paystack wasn't reached when they were asked), oldest first. */
  async refundsDue(limit: number): Promise<string[]> {
    const res = await this.db.query<{ reference: string }>("SELECT reference FROM billing_charges WHERE refund = 'due' ORDER BY created_at LIMIT $1", [limit]);
    return res.rows.map((r) => r.reference);
  }

  /** The period a payment actually paid for (a new plan's starts when it's paid). */
  async setChargePeriod(q: Tx, reference: string, start: number, end: number): Promise<void> {
    await q.query('UPDATE billing_charges SET period_start = $2::timestamptz, period_end = $3::timestamptz WHERE reference = $1', [reference, ts(start), ts(end)]);
  }

  /**
   * The office's latest charges (its history), newest first. Checkouts never paid (left on Paystack's
   * page, declined there, or not started) are left out; the saved card's charges stay, failed ones too.
   */
  async charges(officeId: string, limit: number): Promise<Charge[]> {
    const res = await this.db.query<ChargeRow>(
      `SELECT ${CHARGE_COLUMNS} FROM billing_charges WHERE office_id = $1
         AND NOT (purpose IN ('subscribe', 'pay_due', 'card_update') AND status IN ('pending', 'failed', 'abandoned'))
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [officeId, limit],
    );
    return res.rows.map(toCharge);
  }

  /** The office's seats charge under way (waiting for Paystack or for the bank), if any. */
  async openSeats(q: Tx, officeId: string): Promise<Charge | null> {
    const res = await q.query<ChargeRow>(`SELECT ${CHARGE_COLUMNS} FROM billing_charges WHERE office_id = $1 AND purpose = 'seats' AND status IN ('pending', 'action_needed')`, [
      officeId,
    ]);
    return res.rows[0] ? toCharge(res.rows[0]) : null;
  }

  /** Whether a renewal of the period starting at `periodStart` was tried (charged, or tried and failed). */
  async renewalTried(q: Tx, officeId: string, periodStart: number): Promise<boolean> {
    const res = await q.query("SELECT 1 FROM billing_charges WHERE office_id = $1 AND purpose = 'renewal' AND period_start = $2::timestamptz", [officeId, ts(periodStart)]);
    return res.rowCount > 0;
  }

  /**
   * Charges whose outcome is still unknown, made before `before`. Saved cards' charges (renewals and
   * seats) come first and every time, least recently checked first; a checkout only once after
   * `before` and again once it's older than `givenUp`, as one that isn't paid is usually just left.
   */
  async unsettled(before: number, givenUp: number, limit: number): Promise<string[]> {
    const res = await this.db.query<{ reference: string }>(
      `SELECT reference FROM billing_charges
       WHERE status IN ('pending', 'action_needed') AND created_at < $1::timestamptz
         AND (purpose IN ('renewal', 'seats') OR checked_at IS NULL OR created_at < $2::timestamptz)
       ORDER BY purpose IN ('renewal', 'seats') DESC, checked_at NULLS FIRST, created_at LIMIT $3`,
      [ts(before), ts(givenUp), limit],
    );
    return res.rows.map((r) => r.reference);
  }

  async checked(reference: string, now: number): Promise<void> {
    await this.db.query('UPDATE billing_charges SET checked_at = $2::timestamptz WHERE reference = $1', [reference, ts(now)]);
  }

  /** Offices whose plan may need something done: a period that ended, a grace period, or a lock (maybe to lift). */
  async due(now: number): Promise<string[]> {
    const res = await this.db.query<{ office_id: string }>(
      `SELECT office_id FROM billing_accounts WHERE NOT comp
         AND ((status = 'active' AND period_end <= $1::timestamptz) OR status IN ('past_due', 'locked'))
       ORDER BY office_id`,
      [ts(now)],
    );
    return res.rows.map((r) => r.office_id);
  }

  /** Offices on a plan or that need one (not free), for reminders. */
  async open(): Promise<string[]> {
    const res = await this.db.query<{ office_id: string }>("SELECT office_id FROM billing_accounts WHERE status <> 'free' AND NOT comp ORDER BY office_id");
    return res.rows.map((r) => r.office_id);
  }

  /** Claims an email to send once; false when it was sent already. */
  async notice(officeId: string, kind: string, key: string, now: number): Promise<boolean> {
    const res = await this.db.query('INSERT INTO billing_notices (office_id, kind, period_key, sent_at) VALUES ($1, $2, $3, $4::timestamptz) ON CONFLICT DO NOTHING RETURNING 1', [
      officeId,
      kind,
      key,
      ts(now),
    ]);
    return res.rowCount > 0;
  }

  /** The verified addresses of the office's admins. */
  async adminEmails(officeId: string): Promise<string[]> {
    const res = await this.db.query<{ email: string }>(
      "SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.office_id = $1 AND m.role = 'admin' AND u.email_verified_at IS NOT NULL",
      [officeId],
    );
    return res.rows.map((r) => r.email);
  }

  /** Records a webhook once; false when it came before. */
  async event(event: string, key: string, reference: string | null, payload: unknown, now: number): Promise<number | null> {
    const res = await this.db.query<{ id: string }>(
      'INSERT INTO billing_events (event, key, reference, payload, received_at) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz) ON CONFLICT DO NOTHING RETURNING id',
      [event, key, reference, jsonb(payload), ts(now)],
    );
    return res.rows[0] ? Number(res.rows[0].id) : null;
  }

  async handled(id: number, now: number): Promise<void> {
    await this.db.query('UPDATE billing_events SET handled_at = $2::timestamptz WHERE id = $1', [id, ts(now)]);
  }

  /**
   * When billing was switched on. The first time (the server's first start with a Paystack key), every
   * support workspace there is, and every team with more than FREE_SEATS people, gets LAUNCH_DAYS to
   * choose a plan; smaller teams are free (they need no row).
   */
  async launch(now: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('billing:launch'))");
      const first = await tx.query('INSERT INTO billing_launch (id, launched_at) VALUES (true, $1::timestamptz) ON CONFLICT DO NOTHING RETURNING launched_at', [ts(now)]);
      if (first.rowCount) {
        await tx.query(
          `INSERT INTO billing_accounts (office_id, status, grace_reason, grace_ends_at, created_at, updated_at)
           SELECT o.id, 'past_due', 'launch', $1::timestamptz + make_interval(days => $2), $1::timestamptz, $1::timestamptz FROM offices o
           WHERE o.created_at <= $1::timestamptz AND (o.kind = 'support' OR
             (SELECT count(*) FROM memberships m WHERE m.office_id = o.id) + (SELECT count(*) FROM office_invites i WHERE i.office_id = o.id AND i.expires_at > $1::timestamptz) > $3)
           ON CONFLICT (office_id) DO NOTHING`,
          [ts(now), LAUNCH_DAYS, FREE_SEATS],
        );
        await tx.query("INSERT INTO billing_log (office_id, at, action) SELECT office_id, $1::timestamptz, 'launch' FROM billing_accounts WHERE grace_reason = 'launch'", [ts(now)]);
      }
      const res = await tx.query<{ launched_at: Date }>('SELECT launched_at FROM billing_launch');
      return msOf(res.rows[0].launched_at)!;
    });
  }
}
