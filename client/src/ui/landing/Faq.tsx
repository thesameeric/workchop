import { useStore } from '../../state/store';
import { ChevronDownIcon } from '../icons';
import type { PlanPrices } from './prices';

/** "a, b or c". */
function either(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Common questions; the prices only where the server charges, signing in only where it's offered. */
export function Faq({ prices, signIn }: { prices: PlanPrices | null; signIn: boolean }) {
  const providers = useStore((s) => s.providers);
  const methods = [
    ...(providers.password || providers.emailLinks ? ['your email address'] : []),
    ...(providers.github ? ['GitHub'] : []),
    ...(providers.google ? ['Google'] : []),
    ...(providers.apple ? ['Apple'] : []),
  ];
  const questions: { q: string; a: string }[] = [
    {
      q: 'Do I need to install anything?',
      a: 'No. Homeoffice runs in your browser on a computer or a phone. If you’d like your name tag to show the app you’re in, there’s an optional desktop helper (it needs Node.js).',
    },
    {
      q: 'Does it work on phones?',
      a: 'Yes, in your phone’s browser. Tap the floor to walk and tap a chair to sit. On a computer you can also use the arrow keys or WASD.',
    },
    {
      q: 'Who can hear me?',
      a: 'People near you in the office. Voices get quieter as you walk away and fade out at about 5 metres. In a meeting room, only the people inside hear each other. You check your mic and camera before you first go in, and you can mute at any time.',
    },
    { q: 'Are calls recorded?', a: 'No. Calls aren’t recorded or stored. Chat messages are kept so you can scroll back.' },
    {
      q: 'Do my customers need an account?',
      a: 'No. They open your help desk’s link, tell you their name and what they need, and wait in your lobby until someone calls them to a desk.',
    },
    {
      q: 'Can people outside my team come in?',
      a: prices
        ? `Yes. Turn on a guest link and anyone who has it can come in without an account: up to ${prices.guestCaps.free} guests at a time on Free, and ${prices.guestCaps.team} on Team.`
        : 'Yes. Turn on a guest link and anyone who has it can come in without an account.',
    },
    ...(prices
      ? [
          {
            q: 'How does paying work?',
            a: `It’s free for up to ${prices.freeSeats} people. After that, Team is ${prices.team} per person a month, and a help desk is ${prices.supportMonthly} per staff seat a month, billed yearly. You pay by card through Paystack, in naira, and the workspace owner manages seats in Settings.`,
          },
        ]
      : []),
    ...(signIn && methods.length
      ? [{ q: 'How do I sign in?', a: `With ${either(methods)}.${providers.emailLinks ? ' To sign up with email, we send you a link to finish.' : ''}` }]
      : []),
  ];
  return (
    <section id="faq" className="lp-section lp-faq" aria-labelledby="faq-title">
      <div className="lp-wrap lp-faq-inner">
        <h2 id="faq-title">Questions</h2>
        <div className="lp-faq-list">
          {questions.map(({ q, a }) => (
            <details key={q}>
              <summary>
                {q}
                <ChevronDownIcon size={20} />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
