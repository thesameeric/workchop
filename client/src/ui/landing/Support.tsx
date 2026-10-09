import { withNext } from '../../lib/router';
import { Link } from '../Account';
import { LinkIcon, SupportIcon, TicketIcon, WaitIcon, WalkIcon, type IconComponent } from '../icons';
import { Eyebrow } from './Features';
import type { PlanPrices } from './prices';

/** Signing up, then on to making a help desk. */
export const HELP_DESK_SIGNUP = withNext('/signup', '/#create-support');

const STEPS: { Icon: IconComponent; title: string; text: string }[] = [
  { Icon: LinkIcon, title: 'They open your link.', text: 'No account and no download. They tell you their name and what they need.' },
  { Icon: WaitIcon, title: 'They wait in your lobby.', text: 'Fish tanks, FAQ boards and a music corner, with their place in the queue on screen.' },
  { Icon: WalkIcon, title: 'You call them to a desk.', text: 'One at a time, in the order they came in.' },
  { Icon: TicketIcon, title: 'You talk it through.', text: 'Text, voice or video, just the two of you. Each conversation is kept as a ticket.' },
];

/** Help desks: customers come in with a link and talk to you face to face. */
export function Support({ signIn, prices }: { signIn: boolean; prices: PlanPrices | null }) {
  return (
    <section id="support" className="lp-section lp-support" aria-labelledby="support-title">
      <div className="lp-wrap">
        <div className="lp-support-band">
          <div className="lp-support-copy">
            <Eyebrow Icon={SupportIcon}>For your customers</Eyebrow>
            <h2 id="support-title">Customer support, face to face</h2>
            <p className="lp-lead">Give customers a link to your lobby. They come in without an account, wait their turn, and get called to a desk where you talk by text, voice or video.</p>
          </div>
          <figure className="lp-visual lp-shot lp-support-shot" data-reveal="">
            <div className="lp-shot-frame">
              <img
                src="/landing/shot-support.webp"
                width={1200}
                height={900}
                loading="lazy"
                decoding="async"
                alt="A help desk in a 3D office: Samuel serves a customer, Sanni, face to face across the desk, with a fish tank in front and a Help desk sign behind them."
              />
            </div>
            <span className="lp-shot-chip start">
              <TicketIcon size={16} />
              Ticket #14
            </span>
            <span className="lp-shot-chip end">Now serving 14</span>
          </figure>
          <ol className="lp-support-steps">
            {STEPS.map(({ Icon, title, text }, i) => (
              <li key={title}>
                <span className="lp-step-num" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <h3>
                    <Icon size={18} />
                    {title}
                  </h3>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ol>
          {(signIn || prices) && (
            <div className="lp-support-cta">
              {signIn && (
                <Link to={HELP_DESK_SIGNUP} className="lp-btn support">
                  Set up a help desk
                </Link>
              )}
              {prices && <p className="lp-small">{prices.supportMonthly} per staff seat a month, billed yearly. Customers don’t need a seat.</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
