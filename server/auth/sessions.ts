import crypto from 'node:crypto';
import type { AccountUser } from '../../shared/account';
import { toAccountUser, userColumns, type UserRow } from '../accounts';
import type { Db } from '../db';

export const SESSION_DAYS = 30;
/** Sliding expiry: a session in use is extended, but at most this often (saves a write per request). */
const TOUCH_EVERY = '1 hour';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Whether `v` looks like a token from newToken(). */
export const isToken = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v);

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 32 random bytes, base64url. */
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Compares a secret someone gave with the real one in constant time. */
export function sameSecret(given: unknown, expected: string | null | undefined): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface Session {
  user: AccountUser;
  tokenHash: string;
}

/** Sign-in sessions. The browser holds the token; the database only its SHA-256. */
export class Sessions {
  constructor(private readonly db: Db) {}

  /** A new session (a fresh token on every sign-in). Returns the token for the cookie. */
  async create(userId: string, userAgent: string | undefined): Promise<string> {
    const token = newToken();
    await this.db.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days', $3)`,
      [hashToken(token), userId, userAgent?.slice(0, 300) ?? null],
    );
    return token;
  }

  async lookup(token: string | undefined): Promise<Session | null> {
    if (!isToken(token)) return null;
    const tokenHash = hashToken(token);
    const res = await this.db.query<UserRow & { touch: boolean }>(
      `SELECT ${userColumns('u')}, s.last_seen_at < now() - interval '${TOUCH_EVERY}' AS touch
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    if (!res.rowCount) return null;
    const row = res.rows[0];
    if (row.touch) {
      await this.db.query(
        `UPDATE sessions SET last_seen_at = now(), expires_at = now() + interval '${SESSION_DAYS} days' WHERE token_hash = $1`,
        [tokenHash],
      );
      await this.db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [row.id]);
    }
    return { user: toAccountUser(row), tokenHash };
  }

  async delete(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  /** Ends all of the person's sessions, except `keep`; returns the hashes of the ones ended. */
  async deleteForUser(userId: string, keep?: string): Promise<string[]> {
    const ended = await this.db.query<{ token_hash: string }>('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING token_hash', [userId, keep ?? '']);
    return ended.rows.map((r) => r.token_hash);
  }

  /** Drops expired sessions, abandoned sign-ins, unused email links and invitations; returns the hashes of the sessions dropped. */
  async cleanup(): Promise<string[]> {
    const expired = await this.db.query<{ token_hash: string }>('DELETE FROM sessions WHERE expires_at <= now() RETURNING token_hash');
    await this.db.query('DELETE FROM auth_tx WHERE expires_at < now()');
    await this.db.query('DELETE FROM email_tokens WHERE expires_at < now()');
    await this.db.query('DELETE FROM office_invites WHERE expires_at < now()');
    return expired.rows.map((r) => r.token_hash);
  }
}
