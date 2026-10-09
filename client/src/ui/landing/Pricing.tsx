import { Link } from '../Account';
import { CheckIcon } from '../icons';
import { Eyebrow } from './Features';
import type { PlanPrices } from './prices';
import { HELP_DESK_SIGNUP } from './Support';

/** The three plans, from the server's prices (only shown where it charges). */
export function Pricing({ prices: p, signIn }: { prices: PlanPrices; signIn: boolean }) {
  const plans = [
    {
      id: 'free',
      name: 'Free',
      price: '₦0',
      unit: null,
      line: `For teams of up to ${p.freeSeats} people.`,
      points: ['Everything in the office: voice, video, rooms, chat and build mode', `Up to ${p.guestCaps.free} guests at a time with a guest link`],
      cta: { to: '/signup', label: 'Get started free' },
    },
    {
      id: 'team',
      name: 'Team',
      price: p.team,
      unit: 'per person a month',
      line: `For teams of more than ${p.freeSeats}. Every member has a seat.`,
      points: ['Everything in Free', `Up to ${p.guestCaps.team} guests at a time`, 'Add seats any time. Fewer seats start at renewal'],
      cta: { to: '/signup', label: 'Get started' },
    },
    {
      id: 'support',
      name: 'Customer support',
      price: p.supportMonthly,
      unit: 'per staff seat a month, billed yearly',
      line: 'A lobby and help desks for talking to customers.',
      points: ['Customers come in with a link: no account, no seat', 'A queue, help desks and a ticket for every conversation', `${p.supportYearly} a year per seat`],
      cta: { to: HELP_DESK_SIGNUP, label: 'Set up a help desk' },
    },
  ];
  return (
    <section id="pricing" className="lp-section lp-pricing" aria-labelledby="pricing-title">
      <div className="lp-wrap">
        <div className="lp-section-head">
          <Eyebrow>Pricing</Eyebrow>
          <h2 id="pricing-title">Simple prices, in naira</h2>
          <p className="lp-lead">Start free. Pay by card when your team grows.</p>
        </div>
        <ul className="lp-plans">
          {plans.map((plan) => (
            <li key={plan.id} className={`lp-card lp-plan ${plan.id}`} data-reveal="">
              <h3>{plan.name}</h3>
              <p className="lp-price">
                <strong>{plan.price}</strong>
                {plan.unit && <span> {plan.unit}</span>}
              </p>
              <p className="lp-plan-line">{plan.line}</p>
              <ul className="lp-plan-points">
                {plan.points.map((point) => (
                  <li key={point}>
                    <CheckIcon size={18} />
                    {point}
                  </li>
                ))}
              </ul>
              {signIn && (
                <Link to={plan.cta.to} className={`lp-btn ${plan.id === 'team' ? 'primary' : 'secondary'}`}>
                  {plan.cta.label}
                </Link>
              )}
            </li>
          ))}
        </ul>
        <p className="lp-small lp-center lp-footnote">Prices in Nigerian naira. Payment by card through Paystack.</p>
      </div>
    </section>
  );
}
