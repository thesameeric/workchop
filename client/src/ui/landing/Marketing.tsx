import { useEffect, useMemo, useRef } from 'react';
import { pricesOf, useBilling } from '../../features/billing/state';
import { useProvidersKnown } from '../../lib/account';
import { canSignIn, useStore } from '../../state/store';
import { Faq } from './Faq';
import { Features } from './Features';
import { FinalCta, Footer } from './Footer';
import { Hero } from './Hero';
import './landing.css';
import { Nav } from './Nav';
import { Pricing } from './Pricing';
import { planPrices } from './prices';
import { Steps } from './Steps';
import { Support } from './Support';
import { useReveal } from './useReveal';

/**
 * The landing page, for guests. Prices show only where the server charges (GET /api/billing/status);
 * signing up only where it offers a way to sign in (assumed until it says, as most do).
 */
export function Marketing() {
  const known = useProvidersKnown();
  const signIn = useStore((s) => !s.accountReady || !known || canSignIn(s));
  const billing = useBilling(pricesOf);
  const prices = useMemo(() => (billing ? planPrices(billing) : null), [billing]);
  const root = useRef<HTMLDivElement>(null);
  useReveal(root, !!prices);

  // A link to a section (/#faq) opens there: the page wasn't drawn yet when the browser looked for
  // it. The prices come in later and push the sections below them down (or bring #pricing), so it's
  // looked for again then, unless you've started scrolling or clicking yourself.
  const priced = !!prices;
  const yours = useRef(false);
  useEffect(() => {
    const mine = () => void (yours.current = true);
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    events.forEach((e) => window.addEventListener(e, mine, { once: true, passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, mine));
  }, []);
  useEffect(() => {
    const id = location.hash.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (yours.current || !target || !root.current?.contains(target)) return;
    target.scrollIntoView({ behavior: 'instant' });
  }, [priced]);

  return (
    <div className="lp" ref={root}>
      <a className="lp-skip" href="#main">
        Skip to content
      </a>
      <Nav signIn={signIn} pricing={!!prices} />
      <main id="main" tabIndex={-1}>
        <Hero signIn={signIn} prices={prices} />
        <Features />
        <Support signIn={signIn} prices={prices} />
        <Steps signIn={signIn} />
        {prices && <Pricing prices={prices} signIn={signIn} />}
        <Faq prices={prices} signIn={signIn} />
        <FinalCta signIn={signIn} />
      </main>
      <Footer signIn={signIn} pricing={!!prices} />
    </div>
  );
}
