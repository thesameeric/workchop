import crypto from 'node:crypto';
import type { Db } from './index';

/**
 * A forward-only schema change. Ids are global and never reused: core migrations use 1–99, and
 * features pick the next free id from 100 up (see server/features/index.ts). Never edit a migration
 * that has shipped; add a new one. The SQL must run on PostgreSQL 16 and on PGlite (PostgreSQL 18):
 * no uuidv7(), no MERGE … RETURNING, no CREATE INDEX CONCURRENTLY (each migration runs in a transaction).
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const coreMigrations: Migration[] = [
  {
    id: 1,
    name: 'offices',
    // Exactly the table earlier versions created, so existing databases carry on as they are.
    sql: `
      CREATE TABLE IF NOT EXISTS offices (
        id         text PRIMARY KEY,
        owner_key  text NOT NULL,
        data       jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    id: 2,
    name: 'accounts',
    sql: `
      CREATE TABLE users (
        id           text PRIMARY KEY,
        name         text NOT NULL,
        email        text,
        avatar_url   text,
        profile      jsonb NOT NULL DEFAULT '{}',
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      );
      -- One row per sign-in method. Accounts are never linked by email address.
      CREATE TABLE auth_identities (
        provider         text NOT NULL,
        subject          text NOT NULL,
        user_id          text NOT NULL REFERENCES users ON DELETE CASCADE,
        email            text,
        email_verified   boolean NOT NULL DEFAULT false,
        is_private_email boolean NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, subject)
      );
      CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);
      -- Only a SHA-256 of each session token is stored.
      CREATE TABLE sessions (
        token_hash   text PRIMARY KEY,
        user_id      text NOT NULL REFERENCES users ON DELETE CASCADE,
        created_at   timestamptz NOT NULL DEFAULT now(),
        expires_at   timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        user_agent   text
      );
      CREATE INDEX sessions_user_idx ON sessions (user_id);
      CREATE INDEX sessions_expires_idx ON sessions (expires_at);
      -- Sign-ins in progress (state, nonce, PKCE verifier), kept here because the server may restart mid-login.
      CREATE TABLE auth_tx (
        id_hash       text PRIMARY KEY,
        provider      text NOT NULL,
        state         text NOT NULL,
        nonce         text NOT NULL,
        code_verifier text,
        return_to     text NOT NULL,
        expires_at    timestamptz NOT NULL
      );
      CREATE TABLE memberships (
        user_id       text NOT NULL REFERENCES users ON DELETE CASCADE,
        office_id     text NOT NULL REFERENCES offices ON DELETE CASCADE,
        role          text NOT NULL CHECK (role IN ('owner', 'member')),
        joined_at     timestamptz NOT NULL DEFAULT now(),
        last_visit_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, office_id)
      );
      CREATE INDEX memberships_office_idx ON memberships (office_id);`,
  },
  {
    id: 3,
    name: 'uploads',
    sql: `
      CREATE TABLE uploads (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        office_id        text NOT NULL REFERENCES offices,
        uploader_user_id text REFERENCES users ON DELETE SET NULL,
        uploader_name    text NOT NULL,
        filename         text NOT NULL,
        content_type     text NOT NULL,
        byte_size        int NOT NULL,
        sha256           text NOT NULL,
        storage          text NOT NULL CHECK (storage IN ('db', 'fs', 's3')),
        storage_key      text NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX uploads_office_idx ON uploads (office_id);
      -- The bytes, when stored in the database, apart from the metadata so listing uploads never reads them.
      CREATE TABLE upload_blobs (
        upload_id uuid PRIMARY KEY REFERENCES uploads ON DELETE CASCADE,
        data      bytea NOT NULL
      );`,
  },
  {
    id: 4,
    name: 'email_sign_in',
    sql: `
      UPDATE users SET email = lower(email) WHERE email <> lower(email);
      ALTER TABLE users ADD CONSTRAINT users_email_lower CHECK (email = lower(email));
      -- A confirmed address (by a link we sent, or by the sign-in provider), and scrypt$N$r$p$salt$hash.
      ALTER TABLE users ADD COLUMN email_verified_at timestamptz, ADD COLUMN password_hash text;
      -- Addresses a provider verified for the account's own sign-in. Where several accounts have the
      -- same one, the oldest keeps it verified; the others stay as they are, never merged.
      WITH verified AS (
        SELECT u.id, u.email, u.created_at, min(i.created_at) AS verified_at
        FROM users u JOIN auth_identities i ON i.user_id = u.id AND i.email_verified AND lower(i.email) = u.email
        GROUP BY u.id, u.email, u.created_at
      ), oldest AS (
        SELECT DISTINCT ON (email) id, verified_at FROM verified ORDER BY email, created_at, id
      )
      UPDATE users SET email_verified_at = oldest.verified_at FROM oldest WHERE users.id = oldest.id;
      -- One account per verified address.
      CREATE UNIQUE INDEX users_verified_email_idx ON users (email) WHERE email_verified_at IS NOT NULL;
      -- Links we emailed (sign-up, password reset, email change), by a SHA-256 of their token.
      CREATE TABLE email_tokens (
        token_hash text PRIMARY KEY,
        purpose    text NOT NULL CHECK (purpose IN ('signup', 'reset', 'email')),
        email      text NOT NULL,
        user_id    text REFERENCES users ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX email_tokens_user_idx ON email_tokens (user_id);
      CREATE INDEX email_tokens_expires_idx ON email_tokens (expires_at);
      -- Connecting another sign-in method to this account (from Profile) rather than signing in.
      ALTER TABLE auth_tx ADD COLUMN link_user_id text REFERENCES users ON DELETE CASCADE;
      -- How the person knows a sign-in, when the provider names it (a GitHub login).
      ALTER TABLE auth_identities ADD COLUMN label text;`,
  },
  {
    id: 5,
    name: 'workspaces',
    sql: `
      -- The kind is fixed when the office is made. Offices made before workspaces stay open to
      -- anyone with the address; new ones let in members only, until a guest link is turned on.
      ALTER TABLE offices
        ADD COLUMN kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'support')),
        ADD COLUMN guest_access text NOT NULL DEFAULT 'open' CHECK (guest_access IN ('off', 'link', 'open')),
        ADD COLUMN guest_token text;
      ALTER TABLE offices ALTER COLUMN guest_access SET DEFAULT 'off';
      -- Owners, admins and members. Where an office has several owners, the earliest keeps it and
      -- the others become admins.
      ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
      ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'member'));
      WITH ranked AS (
        SELECT user_id, office_id, row_number() OVER (PARTITION BY office_id ORDER BY joined_at, user_id) AS n
        FROM memberships WHERE role = 'owner'
      )
      UPDATE memberships m SET role = 'admin' FROM ranked r WHERE m.user_id = r.user_id AND m.office_id = r.office_id AND r.n > 1;
      CREATE UNIQUE INDEX memberships_one_owner_idx ON memberships (office_id) WHERE role = 'owner';
      -- People added to an office haven't been there yet (null) until they first come in.
      ALTER TABLE memberships ALTER COLUMN last_visit_at DROP NOT NULL, ALTER COLUMN last_visit_at DROP DEFAULT;
      -- People asked to join by an address no account has verified yet, by a SHA-256 of the emailed token.
      CREATE TABLE office_invites (
        id         text PRIMARY KEY,
        office_id  text NOT NULL REFERENCES offices ON DELETE CASCADE,
        email      text NOT NULL CHECK (email = lower(email)),
        role       text NOT NULL CHECK (role IN ('admin', 'member')),
        invited_by text REFERENCES users ON DELETE SET NULL,
        token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        UNIQUE (office_id, email)
      );
      CREATE INDEX office_invites_email_idx ON office_invites (email);
      CREATE INDEX office_invites_expires_idx ON office_invites (expires_at);`,
  },
];

/** Core migrations followed by each feature's, checked for clashing ids. */
export function collectMigrations(features: { name: string; migrations?: Migration[] }[] = []): Migration[] {
  const all = [...coreMigrations, ...features.flatMap((f) => f.migrations ?? [])];
  const seen = new Set<number>();
  for (const m of all) {
    if (!Number.isInteger(m.id) || m.id < 1) throw new Error(`Migration "${m.name}" needs a positive integer id`);
    if (seen.has(m.id)) throw new Error(`Two migrations use id ${m.id}; ids must be unique`);
    seen.add(m.id);
  }
  return all.sort((a, b) => a.id - b.id);
}

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/** Any number taken for this app's migration lock. */
const MIGRATION_LOCK = 72_430_917;

/**
 * Applies pending migrations in one transaction, under an advisory lock so two servers starting
 * at once (e.g. during a deploy) don't both run them. Returns the names of the ones applied.
 * `dormant` are those of features turned off (coins): not run, but not unknown either when the
 * database ran them while the feature was on.
 */
export async function migrate(db: Db, migrations: Migration[] = coreMigrations, dormant: Migration[] = []): Promise<string[]> {
  return db.transaction(async (tx) => {
    // Transaction-level lock: works through poolers in transaction mode (e.g. Neon) and is released on commit.
    await tx.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         int PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await tx.query<{ id: number; name: string; checksum: string }>('SELECT id, name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.id, r]));
    const known = new Set([...migrations, ...dormant].map((m) => m.id));
    for (const r of rows) {
      if (!known.has(r.id)) console.warn(`[db] the database has migration ${r.id} (${r.name}), which this version doesn't know`);
    }
    const ran: string[] = [];
    for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
      const sum = checksum(m.sql);
      const done = applied.get(m.id);
      if (done) {
        if (done.checksum !== sum) console.warn(`[db] migration ${m.id} (${m.name}) changed after it was applied; the change was not run`);
        continue;
      }
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)', [m.id, m.name, sum]);
      ran.push(`${m.id} ${m.name}`);
    }
    return ran;
  });
}
