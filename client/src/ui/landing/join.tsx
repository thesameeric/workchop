import { useState } from 'react';
import { navigate, officeIdFromPath } from '../../lib/router';
import { recentOffices, setGuestToken } from '../../lib/storage';
import { Link } from '../Account';

/** An office id from a pasted link (with its guest token, if any) or code. */
export function parseOfficeInput(raw: string): { id: string; guest: string | null } | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const id = officeIdFromPath(url.pathname);
    return id ? { id, guest: new URLSearchParams(url.hash.slice(1)).get('guest') } : null;
  } catch {
    const id = /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : officeIdFromPath(text);
    return id ? { id, guest: null } : null;
  }
}

/** A pasted link or code, and going there. */
function useJoin() {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = (value: string) => {
    setText(value);
    setError(null);
  };
  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const link = parseOfficeInput(text);
    if (!link) return setError('Paste a workspace link or code.');
    if (link.guest) setGuestToken(link.id, link.guest);
    navigate(`/o/${link.id}`);
  };
  return { text, change, error, join };
}

/** Paste a workspace's link (or a guest link) to go there: a card on the signed-in home page. */
export function JoinWithLink() {
  const { text, change, error, join } = useJoin();
  return (
    <form className="card" onSubmit={join}>
      <h2>Join with a link</h2>
      <label className="field">
        <span>Workspace link or code</span>
        <input value={text} onChange={(e) => change(e.target.value)} placeholder="https://…/o/abc123" />
      </label>
      <button className="btn wide">Join</button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** Focuses the hero's link field ("Join with a link" on a server without sign-in). */
export function focusJoin(e?: React.MouseEvent): void {
  const input = document.getElementById('join-link');
  if (!input) return;
  e?.preventDefault();
  input.scrollIntoView({ block: 'center' });
  input.focus({ preventScroll: true });
}

/** The same, in one row under the hero's buttons. */
export function JoinInline() {
  const { text, change, error, join } = useJoin();
  return (
    <form id="join" className="lp-join" aria-labelledby="join-label" onSubmit={join} noValidate>
      <label id="join-label" className="lp-join-label" htmlFor="join-link">
        Have a link?
      </label>
      <div className="lp-join-row">
        <input
          id="join-link"
          className="lp-input"
          value={text}
          onChange={(e) => change(e.target.value)}
          placeholder="Paste a link or code"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'join-error' : undefined}
        />
        <button className="lp-btn secondary">Join</button>
      </div>
      {error && (
        <p id="join-error" className="lp-join-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** Offices visited on this browser, to go back to. */
export function RecentOffices() {
  const [offices] = useState(() => recentOffices().slice(0, 4));
  if (!offices.length) return null;
  return (
    <div className="lp-recent">
      <span id="recent-label" className="lp-recent-label">
        Recently visited
      </span>
      <ul aria-labelledby="recent-label">
        {offices.map((r) => (
          <li key={r.id}>
            <Link to={`/o/${r.id}`} className="lp-recent-chip">
              {r.name || 'Untitled office'}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
