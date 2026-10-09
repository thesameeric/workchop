import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { normalizeEmail, passwordProblem, sanitizeUserName, type Space } from '../../../shared/account';
import { acceptInvite, accountUpdated, afterSignIn, errorText, finishSignUp, resetPassword, signOut, useProvidersKnown } from '../lib/account';
import { ApiError, confirmEmailRequest, fetchSpaces, forgotPasswordRequest, peekLinkRequest, previewInvite, signUpRequest, type InvitePreview } from '../lib/api';
import { goHome, navigate, nextParam, withNext } from '../lib/router';
import {
  loadProfile,
  pendingConfirmation,
  pendingInvite,
  saveSignUpNext,
  setPendingConfirmation,
  setPendingInvite,
  takeSignUpNext,
} from '../lib/storage';
import { finePointer } from '../lib/touch';
import { canSignIn, getState, toast, useStore } from '../state/store';
import { Link, NewPasswordField, ProviderButtons, SignInOptions, UserAvatar } from './Account';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';
import { Logo } from './Brand';
import { MailIcon } from './icons';
import { Consent } from './legal/Consent';

// The pages for signing in and up, and for the links we email: /signin, /signup (and /signup#t=… to
// finish), /forgot, /reset#t=…, /confirm-email#t=… and /invite#t=…. The router takes the token out of
// the address.

/** The page around a sign-in form (and the welcome): the brand, then a card. */
export function AuthShell({ title, intro, wide, children }: { title?: string; intro?: ReactNode; wide?: boolean; children?: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="landing-bg" aria-hidden="true" />
      <header className="landing-header">
        <button className="brand link" onClick={() => goHome()}>
          <Logo />
        </button>
      </header>
      <main className={`card auth-card${wide ? ' wide' : ''}`}>
        {title && <h1>{title}</h1>}
        {intro && <p className="auth-intro muted">{intro}</p>}
        {children}
      </main>
    </div>
  );
}

/** "Check your email" after asking for a link. */
function CheckEmail({ children, onAgain }: { children: ReactNode; onAgain: () => void }) {
  return (
    <div className="check-email" role="status">
      <span className="auth-icon">
        <MailIcon size={26} />
      </span>
      <p>{children}</p>
      <p className="muted small">
        Nothing yet? Check your spam folder, or{' '}
        <button type="button" className="link-btn" onClick={onAgain}>
          try again
        </button>
        .
      </p>
    </div>
  );
}

/** A used or out-of-date emailed link, with a way to get a new one. */
function LinkExpired({ title, action, to }: { title: string; action: string; to: string }) {
  return (
    <AuthShell title={title} intro="This link has expired or was already used.">
      <button className="btn primary wide" onClick={() => navigate(to)}>
        {action}
      </button>
    </AuthShell>
  );
}

/**
 * Which address an emailed link is for (null until the server says, or if it can't), and whether
 * the link is no good any more. Asking doesn't use it up.
 */
function useLinkEmail(token: string | null): { email: string | null; expired: boolean } {
  const [link, setLink] = useState<{ email: string | null; expired: boolean }>({ email: null, expired: false });
  useEffect(() => {
    if (!token) return;
    let alive = true;
    peekLinkRequest(token).then(
      ({ email }) => alive && setLink({ email, expired: false }),
      (err: unknown) => alive && setLink({ email: null, expired: err instanceof ApiError && err.code === 'expired' }),
    );
    return () => {
      alive = false;
    };
  }, [token]);
  return link;
}

/** The address a password is for, shown, and for password managers to save it under. */
function UsernameField({ email }: { email: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>Email</label>
      <input id={id} type="email" value={email} autoComplete="username" readOnly />
    </div>
  );
}

function EmailField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>Email</label>
      <input id={id} type="email" value={value} onChange={(e) => onChange(e.target.value)} placeholder="you@example.com" maxLength={254} autoComplete="email" autoFocus={finePointer()} />
    </div>
  );
}

/** In place of the ways to sign in until the server has said which it offers (it's asked again meanwhile). */
function OptionsLoading() {
  return (
    <p className="auth-alt muted" role="status">
      Loading sign-in options…
    </p>
  );
}

function SignInPage() {
  const account = useStore((s) => s.account);
  const offered = useStore(canSignIn);
  const known = useProvidersKnown();
  const next = nextParam();
  useEffect(() => {
    if (account) navigate(next, { replace: true });
  }, [account, next]);
  if (known && !offered) {
    return (
      <AuthShell title="Sign in" intro="This server doesn’t offer accounts. You can still create and join offices as a guest.">
        <button className="btn primary wide" onClick={() => navigate('/')}>
          Back home
        </button>
      </AuthShell>
    );
  }
  const intro = next === '/confirm-email' ? 'Sign in to confirm your new email address.' : 'Your character, your offices and your settings, on every device.';
  return (
    <AuthShell title="Sign in" intro={intro}>
      {known ? (
        <>
          <SignInOptions next={next} />
          <Consent signIn />
        </>
      ) : (
        <OptionsLoading />
      )}
    </AuthShell>
  );
}

function SignUp() {
  const emailLinks = useStore((s) => s.providers.emailLinks);
  const known = useProvidersKnown();
  const next = nextParam();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!known) {
    return (
      <AuthShell title="Create your account">
        <OptionsLoading />
      </AuthShell>
    );
  }
  if (!emailLinks) {
    return (
      <AuthShell title="Create an account" intro="Signing up with an email address isn’t available on this server.">
        <SignInOptions next={next} />
        <Consent />
      </AuthShell>
    );
  }
  if (sentTo) {
    return (
      <AuthShell title="Check your email">
        <CheckEmail onAgain={() => setSentTo(null)}>
          We sent a link to <strong>{sentTo}</strong>. Open it to continue.
        </CheckEmail>
      </AuthShell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = normalizeEmail(email);
    if (!clean) return setError('Enter a valid email address.');
    setBusy(true);
    setError(null);
    try {
      await signUpRequest(clean);
      saveSignUpNext(next);
      setSentTo(clean);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account" intro="Enter your email address. We’ll send you a link to finish signing up.">
      <form onSubmit={submit} noValidate>
        <EmailField value={email} onChange={setEmail} />
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Sending…' : 'Continue'}
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <ProvidersInstead next={next} />
      <Consent />
      <p className="auth-alt muted small">
        Already have an account? <Link to={withNext('/signin', next)}>Sign in</Link>
      </p>
    </AuthShell>
  );
}

/** Google, Apple and GitHub under an email form, when the server has any. */
function ProvidersInstead({ next }: { next: string }) {
  const oauth = useStore((s) => s.providers.google || s.providers.apple || s.providers.github);
  if (!oauth) return null;
  return (
    <>
      <div className="or" aria-hidden="true">
        <span>or</span>
      </div>
      <ProviderButtons next={next} />
    </>
  );
}

/** The emailed sign-up link: name, character and password, then the account is made. */
function FinishSignUp({ token }: { token: string }) {
  // The character this browser's guest had (and their name, which only ever comes from them).
  const [guest] = useState(loadProfile);
  const [name, setName] = useState(guest.name);
  const [avatar, setAvatar] = useState(guest.avatar);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const link = useLinkEmail(token);

  if (expired || link.expired) return <LinkExpired title="Finish signing up" action="Start again" to="/signup" />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = sanitizeUserName(name);
    if (!clean) return setError('Enter your name.');
    const problem = passwordProblem(password, link.email);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await finishSignUp(token, clean, password, avatar);
      afterSignIn(takeSignUpNext() ?? '/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'expired') setExpired(true);
      else setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Finish signing up"
      intro={
        <>
          {link.email && (
            <>
              For <strong>{link.email}</strong>.{' '}
            </>
          )}
          Choose your name and how you look in the office, then a password.
        </>
      }
      wide
    >
      <form onSubmit={submit} noValidate>
        <div className="character-layout">
          <AvatarPreview avatar={avatar} />
          <div>
            <AvatarEditor name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
            <div className="auth-password">
              {link.email && <UsernameField email={link.email} />}
              <NewPasswordField value={password} onChange={setPassword} email={link.email} />
            </div>
          </div>
        </div>
        <div className="auth-actions">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary big" disabled={busy}>
            {busy ? 'Creating your account…' : 'Create account'}
          </button>
        </div>
        <Consent />
      </form>
    </AuthShell>
  );
}

function Forgot() {
  const emailLinks = useStore((s) => s.providers.emailLinks);
  const known = useProvidersKnown();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!known) {
    return (
      <AuthShell title="Forgot your password?">
        <OptionsLoading />
      </AuthShell>
    );
  }
  if (!emailLinks) {
    return (
      <AuthShell title="Forgot your password?" intro="This server can’t send email, so passwords can’t be reset here. Ask the person who runs it.">
        <button className="btn primary wide" onClick={() => navigate('/signin')}>
          Back to sign in
        </button>
      </AuthShell>
    );
  }
  if (sentTo) {
    return (
      <AuthShell title="Check your email">
        <CheckEmail onAgain={() => setSentTo(null)}>
          If an account uses <strong>{sentTo}</strong>, we sent it a link to choose a new password. It works for 1 hour.
        </CheckEmail>
      </AuthShell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = normalizeEmail(email);
    if (!clean) return setError('Enter a valid email address.');
    setBusy(true);
    setError(null);
    try {
      await forgotPasswordRequest(clean);
      setSentTo(clean);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Forgot your password?" intro="Enter your email address and we’ll send you a link to choose a new one.">
      <form onSubmit={submit} noValidate>
        <EmailField value={email} onChange={setEmail} />
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Sending…' : 'Send link'}
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <p className="auth-alt muted small">
        Remembered it? <Link to="/signin">Sign in</Link>
      </p>
    </AuthShell>
  );
}

/** The emailed link to choose a (new) password. */
function ResetPassword({ token }: { token: string | null }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const link = useLinkEmail(token);

  if (!token) {
    return (
      <AuthShell title="Choose a password" intro="Open the link from your email to choose a password.">
        <button className="btn primary wide" onClick={() => navigate('/forgot')}>
          Send a new link
        </button>
      </AuthShell>
    );
  }
  if (expired || link.expired) return <LinkExpired title="Choose a password" action="Send a new link" to="/forgot" />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(password, link.email);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await resetPassword(token, password);
      toast('Password saved. You’re signed in.');
      afterSignIn('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'expired') setExpired(true);
      else setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Choose a password" intro="For your Homeoffice account.">
      <form onSubmit={submit} noValidate>
        {link.email && <UsernameField email={link.email} />}
        <NewPasswordField value={password} onChange={setPassword} email={link.email} label="New password" />
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </AuthShell>
  );
}

/**
 * The emailed link that confirms an email address. Only the account that asked for it can: signed
 * out, you sign in first (the link waits in this tab); as someone else, you switch accounts.
 */
function ConfirmEmail({ token: linked }: { token: string | null }) {
  const account = useStore((s) => s.account);
  const [token] = useState(() => linked ?? pendingConfirmation());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'done' | 'other-account' | { error: string; expired: boolean } | null>(null);
  // The new address, if the server tells (it may only for sign-up and reset links).
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!token || account) return;
    setPendingConfirmation(token);
    navigate(withNext('/signin', '/confirm-email'), { replace: true });
  }, [token, account]);

  const signedIn = !!account;
  useEffect(() => {
    if (!token || !signedIn) return;
    let alive = true;
    peekLinkRequest(token).then(
      (link) => alive && setEmail(link.email),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [token, signedIn]);

  const confirm = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const user = await confirmEmailRequest(token);
      if (getState().account?.id === user.id) accountUpdated(user);
      setPendingConfirmation(null);
      setResult('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'sign-in') {
        setResult('other-account');
      } else {
        // Used up, or the address is taken: nothing to come back to.
        if (err instanceof ApiError) setPendingConfirmation(null);
        setResult({ error: errorText(err), expired: err instanceof ApiError && err.code === 'expired' });
      }
    } finally {
      setBusy(false);
    }
  };
  // Signing out brings the sign-in page (above), and then this link back.
  const switchAccount = () => {
    if (token) setPendingConfirmation(token);
    void signOut();
  };

  const toProfile = (
    <button className="btn primary wide" onClick={() => navigate('/profile')}>
      Go to your profile
    </button>
  );
  if (!token) {
    return (
      <AuthShell title="Confirm your email" intro="Open the link from your email to confirm your address.">
        <button className="btn primary wide" onClick={() => navigate(account ? '/profile' : '/')}>
          Continue
        </button>
      </AuthShell>
    );
  }
  if (!account) return <AuthShell title="Confirm your email" intro="Sign in to confirm your new email address." />;
  if (result === 'done') return <AuthShell title="Email confirmed" intro="Your email address is confirmed.">{toProfile}</AuthShell>;
  if (result === 'other-account') {
    return (
      <AuthShell title="Confirm your email" intro="This link is for another Homeoffice account. Sign in with the account that asked for the change.">
        <button className="btn primary wide" onClick={switchAccount}>
          Sign in with another account
        </button>
      </AuthShell>
    );
  }
  if (result) {
    return (
      <AuthShell title="Confirm your email" intro={result.error}>
        {result.expired && <p className="muted small">Ask for a new link from your profile.</p>}
        {toProfile}
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title="Confirm your email"
      intro={
        email ? (
          <>
            Confirm <strong>{email}</strong> for your Homeoffice account.
          </>
        ) : (
          'Confirm your new email address for your Homeoffice account.'
        )
      }
    >
      <div className="confirm-account">
        <UserAvatar user={account} size={40} />
        <span className="account-who">
          <strong title={account.name}>{account.name}</strong>
          {account.email && <span className="muted small">Currently {account.email}</span>}
        </span>
      </div>
      <button className="btn primary wide" disabled={busy} onClick={() => void confirm()}>
        {busy ? 'Confirming…' : 'Confirm'}
      </button>
      <p className="auth-alt muted small">
        Not your account?{' '}
        <button type="button" className="link-btn" onClick={switchAccount}>
          Sign in with another one
        </button>
      </p>
    </AuthShell>
  );
}

/**
 * A link that no longer works: used already when you're signed in and belong to workspaces (it was
 * accepted, say, as you signed in with its address), or expired.
 */
async function usedOrExpired(): Promise<{ used: Space[] } | 'expired'> {
  setPendingInvite(null);
  const spaces = getState().account ? await fetchSpaces().catch(() => []) : [];
  return spaces.length ? { used: spaces } : 'expired';
}

/** The account an invitation is for: name, character and password, then it's made and you're in. */
function InviteSignUp({ token, invite, onGone }: { token: string; invite: InvitePreview; onGone: () => void }) {
  const [guest] = useState(loadProfile);
  const [name, setName] = useState(guest.name);
  const [avatar, setAvatar] = useState(guest.avatar);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An account has this address after all: sign in with it (the link waits in this tab).
  const [signIn, setSignIn] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = sanitizeUserName(name);
    if (!clean) return setError('Enter your name.');
    const problem = passwordProblem(password, invite.email);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const officeId = await acceptInvite(token, { name: clean, password, avatar });
      setPendingInvite(null);
      afterSignIn(`/o/${officeId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'expired') onGone();
      else {
        setSignIn(err instanceof ApiError && err.code === 'sign-in');
        setError(errorText(err));
      }
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={`Join ${invite.officeName}`}
      intro={
        <>
          You’re invited as {invite.role === 'admin' ? 'an admin' : 'a member'}. Create your account for <strong>{invite.email}</strong>: your name, how
          you look in the office, and a password.
        </>
      }
      wide
    >
      <form onSubmit={submit} noValidate>
        <div className="character-layout">
          <AvatarPreview avatar={avatar} />
          <div>
            <AvatarEditor name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
            <div className="auth-password">
              <UsernameField email={invite.email} />
              <NewPasswordField value={password} onChange={setPassword} email={invite.email} />
            </div>
          </div>
        </div>
        <div className="auth-actions">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {signIn ? (
            <button type="button" className="btn primary big" onClick={() => navigate(withNext('/signin', '/invite'))}>
              Sign in to accept
            </button>
          ) : (
            <button className="btn primary big" disabled={busy}>
              {busy ? 'Creating your account…' : 'Create account and join'}
            </button>
          )}
        </div>
        {!signIn && <Consent />}
      </form>
    </AuthShell>
  );
}

/**
 * An emailed invitation to a workspace (/invite#t=…). Without an account for its address you make
 * one here; with one, you accept signed in with it (the link waits in this tab while you sign in,
 * here or with Google, Apple or GitHub).
 */
function InvitePage({ token: linked }: { token: string | null }) {
  const account = useStore((s) => s.account);
  const accountId = account?.id ?? null;
  const known = useProvidersKnown();
  const [token] = useState(() => linked ?? pendingInvite());
  const [invite, setInvite] = useState<InvitePreview | 'expired' | { used: Space[] } | { error: string } | null>(null);
  const [otherAccount, setOtherAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Asked again after signing in here: signing in with the invited address accepts it by itself.
  useEffect(() => {
    if (!token) return;
    setPendingInvite(token);
    setInvite(null);
    let alive = true;
    previewInvite(token).then(
      (preview) => alive && setInvite(preview),
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.code === 'expired') void usedOrExpired().then((gone) => alive && setInvite(gone));
        else setInvite({ error: errorText(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [token, accountId]);

  const gone = () => void usedOrExpired().then(setInvite);
  const accept = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const officeId = await acceptInvite(token);
      setPendingInvite(null);
      afterSignIn(`/o/${officeId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'other-account') setOtherAccount(true);
      else if (err instanceof ApiError && err.code === 'expired') gone();
      else setError(errorText(err));
      setBusy(false);
    }
  };
  const home = (primary: boolean, label = 'Back home') => (
    <button className={`btn wide${primary ? ' primary' : ''}`} onClick={() => goHome()}>
      {label}
    </button>
  );

  if (!token) return <AuthShell title="Join a workspace" intro="Open the invitation link from your email.">{home(true)}</AuthShell>;
  if (invite === null) return <AuthShell intro="Loading…" />;
  if (invite === 'expired') {
    return (
      <AuthShell title="Invitation expired" intro="This invitation has expired or was already used. Ask whoever invited you for a new one.">
        {home(true)}
      </AuthShell>
    );
  }
  if ('used' in invite) {
    return (
      <AuthShell title="Your workspaces" intro="This invitation was already used or has expired. If it was for you, you’re in.">
        <div className="auth-buttons">
          {invite.used.slice(0, 5).map((s) => (
            <button key={s.id} className="recent-item" onClick={() => navigate(`/o/${s.id}`)}>
              <span>{s.name || 'Untitled office'}</span>
              <span className="muted">Open</span>
            </button>
          ))}
          {home(false, 'All workspaces')}
        </div>
      </AuthShell>
    );
  }
  if ('error' in invite) return <AuthShell title="Join a workspace" intro={invite.error}>{home(true)}</AuthShell>;

  const title = `Join ${invite.officeName}`;
  const as = invite.role === 'admin' ? 'an admin' : 'a member';
  const sameAddress = !!account && account.email === invite.email;
  // Confirming the address (in Profile) makes you a member by itself.
  if (account && sameAddress && !account.emailVerified) {
    return (
      <AuthShell
        title={title}
        intro={
          <>
            Confirm <strong>{invite.email}</strong> in your profile, and you’ll join {invite.officeName} as {as}.
          </>
        }
      >
        <button className="btn primary wide" onClick={() => navigate('/profile')}>
          Go to your profile
        </button>
      </AuthShell>
    );
  }
  if (account && (otherAccount || !sameAddress)) {
    return (
      <AuthShell
        title={title}
        intro={
          <>
            This invitation is for <strong>{invite.email}</strong>, but you’re signed in as {account.email ? <strong>{account.email}</strong> : account.name}.
          </>
        }
      >
        <div className="auth-buttons">
          {/* Signing out brings the page back for the right account, with this link. */}
          <button className="btn primary wide" onClick={() => void signOut()}>
            Sign in with another account
          </button>
          {home(false)}
        </div>
      </AuthShell>
    );
  }
  if (account) {
    return (
      <AuthShell title={title} intro={`You’re invited as ${as}.`}>
        <div className="confirm-account">
          <UserAvatar user={account} size={40} />
          <span className="account-who">
            <strong title={account.name}>{account.name}</strong>
            <span className="muted small">{account.email}</span>
          </span>
        </div>
        <button className="btn primary wide" disabled={busy} onClick={() => void accept()}>
          {busy ? 'Joining…' : `Join ${invite.officeName}`}
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </AuthShell>
    );
  }
  if (invite.hasAccount) {
    return (
      <AuthShell
        title={title}
        intro={
          <>
            You’re invited as {as}. Sign in as <strong>{invite.email}</strong> to accept.
          </>
        }
      >
        {known ? <SignInOptions next="/invite" /> : <OptionsLoading />}
      </AuthShell>
    );
  }
  return <InviteSignUp token={token} invite={invite} onGone={gone} />;
}

export function AuthPage() {
  const page = useStore((s) => s.authPage);
  const token = useStore((s) => s.linkToken);
  const ready = useStore((s) => s.accountReady);
  // Until we know what the server offers (and who you are), so a page doesn't flash "not available".
  if (!ready) return <AuthShell intro="Loading…" />;
  // A new link opened in this tab starts its page afresh.
  if (page === 'signup') return token ? <FinishSignUp key={token} token={token} /> : <SignUp />;
  if (page === 'forgot') return <Forgot />;
  if (page === 'reset') return <ResetPassword key={token} token={token} />;
  if (page === 'confirm-email') return <ConfirmEmail key={token} token={token} />;
  if (page === 'invite') return <InvitePage key={token} token={token} />;
  return <SignInPage />;
}
