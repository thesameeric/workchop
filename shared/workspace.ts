// Workspaces (offices with members): their type, who belongs to them and with which role, and who
// else may come in. Shared by the server (which enforces it) and the client (which hides what you
// can't do).

/** Fixed when the workspace is created. */
export type OfficeKind = 'team' | 'support';

export type MemberRole = 'owner' | 'admin' | 'member';
/** Your role in a workspace you're in; guests came in with a guest link (or an open office). */
export type Role = MemberRole | 'guest';

/**
 * Who besides members may come in: nobody ('off', new workspaces), whoever has the guest link ('link'),
 * or anyone with the address ('open', every office made before workspaces; it can't be turned back on).
 */
export type GuestAccess = 'off' | 'link' | 'open';

/** GET /api/offices/:id when you may come in. */
export interface OfficeInfo {
  id: string;
  name: string;
  kind: OfficeKind;
  /** What you'd be: your membership's role, or 'guest'. */
  role: Role;
  online: number;
}

/** Why GET /api/offices/:id (403 `{ error, reason }`) or a join refused you. */
export type AccessDenied = 'sign-in' | 'members-only' | 'link';

/** Why you were taken out of an office ('office:removed'): removed from its members, or guests turned off. */
export type RemovedReason = 'removed' | 'guests-off';

export interface Member {
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** Only shown to owners and admins. */
  email?: string | null;
  role: MemberRole;
  joinedAt: number;
  /** Their last visit; joinedAt when they haven't been yet. */
  lastVisitAt: number;
}

/** Someone asked to join by email who has no account with that (verified) address yet. */
export interface Invite {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invitedBy: string | null;
  createdAt: number;
  expiresAt: number;
  /** The invitation was emailed (false when this server can't send email). */
  emailed: boolean;
}

/** GET /api/offices/:id/members. Invites and access only for owners and admins. */
export interface MembersAnswer {
  members: Member[];
  invites?: Invite[];
  access?: { guests: GuestAccess; link: string | null };
}

export type Action =
  | 'see-members'
  | 'add-member'
  | 'add-admin'
  | 'change-role'
  | 'remove-member'
  | 'remove-admin'
  | 'transfer'
  | 'guest-link'
  | 'build';

/**
 * Whether `role` may do `action`. `build` also depends on the office: members build when its build
 * policy is 'everyone', guests only in 'open' offices.
 */
export function may(role: Role | null, action: Action, office?: { buildPolicy: 'everyone' | 'owner'; guests: GuestAccess }): boolean {
  if (!role) return false;
  switch (action) {
    case 'see-members':
      return role !== 'guest';
    case 'add-member':
    case 'remove-member':
    case 'guest-link':
      return role === 'owner' || role === 'admin';
    case 'add-admin':
    case 'change-role':
    case 'remove-admin':
    case 'transfer':
      return role === 'owner';
    case 'build':
      if (role === 'owner' || role === 'admin') return true;
      if (!office || office.buildPolicy !== 'everyone') return false;
      return role === 'member' || office.guests === 'open';
  }
}
