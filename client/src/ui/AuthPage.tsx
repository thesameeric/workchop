import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { normalizeEmail, passwordProblem, sanitizeUserName } from '../../../shared/account';
import { accountUpdated, afterSignIn, errorText, finishSignUp, resetPassword, signOut } from '../lib/account';
import { ApiError, confirmEmailRequest, forgotPasswordRequest, peekLinkRequest, signUpRequest } from '../lib/api';
import { navigate, nextParam, withNext } from '../lib/router';
import { loadProfile, pendingConfirmation, saveSignUpNext, setPendingConfirmation, takeSignUpNext } from '../lib/storage';
import { canSignIn, getState, toast, useStore } from '../state/store';
import { Link, NewPasswordField, ProviderButtons, SignInOptions, UserAvatar } from './Account';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';
import { MailIcon } from './icons';

// The pages for signing in and up, and for the links we email: /signin, /signup (and /signup#t=… to
// finish), /forgot, /reset#t=… and /confirm-email#t=…. The router takes the token out of the address.

/** The page around a sign-in form (and the welcome): the brand, then a card. */
export function AuthShell({ title, intro, wide, children }: { title?: string; intro?: ReactNode; wide?: boolean; children?: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="landing-bg" aria-hidden="true" />
      <header className="landing-header">
        <button className="brand link" onClick={() => navigate('/')}>
          <span className="brand-mark">◆</span> Workchop
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
      <input id={id} type="email" value={value} onChange={(e) => onChange(e.target.value)} placeholder="you@example.com" maxLength={254} autoComplete="email" autoFocus />
    </div>
  );
}

function SignInPage() {
  const account = useStore((s) => s.account);
  const offered = useStore(canSignIn);
  const next = nextParam();
  useEffect(() => {
    if (account) navigate(next, { replace: true });
  }, [account, next]);
  if (!offered) {
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
      <SignInOptions next={next} />
    </AuthShell>
  );
}

function SignUp() {
  const emailLinks = useStore((s) => s.providers.emailLinks);
  const next = nextParam();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!emailLinks) {
    return (
      <AuthShell title="Create an account" intro="Signing up with an email address isn’t available on this server.">
        <SignInOptions next={next} />
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
      </form>
    </AuthShell>
  );
}

function Forgot() {
  const emailLinks = useStore((s) => s.providers.emailLinks);
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <AuthShell title="Choose a password" intro="For your Workchop account.">
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
      <AuthShell title="Confirm your email" intro="This link is for another Workchop account. Sign in with the account that asked for the change.">
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
            Confirm <strong>{email}</strong> for your Workchop account.
          </>
        ) : (
          'Confirm your new email address for your Workchop account.'
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
  return <SignInPage />;
}
