import express from 'express';
import { MAX_PASSWORD, normalizeEmail, passwordProblem, sanitizeUserName, type AccountUser, type Space } from '../shared/account';
import { sanitizeAvatar, sanitizeName } from '../shared/avatar';
import { isValidId } from '../shared/office';
import { TEMPLATES } from '../shared/templates';
import {
  may,
  type AccessDenied,
  type GuestAccess,
  type Invite,
  type Member,
  type MemberRole,
  type MembersAnswer,
  type OfficeInfo,
  type OfficeKind,
  type Role,
} from '../shared/workspace';
import type { Accounts } from './accounts';
import { PasswordsBusy } from './auth/passwords';
import { hashToken, isToken, newToken, sameSecret } from './auth/sessions';
import { isUniqueViolation, type Db, type Tx } from './db';
import { addressKey, windowLimiter } from './limits';
import type { Mailer } from './mail';
import { mailTemplates } from './mailTemplates';
import { randomId, type OfficeStore, type StoredOffice } from './officeStore';
import type { RealtimeApi } from './realtime';

// Workspaces: offices with an owner, admins and members, and who else may come in (guests with the
// guest link, or anyone in offices made before workspaces). People are added by email: an account
// that verified the address at once, anyone else with an emailed invitation.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const INVITE_DAYS = 14;

/** Why someone can't come in, for people to read (never with the office's name). */
const DENIED: Record<AccessDenied, string> = {
  'sign-in': 'Sign in to come in.',
  'members-only': 'Only members can come in.',
  link: 'This guest link no longer works.',
};

export type Admission = { role: Role; isOwner: boolean } | { denied: AccessDenied };

export const deniedMessage = (reason: AccessDenied) => DENIED[reason];

/** Guests may come in: an open office, or the guest link's token. */
export function welcomesGuests(stored: StoredOffice, guest: unknown): boolean {
  return stored.guests === 'open' || (stored.guests === 'link' && sameSecret(guest, stored.guestToken));
}

/**
 * Why someone may not come in: signed in, that they aren't a member (whatever link they used);
 * otherwise that their guest link no longer works, or that they need to sign in.
 */
export function refusal(guest: unknown, userId: string | null): { denied: AccessDenied } {
  return { denied: userId ? 'members-only' : typeof guest === 'string' && guest ? 'link' : 'sign-in' };
}

interface MemberRow {
  user_id: string;
  name: string;
  avatar_url: string | null;
  email: string | null;
  role: MemberRole;
  joined_at: Date | string;
  /** Null until their first visit. */
  last_visit_at: Date | string | null;
}

interface InviteRow {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string | null;
  created_at: Date | string;
  expires_at: Date | string;
}

const ms = (d: Date | string) => new Date(d).getTime();

const MEMBER_COLUMNS = `m.user_id, u.name, u.avatar_url, CASE WHEN u.email_verified_at IS NOT NULL THEN u.email END AS email,
  m.role, m.joined_at, m.last_visit_at`;
const INVITE_COLUMNS = 'i.id, i.email, i.role, (SELECT name FROM users WHERE id = i.invited_by) AS invited_by, i.created_at, i.expires_at';

/** `withEmail`: for owners and admins, who see members' (verified) addresses. */
function toMember(r: MemberRow, withEmail: boolean): Member {
  return {
    userId: r.user_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    ...(withEmail ? { email: r.email } : {}),
    role: r.role,
    joinedAt: ms(r.joined_at),
    lastVisitAt: ms(r.last_visit_at ?? r.joined_at),
  };
}

const toInvite = (r: InviteRow, emailed: boolean): Invite => ({
  id: r.id,
  email: r.email,
  role: r.role,
  invitedBy: r.invited_by,
  createdAt: ms(r.created_at),
  expiresAt: ms(r.expires_at),
  emailed,
});

class NotMember extends Error {}
class InviteGone extends Error {}

/** Memberships, invitations and who may come into an office. */
export class Workspaces {
  constructor(private readonly db: Db) {}

  async role(userId: string, officeId: string): Promise<MemberRole | null> {
    const res = await this.db.query<{ role: MemberRole }>('SELECT role FROM memberships WHERE user_id = $1 AND office_id = $2', [userId, officeId]);
    return res.rows[0]?.role ?? null;
  }

  /** Makes `userId` the owner of an office nobody owns yet (one made before accounts); false when someone does. */
  async claim(userId: string, officeId: string): Promise<boolean> {
    try {
      const res = await this.db.query(
        `INSERT INTO memberships (user_id, office_id, role)
         SELECT $1::text, $2::text, 'owner' WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE office_id = $2::text AND role = 'owner')
         ON CONFLICT (user_id, office_id) DO UPDATE SET role = 'owner'`,
        [userId, officeId],
      );
      return res.rowCount > 0;
    } catch (err) {
      // Someone else claimed it at the same moment.
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  /**
   * Of these offices (with the owner keys their creators' browsers kept), the ones this person owns
   * now: the ones nobody owned are theirs from now on.
   */
  async claimAll(userId: string, offices: { id: string; ownerKey: string }[]): Promise<string[]> {
    if (!offices.length) return [];
    const { rows } = await this.db.query<{ id: string; owner_key: string; owner: string | null }>(
      `SELECT o.id, o.owner_key, (SELECT user_id FROM memberships WHERE office_id = o.id AND role = 'owner') AS owner
       FROM offices o WHERE o.id = ANY($1::text[])`,
      [offices.map((o) => o.id)],
    );
    const out: string[] = [];
    for (const given of offices) {
      const row = rows.find((r) => r.id === given.id);
      if (!row || out.includes(row.id) || !sameSecret(given.ownerKey, row.owner_key)) continue;
      if (row.owner === userId || (!row.owner && (await this.claim(userId, row.id)))) out.push(row.id);
    }
    return out;
  }

  private async owned(officeId: string): Promise<boolean> {
    const res = await this.db.query("SELECT 1 FROM memberships WHERE office_id = $1 AND role = 'owner'", [officeId]);
    return res.rowCount > 0;
  }

  /** What someone would be in the office, without coming in (GET /api/offices/:id). */
  async check(stored: StoredOffice, userId: string | null, guest: unknown): Promise<{ role: Role } | { denied: AccessDenied }> {
    const role = userId ? await this.role(userId, stored.office.id) : null;
    if (role) return { role };
    return welcomesGuests(stored, guest) ? { role: 'guest' } : refusal(guest, userId);
  }

  /**
   * Lets someone into an office (a join). In order: someone signed in with the owner key of an
   * office nobody owns claims it; a member comes in with their role (noting the visit); then guests,
   * into an open office or with the guest link. Signed-in people never become members by coming in.
   */
  async admit(stored: StoredOffice, userId: string | null, opts: { ownerKey?: unknown; guest?: unknown }): Promise<Admission> {
    const id = stored.office.id;
    const keyHolder = sameSecret(opts.ownerKey, stored.ownerKey);
    if (userId && keyHolder) await this.claim(userId, id);
    if (userId) {
      const visit = await this.db.query<{ role: MemberRole }>(
        'UPDATE memberships SET last_visit_at = now() WHERE user_id = $1 AND office_id = $2 RETURNING role',
        [userId, id],
      );
      const role = visit.rows[0]?.role;
      if (role) return { role, isOwner: role === 'owner' };
    }
    if (!welcomesGuests(stored, opts.guest)) return refusal(opts.guest, userId);
    // The owner key keeps its rights in an office nobody has claimed yet.
    return { role: 'guest', isOwner: keyHolder && !(await this.owned(id)) };
  }

  /**
   * The offices this person belongs to: the ones they've been to, most recently visited first (the
   * first is their default), then the ones they were added to and haven't visited, newest first.
   */
  async spaces(userId: string): Promise<Omit<Space, 'online'>[]> {
    const res = await this.db.query<{ id: string; name: string | null; kind: OfficeKind; role: MemberRole; last_visit_at: Date | string | null }>(
      `SELECT m.office_id AS id, o.data->'settings'->>'name' AS name, o.kind, m.role, m.last_visit_at
       FROM memberships m JOIN offices o ON o.id = m.office_id
       WHERE m.user_id = $1 ORDER BY m.last_visit_at DESC NULLS LAST, m.joined_at DESC, m.office_id LIMIT 200`,
      [userId],
    );
    return res.rows.map((r) => ({ id: r.id, name: r.name ?? '', kind: r.kind, role: r.role, lastVisitAt: r.last_visit_at === null ? null : ms(r.last_visit_at) }));
  }

  async members(officeId: string, withEmail: boolean): Promise<Member[]> {
    const res = await this.db.query<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.office_id = $1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.name), m.user_id LIMIT 1000`,
      [officeId],
    );
    return res.rows.map((r) => toMember(r, withEmail));
  }

  async member(officeId: string, userId: string, tx: Tx = this.db): Promise<Member | null> {
    const res = await tx.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.office_id = $1 AND m.user_id = $2`, [
      officeId,
      userId,
    ]);
    return res.rows[0] ? toMember(res.rows[0], true) : null;
  }

  async invites(officeId: string, emailed: boolean): Promise<Invite[]> {
    const res = await this.db.query<InviteRow>(
      `SELECT ${INVITE_COLUMNS} FROM office_invites i WHERE i.office_id = $1 AND i.expires_at > now() ORDER BY i.created_at DESC LIMIT 500`,
      [officeId],
    );
    return res.rows.map((r) => toInvite(r, emailed));
  }

  /**
   * Adds whoever has verified `email` to the office at once, or else invites the address (the
   * token goes in the emailed link). 'member' or 'invited' when they already are.
   */
  async add(
    officeId: string,
    email: string,
    role: 'admin' | 'member',
    by: string,
  ): Promise<{ member: Member } | { invite: InviteRow; token: string } | 'member' | 'invited'> {
    return this.db.transaction(async (tx) => {
      const owner = await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1 AND email_verified_at IS NOT NULL', [email]);
      const userId = owner.rows[0]?.id;
      if (userId) {
        const added = await tx.query('INSERT INTO memberships (user_id, office_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, office_id) DO NOTHING', [
          userId,
          officeId,
          role,
        ]);
        if (!added.rowCount) return 'member';
        await tx.query('DELETE FROM office_invites WHERE office_id = $1 AND email = $2', [officeId, email]);
        return { member: (await this.member(officeId, userId, tx))! };
      }
      // An expired invitation (not yet cleaned up) gives way to a new one.
      await tx.query('DELETE FROM office_invites WHERE office_id = $1 AND email = $2 AND expires_at <= now()', [officeId, email]);
      const token = newToken();
      const invite = await tx.query<InviteRow>(
        `INSERT INTO office_invites (id, office_id, email, role, invited_by, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '${INVITE_DAYS} days')
         ON CONFLICT (office_id, email) DO NOTHING
         RETURNING id, email, role, (SELECT name FROM users WHERE id = $5) AS invited_by, created_at, expires_at`,
        [randomId(16), officeId, email, role, by, hashToken(token)],
      );
      return invite.rows[0] ? { invite: invite.rows[0], token } : 'invited';
    });
  }

  /** A fresh token for an invitation (the old link stops working) and another 14 days. */
  async renewInvite(officeId: string, inviteId: string): Promise<{ invite: InviteRow; token: string } | null> {
    const token = newToken();
    const res = await this.db.query<InviteRow>(
      `UPDATE office_invites i SET token_hash = $3, expires_at = now() + interval '${INVITE_DAYS} days'
       WHERE i.id = $1 AND i.office_id = $2 RETURNING ${INVITE_COLUMNS}`,
      [inviteId, officeId, hashToken(token)],
    );
    return res.rows[0] ? { invite: res.rows[0], token } : null;
  }

  async inviteRole(officeId: string, inviteId: string): Promise<'admin' | 'member' | null> {
    const res = await this.db.query<{ role: 'admin' | 'member' }>('SELECT role FROM office_invites WHERE id = $1 AND office_id = $2', [inviteId, officeId]);
    return res.rows[0]?.role ?? null;
  }

  async revokeInvite(officeId: string, inviteId: string): Promise<boolean> {
    return (await this.db.query('DELETE FROM office_invites WHERE id = $1 AND office_id = $2', [inviteId, officeId])).rowCount > 0;
  }

  /** The invitation an emailed link is for while it works, without using it up. */
  async invite(token: unknown): Promise<{ officeId: string; officeName: string; email: string; role: 'admin' | 'member' } | null> {
    if (!isToken(token)) return null;
    const res = await this.db.query<{ office_id: string; name: string | null; email: string; role: 'admin' | 'member' }>(
      `SELECT i.office_id, o.data->'settings'->>'name' AS name, i.email, i.role
       FROM office_invites i JOIN offices o ON o.id = i.office_id WHERE i.token_hash = $1 AND i.expires_at > now()`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    return row ? { officeId: row.office_id, officeName: row.name ?? '', email: row.email, role: row.role } : null;
  }

  /** Uses the invitation up; null when it was used already or has expired. */
  async takeInvite(token: unknown, tx: Tx = this.db): Promise<{ officeId: string; email: string; role: 'admin' | 'member' } | null> {
    if (!isToken(token)) return null;
    const res = await tx.query<{ office_id: string; email: string; role: 'admin' | 'member'; fresh: boolean }>(
      'DELETE FROM office_invites WHERE token_hash = $1 RETURNING office_id, email, role, expires_at > now() AS fresh',
      [hashToken(token)],
    );
    const row = res.rows[0];
    return row?.fresh ? { officeId: row.office_id, email: row.email, role: row.role } : null;
  }

  async join(officeId: string, userId: string, role: MemberRole, tx: Tx = this.db): Promise<void> {
    await tx.query('INSERT INTO memberships (user_id, office_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, office_id) DO NOTHING', [userId, officeId, role]);
  }

  /** Uses the invitation up and makes `userId` a member, together; null when it was used already or expired. */
  async accept(token: unknown, userId: string): Promise<{ officeId: string; role: 'admin' | 'member' } | null> {
    return this.db.transaction(async (tx) => {
      const taken = await this.takeInvite(token, tx);
      if (taken) await this.join(taken.officeId, userId, taken.role, tx);
      return taken;
    });
  }

  async changeRole(officeId: string, userId: string, role: 'admin' | 'member'): Promise<boolean> {
    const res = await this.db.query("UPDATE memberships SET role = $3 WHERE office_id = $1 AND user_id = $2 AND role <> 'owner'", [officeId, userId, role]);
    return res.rowCount > 0;
  }

  /** Removes a member who still has `role` (so a change meanwhile isn't overruled). */
  async remove(officeId: string, userId: string, role: MemberRole): Promise<boolean> {
    return (await this.db.query('DELETE FROM memberships WHERE office_id = $1 AND user_id = $2 AND role = $3', [officeId, userId, role])).rowCount > 0;
  }

  /** Makes another member the owner, and the owner an admin. False when either isn't what they were. */
  async transfer(officeId: string, from: string, to: string): Promise<boolean> {
    try {
      await this.db.transaction(async (tx) => {
        // Demoted first: only one owner at a time.
        const demoted = await tx.query("UPDATE memberships SET role = 'admin' WHERE office_id = $1 AND user_id = $2 AND role = 'owner'", [officeId, from]);
        const promoted = demoted.rowCount ? await tx.query("UPDATE memberships SET role = 'owner' WHERE office_id = $1 AND user_id = $2", [officeId, to]) : null;
        if (!promoted?.rowCount) throw new NotMember();
      });
      return true;
    } catch (err) {
      if (err instanceof NotMember) return false;
      throw err;
    }
  }
}

export interface WorkspaceDeps {
  store: OfficeStore;
  workspaces: Workspaces;
  accounts: Accounts;
  realtime: RealtimeApi;
  mailer: Mailer;
  publicOrigin: string | null;
  clientIp(req: express.Request): string;
  auth: {
    requireUser: express.RequestHandler;
    userFromRequest(req: express.Request): Promise<AccountUser | null>;
    /** Signs this browser in as `user`. */
    startSession(req: express.Request, res: express.Response, user: AccountUser): Promise<void>;
    /** Ends the person's sessions and disconnects their sockets. */
    endSessions(userId: string): Promise<number>;
    /** Throws PasswordsBusy when too many are being hashed. */
    hashPassword(password: string): Promise<string>;
  };
}

const bodyOf = (req: express.Request) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
/** A password as typed; anything longer than a password can be is never right. */
const passwordOf = (v: unknown) => (typeof v === 'string' && v.length <= 4 * MAX_PASSWORD ? v : '');

const tooMany = (res: express.Response, ms: number, error: string) => {
  res.status(429).set('Retry-After', String(Math.ceil(ms / 1000))).json({ error });
};
const forbidden = (res: express.Response, error = 'Only owners and admins can do that.') => {
  res.status(403).json({ error });
};
const notFound = (res: express.Response, error: string) => {
  res.status(404).json({ error });
};
const expired = (res: express.Response) => {
  res.status(400).json({ error: 'This invitation has expired or was already used.', code: 'expired' });
};

/** The /api routes for workspaces: creating them, coming in, members, invitations and guest links. */
export function workspaceRoutes(deps: WorkspaceDeps): express.Router {
  const { store, workspaces, accounts, realtime, mailer, publicOrigin, auth } = deps;
  const { requireUser } = auth;
  const router = express.Router();
  // Links in emails need the address people open Workchop at.
  const emailLinks = mailer.kind !== 'off' && !!publicOrigin;
  // New workspaces per account and per visitor; people added or invited (each may send an email)
  // per account and per workspace; claims of old offices per account.
  const createsBy = windowLimiter(10, HOUR);
  const createsFrom = windowLimiter(30, HOUR);
  const addsBy = windowLimiter(30, HOUR);
  const addsTo = windowLimiter(100, DAY);
  const claimsBy = windowLimiter(20, HOUR);

  /** The guest link, while it's on. */
  const accessOf = (officeId: string, guests: GuestAccess, token: string | null): { guests: GuestAccess; link: string | null } => ({
    guests,
    link: guests === 'link' && token ? `${publicOrigin ?? ''}/o/${officeId}#guest=${token}` : null,
  });

  /** The office in the address, or null after answering 404 (or 503). */
  const officeOf = async (req: express.Request, res: express.Response): Promise<StoredOffice | null> => {
    let stored: StoredOffice | null;
    try {
      stored = await store.get(String(req.params.id));
    } catch (err) {
      console.error('[store] could not load office:', err);
      res.status(503).json({ error: 'Storage is unavailable right now.' });
      return null;
    }
    if (!stored) notFound(res, 'Office not found');
    return stored;
  };

  /** The office and the signed-in person's role there; null after answering when they aren't a member. */
  const asMember = async (req: express.Request, res: express.Response) => {
    const stored = await officeOf(req, res);
    if (!stored) return null;
    const user = res.locals.user as AccountUser;
    const role = await workspaces.role(user.id, stored.office.id);
    if (!role) {
      res.status(403).json({ error: deniedMessage('members-only'), reason: 'members-only' });
      return null;
    }
    return { stored, id: stored.office.id, user, role };
  };

  /** Counts a change that may send an email; false (after answering 429) when there have been too many. */
  const mayAdd = (res: express.Response, userId: string, officeId: string): boolean => {
    const wait = Math.max(addsBy.wait(userId), addsTo.wait(officeId));
    if (wait) {
      tooMany(res, wait, 'You’ve added a lot of people. Try again later.');
      return false;
    }
    addsBy(userId);
    addsTo(officeId);
    return true;
  };

  const inviter = (user: AccountUser) => ({ name: user.name, email: user.email ?? '' });
  const officeName = (stored: StoredOffice) => stored.office.settings.name;
  const sendInvite = (stored: StoredOffice, by: AccountUser, email: string, token: string) => {
    if (emailLinks) mailer.send({ to: email, ...mailTemplates.invited(`${publicOrigin}/invite#t=${token}`, inviter(by), officeName(stored)) });
  };

  router.post('/offices', requireUser, async (req, res) => {
    const user = res.locals.user as AccountUser;
    const visitor = addressKey(deps.clientIp(req));
    const wait = Math.max(createsBy.wait(user.id), createsFrom.wait(visitor));
    if (wait) return tooMany(res, wait, 'Too many offices created, try again later.');
    const body = bodyOf(req);
    const kind = body.kind ?? 'team';
    // Support workspaces can be made once there's a template for them.
    const template = TEMPLATES.find((t) => t.kind === kind && (body.template === undefined || t.id === body.template));
    if (!template) {
      res.status(400).json({ error: 'Pick a type and a template.' });
      return;
    }
    createsBy(user.id);
    createsFrom(visitor);
    const name = sanitizeName(body.name, 48) || 'My Office';
    let stored: StoredOffice;
    try {
      stored = await store.create(name, template.id, { kind: template.kind, ownerId: user.id });
    } catch (err) {
      console.error('[store] could not create office:', err);
      res.status(503).json({ error: 'Could not save the new office. Please try again.' });
      return;
    }
    res.status(201).json({ id: stored.office.id });
  });

  router.post('/offices/claim', requireUser, async (req, res) => {
    const user = res.locals.user as AccountUser;
    const list = bodyOf(req).offices;
    if (!Array.isArray(list)) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const wait = claimsBy.wait(user.id);
    if (wait) return tooMany(res, wait, 'Too many tries. Try again later.');
    claimsBy(user.id);
    const offices = list
      .slice(0, 50)
      .filter((o): o is { id: string; ownerKey: string } => !!o && typeof o === 'object' && isValidId(o.id) && typeof o.ownerKey === 'string');
    const claimed = await workspaces.claimAll(user.id, offices);
    for (const id of claimed) realtime.setRole(id, user.id, 'owner');
    res.json({ claimed });
  });

  router.get('/offices/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const stored = await officeOf(req, res);
    if (!stored) return;
    const user = await auth.userFromRequest(req);
    const found = await workspaces.check(stored, user?.id ?? null, req.get('x-workchop-guest'));
    if ('denied' in found) {
      res.status(403).json({ error: deniedMessage(found.denied), reason: found.denied });
      return;
    }
    const info: OfficeInfo = { id: stored.office.id, name: officeName(stored), kind: stored.kind, role: found.role, online: realtime.onlineCount(stored.office.id) };
    res.json(info);
  });

  router.get('/me/spaces', requireUser, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = res.locals.user as AccountUser;
    const spaces: Space[] = (await workspaces.spaces(user.id)).map((s) => ({
      ...s,
      // Offices open right now may have been renamed moments ago.
      name: store.peek(s.id)?.office.settings.name ?? s.name,
      online: realtime.onlineCount(s.id),
    }));
    res.json(spaces);
  });

  router.get('/offices/:id/members', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const m = await asMember(req, res);
    if (!m) return;
    const manager = may(m.role, 'add-member');
    const answer: MembersAnswer = { members: await workspaces.members(m.id, manager) };
    if (manager) {
      answer.invites = await workspaces.invites(m.id, emailLinks);
      answer.access = accessOf(m.id, m.stored.guests, m.stored.guestToken);
    }
    res.json(answer);
  });

  router.post('/offices/:id/members', requireUser, async (req, res) => {
    const m = await asMember(req, res);
    if (!m) return;
    const body = bodyOf(req);
    const role = body.role ?? 'member';
    if (role !== 'member' && role !== 'admin') {
      res.status(400).json({ error: 'Pick a role.' });
      return;
    }
    if (!may(m.role, role === 'admin' ? 'add-admin' : 'add-member')) return forbidden(res, role === 'admin' ? 'Only the owner can add admins.' : undefined);
    const email = normalizeEmail(body.email);
    if (!email) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    // Whoever adds people says who they are with an address they've confirmed.
    if (!m.user.emailVerified || !m.user.email) {
      res.status(403).json({ error: 'Confirm your email address first.', code: 'unverified' });
      return;
    }
    if (!mayAdd(res, m.user.id, m.id)) return;
    const added = await workspaces.add(m.id, email, role, m.user.id);
    if (added === 'member') {
      res.status(409).json({ error: 'They’re already a member.', code: 'member' });
      return;
    }
    if (added === 'invited') {
      res.status(409).json({ error: 'They’re already invited.', code: 'invited' });
      return;
    }
    if ('member' in added) {
      if (mailer.kind !== 'off' && publicOrigin) {
        mailer.send({ to: email, ...mailTemplates.added(`${publicOrigin}/o/${m.id}`, inviter(m.user), officeName(m.stored)) });
      }
      // Someone in the office as a guest right now is a member from now on.
      realtime.setRole(m.id, added.member.userId, role);
      res.status(201).json({ member: added.member });
      return;
    }
    sendInvite(m.stored, m.user, email, added.token);
    res.status(202).json({ invite: toInvite(added.invite, emailLinks) });
  });

  router.patch('/offices/:id/members/:userId', requireUser, async (req, res) => {
    const m = await asMember(req, res);
    if (!m) return;
    if (!may(m.role, 'change-role')) return forbidden(res, 'Only the owner can change roles.');
    const role = bodyOf(req).role;
    const target = String(req.params.userId);
    if (role !== 'admin' && role !== 'member') {
      res.status(400).json({ error: 'Pick a role.' });
      return;
    }
    if (target === m.user.id) {
      res.status(400).json({ error: 'Make someone else the owner first.' });
      return;
    }
    if (!(await workspaces.changeRole(m.id, target, role))) return notFound(res, 'They’re not a member.');
    realtime.setRole(m.id, target, role);
    res.json({ member: await workspaces.member(m.id, target) });
  });

  router.delete('/offices/:id/members/:userId', requireUser, async (req, res) => {
    const m = await asMember(req, res);
    if (!m) return;
    const target = String(req.params.userId);
    let role: MemberRole | null = m.role;
    if (target === m.user.id) {
      if (m.role === 'owner') {
        res.status(400).json({ error: 'Make someone else the owner before you leave.' });
        return;
      }
    } else {
      role = await workspaces.role(target, m.id);
      if (!role) return notFound(res, 'They’re not a member.');
      if (role === 'owner' || !may(m.role, role === 'admin' ? 'remove-admin' : 'remove-member')) return forbidden(res);
    }
    if (!(await workspaces.remove(m.id, target, role))) {
      res.status(409).json({ error: 'Their role just changed. Try again.' });
      return;
    }
    realtime.setRole(m.id, target, null);
    res.json({ ok: true });
  });

  router.post('/offices/:id/owner', requireUser, async (req, res) => {
    const m = await asMember(req, res);
    if (!m) return;
    if (!may(m.role, 'transfer')) return forbidden(res, 'Only the owner can do that.');
    const target = bodyOf(req).userId;
    if (typeof target !== 'string' || target === m.user.id) {
      res.status(400).json({ error: 'Pick another member.' });
      return;
    }
    if (!(await workspaces.transfer(m.id, m.user.id, target))) return notFound(res, 'They’re not a member.');
    realtime.setRole(m.id, m.user.id, 'admin');
    realtime.setRole(m.id, target, 'owner');
    res.json({ ok: true });
  });

  /** The invitation in the address, if the person may manage it; null after answering otherwise. */
  const managedInvite = async (req: express.Request, res: express.Response, m: { id: string; role: MemberRole }) => {
    const inviteId = String(req.params.inviteId);
    const role = await workspaces.inviteRole(m.id, inviteId);
    if (!role) {
      notFound(res, 'That invitation is gone.');
      return null;
    }
    if (!may(m.role, role === 'admin' ? 'add-admin' : 'add-member')) {
      forbidden(res);
      return null;
    }
    return inviteId;
  };

  router.delete('/offices/:id/invites/:inviteId', requireUser, async (req, res) => {
    const m = await asMember(req, res);
    const inviteId = m && (await managedInvite(req, res, m));
    if (!m || !inviteId) return;
    await workspaces.revokeInvite(m.id, inviteId);
    res.json({ ok: true });
  });

  router.post('/offices/:id/invites/:inviteId/resend', requireUser, async (req, res) => {
    const m = await asMember(req, res);
    const inviteId = m && (await managedInvite(req, res, m));
    if (!m || !inviteId) return;
    if (!emailLinks) {
      res.status(503).json({ error: 'This server can’t send email.', code: 'mail-off' });
      return;
    }
    if (!mayAdd(res, m.user.id, m.id)) return;
    const renewed = await workspaces.renewInvite(m.id, inviteId);
    if (!renewed) return notFound(res, 'That invitation is gone.');
    sendInvite(m.stored, m.user, renewed.invite.email, renewed.token);
    res.status(202).json({ invite: toInvite(renewed.invite, true) });
  });

  router.put('/offices/:id/access', requireUser, async (req, res) => {
    const m = await asMember(req, res);
    if (!m) return;
    if (!may(m.role, 'guest-link')) return forbidden(res);
    const guests = bodyOf(req).guests;
    // 'open' (offices from before workspaces) can only be left.
    if (guests !== 'off' && guests !== 'link') {
      res.status(400).json({ error: 'Turn the guest link on or off.' });
      return;
    }
    const before = m.stored.guests;
    // Turned on again, it's a new link: the old one stays dead.
    const token = guests === 'link' ? (before === 'link' && m.stored.guestToken) || newToken() : null;
    await store.setAccess(m.id, guests, token);
    if (guests !== before) realtime.accessChanged(m.id, guests);
    res.json(accessOf(m.id, guests, token));
  });

  router.post('/offices/:id/access/reset', requireUser, async (req, res) => {
    const m = await asMember(req, res);
    if (!m) return;
    if (!may(m.role, 'guest-link')) return forbidden(res);
    if (m.stored.guests !== 'link') {
      res.status(400).json({ error: 'Turn the guest link on first.' });
      return;
    }
    // Guests already in stay; the old link lets nobody else in.
    const token = newToken();
    await store.setAccess(m.id, 'link', token);
    res.json(accessOf(m.id, 'link', token));
  });

  router.post('/invites/preview', async (req, res) => {
    const invite = await workspaces.invite(bodyOf(req).token);
    if (!invite) return expired(res);
    res.json({
      officeId: invite.officeId,
      officeName: store.peek(invite.officeId)?.office.settings.name ?? invite.officeName,
      email: invite.email,
      role: invite.role,
      hasAccount: !!(await accounts.byVerifiedEmail(invite.email)),
    });
  });

  router.post('/invites/accept', async (req, res) => {
    const body = bodyOf(req);
    const invite = await workspaces.invite(body.token);
    if (!invite) return expired(res);
    const user = await auth.userFromRequest(req);
    if (user) {
      // Only the account that has the address confirmed.
      if (!user.emailVerified || user.email !== invite.email) {
        res.status(409).json({ error: `This invite is for ${invite.email}.`, code: 'other-account' });
        return;
      }
      const taken = await workspaces.accept(body.token, user.id);
      if (!taken) return expired(res);
      // Someone in the office as a guest right now is a member from now on.
      realtime.setRole(taken.officeId, user.id, taken.role);
      res.json({ user, officeId: taken.officeId });
      return;
    }
    if (await accounts.byVerifiedEmail(invite.email)) {
      res.status(401).json({ error: `Sign in as ${invite.email} to accept.`, code: 'sign-in' });
      return;
    }
    // A new account with the invited address, which the emailed link confirms.
    const name = sanitizeUserName(body.name);
    if (!name) {
      res.status(400).json({ error: 'Enter your name.' });
      return;
    }
    const password = passwordOf(body.password);
    const problem = passwordProblem(password, invite.email);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    let passwordHash: string;
    try {
      passwordHash = await auth.hashPassword(password);
    } catch (err) {
      if (!(err instanceof PasswordsBusy)) throw err;
      res.status(503).set('Retry-After', '5').json({ error: 'Too many people are signing in right now. Try again in a moment.' });
      return;
    }
    const avatar = body.avatar && typeof body.avatar === 'object' ? sanitizeAvatar(body.avatar) : undefined;
    let created: Awaited<ReturnType<Accounts['createWithPassword']>>;
    try {
      // The account, using the invitation up and the membership all happen, or none of them.
      created = await accounts.createWithPassword({ email: invite.email, name, passwordHash, avatar }, async (tx, userId) => {
        if (!(await workspaces.takeInvite(body.token, tx))) throw new InviteGone();
        await workspaces.join(invite.officeId, userId, invite.role, tx);
      });
    } catch (err) {
      if (err instanceof InviteGone) return expired(res);
      throw err;
    }
    // Someone verified the address meanwhile: whoever knew that account's old password is signed out.
    if (created.replaced) await auth.endSessions(created.user.id);
    await auth.startSession(req, res, created.user);
    res.json({ user: created.user, officeId: invite.officeId });
  });

  return router;
}
