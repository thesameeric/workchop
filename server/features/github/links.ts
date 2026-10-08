import type { Db, Tx } from '../../db';
import type { Migration } from '../../features';
import { decryptToken, encryptToken, type TokenField } from './crypto';

export const migrations: Migration[] = [
  {
    id: 500,
    name: 'github_links',
    sql: `
      -- A Workchop account's GitHub connection; one GitHub account links to one Workchop account.
      CREATE TABLE github_links (
        user_id            text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
        github_id          bigint NOT NULL UNIQUE,
        login              text NOT NULL,
        access_token_enc   text NOT NULL,
        refresh_token_enc  text,
        access_expires_at  timestamptz,
        refresh_expires_at timestamptz,
        scopes             text NOT NULL DEFAULT '',
        needs_reconnect    boolean NOT NULL DEFAULT false,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    id: 501,
    name: 'github_oauth_tx',
    sql: `
      -- Connections in progress: only a SHA-256 of the state is stored, and each is used once.
      CREATE TABLE github_oauth_tx (
        state_hash    text PRIMARY KEY,
        user_id       text NOT NULL REFERENCES users ON DELETE CASCADE,
        code_verifier text NOT NULL,
        return_to     text NOT NULL,
        expires_at    timestamptz NOT NULL
      );
      CREATE INDEX github_oauth_tx_expires_idx ON github_oauth_tx (expires_at);`,
  },
];

/** A user's GitHub connection, tokens decrypted. */
export interface Link {
  userId: string;
  githubId: string;
  login: string;
  /** Null when it can't be decrypted (then the link needs reconnecting). */
  accessToken: string | null;
  refreshToken: string | null;
  /** ms since 1970; null: doesn't expire. */
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  /** Comma-separated, sorted: "notifications,repo". */
  scopes: string;
  needsReconnect: boolean;
}

/** Tokens and expiries to store. */
export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  scopes: string;
}

interface LinkRow {
  user_id: string;
  github_id: string;
  login: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  access_expires_ms: number | null;
  refresh_expires_ms: number | null;
  scopes: string;
  needs_reconnect: boolean;
}

const COLUMNS = `user_id, github_id::text AS github_id, login, access_token_enc, refresh_token_enc,
  (extract(epoch FROM access_expires_at) * 1000)::float8 AS access_expires_ms,
  (extract(epoch FROM refresh_expires_at) * 1000)::float8 AS refresh_expires_ms,
  scopes, needs_reconnect`;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Scopes as GitHub lists them ("notifications, repo") in one stable form. */
export function normalizeScopes(raw: string): string {
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))].sort().join(',');
}

export const hasRepoScope = (scopes: string) => scopes.split(',').includes('repo');

/** github_links and github_oauth_tx; tokens are encrypted here and never leave decrypted except to callers in this feature. */
export class Links {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  private decrypt(userId: string, field: TokenField, value: string | null): string | null {
    if (value === null) return null;
    try {
      return decryptToken(this.key, userId, field, value);
    } catch {
      return null;
    }
  }

  private toLink(row: LinkRow): Link {
    const accessToken = this.decrypt(row.user_id, 'access', row.access_token_enc);
    const refreshToken = this.decrypt(row.user_id, 'refresh', row.refresh_token_enc);
    return {
      userId: row.user_id,
      githubId: row.github_id,
      login: row.login,
      accessToken,
      refreshToken,
      accessExpiresAt: row.access_expires_ms,
      refreshExpiresAt: row.refresh_expires_ms,
      scopes: row.scopes,
      // A token that can't be decrypted (another key, or a changed row) can't be used.
      needsReconnect: row.needs_reconnect || accessToken === null || (row.refresh_token_enc !== null && refreshToken === null),
    };
  }

  async get(userId: string, tx: Tx = this.db, forUpdate = false): Promise<Link | null> {
    const res = await tx.query<LinkRow>(`SELECT ${COLUMNS} FROM github_links WHERE user_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [userId]);
    return res.rows[0] ? this.toLink(res.rows[0]) : null;
  }

  /** Other servers may use the same database (Postgres); PGlite is only ever opened by one process. */
  get shared(): boolean {
    return this.db.kind === 'postgres';
  }

  /**
   * Runs `fn` holding this user's GitHub lock, which every server sharing the database respects:
   * refresh tokens die when used, so only one refresh may run at a time. Do nothing slow inside on
   * PGlite (it has a single connection).
   */
  withLock<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`github:${userId}`]);
      return fn(tx);
    });
  }

  /**
   * Connects `userId` to a GitHub account, replacing their previous connection and taking this
   * GitHub account away from any other Workchop account. Returns the connections no longer used (to
   * revoke their tokens) and the other accounts that lost the connection.
   */
  async link(userId: string, github: { id: string; login: string }, tokens: Tokens): Promise<{ replaced: Link[]; movedFrom: string[] }> {
    return this.withLock(userId, async (tx) => {
      const previous = await this.get(userId, tx, true);
      const moved = await tx.query<LinkRow>(`DELETE FROM github_links WHERE github_id = $1 AND user_id <> $2 RETURNING ${COLUMNS}`, [github.id, userId]);
      await tx.query(
        `INSERT INTO github_links (user_id, github_id, login, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, scopes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id) DO UPDATE SET github_id = $2, login = $3, access_token_enc = $4, refresh_token_enc = $5,
           access_expires_at = $6, refresh_expires_at = $7, scopes = $8, needs_reconnect = false, updated_at = now()`,
        [userId, github.id, github.login, ...this.encrypted(userId, tokens)],
      );
      const old = [previous, ...moved.rows.map((r) => this.toLink(r))];
      return {
        replaced: old.filter((l): l is Link => !!l?.accessToken && l.accessToken !== tokens.accessToken),
        movedFrom: moved.rows.map((r) => r.user_id),
      };
    });
  }

  private encrypted(userId: string, t: Tokens) {
    return [
      encryptToken(this.key, userId, 'access', t.accessToken),
      t.refreshToken === null ? null : encryptToken(this.key, userId, 'refresh', t.refreshToken),
      iso(t.accessExpiresAt),
      iso(t.refreshExpiresAt),
      t.scopes,
    ];
  }

  /** Saves refreshed tokens (inside withLock). */
  async saveTokens(tx: Tx, userId: string, tokens: Tokens): Promise<void> {
    await tx.query(
      `UPDATE github_links SET access_token_enc = $2, refresh_token_enc = $3, access_expires_at = $4, refresh_expires_at = $5,
         scopes = $6, needs_reconnect = false, updated_at = now() WHERE user_id = $1`,
      [userId, ...this.encrypted(userId, tokens)],
    );
  }

  async setNeedsReconnect(userId: string, tx: Tx = this.db): Promise<void> {
    await tx.query('UPDATE github_links SET needs_reconnect = true, updated_at = now() WHERE user_id = $1', [userId]);
  }

  async setScopes(userId: string, scopes: string): Promise<void> {
    await this.db.query('UPDATE github_links SET scopes = $2, updated_at = now() WHERE user_id = $1', [userId, scopes]);
  }

  /** Removes the connection; returns it as it was. */
  async remove(userId: string): Promise<Link | null> {
    return this.withLock(userId, async (tx) => {
      const res = await tx.query<LinkRow>(`DELETE FROM github_links WHERE user_id = $1 RETURNING ${COLUMNS}`, [userId]);
      return res.rows[0] ? this.toLink(res.rows[0]) : null;
    });
  }

  async startTx(stateHash: string, userId: string, codeVerifier: string, returnTo: string, minutes: number): Promise<void> {
    await this.db.query(
      `INSERT INTO github_oauth_tx (state_hash, user_id, code_verifier, return_to, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [stateHash, userId, codeVerifier, returnTo, minutes],
    );
  }

  /** Takes (and deletes) a connection in progress. */
  async takeTx(stateHash: string): Promise<{ userId: string; codeVerifier: string; returnTo: string; fresh: boolean } | null> {
    const res = await this.db.query<{ user_id: string; code_verifier: string; return_to: string; fresh: boolean }>(
      'DELETE FROM github_oauth_tx WHERE state_hash = $1 RETURNING user_id, code_verifier, return_to, expires_at > now() AS fresh',
      [stateHash],
    );
    const row = res.rows[0];
    return row ? { userId: row.user_id, codeVerifier: row.code_verifier, returnTo: row.return_to, fresh: row.fresh } : null;
  }

  async cleanupTx(): Promise<void> {
    await this.db.query('DELETE FROM github_oauth_tx WHERE expires_at < now()');
  }
}
