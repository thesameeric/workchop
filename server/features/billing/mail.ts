import { formatMoney } from '../../../shared/billing';
import { compose } from '../../mailTemplates';

// Billing's emails, to the owner (and, when a workspace locks, its admins). Each links to the
// workspace's Billing settings, except "action needed", which links to the bank's page.

/** 12 November 2026, in Lagos (prices are in naira). */
export const formatDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });

const OWNER = 'You get this email because you own this workspace on Homeoffice.';
const seatsText = (n: number) => `${n} ${n === 1 ? 'seat' : 'seats'}`;
/** What happens when it isn't paid in time: a team of 3 people or fewer goes on the Free plan, anything else pauses. */
const unpaid = (free: boolean) => (free ? 'it goes on the Free plan' : 'the workspace pauses: then only you and its admins can come in');

export const billingMail = {
  receipt: (link: string, w: string, c: { amount: number; seats: number; reference: string; periodEnd: number | null; card: string | null }) =>
    compose(
      `Receipt for ${w}`,
      `We received ${formatMoney(c.amount)} for ${w}${c.seats ? ` (${seatsText(c.seats)})` : ''}${c.card ? ` from your card ending ${c.card}` : ''}.${c.periodEnd ? ` Paid until ${formatDate(c.periodEnd)}.` : ''} Reference: ${c.reference}.`,
      { label: 'See billing', link },
      OWNER,
    ),
  /** `free`: a small team, which goes on the Free plan instead of pausing. */
  paymentFailed: (link: string, w: string, amount: number, by: number, retry: boolean, free: boolean) =>
    compose(
      `Payment for ${w} failed`,
      `We couldn’t charge ${formatMoney(amount)} to your card for ${w}.${retry ? ' We’ll try again in a few days.' : ''} Pay or add another card by ${formatDate(by)}, or ${unpaid(free)}.`,
      { label: 'Pay now', link },
      OWNER,
    ),
  reminder: (link: string, w: string, by: number, free: boolean) =>
    compose(`${w} isn’t paid yet`, `Pay for ${w} by ${formatDate(by)}, or ${unpaid(free)}.`, { label: 'Pay now', link }, OWNER),
  locksTomorrow: (link: string, w: string, free: boolean) =>
    compose(free ? `${w} goes on the Free plan tomorrow` : `${w} pauses tomorrow`, `Pay for ${w} today, or tomorrow ${unpaid(free)}.`, { label: 'Pay now', link }, OWNER),
  locked: (link: string, w: string) =>
    compose(
      `${w} is paused`,
      `${w} is paused because its plan isn’t paid. Only its owner and admins can come in until the owner pays.`,
      { label: `Open ${w}`, link },
      'You get this email because you own or run this workspace on Homeoffice.',
    ),
  actionNeeded: (bankLink: string, w: string, amount: number) =>
    compose(`Confirm the payment for ${w}`, `Your bank wants you to confirm the payment of ${formatMoney(amount)} for ${w}.`, { label: 'Confirm with your bank', link: bankLink }, OWNER),
  renewsSoon: (link: string, w: string, amount: number, at: number, card: string | null) =>
    compose(
      `${w} renews on ${formatDate(at)}`,
      `${w} renews on ${formatDate(at)}: we’ll charge ${formatMoney(amount)}${card ? ` to your card ending ${card}` : ''}.`,
      { label: 'See billing', link },
      OWNER,
    ),
  cardExpiring: (link: string, w: string, at: number) =>
    compose(`Update your card for ${w}`, `Your card expires before ${w} renews on ${formatDate(at)}. Update it so the workspace doesn’t pause.`, { label: 'Update card', link }, OWNER),
  cancelled: (link: string, w: string, at: number) =>
    compose(`Your plan for ${w} ends on ${formatDate(at)}`, `You cancelled the plan for ${w}. It ends on ${formatDate(at)}. You can resume it until then.`, { label: 'See billing', link }, OWNER),
  /** Cancelled after its period ended: `pausesAt` null when it's on the Free plan now. */
  renewalStopped: (link: string, w: string, pausesAt: number | null) =>
    compose(
      `Your plan for ${w} won’t renew`,
      `You cancelled the plan for ${w}, so your card won’t be charged again.${
        pausesAt === null ? ' It’s on the Free plan now.' : ` The workspace pauses on ${formatDate(pausesAt)} unless it’s paid: then only you and its admins can come in.`
      }`,
      { label: 'See billing', link },
      OWNER,
    ),
  seatsChanged: (link: string, w: string, seats: number, from: number | null) =>
    compose(
      `Seats changed for ${w}`,
      from ? `${w} will have ${seatsText(seats)} from ${formatDate(from)}.` : `${w} now has ${seatsText(seats)}.`,
      { label: 'See billing', link },
      OWNER,
    ),
  launch: (link: string, w: string, by: number) =>
    compose(
      `Choose a plan for ${w}`,
      `Homeoffice now has paid plans. Choose one for ${w} by ${formatDate(by)}, or the workspace pauses: then only you and its admins can come in.`,
      { label: 'Choose a plan', link },
      OWNER,
    ),
  addCard: (link: string, w: string, at: number | null) =>
    compose(
      `Add a card for ${w}`,
      `You’re now the owner of ${w}.${at ? ` Its plan is paid until ${formatDate(at)}.` : ''} Add a card so it keeps renewing.`,
      { label: 'Add a card', link },
      OWNER,
    ),
  disputed: (link: string, w: string) =>
    compose(`A payment for ${w} is disputed`, `Someone disputed a card payment for ${w} with their bank. We’ll be in touch if anything is needed.`, { label: 'See billing', link }, OWNER),
};
