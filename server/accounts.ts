import type { AccountUser, AuthProvider, UserProfile } from '../shared/account';
import { jsonb, type Db } from './db';
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
}

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  avatar_url: string | null;
  profile: UserProfile;
}

export const USER_COLUMNS = 'id, name, email, avatar_url, profile';

export function toAccountUser(row: UserRow): AccountUser {
  return { id: row.id, name: row.name, email: row.email, avatarUrl: row.avatar_url, profile: row.profile ?? {} };
}

class LostRace extends Error {}

/** Users, their sign-in identities, and the offices they belong to. */
export class Accounts {
  constructor(private readonly db: Db) {}

  /**
   * The account for this identity, created on first sign-in. Identities are never matched by email,
   * so the same address at Google and Apple gives two accounts.
   */
  async signIn(identity: Identity): Promise<AccountUser> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const found = await tx.query<{ user_id: string }>('SELECT user_id FROM auth_identities WHERE provider = $1 AND subject = $2', [
            identity.provider,
            identity.subject,
          ]);
          if (found.rowCount) {
            const userId = found.rows[0].user_id;
            await tx.query('UPDATE auth_identities SET email = $3, email_verified = $4, is_private_email = $5 WHERE provider = $1 AND subject = $2', [
              identity.provider,
              identity.subject,
              identity.email,
              identity.emailVerified,
              identity.isPrivateEmail,
            ]);
            const user = await tx.query<UserRow>(
              `UPDATE users SET last_seen_at = now(), avatar_url = COALESCE($2, avatar_url) WHERE id = $1 RETURNING ${USER_COLUMNS}`,
              [userId, identity.avatarUrl],
            );
            return toAccountUser(user.rows[0]);
          }
          const user = await tx.query<UserRow>(`INSERT INTO users (id, name, email, avatar_url) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`, [
            randomId(16),
            identity.name,
            identity.email,
            identity.avatarUrl,
          ]);
          const linked = await tx.query(
            `INSERT INTO auth_identities (provider, subject, user_id, email, email_verified, is_private_email)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider, subject) DO NOTHING`,
            [identity.provider, identity.subject, user.rows[0].id, identity.email, identity.emailVerified, identity.isPrivateEmail],
          );
          // Someone signed in with the same identity at the same moment: use their account.
          if (!linked.rowCount) throw new LostRace();
          return toAccountUser(user.rows[0]);
        });
      } catch (err) {
        if (!(err instanceof LostRace) || attempt >= 3) throw err;
      }
    }
  }

  async get(id: string): Promise<AccountUser | null> {
    const res = await this.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return res.rowCount ? toAccountUser(res.rows[0]) : null;
  }

  /** Renames and/or merges `profile` into the saved one (top-level keys are replaced). */
  async update(id: string, patch: { name?: string; profile?: UserProfile }): Promise<AccountUser | null> {
    const res = await this.db.query<UserRow>(
      `UPDATE users SET name = COALESCE($2, name), profile = profile || $3::jsonb WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [id, patch.name ?? null, jsonb(patch.profile ?? {})],
    );
    return res.rowCount ? toAccountUser(res.rows[0]) : null;
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
