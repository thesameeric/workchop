import { useEffect, useState, type FormEvent } from 'react';
import { sanitizeUserName, type AccountUser } from '../../../shared/account';
import { errorText, saveAccountCharacter } from '../lib/account';
import { navigate, nextParam } from '../lib/router';
import { getState, useStore } from '../state/store';
import { AuthShell } from './AuthPage';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';

// Once, after the first sign-in with an account that has no character yet (Google, Apple, GitHub or
// the dev login): choose a name and a look, then go on to where you were going (?next=).

function WelcomeForm({ account, next }: { account: AccountUser; next: string }) {
  // The account's name, and this browser's guest character to start from.
  const [name, setName] = useState(() => getState().me.name);
  const [avatar, setAvatar] = useState(() => account.profile.avatar ?? getState().me.avatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = account.name.split(' ')[0];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = sanitizeUserName(name);
    if (!clean) return setError('Enter your name.');
    setBusy(true);
    setError(null);
    try {
      await saveAccountCharacter(clean, avatar);
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell title={first ? `Welcome, ${first}!` : 'Welcome!'} intro="Choose your name and how you look in the office. You can change them later in your profile." wide>
      <form onSubmit={submit} noValidate>
        <div className="character-layout">
          <AvatarPreview avatar={avatar} />
          <AvatarEditor name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
        </div>
        <div className="auth-actions">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary big" disabled={busy}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

export function Welcome() {
  const ready = useStore((s) => s.accountReady);
  const account = useStore((s) => s.account);
  const next = nextParam();

  // Nobody signed in (any more): straight on.
  useEffect(() => {
    if (ready && !account) navigate(next, { replace: true });
  }, [ready, account, next]);

  if (!account) return <AuthShell intro="Loading…" />;
  return <WelcomeForm key={account.id} account={account} next={next} />;
}
