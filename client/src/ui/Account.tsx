import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AccountUser } from '../../../shared/account';
import { signInUrl, signInWithDev, signOut } from '../lib/account';
import { colorFor, initials } from '../lib/color';
import { useStore } from '../state/store';
import { ChevronDownIcon, SignInIcon, SignOutIcon, UserEditIcon } from './icons';

/**
 * Open/close state for a menu that closes on Escape or a click outside `ref` (the button and menu)
 * and `menuRef` (the menu, when it is rendered elsewhere, e.g. in a portal). `close(true)` also
 * puts the focus back on `buttonRef`, as Escape does.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, close, ref, menuRef, buttonRef };
}

/**
 * Keyboard use of a menu: arrows, Home and End move between its items, Escape and Tab close it
 * (Escape back to its button). Keys used here don't reach the office's shortcuts or movement.
 */
function menuKeys(e: KeyboardEvent<HTMLElement>, close: (refocus?: boolean) => void): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
  else if (e.key === 'ArrowUp') next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close(true);
    return;
  } else if (e.key === 'Tab') {
    // Back to the button: Tab then goes on from there, Shift+Tab stays on it.
    if (e.shiftKey) e.preventDefault();
    close(true);
    return;
  } else return;
  e.preventDefault();
  e.stopPropagation();
  items[next]?.focus();
}

/** The account's picture (Google's), or its initials. */
export function UserAvatar({ user, size = 32 }: { user: AccountUser; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (user.avatarUrl && !broken) {
    return <img className="user-avatar" src={user.avatarUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <span className="user-avatar" style={{ width: size, height: size, background: colorFor(user.name), fontSize: Math.round(size * 0.4) }}>
      {initials(user.name)}
    </span>
  );
}

/**
 * Who you're signed in as, and "Sign out" (plus "Edit character" inside an office). It takes the
 * focus when it opens, so it can be used from the keyboard.
 */
export function AccountMenu({ user, onClose, onEditCharacter }: { user: AccountUser; onClose: (refocus?: boolean) => void; onEditCharacter?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), []);
  return (
    <div className="account-menu" role="menu" aria-label="Account" ref={ref} onKeyDown={(e) => menuKeys(e, onClose)}>
      <div className="account-head">
        <UserAvatar user={user} size={40} />
        <div className="account-who">
          <strong title={user.name}>{user.name}</strong>
          {user.email && (
            <span className="muted small" title={user.email}>
              {user.email}
            </span>
          )}
        </div>
      </div>
      {onEditCharacter && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onEditCharacter();
          }}
        >
          <UserEditIcon size={18} />
          Edit character
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          void signOut();
        }}
      >
        <SignOutIcon size={18} />
        Sign out
      </button>
    </div>
  );
}

/** The signed-in person's button for page headers (nothing for guests). */
export function AccountButton() {
  const account = useStore((s) => s.account);
  const { open, setOpen, close, ref, buttonRef } = usePopover();
  if (!account) return null;
  return (
    <div className="account" ref={ref}>
      <button className="account-btn" ref={buttonRef} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="Your account">
        <UserAvatar user={account} size={30} />
        <span className="account-name">{account.name}</span>
        <ChevronDownIcon size={16} />
      </button>
      {open && <AccountMenu user={account} onClose={close} />}
    </div>
  );
}

function GoogleLogo() {
  // The standard multicolour "G" (Google Identity branding guidelines).
  return (
    <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

/** The sign-in methods the server offers: Google and Apple buttons, and the dev login when it's on. */
export function SignInOptions() {
  const providers = useStore((s) => s.providers);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oauth = providers.google || providers.apple;

  const devLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithDev(name.trim(), email.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="sign-in">
      {oauth && (
        <div className="provider-buttons">
          {providers.google && (
            <a className="provider-btn google" href={signInUrl('google')}>
              <GoogleLogo />
              <span>Continue with Google</span>
            </a>
          )}
          {providers.apple && (
            <a className="provider-btn apple" href={signInUrl('apple')}>
              <AppleLogo />
              <span>Continue with Apple</span>
            </a>
          )}
        </div>
      )}
      {oauth && providers.dev && (
        <div className="or" aria-hidden="true">
          <span>or</span>
        </div>
      )}
      {providers.dev && (
        <form className="dev-login" onSubmit={devLogin}>
          <div className="dev-fields">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" maxLength={32} autoComplete="name" />
            </label>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" maxLength={254} autoComplete="email" />
            </label>
          </div>
          <button className="btn wide" disabled={busy || (!name.trim() && !email.trim())}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="muted small">Developer sign-in: no password, for testing.</p>
          {error && <p className="form-error">{error}</p>}
        </form>
      )}
    </div>
  );
}

/** "Sign in" for guests in a page header, opening the sign-in options (nothing when sign-in is off). */
export function SignInButton() {
  const providers = useStore((s) => s.providers);
  const { open, setOpen, ref, buttonRef } = usePopover();
  if (!providers.google && !providers.apple && !providers.dev) return null;
  return (
    <div className="account" ref={ref}>
      <button className="btn small" ref={buttonRef} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <SignInIcon size={16} />
        Sign in
      </button>
      {open && (
        <div className="account-menu sign-in-menu">
          <p className="muted small">Keep your character on every device, and find your offices again.</p>
          <SignInOptions />
        </div>
      )}
    </div>
  );
}
