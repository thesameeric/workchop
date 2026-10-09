import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountUser, Space, SpaceBilling } from '../../../../shared/account';
import { formatMoney } from '../../../../shared/billing';
import { TEMPLATES, type TemplateId } from '../../../../shared/templates';
import type { MemberRole, OfficeKind } from '../../../../shared/workspace';
import { startCheckout } from '../../features/billing/api';
import { SeatPicker } from '../../features/billing/SeatPicker';
import { pricesOf, useBilling } from '../../features/billing/state';
import { errorText } from '../../lib/account';
import { claimOffices, createOffice, fetchSpaces } from '../../lib/api';
import { colorFor, initials } from '../../lib/color';
import { defaultPending, navigate, openDefault, withNext } from '../../lib/router';
import { forgetOwnerKeys, ownerKeys } from '../../lib/storage';
import { ago } from '../../lib/time';
import { finePointer } from '../../lib/touch';
import { toast, useStore } from '../../state/store';
import { AccountButton } from '../Account';
import { Logo } from '../Brand';
import { BuildingIcon, SupportIcon, type IconComponent } from '../icons';
import { JoinWithLink } from './join';

// Signed in, the home page is your workspaces and making a new one. A fresh load goes on to your
// default workspace (lib/router.ts).

const ROLE_LABELS: Record<MemberRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** A workspace's billing problem (shared/billing.ts), on its card. */
const BILLING_BADGES: Record<SpaceBilling, string> = { locked: 'Paused', 'past-due': 'Payment due', unpaid: 'Not paid' };

/** The kinds of workspace; one without templates yet shows as coming soon. */
const KINDS: { id: OfficeKind; label: string; description: string; Icon: IconComponent }[] = [
  { id: 'team', label: 'Team', description: 'An office for your team to work together.', Icon: BuildingIcon },
  { id: 'support', label: 'Customer support', description: 'Help customers face to face.', Icon: SupportIcon },
];

/** "Create workspace" links: #create, or #create-support for a help desk (from the landing page). */
const createHash = () => /^#create(-support)?$/.test(location.hash);

/** The signed-in home page's frame: the logo and your account. */
export function HomeFrame({ children }: { children: ReactNode }) {
  return (
    <div className="landing">
      <div className="landing-bg" aria-hidden="true" />
      <header className="landing-header">
        <div className="brand">
          <Logo />
        </div>
        <AccountButton />
      </header>
      <main className="landing-main">{children}</main>
    </div>
  );
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
          <span className={`badge${space.role === 'member' ? ' neutral' : ''}`}>{ROLE_LABELS[space.role]}</span>
          {space.kind === 'support' && <span className="badge neutral">Support</span>}
          {space.billing && <span className={`badge billing-badge ${space.billing}`}>{BILLING_BADGES[space.billing]}</span>}
        </span>
        <span className="space-meta">
          <span className={`presence${live ? ' live' : ''}`}>
            <i />
            {live ? `${space.online} online` : 'Nobody online'}
          </span>
          <span>{space.lastVisitAt ? `Visited ${ago(space.lastVisitAt)}` : 'Not visited yet'}</span>
        </span>
      </span>
    </button>
  );
}

/** Offices made on this browser before accounts (their owner keys are here), to add to yours. */
function ClaimOffices({ onClaimed }: { onClaimed: () => void }) {
  const [keys, setKeys] = useState(ownerKeys);
  const [busy, setBusy] = useState(false);
  if (!keys.length) return null;
  const claim = async () => {
    setBusy(true);
    try {
      const claimed = await claimOffices(keys);
      // The rest can't be (they have an owner, are gone, or the key is wrong): their keys are of no more use.
      forgetOwnerKeys(keys.map((k) => k.id));
      setKeys([]);
      const missed = keys.length - claimed.length;
      if (claimed.length) toast(claimed.length === 1 ? 'Added 1 office to your workspaces' : `Added ${claimed.length} offices to your workspaces`);
      if (missed) toast(missed === 1 ? '1 office couldn’t be added.' : `${missed} offices couldn’t be added.`, 'error');
      onClaimed();
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
    }
  };
  return (
    <div className="claim-card">
      <span className="spaces-empty-icon">
        <BuildingIcon size={22} />
      </span>
      <div>
        <strong>Add offices you created on this browser</strong>
        <p className="muted small">
          {keys.length === 1 ? 'You made an office here' : `You made ${keys.length} offices here`} before signing in. Add {keys.length === 1 ? 'it' : 'them'} to
          your account to own {keys.length === 1 ? 'it' : 'them'} on every device.
        </p>
      </div>
      <button className="btn small primary" disabled={busy} onClick={() => void claim()}>
        {busy ? 'Adding…' : keys.length === 1 ? 'Add it' : 'Add them'}
      </button>
    </div>
  );
}

/**
 * The workspaces a signed-in person belongs to, kept up to date. The first answer may take you on to
 * your default workspace instead (not when you came to create one).
 */
function useSpaces(accountId: string, attempt: number): { spaces: Space[] | null; failed: boolean } {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Only the first answer may take you on to your default workspace.
  const deciding = useRef(true);

  useEffect(() => {
    let alive = true;
    // The first time even in a background tab; refreshes only while the page is seen.
    const load = (initial = false) => {
      if (!initial && document.visibilityState !== 'visible') return;
      fetchSpaces()
        .then((list) => {
          if (!alive) return;
          const decide = deciding.current;
          deciding.current = false;
          if (decide && openDefault(createHash() ? undefined : list[0]?.id)) return;
          setSpaces(list);
          setFailed(false);
        })
        .catch(() => {
          if (!alive) return;
          if (deciding.current) openDefault(undefined);
          deciding.current = false;
          setFailed(true);
        });
    };
    load(true);
    // People come and go: refresh now and then, and when coming back to the page.
    const refresh = () => load();
    const timer = setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [accountId, attempt]);

  return { spaces, failed };
}

/** Signed in: your workspaces, and making or joining another. */
export function Home({ account }: { account: AccountUser }) {
  const [attempt, setAttempt] = useState(0);
  const { spaces, failed } = useSpaces(account.id, attempt);
  const retry = () => setAttempt((n) => n + 1);
  // On the way to your default workspace: nothing to show yet.
  if (spaces === null && !failed && defaultPending()) return <div aria-busy="true" />;
  return (
    <>
      <section className="spaces">
        <h1>Welcome, {account.name.split(' ')[0]}.</h1>
        <ClaimOffices onClaimed={retry} />
        <h2>Your workspaces</h2>
        {spaces === null && !failed && <p className="muted">Loading…</p>}
        {spaces === null && failed && (
          <p className="muted">
            Couldn’t load your workspaces.{' '}
            <button className="link-btn" onClick={retry}>
              Try again
            </button>
          </p>
        )}
        {spaces?.length === 0 && (
          <div className="spaces-empty">
            <span className="spaces-empty-icon">
              <BuildingIcon size={26} />
            </span>
            <strong>No workspaces yet</strong>
            <p className="muted small">Create one, or open an invitation or a link someone sent you.</p>
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
      <section className="landing-cards">
        <CreateWorkspace />
        <JoinWithLink />
      </section>
    </>
  );
}

/** The kind to start with: a help desk when asked for (#create-support), else a team office. */
function startKind(): OfficeKind {
  return location.hash === '#create-support' && TEMPLATES.some((t) => t.kind === 'support') ? 'support' : 'team';
}

/** A new workspace: its type, then a name and a template (and, for a paid help desk, its seats). */
function CreateWorkspace() {
  const [kind, setKind] = useState<OfficeKind>(startKind);
  const templates = TEMPLATES.filter((t) => t.kind === kind);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<TemplateId>(templates[0].id);
  const [seats, setSeats] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const prices = useBilling(pricesOf);
  const verified = useStore((s) => !!s.account?.emailVerified);
  // On a server that charges, a help desk is paid for before it opens: on to Paystack once made.
  const paid = !!prices && kind === 'support';

  // "Create workspace" from inside an office (or "Set up a help desk" on the landing page) brings you
  // here (ready to type, where that brings up no keyboard over it).
  useEffect(() => {
    if (!createHash()) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    if (finePointer()) nameRef.current?.focus();
    nameRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  const placeholder = kind === 'support' ? 'Help Desk' : 'Our Office';

  const pickKind = (next: OfficeKind) => {
    setKind(next);
    setTemplate(TEMPLATES.find((t) => t.kind === next)!.id);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let id: string;
    try {
      id = (await createOffice(name.trim() || placeholder, kind, template)).id;
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return;
    }
    if (!paid) return navigate(`/o/${id}`);
    try {
      location.assign((await startCheckout(id, seats)).url);
    } catch (err) {
      // It's made, unpaid: its owner can pay from Settings > Billing there.
      navigate(`/o/${id}?billing`);
      toast(errorText(err), 'error');
    }
  };

  return (
    <form className="card" onSubmit={create}>
      <h2>Create a workspace</h2>
      <div className="field">
        <span id="kind-label">Type</span>
        <div className="kinds" role="radiogroup" aria-labelledby="kind-label">
          {KINDS.map(({ id, label, description, Icon }) => {
            const ready = TEMPLATES.some((t) => t.kind === id);
            return (
              <button type="button" key={id} role="radio" aria-checked={kind === id} className={`template kind${kind === id ? ' active' : ''}`} disabled={!ready} onClick={() => pickKind(id)}>
                <Icon size={22} />
                <strong>
                  {label}
                  {!ready && <span className="badge neutral">Coming soon</span>}
                </strong>
                <span>{description}</span>
              </button>
            );
          })}
        </div>
        {prices && kind === 'team' && (
          <p className="muted small create-price">
            Free for up to {prices.freeSeats} people. More than that: {formatMoney(prices.prices.team)} a month for each person.
          </p>
        )}
      </div>
      <label className="field">
        <span>Name</span>
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={48} />
      </label>
      <div className="field">
        <span id="template-label">Template</span>
        <div className="templates" role="radiogroup" aria-labelledby="template-label">
          {templates.map((t) => (
            <button type="button" key={t.id} role="radio" aria-checked={template === t.id} className={`template${template === t.id ? ' active' : ''}`} onClick={() => setTemplate(t.id)}>
              <strong>{t.label}</strong>
              <span>{t.description}</span>
            </button>
          ))}
        </div>
      </div>
      {paid && (
        <div className="field">
          <span>Seats</span>
          <SeatPicker value={seats} min={1} onChange={setSeats} />
          <p className="muted small create-price">
            {formatMoney(Math.round(prices.prices.support / 12))} per seat a month, billed yearly: {formatMoney(prices.prices.support)} × {seats} ={' '}
            <strong>{formatMoney(prices.prices.support * seats)}</strong>
          </p>
          <p className="muted small create-price">A seat is for each of your staff, you included. Customers don’t need one.</p>
        </div>
      )}
      {paid && !verified && (
        <p className="muted small create-price">
          Confirm your email address in your{' '}
          <button type="button" className="link-btn" onClick={() => navigate(withNext('/profile', '/'))}>
            profile
          </button>{' '}
          to pay for a help desk.
        </p>
      )}
      <button className="btn primary wide" disabled={busy || (paid && !verified)}>
        {busy ? 'Creating…' : paid ? 'Continue to payment' : 'Create workspace'}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
