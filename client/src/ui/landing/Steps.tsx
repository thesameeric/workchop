import { Link } from '../Account';
import { Eyebrow } from './Features';

const STEPS = [
  { title: 'Create an office.', text: 'Sign up and pick a template: a startup office, a blank floor or a support lobby.' },
  { title: 'Send the link.', text: 'Invite your team by email, or turn on a guest link so anyone with it can come in.' },
  { title: 'Walk in.', text: 'Pick your character, check your mic and say hi. There’s nothing to install.' },
];

/** Getting started, in three steps. */
export function Steps({ signIn }: { signIn: boolean }) {
  return (
    <section id="how" className="lp-section lp-how" aria-labelledby="how-title">
      <div className="lp-wrap">
        <div className="lp-section-head">
          <Eyebrow>How it works</Eyebrow>
          <h2 id="how-title">Up and running in three steps</h2>
        </div>
        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="lp-card" data-reveal="">
              <span className="lp-steps-num" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
        {signIn && (
          <div className="lp-center">
            <Link to="/signup" className="lp-btn primary">
              Get started free
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
