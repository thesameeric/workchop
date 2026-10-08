import crypto from 'node:crypto';
import { sanitizeName } from '../../../shared/avatar';
import type { HelperDevice } from '../../../shared/presence';
import type { Db } from '../../db';
import { randomId } from '../../officeStore';

/** Desktop helper tokens: "wcp_" and 32 random bytes (base64url), so a leaked one is recognisable. */
export const TOKEN_PREFIX = 'wcp_';
const TOKEN_FORMAT = /^wcp_[A-Za-z0-9_-]{43}$/;
export const PRESENCE_SCOPE = 'presence:write';
/** Paired computers per account. */
export const MAX_DEVICES = 10;
const MAX_LABEL = 40;
/** How long a looked-up token is trusted from memory (revoking clears it at once). */
const CACHE_MS = 5 * 60 * 1000;
/** Unknown tokens remembered, so retries don't each cost a query. */
const MAX_UNKNOWN = 5000;
/** last_used_at is written at most this often per token. */
const TOUCH_MS = 10 * 60 * 1000;

export function newToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function isTokenFormat(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_FORMAT.test(v);
}

/** Only this is stored. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function sanitizeLabel(v: unknown): string {
  return sanitizeName(v, MAX_LABEL) || 'My computer';
}

export class TooManyDevices extends Error {}

interface TokenRow {
  id: string;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
}

/** Who a token belongs to. */
export interface TokenOwner {
  id: string;
  userId: string;
}

export class HelperTokens {
  private readonly known = new Map<string, TokenOwner & { at: number }>();
  private readonly unknown = new Map<string, number>();
  private readonly touched = new Map<string, number>();
  /** Revoked here, so a lookup that was already under way can't bring one back. */
  private readonly revoked = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Pairs a computer: the token is returned this once and only its hash is kept. */
  async create(userId: string, label: unknown): Promise<{ device: HelperDevice; token: string }> {
    const token = newToken();
    const id = randomId(12);
    const name = sanitizeLabel(label);
    const row = await this.db.transaction(async (tx) => {
      // Serializes pairing per account, so two at once can't both slip under the limit.
      await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      if (count.rows[0].n >= MAX_DEVICES) throw new TooManyDevices();
      const res = await tx.query<TokenRow>(
        `INSERT INTO api_tokens (id, user_id, token_hash, scope, label) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, label, created_at, last_used_at`,
        [id, userId, hashToken(token), PRESENCE_SCOPE, name],
      );
      return res.rows[0];
    });
    return { device: toDevice(row), token };
  }

  async list(userId: string): Promise<HelperDevice[]> {
    const res = await this.db.query<TokenRow>(
      `SELECT id, label, created_at, last_used_at FROM api_tokens
       WHERE user_id = $1 AND scope = $2 AND revoked_at IS NULL ORDER BY created_at`,
      [userId, PRESENCE_SCOPE],
    );
    return res.rows.map(toDevice);
  }

  /** Unpairs a computer; its token stops working at once. */
  async revoke(userId: string, id: string): Promise<boolean> {
    const res = await this.db.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, userId]);
    this.revoked.add(id);
    for (const [hash, owner] of this.known) if (owner.id === id) this.known.delete(hash);
    this.touched.delete(id);
    return res.rowCount > 0;
  }

  /** Whether this token (by its hash) was looked up recently, so checking it again costs no query. */
  cached(hash: string): boolean {
    const hit = this.known.get(hash);
    const missedAt = this.unknown.get(hash);
    return (!!hit && this.now() - hit.at < CACHE_MS) || (missedAt !== undefined && this.now() - missedAt < CACHE_MS);
  }

  /** Who a presence token belongs to, or null (wrong format, unknown or revoked). Pass its hash if known. */
  async verify(token: string, hash = hashToken(token)): Promise<TokenOwner | null> {
    if (!isTokenFormat(token)) return null;
    const now = this.now();
    const hit = this.known.get(hash);
    if (hit && now - hit.at < CACHE_MS) return { id: hit.id, userId: hit.userId };
    const missedAt = this.unknown.get(hash);
    if (missedAt !== undefined && now - missedAt < CACHE_MS) return null;
    const res = await this.db.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM api_tokens WHERE token_hash = $1 AND scope = $2 AND revoked_at IS NULL',
      [hash, PRESENCE_SCOPE],
    );
    const row = res.rows[0];
    if (row && this.revoked.has(row.id)) return null;
    if (!row) {
      if (this.unknown.size >= MAX_UNKNOWN) this.unknown.clear();
      this.unknown.set(hash, now);
      this.known.delete(hash);
      return null;
    }
    const owner = { id: row.id, userId: row.user_id };
    this.known.set(hash, { ...owner, at: now });
    return owner;
  }

  /** Notes that a token was used (written to the database now and then, not on every heartbeat). */
  async touch(id: string): Promise<void> {
    const now = this.now();
    if (now - (this.touched.get(id) ?? 0) < TOUCH_MS) return;
    this.touched.set(id, now);
    await this.db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [id]);
  }
}

function toDevice(row: TokenRow): HelperDevice {
  return {
    id: row.id,
    label: row.label,
    createdAt: new Date(row.created_at).getTime(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).getTime() : null,
    active: false,
    platform: null,
  };
}
