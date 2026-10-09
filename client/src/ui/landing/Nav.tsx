import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from '../Account';
import { Logo } from '../Brand';
import { CloseIcon, MenuIcon } from '../icons';
import { focusJoin } from './join';

/** The page's own sections, for the header and the footer. */
export function sectionLinks(pricing: boolean) {
  return [
    { href: '#features', label: 'Features' },
    { href: '#support', label: 'Customer support' },
    ...(pricing ? [{ href: '#pricing', label: 'Pricing' }] : []),
  ];
}

/** The logo, back to the top of the page. */
export function BrandLink() {
  const top = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
    scrollTo({ top: 0 });
  };
  return (
    <a href="/" className="brand lp-brand" onClick={top}>
      <Logo size={24} />
    </a>
  );
}

/** The sticky header: the logo, the sections, and signing in; on narrow screens the sections are in a menu. */
export function Nav({ signIn, pricing }: { signIn: boolean; pricing: boolean }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const links = sectionLinks(pricing);

  // A line under the header once the page has scrolled.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The menu closes on Escape (back to its button), a click outside it, and on wider screens.
  useEffect(() => {
    if (!open) return;
    const wide = matchMedia('(min-width: 840px)');
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!header.current?.contains(e.target as Node)) setOpen(false);
    };
    const onWide = () => wide.matches && setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    wide.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      wide.removeEventListener('change', onWide);
    };
  }, [open]);

  const close = () => setOpen(false);
  const cta = signIn ? (
    <Link to="/signup" className="lp-btn primary small">
      Get started
    </Link>
  ) : (
    <a href="#join" className="lp-btn primary small lp-header-join" onClick={focusJoin}>
      Join with a link
    </a>
  );

  return (
    <>
      <div ref={sentinel} className="lp-sentinel" aria-hidden="true" />
      <header ref={header} className={`lp-header${scrolled ? ' scrolled' : ''}${open ? ' open' : ''}`}>
        <div className="lp-wrap lp-header-bar">
          <BrandLink />
          <nav aria-label="Main" className="lp-nav">
            <ul>
              {links.map((l) => (
                <li key={l.href}>
                  <a href={l.href}>{l.label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="lp-header-actions">
            {signIn && (
              <Link to="/signin" className="lp-signin">
                Sign in
              </Link>
            )}
            {cta}
            <button ref={button} type="button" className="lp-menu-btn" aria-label="Menu" aria-expanded={open} aria-controls="lp-menu" onClick={() => setOpen((v) => !v)}>
              {open ? <CloseIcon size={22} /> : <MenuIcon size={22} />}
            </button>
          </div>
        </div>
        <nav id="lp-menu" aria-label="Menu" className="lp-menu" hidden={!open}>
          <ul className="lp-wrap">
            {links.map((l) => (
              <li key={l.href}>
                <a href={l.href} onClick={close}>
                  {l.label}
                </a>
              </li>
            ))}
            {signIn && (
              <li>
                <Link to="/signin">Sign in</Link>
              </li>
            )}
          </ul>
        </nav>
      </header>
    </>
  );
}
