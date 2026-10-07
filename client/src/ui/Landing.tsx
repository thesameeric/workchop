import { useState } from 'react';
import { TEMPLATES, type TemplateId } from '../../../shared/templates';
import { createOffice } from '../lib/api';
import { navigate, officeIdFromPath } from '../lib/router';
import { recentOffices, setOwnerKey } from '../lib/storage';
import { HammerIcon, HeadphonesIcon, LockIcon, UserEditIcon } from './icons';

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

export function Landing() {
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
      </header>
      <main className="landing-main">
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
            {recent.length > 0 && (
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
