import { may } from '../../../../shared/workspace';
import { useStore } from '../../state/store';
import { AlertIcon } from '../../ui/icons';
import { problemOf } from './format';
import { openBilling, useBilling } from './state';

/** In the top bar, for the owner and admins: what needs doing about the plan, opening Billing. */
export function BillingBanner() {
  const view = useBilling((s) => s.view);
  const owner = useStore((s) => may(s.role, 'billing'));
  const problem = view && problemOf(view, owner);
  if (!view || !problem) return null;
  const action = !owner ? 'Details' : view.graceReason === 'action_needed' ? 'Confirm' : view.graceReason === 'launch' ? 'Choose' : 'Pay';
  return (
    <button className={`billing-banner${view.status === 'locked' ? ' locked' : ''}`} onClick={() => openBilling()}>
      <AlertIcon size={16} />
      <span>{problem}</span>
      <strong>{action}</strong>
    </button>
  );
}
