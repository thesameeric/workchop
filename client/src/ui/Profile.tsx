import { useEffect, useId, useState, type FormEvent } from 'react';
import { normalizeEmail, passwordProblem, sanitizeUserName, type AccountUser, type SignInMethod, type SignInMethods } from '../../../shared/account';
import type { AvatarConfig } from '../../../shared/types';
import { connectUrl, errorText, saveAccountCharacter, signOut } from '../lib/account';
import { changeEmailRequest, changePasswordRequest, fetchSignInMethods, passwordLinkRequest, removeSignInMethod, signOutOthersRequest } from '../lib/api';
import { navigate, nextParam, withNext } from '../lib/router';
import { useStore } from '../state/store';
import { NewPasswordField, PasswordInput, PROVIDER_NAMES, ProviderLogo } from './Account';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';
import { Logo } from './Brand';
import { BackIcon, CheckIcon, DevicesIcon, KeyIcon, MailIcon, SignInIcon, SignOutIcon, UserEditIcon, VerifiedIcon } from './icons';

// Your account: name and character, email, password, the ways you sign in, and your devices. A page
// (/profile) outside an office, and the same sections in a window inside one (ui/Modals.tsx).

const sameAvatar = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function CharacterSection({ account }: { account: AccountUser }) {
  const fallback = useStore((s) => s.me.avatar);
  // Your edits; until there are some, the form shows the account as it is (changed on another device too).
  const [edit, setEdit] = useState<{ name: string; avatar: AvatarConfig } | null>(null);
  const { name, avatar } = edit ?? { name: account.name, avatar: account.profile.avatar ?? fallback };
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = sanitizeUserName(name);
  const changed = clean !== account.name || !sameAvatar(avatar, account.profile.avatar);
  const setName = (v: string) => setEdit({ name: v, avatar });
  const setAvatar = (v: AvatarConfig) => setEdit({ name, avatar: v });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!clean) return setError('Enter your name.');
    setBusy(true);
    setError(null);
    try {
      await saveAccountCharacter(clean, avatar);
      setEdit(null);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="profile-section" onSubmit={save}>
      <h2>
        <UserEditIcon size={20} /> Name and character
      </h2>
      <div className="character-layout">
        <AvatarPreview avatar={avatar} height={260} />
        <AvatarEditor name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
      </div>
      <div className="profile-save">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {saved && !changed && !error && (
          <span className="saved muted small" role="status">
            <CheckIcon size={15} /> Saved
          </span>
        )}
        <button className="btn primary" disabled={busy || !changed}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function EmailSection({ account }: { account: AccountUser }) {
  const emailLinks = useStore((s) => s.providers.emailLinks);
  const id = useId();
  // The form open: for a new address, or to confirm this one (which, with a password, asks for it).
  const [editing, setEditing] = useState<'change' | 'verify' | null>(null);
  const [email, setEmail] = useState('');
  const [current, setCurrent] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (address: string) => {
    setBusy(true);
    setError(null);
    try {
      await changeEmailRequest(address, account.hasPassword ? current : undefined);
      setSentTo(address);
      setEditing(null);
      setEmail('');
      setCurrent('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const open = (mode: 'change' | 'verify') => {
    setEditing(mode);
    setSentTo(null);
    setError(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = editing === 'verify' ? account.email : normalizeEmail(email);
    if (!clean) return setError('Enter a valid email address.');
    if (editing === 'change' && clean === account.email && account.emailVerified) return setError('That’s already your email address.');
    if (account.hasPassword && !current) return setError('Enter your password.');
    void send(clean);
  };

  return (
    <section className="profile-section">
      <h2>
        <MailIcon size={20} /> Email
      </h2>
      <div className="profile-row">
        <div className="profile-value">
          {account.email ? <strong title={account.email}>{account.email}</strong> : <span className="muted">No email address</span>}
          {account.email &&
            (account.emailVerified ? (
              <span className="badge verified">
                <VerifiedIcon size={13} /> Verified
              </span>
            ) : (
              <span className="badge neutral">Not verified</span>
            ))}
        </div>
        {emailLinks && !editing && (
          <div className="profile-actions">
            {account.email && !account.emailVerified && (
              <button className="btn small" disabled={busy} onClick={() => (account.hasPassword ? open('verify') : void send(account.email!))}>
                Verify
              </button>
            )}
            <button className="btn small" onClick={() => open('change')}>
              {account.email ? 'Change email' : 'Add email'}
            </button>
          </div>
        )}
      </div>
      {editing && (
        <form className="profile-form" onSubmit={submit} noValidate>
          {/* For password managers: whose password this is. */}
          {account.hasPassword && <input type="email" autoComplete="username" value={account.email ?? ''} readOnly hidden />}
          {editing === 'change' && (
            <div className="field">
              <label htmlFor={id}>New email address</label>
              <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" maxLength={254} autoComplete="email" autoFocus />
            </div>
          )}
          {account.hasPassword && (
            <div className="field">
              <label htmlFor={`${id}-password`}>Your password</label>
              <PasswordInput id={`${id}-password`} value={current} onChange={setCurrent} autoComplete="current-password" autoFocus={editing === 'verify'} />
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="row-end">
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send link'}
            </button>
          </div>
        </form>
      )}
      {sentTo && (
        <p className="profile-note" role="status">
          If no other account uses <strong>{sentTo}</strong>, we sent it a link. Open it while signed in here to confirm the address.
        </p>
      )}
      {error && !editing && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ChangePassword({ account }: { account: AccountUser }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!current) return setError('Enter your current password.');
    const problem = passwordProblem(password, account.email);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await changePasswordRequest(current, password);
      setDone(true);
      setOpen(false);
      setCurrent('');
      setPassword('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <>
        <div className="profile-row">
          <span className="muted small">You can sign in with your email address and password.</span>
          <button
            className="btn small"
            onClick={() => {
              setOpen(true);
              setDone(false);
            }}
          >
            Change password
          </button>
        </div>
        {done && (
          <p className="profile-note" role="status">
            Password changed. Your other devices were signed out.
          </p>
        )}
      </>
    );
  }
  return (
    <form className="profile-form" onSubmit={submit} noValidate>
      {/* For password managers: whose password this is. */}
      <input type="email" autoComplete="username" value={account.email ?? ''} readOnly hidden />
      <div className="field">
        <label htmlFor={id}>Current password</label>
        <PasswordInput id={id} value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
      </div>
      <NewPasswordField value={password} onChange={setPassword} email={account.email} label="New password" />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row-end">
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

/** For accounts without a password: a link by email to set one. */
function SetPassword({ account }: { account: AccountUser }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verified = !!account.email && account.emailVerified;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await passwordLinkRequest();
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="profile-row">
        <span className="muted small">
          {verified
            ? 'Set a password to also sign in with your email address.'
            : account.email
              ? 'Confirm your email address first, then you can set a password.'
              : 'Add an email address first, then you can set a password.'}
        </span>
        {verified && (
          <button className="btn small" disabled={busy} onClick={() => void send()}>
            Set a password
          </button>
        )}
      </div>
      {sent && (
        <p className="profile-note" role="status">
          We sent a link to <strong>{account.email}</strong>. Open it to set your password.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function PasswordSection({ account }: { account: AccountUser }) {
  const emailLinks = useStore((s) => s.providers.emailLinks);
  // Without email, a password can only be changed, not set.
  if (!account.hasPassword && !emailLinks) return null;
  return (
    <section className="profile-section">
      <h2>
        <KeyIcon size={20} /> Password
      </h2>
      {account.hasPassword ? <ChangePassword account={account} /> : <SetPassword account={account} />}
    </section>
  );
}

const PROVIDERS = ['google', 'apple', 'github'] as const;

/** One identity: a provider can be connected more than once (two GitHub accounts, say). */
const keyOf = (m: SignInMethod) => `${m.provider}:${m.subject}`;

function SignInSection({ account }: { account: AccountUser }) {
  const providers = useStore((s) => s.providers);
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** The identity being removed (provider:subject). */
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSignInMethods().then(
      (m) => alive && setMethods(m),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [account.id, account.hasPassword, attempt]);

  const remove = async (method: SignInMethod) => {
    setRemoving(keyOf(method));
    setError(null);
    try {
      setMethods(await removeSignInMethod(method));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRemoving(null);
    }
  };

  if (!methods) {
    return (
      <section className="profile-section">
        <h2>
          <SignInIcon size={20} /> Ways to sign in
        </h2>
        {failed ? (
          <p className="muted small">
            Couldn’t load them.{' '}
            <button
              className="link-btn"
              onClick={() => {
                setFailed(false);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          </p>
        ) : (
          <p className="muted small">Loading…</p>
        )}
      </section>
    );
  }
  const ways = methods.methods.length + (methods.hasPassword ? 1 : 0);
  const connectable = PROVIDERS.filter((p) => providers[p] && !methods.methods.some((m) => m.provider === p));
  return (
    <section className="profile-section">
      <h2>
        <SignInIcon size={20} /> Ways to sign in
      </h2>
      <ul className="methods">
        {methods.hasPassword && (
          <li className="method">
            <span className="method-logo">
              <KeyIcon size={20} />
            </span>
            <span className="method-text">
              <strong>Email and password</strong>
              {account.email && <span className="muted small">{account.email}</span>}
            </span>
          </li>
        )}
        {methods.methods.map((m) => (
          <li className="method" key={keyOf(m)}>
            <span className="method-logo">
              <ProviderLogo provider={m.provider} />
            </span>
            <span className="method-text">
              <strong>{PROVIDER_NAMES[m.provider]}</strong>
              {m.label && <span className="muted small">{m.label}</span>}
            </span>
            <button
              className="btn small"
              disabled={ways <= 1 || removing !== null}
              title={ways <= 1 ? 'Add another way to sign in first' : `Stop signing in with this ${PROVIDER_NAMES[m.provider]} account`}
              onClick={() => void remove(m)}
            >
              {removing === keyOf(m) ? 'Removing…' : 'Remove'}
            </button>
          </li>
        ))}
        {ways === 0 && <li className="muted small">Only the developer sign-in so far.</li>}
      </ul>
      {connectable.length > 0 && (
        <div className="connect">
          {connectable.map((p) => (
            <a key={p} className="btn small" href={connectUrl(p)}>
              <ProviderLogo provider={p} /> Connect {PROVIDER_NAMES[p]}
            </a>
          ))}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function DevicesSection({ onSignOut }: { onSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signOutOthers = async () => {
    setBusy(true);
    setError(null);
    try {
      const ended = await signOutOthersRequest();
      setNote(ended ? `Signed out ${ended} other ${ended === 1 ? 'device' : 'devices'}.` : 'You weren’t signed in anywhere else.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="profile-section">
      <h2>
        <DevicesIcon size={20} /> Devices
      </h2>
      <p className="muted small">Signed in on a computer you no longer use? Sign out everywhere but here.</p>
      <div className="profile-buttons">
        <button className="btn" disabled={busy} onClick={() => void signOutOthers()}>
          {busy ? 'Signing out…' : 'Sign out other devices'}
        </button>
        <button className="btn danger" onClick={onSignOut}>
          <SignOutIcon size={18} /> Sign out
        </button>
      </div>
      {note && (
        <p className="profile-note" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Everything about your account; `onSignOut` signs out from here. */
export function ProfileSections({ account, onSignOut }: { account: AccountUser; onSignOut: () => void }) {
  return (
    <div className="profile-sections">
      <CharacterSection account={account} />
      <EmailSection account={account} />
      <PasswordSection account={account} />
      <SignInSection account={account} />
      <DevicesSection onSignOut={onSignOut} />
    </div>
  );
}

/** /profile (?next= is where Back goes). */
export function ProfilePage() {
  const ready = useStore((s) => s.accountReady);
  const account = useStore((s) => s.account);
  const next = nextParam();

  useEffect(() => {
    if (ready && !account) navigate(withNext('/signin', '/profile'), { replace: true });
  }, [ready, account]);

  return (
    <div className="profile-page">
      <div className="landing-bg" aria-hidden="true" />
      <header className="landing-header">
        <button className="brand link" onClick={() => navigate('/')}>
          <Logo />
        </button>
        <button className="btn small" onClick={() => navigate(next)}>
          <BackIcon size={16} /> {next.startsWith('/o/') ? 'Back to the office' : 'Back'}
        </button>
      </header>
      <main className="profile-main">
        <h1>Profile</h1>
        {account ? (
          <ProfileSections
            account={account}
            onSignOut={() => {
              navigate('/');
              void signOut();
            }}
          />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    </div>
  );
}
