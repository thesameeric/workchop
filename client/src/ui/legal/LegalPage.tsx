import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { pricesOf, useBilling } from '../../features/billing/state';
import { useProvidersKnown } from '../../lib/account';
import { canSignIn, useStore } from '../../state/store';
import { Link } from '../Account';
import { Logo } from '../Brand';
import { ChevronDownIcon, type IconComponent } from '../icons';
import { Eyebrow } from '../landing/Features';
import { Footer } from '../landing/Footer';
import { LEGAL_LINKED } from '.';
import '../landing/landing.css';
import './legal.css';

/** One part of a legal page: an h2 and what's under it. */
export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** When the pages last changed (both share it). */
const UPDATED = { label: '9 October 2026', iso: '2026-10-09' };
const CONTACT = 'hello@homeoffice.town';

/** The contact address as a link. */
export function Mail() {
  return <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;
}

/** How far down the window a section's heading counts as reached (a jump to it lands at 96px). */
const READ_LINE = 120;

/** The section being read: the last whose heading has reached the top of the window (the last of all at the bottom of the page). */
function useCurrent(ids: string[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      const reached = ids.filter((id) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= READ_LINE);
      setCurrent(atEnd ? ids[ids.length - 1] : (reached[reached.length - 1] ?? null));
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ids]);
  return current;
}

function TocList({ sections, current, onPick }: { sections: LegalSection[]; current?: string | null; onPick?: (id: string) => void }) {
  return (
    <ol>
      {sections.map((s) => (
        <li key={s.id}>
          <a href={`#${s.id}`} aria-current={s.id === current ? 'true' : undefined} onClick={onPick && (() => onPick(s.id))}>
            {s.title}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The logo home, and signing in (or back to your workspaces). */
function LegalHeader({ signIn, signedIn }: { signIn: boolean; signedIn: boolean }) {
  return (
    <header className="lp-header scrolled">
      <div className="lp-wrap lp-header-bar">
        <Link to="/" className="brand lp-brand">
          <Logo size={24} />
        </Link>
        <div className="lp-header-actions">
          {signedIn ? (
            <Link to="/" className="lp-btn secondary small">
              Your workspaces
            </Link>
          ) : (
            signIn && (
              <>
                <Link to="/signin" className="lp-signin">
                  Sign in
                </Link>
                <Link to="/signup" className="lp-btn primary small">
                  Get started
                </Link>
              </>
            )
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * A legal page in the landing page's look: the title and date, a table of contents (beside the text on
 * wide screens, folded above it on narrow ones) and the sections.
 */
export function LegalPage({ title, Icon, intro, sections }: { title: string; Icon: IconComponent; intro: ReactNode; sections: LegalSection[] }) {
  const signedIn = useStore((s) => !!s.account);
  // Offered until the server has said otherwise.
  const known = useProvidersKnown();
  const signIn = useStore((s) => !s.account && (!s.accountReady || !known || canSignIn(s)));
  const pricing = useBilling((s) => !!pricesOf(s));
  const ids = useMemo(() => sections.map((s) => s.id), [sections]);
  const current = useCurrent(ids);
  const folded = useRef<HTMLDetailsElement>(null);

  // The page opens at its top, or at the section in the address (/privacy#cookies), which wasn't drawn
  // yet when the browser looked for it. At once: the landing page's smooth scrolling, still on from the
  // page before, would stop partway as this one replaces it.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView({ behavior: 'instant' });
    else scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  // Kept out of search results while nothing links here yet.
  useEffect(() => {
    if (LEGAL_LINKED) return;
    const robots = Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex' });
    document.head.append(robots);
    return () => robots.remove();
  }, []);

  // Picking from the folded list closes it, and the focus it held goes on to the section's heading
  // (once the browser has jumped there, which would leave the focus nowhere).
  const pick = (id: string) => {
    folded.current?.removeAttribute('open');
    requestAnimationFrame(() => document.getElementById(`${id}-title`)?.focus({ preventScroll: true }));
  };

  return (
    <div className="lp legal">
      <a className="lp-skip" href="#main">
        Skip to content
      </a>
      <LegalHeader signIn={signIn} signedIn={signedIn} />
      <main id="main" tabIndex={-1} className="lp-wrap legal-grid">
        <header className="legal-head">
          <Eyebrow Icon={Icon}>Legal</Eyebrow>
          <h1>{title}</h1>
          <p className="legal-updated">
            Last updated <time dateTime={UPDATED.iso}>{UPDATED.label}</time>
          </p>
          <div className="legal-intro">{intro}</div>
        </header>
        <nav className="legal-toc" aria-label="On this page">
          <p className="legal-toc-label">On this page</p>
          <TocList sections={sections} current={current} />
        </nav>
        <details ref={folded} className="legal-toc-folded">
          <summary>
            On this page
            <ChevronDownIcon size={20} />
          </summary>
          <nav aria-label="On this page">
            <TocList sections={sections} onPick={pick} />
          </nav>
        </details>
        <article className="legal-text">
          {sections.map((s) => (
            <section key={s.id} id={s.id}>
              <h2 id={`${s.id}-title`} tabIndex={-1}>{s.title}</h2>
              {s.body}
            </section>
          ))}
        </article>
      </main>
      <Footer signIn={signIn} pricing={pricing} away />
    </div>
  );
}
