import { useEffect, useState } from 'react';
import type { AccountUser, Space } from '../../../shared/account';
import { TEMPLATES, type TemplateId } from '../../../shared/templates';
import { createOffice, fetchSpaces } from '../lib/api';
import { colorFor, initials } from '../lib/color';
import { navigate, officeIdFromPath } from '../lib/router';
import { recentOffices, setOwnerKey } from '../lib/storage';
import { ago } from '../lib/time';
import { useStore } from '../state/store';
import { AccountButton, SignInOptions } from './Account';
import { BuildingIcon, HammerIcon, HeadphonesIcon, LockIcon, UserEditIcon } from './icons';

function parseOfficeInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return officeIdFromPath(url.pathname);
  } catch {
    return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : officeIdFromPath(text);
  }
}

function SpaceCard({ space }: { space: Space }) {
  const live = space.online > 0;
  const name = space.name || 'Untitled office';
  return (
    <button className="space-card" onClick={() => navigate(`/o/${space.id}`)}>
      <span className="space-icon" style={{ background: colorFor(name) }} aria-hidden="true">
        {initials(name)}
      </span>
      <span className="space-info">
        <span className="space-title">
          <strong>{name}</strong>
          <span className={`badge${space.role === 'owner' ? '' : ' neutral'}`}>{space.role}</span>
        </span>
        <span className="space-meta">
          <span className={`presence${live ? ' live' : ''}`}>
            <i />
            {live ? `${space.online} online` : 'Nobody online'}
          </span>
          <span>Visited {ago(space.lastVisitAt)}</span>
        </span>
      </span>
    </button>
  );
}

/** The offices a signed-in person belongs to, with who's in them right now. */
function YourSpaces({ account }: { account: AccountUser }) {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      fetchSpaces()
        .then((list) => {
          if (!alive) return;
          setSpaces(list);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    };
    load();
    // People come and go: refresh now and then, and when coming back to the page.
    const timer = setInterval(load, 30_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [account.id, attempt]);

  return (
    <section className="spaces">
      <h1>Welcome, {account.name.split(' ')[0]}.</h1>
      <h2>Your spaces</h2>
      {spaces === null && !failed && <p className="muted">Loading…</p>}
      {spaces === null && failed && (
        <p className="muted">
          Couldn’t load your spaces.{' '}
          <button className="link-btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      {spaces?.length === 0 && (
        <div className="spaces-empty">
          <span className="spaces-empty-icon">
            <BuildingIcon size={26} />
          </span>
          <strong>No spaces yet</strong>
          <p className="muted small">Create an office or open an invite link. The offices you visit show up here.</p>
        </div>
      )}
      {!!spaces?.length && (
        <div className="spaces-grid">
          {spaces.map((s) => (
            <SpaceCard key={s.id} space={s} />
          ))}
        </div>
      )}
    </section>
  );
}

function Intro() {
  const providers = useStore((s) => s.providers);
  return (
    <div className="intro">
      <section className="hero">
        <h1>Your team’s office, in 3D.</h1>
        <p>
          Walk up to someone to start talking. Proximity voice and video, private meeting rooms, screen sharing,
          your own character, and an office you can rebuild together.
        </p>
        <ul className="features">
          <li>
            <HeadphonesIcon /> Spatial audio & video that fades with distance
          </li>
          <li>
            <LockIcon /> Private areas for meetings
          </li>
          <li>
            <UserEditIcon /> Customisable characters
          </li>
          <li>
            <HammerIcon /> Build mode to design your space
          </li>
        </ul>
      </section>
      {(providers.google || providers.apple || providers.dev) && (
        <section className="card sign-in-card">
          <h2>Sign in</h2>
          <p className="muted small">Keep your character on every device and find your offices again. Or just create or join one as a guest.</p>
          <SignInOptions />
        </section>
      )}
    </div>
  );
}

export function Landing() {
  const ready = useStore((s) => s.accountReady);
  const account = useStore((s) => s.account);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<TemplateId>('startup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinText, setJoinText] = useState('');
  const recent = recentOffices();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id, ownerKey } = await createOffice(name.trim() || 'Our Office', template);
      setOwnerKey(id, ownerKey);
      navigate(`/o/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseOfficeInput(joinText);
    if (id) navigate(`/o/${id}`);
    else setError('Paste an office link or code.');
  };

  return (
    <div className="landing">
      <div className="landing-bg" aria-hidden="true" />
      <header className="landing-header">
        <div className="brand">
          <span className="brand-mark">◆</span> Workchop
        </div>
        <AccountButton />
      </header>
      <main className="landing-main">
        {/* Until we know who you are, neither the guest intro nor your spaces (one would flash). */}
        {!ready ? <div aria-busy="true" /> : account ? <YourSpaces account={account} /> : <Intro />}
        <section className="landing-cards">
          <form className="card" onSubmit={create}>
            <h2>Create an office</h2>
            <label className="field">
              <span>Office name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Our Office" maxLength={48} />
            </label>
            <div className="templates">
              {TEMPLATES.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`template${template === t.id ? ' active' : ''}`}
                  onClick={() => setTemplate(t.id)}
                >
                  <strong>{t.label}</strong>
                  <span>{t.description}</span>
                </button>
              ))}
            </div>
            <button className="btn primary wide" disabled={busy}>
              {busy ? 'Creating…' : 'Create office'}
            </button>
          </form>
          <form className="card" onSubmit={join}>
            <h2>Join an office</h2>
            <label className="field">
              <span>Invite link or code</span>
              <input value={joinText} onChange={(e) => setJoinText(e.target.value)} placeholder="https://…/o/abc123" />
            </label>
            <button className="btn wide">Join</button>
            {ready && !account && recent.length > 0 && (
              <div className="recent">
                <span className="muted">Recent</span>
                {recent.map((r) => (
                  <button type="button" key={r.id} className="recent-item" onClick={() => navigate(`/o/${r.id}`)}>
                    <span>{r.name}</span>
                    <span className="muted">/o/{r.id}</span>
                  </button>
                ))}
              </div>
            )}
          </form>
          {error && <div className="form-error">{error}</div>}
        </section>
      </main>
    </div>
  );
}
