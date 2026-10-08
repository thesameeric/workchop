import {
  DAILY_COINS,
  PRESENCE_COINS,
  PRESENCE_DAILY_CAP,
  utcDay,
  WELCOME_COINS,
  type CoinKind,
  type LedgerEntry,
} from '../../../shared/coins';
import type { Db, Tx } from '../../db';
import type { Migration } from '../../db/migrations';

export const migrations: Migration[] = [
  {
    id: 600,
    name: 'coins',
    sql: `
      CREATE TABLE wallets (
        user_id    text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
        balance    int NOT NULL CHECK (balance >= 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- Every change to a wallet, with the balance it left. Rows are never changed or deleted.
      CREATE TABLE coin_ledger (
        id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id              text NOT NULL REFERENCES users ON DELETE CASCADE,
        delta                int NOT NULL CHECK (delta <> 0),
        balance_after        int NOT NULL CHECK (balance_after >= 0),
        kind                 text NOT NULL CHECK (kind IN ('welcome', 'daily', 'presence', 'tip_in', 'tip_out')),
        counterparty_user_id text REFERENCES users ON DELETE SET NULL,
        office_id            text REFERENCES offices ON DELETE SET NULL,
        note                 text,
        -- welcome:<user>, daily:<user>:<day>, presence:<user>:<day>:<n>, tip:<sender>:<uuid>[:in]
        idempotency_key      text UNIQUE,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX coin_ledger_user_idx ON coin_ledger (user_id, id DESC);
      CREATE INDEX coin_ledger_user_kind_idx ON coin_ledger (user_id, kind, created_at);
      -- Offices where the owner turned coins off (or back on); no row means on.
      CREATE TABLE coin_offices (
        office_id  text PRIMARY KEY REFERENCES offices ON DELETE CASCADE,
        enabled    boolean NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );`,
  },
];

/** A tip that can't be made; the message is shown to the sender. */
export class CoinsError extends Error {}

/** Wallet balances are Postgres ints. */
const MAX_BALANCE = 2_147_483_647;

interface EntryRow {
  id: string | number;
  delta: number;
  balance_after: number;
  kind: CoinKind;
  counterparty_user_id: string | null;
  counterparty_name: string | null;
  office_id: string | null;
  note: string | null;
  created_at: Date | string;
}

function toEntry(r: EntryRow): LedgerEntry {
  return {
    id: Number(r.id),
    delta: r.delta,
    balanceAfter: r.balance_after,
    kind: r.kind,
    counterparty: r.counterparty_user_id ? { id: r.counterparty_user_id, name: r.counterparty_name ?? '' } : null,
    officeId: r.office_id,
    note: r.note,
    at: new Date(r.created_at).getTime(),
  };
}

export interface Award {
  balance: number;
  delta: number;
  kind: CoinKind;
}

export interface TipResult {
  fromBalance: number;
  toBalance: number;
  /** Account names, for the shout-out. */
  fromName: string;
  toName: string;
  /** The same tip (same key) was already made; nothing changed. */
  duplicate: boolean;
}

/**
 * Wallets and their ledger. Every change runs in one transaction that locks the wallets it touches
 * (SELECT … FOR UPDATE, in user id order so two transfers can't deadlock) and writes ledger rows
 * whose unique idempotency keys make retries and repeats harmless.
 */
export class Wallets {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates the wallet with its welcome bonus if it doesn't exist; true when it was created. */
  private async create(tx: Tx, userId: string, at: Date): Promise<boolean> {
    const made = await tx.query('INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id', [
      userId,
      WELCOME_COINS,
    ]);
    if (!made.rows.length) return false;
    await tx.query(
      `INSERT INTO coin_ledger (user_id, delta, balance_after, kind, idempotency_key, created_at) VALUES ($1, $2, $2, 'welcome', $3, $4)`,
      [userId, WELCOME_COINS, `welcome:${userId}`, at],
    );
    return true;
  }

  private async lock(tx: Tx, userId: string): Promise<number> {
    const res = await tx.query<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!res.rows.length) throw new Error(`no wallet for ${userId}`);
    return res.rows[0].balance;
  }

  /** Adds `delta` to a locked wallet and writes its ledger row; null when the key was used already. */
  private async credit(
    tx: Tx,
    userId: string,
    balance: number,
    entry: { delta: number; kind: CoinKind; key: string; at: Date; officeId?: string | null; counterparty?: string | null; note?: string | null },
  ): Promise<number | null> {
    const after = balance + entry.delta;
    if (after < 0) throw new CoinsError('Not enough coins');
    if (after > MAX_BALANCE) throw new CoinsError('That wallet is full');
    const row = await tx.query(
      `INSERT INTO coin_ledger (user_id, delta, balance_after, kind, counterparty_user_id, office_id, note, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [userId, entry.delta, after, entry.kind, entry.counterparty ?? null, entry.officeId ?? null, entry.note || null, entry.key, entry.at],
    );
    if (!row.rows.length) return null;
    await tx.query('UPDATE wallets SET balance = $2, updated_at = $3 WHERE user_id = $1', [userId, after, entry.at]);
    return after;
  }

  /** Makes sure the wallet exists; returns the welcome bonus when it was just created. */
  async ensure(userId: string): Promise<Award | null> {
    const at = new Date(this.now());
    return this.db.transaction(async (tx) => ((await this.create(tx, userId, at)) ? { balance: WELCOME_COINS, delta: WELCOME_COINS, kind: 'welcome' } : null));
  }

  /** The daily check-in bonus, once per UTC day; null when it was already given today. */
  async daily(userId: string, officeId: string | null): Promise<Award | null> {
    const now = this.now();
    const at = new Date(now);
    return this.db.transaction(async (tx) => {
      await this.create(tx, userId, at);
      const balance = await this.lock(tx, userId);
      const after = await this.credit(tx, userId, balance, { delta: DAILY_COINS, kind: 'daily', key: `daily:${userId}:${utcDay(now)}`, at, officeId });
      return after === null ? null : { balance: after, delta: DAILY_COINS, kind: 'daily' };
    });
  }

  /** Coins for half an hour of presence, up to the daily cap; null once the cap is reached. */
  async presence(userId: string, officeId: string | null): Promise<Award | null> {
    const now = this.now();
    const at = new Date(now);
    const day = utcDay(now);
    const start = new Date(`${day}T00:00:00.000Z`);
    return this.db.transaction(async (tx) => {
      await this.create(tx, userId, at);
      const balance = await this.lock(tx, userId);
      // Counted under the wallet's lock, and the n-th award of the day has its own key, so the cap holds.
      const today = await tx.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM coin_ledger WHERE user_id = $1 AND kind = 'presence' AND created_at >= $2 AND created_at < $3`,
        [userId, start, new Date(start.getTime() + 86_400_000)],
      );
      const n = Number(today.rows[0].n);
      if ((n + 1) * PRESENCE_COINS > PRESENCE_DAILY_CAP) return null;
      const after = await this.credit(tx, userId, balance, { delta: PRESENCE_COINS, kind: 'presence', key: `presence:${userId}:${day}:${n + 1}`, at, officeId });
      return after === null ? null : { balance: after, delta: PRESENCE_COINS, kind: 'presence' };
    });
  }

  /**
   * Moves `amount` coins from one wallet to another. `key` is the sender's uuid for this tip: the
   * same key again returns the current balances without moving anything.
   */
  async tip(t: { from: string; to: string; amount: number; note: string; key: string; officeId: string | null }): Promise<TipResult> {
    if (t.from === t.to) throw new CoinsError('You can’t send coins to yourself');
    if (!Number.isInteger(t.amount) || t.amount <= 0) throw new CoinsError('Bad amount');
    const at = new Date(this.now());
    const order = [t.from, t.to].sort();
    return this.db.transaction(async (tx) => {
      for (const id of order) await this.create(tx, id, at);
      const balances = new Map<string, number>();
      for (const id of order) balances.set(id, await this.lock(tx, id));
      const from = balances.get(t.from)!;
      const to = balances.get(t.to)!;
      const names = await tx.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ANY($1)', [order]);
      const nameOf = (id: string) => names.rows.find((r) => r.id === id)?.name ?? '';
      const result = { fromBalance: from, toBalance: to, fromName: nameOf(t.from), toName: nameOf(t.to), duplicate: true };
      const outKey = `tip:${t.from}:${t.key}`;
      // Checked after locking the sender: a concurrent retry of the same tip waits here, then sees it.
      const seen = await tx.query<{ delta: number; counterparty_user_id: string | null }>(
        'SELECT delta, counterparty_user_id FROM coin_ledger WHERE idempotency_key = $1',
        [outKey],
      );
      if (seen.rows.length) {
        const [prev] = seen.rows;
        if (prev.delta !== -t.amount || prev.counterparty_user_id !== t.to) throw new CoinsError('That tip was already sent with other details');
        return result;
      }
      if (from < t.amount) throw new CoinsError('Not enough coins');
      const common = { at, officeId: t.officeId, note: t.note };
      const fromAfter = await this.credit(tx, t.from, from, { ...common, delta: -t.amount, kind: 'tip_out', key: outKey, counterparty: t.to });
      const toAfter = await this.credit(tx, t.to, to, { ...common, delta: t.amount, kind: 'tip_in', key: `${outKey}:in`, counterparty: t.from });
      if (fromAfter === null || toAfter === null) throw new Error('tip key used concurrently');
      return { ...result, fromBalance: fromAfter, toBalance: toAfter, duplicate: false };
    });
  }

  async balance(userId: string): Promise<number> {
    const res = await this.db.query<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
    return res.rows[0]?.balance ?? 0;
  }

  /** Ledger entries, newest first, older than `before` (an entry id) when given. */
  async history(userId: string, limit: number, before?: number): Promise<LedgerEntry[]> {
    const res = await this.db.query<EntryRow>(
      `SELECT l.id, l.delta, l.balance_after, l.kind, l.counterparty_user_id, u.name AS counterparty_name, l.office_id, l.note, l.created_at
       FROM coin_ledger l LEFT JOIN users u ON u.id = l.counterparty_user_id
       WHERE l.user_id = $1 AND ($2::bigint IS NULL OR l.id < $2::bigint)
       ORDER BY l.id DESC LIMIT $3`,
      [userId, before ?? null, limit],
    );
    return res.rows.map(toEntry);
  }

  async officeEnabled(officeId: string): Promise<boolean> {
    const res = await this.db.query<{ enabled: boolean }>('SELECT enabled FROM coin_offices WHERE office_id = $1', [officeId]);
    return res.rows[0]?.enabled ?? true;
  }

  async setOfficeEnabled(officeId: string, enabled: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO coin_offices (office_id, enabled) VALUES ($1, $2)
       ON CONFLICT (office_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [officeId, enabled],
    );
  }
}
