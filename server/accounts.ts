import { MAX_SETTINGS, type AccountUser, type AuthProvider, type SignInMethod, type SignInMethods, type UserProfile } from '../shared/account';
import type { AvatarConfig } from '../shared/types';
import { isUniqueViolation, jsonb, type Db, type Tx } from './db';
import { randomId } from './officeStore';

/** What a sign-in method tells us about someone. */
export interface Identity {
  provider: AuthProvider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean;
  /** Used only when the account is created. */
  name: string;
  avatarUrl: string | null;
  /** How the person knows this sign-in, when the provider has a name for it (a GitHub login). */
  label: string | null;
}

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  email_verified: boolean;
  has_password: boolean;
  avatar_url: string | null;
  profile: UserProfile;
}

/** The columns of a UserRow, from `users` (or the alias `as`). Never the password hash itself. */
export function userColumns(as?: string): string {
  const t = as ? `${as}.` : '';
  return `${t}id, ${t}name, ${t}email, ${t}email_verified_at IS NOT NULL AS email_verified, ${t}password_hash IS NOT NULL AS has_password, ${t}avatar_url, ${t}profile`;
}

export function toAccountUser(row: UserRow): AccountUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    hasPassword: row.has_password,
    avatarUrl: row.avatar_url,
    profile: row.profile ?? {},
  };
}

class LostRace extends Error {}

/** An account may keep at most MAX_SETTINGS settings. */
export class TooManySettings extends Error {}

/** Another account has verified this email address. */
export class EmailTaken extends Error {}

/** Removing it would leave the account no way to sign in. */
export class LastSignInMethod extends Error {}

const PROVIDER_NAMES: Record<SignInMethod['provider'], string> = { google: 'Google', apple: 'Apple', github: 'GitHub' };

/** Google, Apple or GitHub, for people to read. */
export const providerName = (provider: SignInMethod['provider']): string => PROVIDER_NAMES[provider];

const insertIdentity = (tx: Tx, userId: string, identity: Identity) =>
  tx.query(
    `INSERT INTO auth_identities (provider, subject, user_id, email, email_verified, is_private_email, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (provider, subject) DO NOTHING`,
    [identity.provider, identity.subject, userId, identity.email, identity.emailVerified, identity.isPrivateEmail, identity.label],
  );

const updateIdentity = (tx: Tx, identity: Identity) =>
  tx.query('UPDATE auth_identities SET email = $3, email_verified = $4, is_private_email = $5, label = $6 WHERE provider = $1 AND subject = $2', [
    identity.provider,
    identity.subject,
    identity.email,
    identity.emailVerified,
    identity.isPrivateEmail,
    identity.label,
  ]);

/**
 * An address a provider verified becomes the account's verified one, when the account has none or
 * has the same one unconfirmed, and no other account has verified it.
 */
const adoptVerifiedEmail = (tx: Tx, userId: string, email: string | null) =>
  email
    ? tx.query(
        `UPDATE users SET email = $2, email_verified_at = now()
         WHERE id = $1 AND email_verified_at IS NULL AND (email IS NULL OR email = $2)
           AND NOT EXISTS (SELECT 1 FROM users o WHERE o.email = $2 AND o.email_verified_at IS NOT NULL)`,
        [userId, email],
      )
    : null;

/** Users, their sign-in identities and passwords, and the offices they belong to. */
export class Accounts {
  constructor(private readonly db: Db) {}

  /**
   * Runs `fn` in a transaction, again when it lost a race to someone doing the same at the same
   * moment (the same identity, or the same verified address), so the retry finds their account.
   */
  private async retrying<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(fn);
      } catch (err) {
        if (!(err instanceof LostRace || isUniqueViolation(err)) || attempt >= 3) throw err;
      }
    }
  }

  /**
   * The account for this identity, created on first sign-in. A new identity with an address its
   * provider verified joins the account that verified that address; anything else (unverified
   * addresses, the dev login) gets an account of its own. Accounts are never merged. A known
   * identity whose provider now vouches for the account's address verifies it.
   */
  async signIn(identity: Identity): Promise<AccountUser> {
    const verified = identity.emailVerified && identity.provider !== 'dev' ? identity.email : null;
    return this.retrying(async (tx) => {
      const found = await tx.query<{ user_id: string }>('SELECT user_id FROM auth_identities WHERE provider = $1 AND subject = $2', [
        identity.provider,
        identity.subject,
      ]);
      const owner = found.rowCount
        ? found.rows[0].user_id
        : verified
          ? (await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1 AND email_verified_at IS NOT NULL', [verified])).rows[0]?.id
          : undefined;
      if (owner) {
        if (found.rowCount) {
          await updateIdentity(tx, identity);
          await adoptVerifiedEmail(tx, owner, verified);
        }
        // Someone added the same identity at the same moment.
        else if (!(await insertIdentity(tx, owner, identity)).rowCount) throw new LostRace();
        const user = await tx.query<UserRow>(
          `UPDATE users SET last_seen_at = now(), avatar_url = COALESCE($2, avatar_url) WHERE id = $1 RETURNING ${userColumns()}`,
          [owner, identity.avatarUrl],
        );
        return toAccountUser(user.rows[0]);
      }
      const user = await tx.query<UserRow>(
        `INSERT INTO users (id, name, email, avatar_url, email_verified_at) VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() END)
         RETURNING ${userColumns()}`,
        [randomId(16), identity.name, identity.email, identity.avatarUrl, !!verified],
      );
      if (!(await insertIdentity(tx, user.rows[0].id, identity)).rowCount) throw new LostRace();
      return toAccountUser(user.rows[0]);
    });
  }

  /**
   * Connects `identity` to the account (from Profile); null when it belongs to another account. An
   * address the provider verified becomes the account's verified one, when the account had none or
   * the same one unconfirmed, and no other account verified it.
   */
  async link(userId: string, identity: Identity): Promise<AccountUser | null> {
    return this.retrying(async (tx) => {
      const found = await tx.query<{ user_id: string }>('SELECT user_id FROM auth_identities WHERE provider = $1 AND subject = $2', [
        identity.provider,
        identity.subject,
      ]);
      if (found.rowCount && found.rows[0].user_id !== userId) return null;
      if (found.rowCount) await updateIdentity(tx, identity);
      else if (!(await insertIdentity(tx, userId, identity)).rowCount) throw new LostRace();
      await adoptVerifiedEmail(tx, userId, identity.emailVerified ? identity.email : null);
      const user = await tx.query<UserRow>(`UPDATE users SET avatar_url = COALESCE(avatar_url, $2) WHERE id = $1 RETURNING ${userColumns()}`, [
        userId,
        identity.avatarUrl,
      ]);
      return user.rowCount ? toAccountUser(user.rows[0]) : null;
    });
  }

  async get(id: string): Promise<AccountUser | null> {
    const res = await this.db.query<UserRow>(`SELECT ${userColumns()} FROM users WHERE id = $1`, [id]);
    return res.rowCount ? toAccountUser(res.rows[0]) : null;
  }

  /** The account that verified this address, with its password hash (null without a password). */
  async byVerifiedEmail(email: string): Promise<{ id: string; passwordHash: string | null } | null> {
    const res = await this.db.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE email = $1 AND email_verified_at IS NOT NULL',
      [email],
    );
    return res.rowCount ? { id: res.rows[0].id, passwordHash: res.rows[0].password_hash } : null;
  }

  async passwordHash(id: string): Promise<string | null> {
    const res = await this.db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [id]);
    return res.rows[0]?.password_hash ?? null;
  }

  async anyPassword(): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1')).rowCount > 0;
  }

  /**
   * A new account with a verified address and a password, from a sign-up link. When an account has
   * verified the address meanwhile, sets that one's password instead (`existing`, and `replaced`
   * when it had one).
   */
  async createWithPassword(fields: {
    email: string;
    name: string;
    passwordHash: string;
    avatar?: AvatarConfig;
  }): Promise<{ user: AccountUser; existing: boolean; replaced: boolean }> {
    return this.retrying(async (tx) => {
      const owner = await tx.query<{ id: string; replaced: boolean }>(
        'SELECT id, password_hash IS NOT NULL AS replaced FROM users WHERE email = $1 AND email_verified_at IS NOT NULL FOR UPDATE',
        [fields.email],
      );
      if (owner.rowCount) {
        const user = await tx.query<UserRow>(`UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING ${userColumns()}`, [owner.rows[0].id, fields.passwordHash]);
        return { user: toAccountUser(user.rows[0]), existing: true, replaced: owner.rows[0].replaced };
      }
      const user = await tx.query<UserRow>(
        `INSERT INTO users (id, name, email, email_verified_at, password_hash, profile) VALUES ($1, $2, $3, now(), $4, $5::jsonb) RETURNING ${userColumns()}`,
        [randomId(16), fields.name, fields.email, fields.passwordHash, jsonb(fields.avatar ? { avatar: fields.avatar } : {})],
      );
      return { user: toAccountUser(user.rows[0]), existing: false, replaced: false };
    });
  }

  /** Sets the password; with `email`, only while that is still the account's verified address. */
  async setPassword(id: string, passwordHash: string, email?: string): Promise<AccountUser | null> {
    const res = await this.db.query<UserRow>(
      `UPDATE users SET password_hash = $2 WHERE id = $1 AND ($3::text IS NULL OR (email = $3 AND email_verified_at IS NOT NULL)) RETURNING ${userColumns()}`,
      [id, passwordHash, email ?? null],
    );
    return res.rowCount ? toAccountUser(res.rows[0]) : null;
  }

  /** Makes `email` the account's verified address. Throws EmailTaken when another account verified it. */
  async confirmEmail(id: string, email: string): Promise<AccountUser | null> {
    return this.retrying(async (tx) => {
      const owner = await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1 AND email_verified_at IS NOT NULL', [email]);
      if (owner.rowCount && owner.rows[0].id !== id) throw new EmailTaken();
      const res = await tx.query<UserRow>(
        `UPDATE users SET email = $2, email_verified_at = COALESCE(CASE WHEN email = $2 THEN email_verified_at END, now()) WHERE id = $1 RETURNING ${userColumns()}`,
        [id, email],
      );
      return res.rowCount ? toAccountUser(res.rows[0]) : null;
    });
  }

  async signInMethods(id: string): Promise<SignInMethods> {
    const methods = await this.db.query<{ provider: SignInMethod['provider']; subject: string; label: string | null; email: string | null; email_verified: boolean }>(
      "SELECT provider, subject, label, email, email_verified FROM auth_identities WHERE user_id = $1 AND provider <> 'dev' ORDER BY created_at, provider, subject",
      [id],
    );
    return {
      methods: methods.rows.map((m) => ({
        provider: m.provider,
        subject: m.subject,
        label: m.label ?? m.email ?? `${providerName(m.provider)} account`,
        email: m.email,
        emailVerified: m.email_verified,
      })),
      hasPassword: !!(await this.passwordHash(id)),
    };
  }

  /**
   * Disconnects one identity; false when the account has no such identity. Throws LastSignInMethod
   * unless a password or an identity at one of the `usable` providers remains.
   */
  async removeSignInMethod(id: string, provider: AuthProvider, subject: string, usable: AuthProvider[]): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // One removal at a time per account, so two can't each leave the other as the last way in.
      const user = await tx.query<{ has_password: boolean }>('SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!user.rowCount) return false;
      const others = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM auth_identities WHERE user_id = $1 AND NOT (provider = $2 AND subject = $3) AND provider = ANY($4::text[])',
        [id, provider, subject, usable],
      );
      const removed = await tx.query('DELETE FROM auth_identities WHERE user_id = $1 AND provider = $2 AND subject = $3', [id, provider, subject]);
      if (!removed.rowCount) return false;
      if (!user.rows[0].has_password && !others.rows[0].n) throw new LastSignInMethod();
      return true;
    });
  }

  /**
   * Renames and/or merges `profile` into the saved one: its avatar and status are replaced, its
   * settings merged key by key (so devices saving different settings don't undo each other).
   * Throws TooManySettings when the merged settings would have more than MAX_SETTINGS keys.
   */
  async update(id: string, patch: { name?: string; profile?: UserProfile }): Promise<AccountUser | null> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<{ profile: UserProfile | null }>('SELECT profile FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rowCount) return null;
      const profile = { ...patch.profile };
      if (profile.settings) {
        profile.settings = { ...current.rows[0].profile?.settings, ...profile.settings };
        if (Object.keys(profile.settings).length > MAX_SETTINGS) throw new TooManySettings();
      }
      const res = await tx.query<UserRow>(
        `UPDATE users SET name = COALESCE($2, name), profile = profile || $3::jsonb WHERE id = $1 RETURNING ${userColumns()}`,
        [id, patch.name ?? null, jsonb(profile)],
      );
      return toAccountUser(res.rows[0]);
    });
  }

  /** Records a visit and returns the person's role there; `owner` makes (or keeps) them an owner. */
  async visit(userId: string, officeId: string, owner: boolean): Promise<'owner' | 'member'> {
    const res = await this.db.query<{ role: 'owner' | 'member' }>(
      `INSERT INTO memberships (user_id, office_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, office_id) DO UPDATE SET last_visit_at = now(),
         role = CASE WHEN EXCLUDED.role = 'owner' THEN 'owner' ELSE memberships.role END
       RETURNING role`,
      [userId, officeId, owner ? 'owner' : 'member'],
    );
    return res.rows[0].role;
  }

  async role(userId: string, officeId: string): Promise<'owner' | 'member' | null> {
    const res = await this.db.query<{ role: 'owner' | 'member' }>('SELECT role FROM memberships WHERE user_id = $1 AND office_id = $2', [userId, officeId]);
    return res.rows[0]?.role ?? null;
  }

  /** Offices this person belongs to, most recently visited first. */
  async spaces(userId: string): Promise<{ id: string; name: string; role: 'owner' | 'member'; lastVisitAt: number }[]> {
    const res = await this.db.query<{ id: string; name: string | null; role: 'owner' | 'member'; last_visit_at: Date }>(
      `SELECT m.office_id AS id, o.data->'settings'->>'name' AS name, m.role, m.last_visit_at
       FROM memberships m JOIN offices o ON o.id = m.office_id
       WHERE m.user_id = $1 ORDER BY m.last_visit_at DESC LIMIT 200`,
      [userId],
    );
    return res.rows.map((r) => ({ id: r.id, name: r.name ?? '', role: r.role, lastVisitAt: new Date(r.last_visit_at).getTime() }));
  }
}
