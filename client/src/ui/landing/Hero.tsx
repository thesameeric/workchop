import { HeroStage } from '../../landing3d/HeroStage';
import { Link } from '../Account';
import { CheckIcon, GlobeIcon, PhoneIcon, SupportIcon, WalletIcon, type IconComponent } from '../icons';
import { focusJoin, JoinInline, RecentOffices } from './join';
import type { PlanPrices } from './prices';

/** The top of the page: what it is, getting started, joining with a link, and the live office. */
export function Hero({ signIn, prices }: { signIn: boolean; prices: PlanPrices | null }) {
  const facts: { Icon: IconComponent; text: string }[] = [
    { Icon: GlobeIcon, text: 'Runs in your browser' },
    { Icon: PhoneIcon, text: 'Works on phones' },
    { Icon: SupportIcon, text: 'Customers don’t need an account' },
    ...(prices ? [{ Icon: WalletIcon, text: 'Pay in naira' }] : []),
  ];
  return (
    <section className="lp-hero" aria-labelledby="hero-title">
      <div className="lp-wrap lp-hero-grid">
        <div className="lp-hero-copy">
          <h1 id="hero-title">An office your team can walk into.</h1>
          <p className="lp-lead">
            <span className="lp-wide">Homeoffice is a 3D office in your browser. Walk up to someone to talk, step into a room for privacy, and see who’s around.</span>
            <span className="lp-narrow">A 3D office in your browser. Walk up to someone to talk.</span>
          </p>
        </div>
        <div className="lp-hero-actions">
          <div className="lp-buttons">
            {signIn ? (
              <>
                <Link to="/signup" className="lp-btn primary">
                  Get started free
                </Link>
                <Link to="/signin" className="lp-btn secondary">
                  Sign in
                </Link>
              </>
            ) : (
              <a href="#join" className="lp-btn primary" onClick={focusJoin}>
                Join with a link
              </a>
            )}
          </div>
          <p className="lp-reassure">
            <CheckIcon size={18} />
            {prices ? `Free for up to ${prices.freeSeats} people. Nothing to install.` : 'Nothing to install. It runs in your browser.'}
          </p>
        </div>
        <div className="lp-hero-stage">
          <HeroStage />
        </div>
        <div className="lp-hero-join">
          <JoinInline />
          <RecentOffices />
        </div>
      </div>
      <div className="lp-wrap">
        <ul className="lp-facts">
          {facts.map(({ Icon, text }) => (
            <li key={text}>
              <span className="lp-fact-icon">
                <Icon size={18} />
              </span>
              {text}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
