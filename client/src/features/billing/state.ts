import { create } from 'zustand';
import type { BillingStatusAnswer, BillingView } from '../../../../shared/billing';
import { may } from '../../../../shared/workspace';
import { errorText } from '../../lib/account';
import { getState, setState } from '../../state/store';
import { fetchBilling, fetchStatus } from './api';
import { day } from './format';

interface BillingState {
  /** null until the server answers; `available: false` when it doesn't charge for workspaces. */
  status: BillingStatusAnswer | null;
  /** The plan of the office you're in, for its owner and admins. */
  view: BillingView | null;
  /** Why the plan couldn't be loaded. */
  error: string | null;
  /** Opened by "Add seats" (every seat was taken): the seat pickers start with one for another person. */
  oneMore: boolean;
}

export const useBilling = create<BillingState>()(() => ({ status: null, view: null, error: null, oneMore: false }));

/** The prices, when this server charges for workspaces. */
export const pricesOf = (s: Pick<BillingState, 'status'>) => (s.status?.available ? s.status : null);

let loading: Promise<BillingStatusAnswer> | null = null;

/** Asks the server once whether it charges (again later if it couldn't be reached). */
export function loadStatus(): Promise<BillingStatusAnswer> {
  loading ??= fetchStatus().catch(() => {
    loading = null;
    return { available: false } as const;
  });
  return loading.then((status) => {
    if (useBilling.getState().status !== status) useBilling.setState({ status });
    return status;
  });
}

let asked = 0;

/** Loads the plan of the office you're in, if you may see it. */
export async function refreshBilling(): Promise<void> {
  const n = ++asked;
  const { officeId, role } = getState();
  if (!officeId || !may(role, 'see-billing') || !(await loadStatus()).available) {
    if (n === asked) useBilling.setState({ view: null, error: null });
    return;
  }
  try {
    const view = await fetchBilling(officeId);
    if (n === asked && getState().officeId === officeId) useBilling.setState({ view, error: null });
  } catch (err) {
    if (n === asked) useBilling.setState({ error: errorText(err) });
  }
}

/** Opens Settings at Billing (also while Settings is open); `oneMore` from a full workspace's "Add seats". */
export function openBilling(oneMore = false): void {
  useBilling.setState({ oneMore });
  setState({ modal: 'settings', settingsSection: 'billing' });
}

/** What handing the workspace over means for its plan, for the transfer's confirmation; null when nothing. */
export function transferNote(name: string): string | null {
  const view = useBilling.getState().view;
  if (!view || (view.plan !== 'team' && view.plan !== 'support')) return null;
  if (view.status === 'active' && view.periodEnd) {
    return `The plan is paid until ${day(view.periodEnd)}. Your card comes off it, so ${name} must add a card by then to keep it going.`;
  }
  if (view.status === 'past_due' && view.graceEndsAt) return `A payment is due. ${name} must pay by ${day(view.graceEndsAt)}, or the workspace pauses.`;
  return null;
}
