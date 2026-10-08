import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { normalizeEmail } from '../../../shared/account';
import { may, type Invite, type Member, type MemberRole, type MembersAnswer } from '../../../shared/workspace';
import { errorText } from '../lib/account';
import {
  addMember,
  changeRole,
  fetchMembers,
  removeMember,
  resendInvite,
  resetGuestLink,
  revokeInvite,
  setGuestAccess,
  transferOwnership,
  type GuestLink,
} from '../lib/api';
import { getSession, leaveOffice } from '../lib/session';
import { ago } from '../lib/time';
import { getState, setState, toast, useStore } from '../state/store';
import { UserAvatar } from './Account';
import { AlertIcon, CloseIcon, CopyIcon, LeaveIcon, MailIcon, OwnerIcon, RefreshIcon, RemoveUserIcon, ResendIcon, WorkspaceIcon } from './icons';
import { registerSettingsSection } from './settings';

// The Workspace section of Settings: its members (and for owners and admins adding people, roles,
// invitations and the guest link). Shown to members, not to guests.

/** Opens Settings at the Workspace section ("Invite people" in the dock). */
export function openWorkspaceSettings(): void {
  setState({ modal: 'settings', settingsSection: 'workspace' });
}

const ROLE_LABELS: Record<MemberRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** Runs a change, saying what went wrong if the server refuses it; resolves true when it worked. */
async function attempt(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    toast(errorText(err), 'error');
    return false;
  }
}

function AddPeople({ officeId, onAdded }: { officeId: string; onAdded: () => void }) {
  const role = useStore((s) => s.role);
  const verified = useStore((s) => !!s.account?.emailVerified);
  const id = useId();
  const [email, setEmail] = useState('');
  const [as, setAs] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Opened with "Invite people": ready to type.
  useEffect(() => {
    if (getState().settingsSection === 'workspace') input.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = normalizeEmail(email);
    if (!address) return setResult({ ok: false, text: 'Enter a valid email address.' });
    setBusy(true);
    setResult(null);
    try {
      const added = await addMember(officeId, address, as);
      setEmail('');
      if ('member' in added) setResult({ ok: true, text: `${added.member.name} is a member now.` });
      else if (added.invite.emailed) setResult({ ok: true, text: `Invitation sent to ${address}.` });
      else setResult({ ok: true, text: `${address} is invited. Ask them to sign up with that address.` });
      onAdded();
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  if (!verified) {
    return (
      <p className="ws-note">
        <AlertIcon size={16} /> Confirm your email address in your profile to add people.
      </p>
    );
  }
  return (
    <form className="ws-add" onSubmit={submit} noValidate>
      <label htmlFor={`${id}-email`}>Add people by email</label>
      <div className="ws-add-row">
        <input
          ref={input}
          id={`${id}-email`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          maxLength={254}
          autoComplete="off"
        />
        {may(role, 'add-admin') && (
          <select value={as} onChange={(e) => setAs(e.target.value as 'member' | 'admin')} aria-label="Role">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
      {result && (
        <p className={result.ok ? 'ws-result small' : 'form-error'} role={result.ok ? 'status' : 'alert'}>
          {result.text}
        </p>
      )}
    </form>
  );
}

function MemberRow({ member, officeId, onChange }: { member: Member; officeId: string; onChange: () => void }) {
  const role = useStore((s) => s.role);
  const me = useStore((s) => s.account?.id);
  const [busy, setBusy] = useState(false);
  const self = member.userId === me;
  const run = async (change: () => Promise<unknown>) => {
    setBusy(true);
    if (await attempt(change)) onChange();
    setBusy(false);
  };
  const removable = !self && member.role !== 'owner' && may(role, member.role === 'admin' ? 'remove-admin' : 'remove-member');
  const transfer = () => {
    if (confirm(`Make ${member.name} the owner? You’ll become an admin.`)) void run(() => transferOwnership(officeId, member.userId));
  };
  const remove = () => {
    if (confirm(`Remove ${member.name} from this workspace?`)) void run(() => removeMember(officeId, member.userId));
  };
  const leave = async () => {
    if (!confirm('Leave this workspace? You’ll need to be added again to come back.')) return;
    const session = getSession();
    if (session) session.leaving = true;
    setBusy(true);
    if (await attempt(() => removeMember(officeId, member.userId))) {
      leaveOffice();
      toast('You left the workspace.');
    } else {
      if (session) session.leaving = false;
      setBusy(false);
    }
  };

  return (
    <li className="ws-row">
      <UserAvatar user={member} size={34} />
      <span className="ws-who">
        <strong title={member.name}>
          {member.name}
          {self && <span className="muted"> (you)</span>}
        </strong>
        <span className="muted small" title={member.email ?? undefined}>
          {member.email ?? `Joined ${ago(member.joinedAt)}`}
        </span>
      </span>
      <span className="ws-actions">
        {may(role, 'change-role') && !self && member.role !== 'owner' ? (
          <select
            value={member.role}
            disabled={busy}
            aria-label={`${member.name}’s role`}
            onChange={(e) => void run(() => changeRole(officeId, member.userId, e.target.value as MemberRole))}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        ) : (
          <span className={`badge${member.role === 'member' ? ' neutral' : ''}`}>{ROLE_LABELS[member.role]}</span>
        )}
        {may(role, 'transfer') && !self && (
          <button className="icon-btn" disabled={busy} onClick={transfer} title="Make owner" aria-label={`Make ${member.name} the owner`}>
            <OwnerIcon size={18} />
          </button>
        )}
        {removable && (
          <button className="icon-btn danger" disabled={busy} onClick={remove} title="Remove" aria-label={`Remove ${member.name}`}>
            <RemoveUserIcon size={18} />
          </button>
        )}
        {self && member.role !== 'owner' && (
          <button className="btn small danger" disabled={busy} onClick={() => void leave()}>
            <LeaveIcon size={16} /> Leave
          </button>
        )}
      </span>
    </li>
  );
}

function InviteRow({ invite, officeId, onChange }: { invite: Invite; officeId: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (change: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    if (await attempt(change)) {
      if (done) toast(done);
      onChange();
    }
    setBusy(false);
  };
  return (
    <li className="ws-row">
      <span className="ws-icon">
        <MailIcon size={18} />
      </span>
      <span className="ws-who">
        <strong title={invite.email}>{invite.email}</strong>
        <span className="muted small">
          {invite.role === 'admin' ? 'Admin · ' : ''}
          {invite.emailed ? `Invited ${ago(invite.createdAt)}` : 'Not emailed: they sign up with this address'}
        </span>
      </span>
      <span className="ws-actions">
        {invite.emailed && (
          <button className="icon-btn" disabled={busy} onClick={() => void run(() => resendInvite(officeId, invite.id), `Sent again to ${invite.email}`)} title="Send again">
            <ResendIcon size={18} />
          </button>
        )}
        <button className="icon-btn danger" disabled={busy} onClick={() => void run(() => revokeInvite(officeId, invite.id))} title="Cancel invitation" aria-label={`Cancel the invitation to ${invite.email}`}>
          <CloseIcon size={18} />
        </button>
      </span>
    </li>
  );
}

/** Turns the guest link on and off, copies it and makes a new one. */
function GuestLinkSettings({ officeId, access, onChange }: { officeId: string; access: GuestLink; onChange: (access: GuestLink) => void }) {
  const [busy, setBusy] = useState(false);
  // A server that doesn't know its own address (no PUBLIC_URL) gives it without one: this page's.
  const link = access.link && new URL(access.link, location.origin).href;
  const run = async (change: () => Promise<GuestLink>) => {
    setBusy(true);
    try {
      onChange(await change());
    } catch (err) {
      toast(errorText(err), 'error');
    }
    setBusy(false);
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast('Guest link copied');
    } catch {
      prompt('Copy the guest link:', link);
    }
  };
  const reset = () => {
    if (confirm('Make a new guest link? The old one stops working; guests already inside stay.')) void run(() => resetGuestLink(officeId));
  };
  return (
    <section className="ws-section">
      <h4>Guest link</h4>
      <label className="ws-toggle">
        <input type="checkbox" role="switch" checked={access.guests === 'link'} disabled={busy} onChange={(e) => void run(() => setGuestAccess(officeId, e.target.checked ? 'link' : 'off'))} />
        <span>
          <strong>Let guests in with a link</strong>
          <span className="muted small">Anyone with it comes in without an account. Turning it off takes guests out.</span>
        </span>
      </label>
      {link && (
        <div className="ws-link">
          <input readOnly value={link} aria-label="Guest link" onFocus={(e) => e.target.select()} />
          <button className="icon-btn" onClick={() => void copy()} title="Copy link">
            <CopyIcon size={18} />
          </button>
          <button className="icon-btn" disabled={busy} onClick={reset} title="New link">
            <RefreshIcon size={18} />
          </button>
        </div>
      )}
    </section>
  );
}

/** Offices from before workspaces are open to anyone with their address, until someone closes them. */
function OpenOffice({ officeId, onChange }: { officeId: string; onChange: (access: GuestLink) => void }) {
  const [busy, setBusy] = useState(false);
  const close = async (guests: 'off' | 'link') => {
    setBusy(true);
    try {
      onChange(await setGuestAccess(officeId, guests));
    } catch (err) {
      toast(errorText(err), 'error');
    }
    setBusy(false);
  };
  return (
    <div className="ws-banner">
      <AlertIcon size={18} />
      <div>
        <strong>Anyone with this office’s address can come in.</strong>
        <p className="muted small">Make it members only, or let guests in with a link you can turn off. Check the members below too.</p>
        <div className="ws-banner-actions">
          <button className="btn small primary" disabled={busy} onClick={() => void close('off')}>
            Members only
          </button>
          <button className="btn small" disabled={busy} onClick={() => void close('link')}>
            Use a guest link
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceSection() {
  const officeId = useStore((s) => s.officeId);
  const role = useStore((s) => s.role);
  const guests = useStore((s) => s.guests);
  const [data, setData] = useState<MembersAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Again when your role or the access changes (here or by someone else).
  useEffect(() => {
    if (!officeId) return;
    let alive = true;
    fetchMembers(officeId).then(
      (answer) => {
        if (!alive) return;
        setData(answer);
        setError(null);
      },
      (err: unknown) => alive && setError(errorText(err)),
    );
    return () => {
      alive = false;
    };
  }, [officeId, role, guests, version]);

  if (!officeId) return null;
  if (!data) return error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>;
  const setAccess = (access: GuestLink) => {
    setData((d) => d && { ...d, access });
    setState({ guests: access.guests });
  };
  const access = data.access;
  return (
    <div className="ws">
      {access?.guests === 'open' && <OpenOffice officeId={officeId} onChange={setAccess} />}
      {may(role, 'add-member') && <AddPeople officeId={officeId} onAdded={reload} />}
      <section className="ws-section">
        <h4>Members · {data.members.length}</h4>
        <ul className="ws-list">
          {data.members.map((m) => (
            <MemberRow key={m.userId} member={m} officeId={officeId} onChange={reload} />
          ))}
        </ul>
      </section>
      {!!data.invites?.length && (
        <section className="ws-section">
          <h4>Invited · {data.invites.length}</h4>
          <ul className="ws-list">
            {data.invites.map((i) => (
              <InviteRow key={i.id} invite={i} officeId={officeId} onChange={reload} />
            ))}
          </ul>
        </section>
      )}
      {access && access.guests !== 'open' && <GuestLinkSettings officeId={officeId} access={access} onChange={setAccess} />}
    </div>
  );
}

// Members see the section; guests don't.
let remove: (() => void) | null = null;
const sync = () => {
  const show = may(getState().role, 'see-members');
  if (show && !remove) remove = registerSettingsSection({ id: 'workspace', title: 'Workspace', icon: WorkspaceIcon, order: 5, Component: WorkspaceSection });
  else if (!show && remove) {
    remove();
    remove = null;
  }
};
sync();
useStore.subscribe(sync);
