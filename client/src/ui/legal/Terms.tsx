import { DEFAULT_PRICES, FREE_SEATS, formatMoney, GRACE_DAYS, LOCKED_STAFF_CAP, MIN_CHARGE, RETRY_DAYS } from '../../../../shared/billing';
import { pricesOf, useBilling } from '../../features/billing/state';
import { Link } from '../Account';
import { FileTextIcon } from '../icons';
import { LegalPage, Mail, type LegalSection } from './LegalPage';
import { LEGAL_ENTITY, PRIVACY_PATH } from '.';

// The agreement for using Homeoffice. Plans and billing follow the code (shared/billing.ts and the
// README's "Billing"): change this page, and its date in LegalPage.tsx, along with them.

const retries = `${RETRY_DAYS.slice(0, -1).join(', ')} and ${RETRY_DAYS[RETRY_DAYS.length - 1]}`;

/** The plans at the prices this server charges (the defaults until it has said). */
function Plans() {
  const prices = useBilling((s) => pricesOf(s)?.prices ?? DEFAULT_PRICES);
  return (
    <ul>
      <li>
        <strong>Free:</strong> team workspaces of up to {FREE_SEATS} people.
      </li>
      <li>
        <strong>Team:</strong> {formatMoney(prices.team)} per seat a month.
      </li>
      <li>
        <strong>Customer support:</strong> {formatMoney(Math.round(prices.support / 12))} per seat a month, billed yearly ({formatMoney(prices.support)}{' '}
        per seat a year). Help desks have no free plan.
      </li>
    </ul>
  );
}

const sections: LegalSection[] = [
  {
    id: 'service',
    title: 'Homeoffice',
    body: (
      <p>
        Homeoffice is a 3D office in your browser. Teams walk around it, talk by voice and video when they’re near each other, chat, share files and build
        the office together. Businesses can also use it as a help desk, where customers come in with a link. Some parts are optional, like GitHub
        notifications, Spotify listen-along and the desktop helper.
      </p>
    ),
  },
  {
    id: 'account',
    title: 'Your account',
    body: (
      <ul>
        <li>You need an account to create a workspace. Guests and customers can come in with a link, without one.</li>
        <li>You must be at least 18 to use Homeoffice.</li>
        <li>Use your own email address, and keep your password and other ways to sign in safe. You’re responsible for what happens in your account.</li>
        <li>
          If you think someone else is using your account, change your password, sign out your other devices in your profile, and email us at <Mail />.
        </li>
        <li>If you use Homeoffice for an organisation, you confirm that you may agree to these terms for it.</li>
      </ul>
    ),
  },
  {
    id: 'workspaces',
    title: 'Workspaces and roles',
    body: (
      <>
        <p>
          Each workspace has one owner, and can have admins and members. The owner controls the workspace and its data: who can come in, who can build,
          the guest link, the plan and its seats. The owner can hand the workspace to another member. Admins can add and remove members and manage the
          guest link.
        </p>
        <p>
          A guest link lets anyone who has it come in without an account, so share it with care. Turning it off, or making a new one, stops the old link
          working.
        </p>
        <p>
          <strong>Help desks.</strong> The owner of a customer support workspace is responsible for its customers’ information and for how its staff use
          it. If you run one, tell your customers how you use their information, for example in your own privacy notice, and ask only for what you need.
          We store and handle your customers’ information for you, as described in our <Link to={PRIVACY_PATH}>Privacy Policy</Link>.
        </p>
      </>
    ),
  },
  {
    id: 'acceptable-use',
    title: 'Using Homeoffice fairly',
    body: (
      <>
        <p>Don’t use Homeoffice to:</p>
        <ul>
          <li>break the law, or help anyone else break it;</li>
          <li>harass, threaten or bully anyone, or treat people unfairly because of who they are;</li>
          <li>share anything illegal or harmful, or anything you don’t have the right to share, including music you play on a jukebox;</li>
          <li>record people or share their information without their permission;</li>
          <li>send spam, malware or scams, or pretend to be someone else;</li>
          <li>get into accounts or workspaces that aren’t yours, or get around limits, payments or security;</li>
          <li>overload, attack or scrape the service.</li>
        </ul>
        <p>We may remove content or limit accounts that break these rules.</p>
      </>
    ),
  },
  {
    id: 'content',
    title: 'Your content',
    body: (
      <>
        <p>
          What you put into Homeoffice stays yours: messages, files, office layouts, notes and everything else. You let us store, copy, send and show it,
          only to run Homeoffice for you and the people you share it with. That ends when your content is deleted, though people you shared it with may
          have kept copies, like a file they downloaded.
        </p>
        <p>Only share what you have the right to share. If you send us ideas or feedback, we may use them freely.</p>
      </>
    ),
  },
  {
    id: 'billing',
    title: 'Plans and billing',
    body: (
      <>
        <Plans />
        <p>
          Prices are in naira and include VAT where it applies. A plan keeps its price while it continues, unless we tell the owner of a new price at
          least 30 days before it applies; they can cancel before then. A plan started again after it has ended is charged at the current price.
        </p>

        <h3>Seats</h3>
        <p>
          The owner, admins, members and open invitations each take a seat; guests and customers don’t. Only the owner buys seats. Moving from Free to Team
          means paying for every seat, the owner’s included.
        </p>

        <h3>Paying</h3>
        <p>
          You pay by card on Paystack’s page, and we save the card so renewals are charged to it automatically. Seats you add during a period are charged
          straight away for the rest of it; seats you remove come off at the next renewal. Changing your card costs {formatMoney(MIN_CHARGE)}, which comes
          off your next renewal.
        </p>
        <p>
          Handing a workspace to a new owner keeps the period already paid for. The old owner’s card is removed, and the plan doesn’t renew until the new
          owner adds a card.
        </p>

        <h3>If a payment fails</h3>
        <p>
          We try again {retries} days later. If it’s still unpaid {GRACE_DAYS} days after the period ended, the workspace is paused until it’s paid: only
          the owner and admins can come in, at most {LOCKED_STAFF_CAP} at a time. A team of {FREE_SEATS} people or fewer moves to the Free plan instead.
          Until a help desk is paid for, only its owner and admins can come in, and no customers can.
        </p>

        <h3>Cancelling and refunds</h3>
        <p>
          You can cancel at any time in the workspace’s billing settings. The plan then runs to the end of the period you’ve paid for, and you can resume
          it until then. After that, a team of {FREE_SEATS} people or fewer moves to the Free plan; any other workspace is paused {GRACE_DAYS} days later,
          as when a payment fails, until it’s paid for again. We don’t refund partial periods or unused seats. If you’re charged twice for the same thing,
          we refund the second payment automatically.
        </p>
      </>
    ),
  },
  {
    id: 'availability',
    title: 'Availability and changes',
    body: (
      <p>
        We work to keep Homeoffice running well, but we can’t promise it will always be available or free of bugs. Updates and maintenance sometimes
        disconnect everyone for a few seconds. We may change, add or remove features. If a change takes away something important from a paid plan, we’ll
        tell the owner first.
      </p>
    ),
  },
  {
    id: 'others',
    title: 'Other companies’ services',
    body: (
      <p>
        Some features use other companies’ services: signing in with Google, Apple or GitHub, GitHub notifications, Spotify listen-along (which needs
        Spotify Premium) and Paystack for payments. Their own terms apply when you use them, and we’re not responsible for them.
      </p>
    ),
  },
  {
    id: 'ending',
    title: 'Ending',
    body: (
      <>
        <p>
          You can stop using Homeoffice at any time: leave your workspaces, cancel any plan, and email us to delete your account or a workspace you own.
        </p>
        <p>
          We may suspend or close an account or workspace that breaks these terms or the law, or puts others at risk. When we reasonably can, we’ll tell
          you first and give you a chance to put it right. The parts of these terms that are meant to last, like the limits on liability, still apply
          after.
        </p>
      </>
    ),
  },
  {
    id: 'disclaimers',
    title: 'Disclaimers',
    body: (
      <p>
        Homeoffice is provided as it is and as available. As far as the law allows, we make no promises beyond those in these terms, for example that it
        will suit every need or that every call will connect. Weather, GitHub and Spotify information comes from others and may be wrong or late. Nothing
        in these terms takes away rights that consumer law gives you.
      </p>
    ),
  },
  {
    id: 'liability',
    title: 'Limits on liability',
    body: (
      <p>
        As far as the law allows, we aren’t liable for indirect losses, such as lost profits, revenue, data or business. Our total liability for all claims
        together is limited to what you paid us for Homeoffice in the 12 months before the first one. This doesn’t limit liability that the law doesn’t
        allow us to limit, such as for fraud.
      </p>
    ),
  },
  {
    id: 'law',
    title: 'Governing law',
    body: (
      <p>
        These terms are governed by the laws of the Federal Republic of Nigeria. If we disagree about something, email us first and we’ll try to sort it
        out. If we can’t, the courts of Nigeria will decide.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to these terms',
    body: (
      <p>
        We may update these terms. We’ll change the date at the top and, if a change matters, tell people with an account by email or in Homeoffice before
        it applies. Using Homeoffice after that means you accept the new terms. If you don’t, stop using it and cancel any plan.
      </p>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: (
      <p>
        Questions about these terms: <Mail />. See also our <Link to={PRIVACY_PATH}>Privacy Policy</Link>.
      </p>
    ),
  },
];

export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      Icon={FileTextIcon}
      intro={
        <p>
          The agreement between you and {LEGAL_ENTITY} (“we” or “us”) when you use Homeoffice at homeoffice.town. By using Homeoffice, you agree to these
          terms. Our <Link to={PRIVACY_PATH}>Privacy Policy</Link> explains what we do with your information.
        </p>
      }
      sections={sections}
    />
  );
}
