// Billing (README: "Billing"), on servers with a Paystack key: Settings > Billing for the owner and
// admins, a top-bar banner when something needs doing, and /billing/return, where Paystack sends
// people back. Home's prices and help-desk checkout, and the Workspace section's seats, use this
// folder's state and API too.
import type { BillingSummary } from '../../../../shared/billing';
import { may } from '../../../../shared/workspace';
import { onSession } from '../../lib/session';
import { getState, useStore } from '../../state/store';
import { CreditCardIcon } from '../../ui/icons';
import { registerPage } from '../../ui/pages';
import { registerSettingsSection } from '../../ui/settings';
import { registerTopBarItem } from '../../ui/topbar';
import { BillingBanner } from './Banner';
import { BillingSection } from './BillingSection';
import { ReturnPage } from './ReturnPage';
import { loadStatus, openBilling, refreshBilling, useBilling } from './state';
import './billing.css';

registerPage({ path: '/billing/return', Component: ReturnPage });
registerTopBarItem({ id: 'billing', order: 5, Component: BillingBanner });

// Settings > Billing: the owner and admins, on a server that charges.
let removeSection: (() => void) | null = null;
const sync = () => {
  const show = may(getState().role, 'see-billing') && !!useBilling.getState().status?.available;
  if (show && !removeSection) removeSection = registerSettingsSection({ id: 'billing', title: 'Billing', icon: CreditCardIcon, order: 6, Component: BillingSection });
  else if (!show && removeSection) {
    removeSection();
    removeSection = null;
  }
};
useStore.subscribe(sync);
useBilling.subscribe(sync);
void loadStatus();

// "Add seats" asks for room for one more person until Settings closes.
useStore.subscribe((s) => {
  if (s.modal !== 'settings' && useBilling.getState().oneMore) useBilling.setState({ oneMore: false });
});

/** Billing emails link to /o/<id>?billing: once in, Settings opens at Billing, and the address loses it. */
function openFromLink(): void {
  const params = new URLSearchParams(location.search);
  if (!params.has('billing')) return;
  params.delete('billing');
  const query = params.toString();
  history.replaceState(history.state, '', location.pathname + (query ? `?${query}` : '') + location.hash);
  if (may(getState().role, 'see-billing')) void loadStatus().then((status) => status.available && openBilling());
}

onSession('billing', (session) => {
  const offJoined = session.onJoined(() => {
    void refreshBilling();
    openFromLink();
  });
  // Made an admin, or no longer one (joining sets the first role, which onJoined covers).
  const offRole = useStore.subscribe((s, prev) => {
    if (prev.role && s.role !== prev.role) void refreshBilling();
  });
  const onState = (summary: BillingSummary) => {
    if (summary.officeId !== session.officeId) return;
    useBilling.setState((s) => ({ view: { ...s.view, ...summary } }));
    // The owner's amounts, card and payments change with it.
    if (may(getState().role, 'billing')) void refreshBilling();
  };
  session.socket.on('billing:state', onState);
  return () => {
    offJoined();
    offRole();
    session.socket.off('billing:state', onState);
    useBilling.setState({ view: null, error: null });
  };
});
