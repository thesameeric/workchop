import { seatsOf } from '../../../../shared/catalog';
import { CUSTOMER_SEAT, SUPPORT_DESK, ticketConv } from '../../../../shared/support';
import { isCustomer } from '../../../../shared/workspace';
import { onSession } from '../../lib/session';
import { getState, setPanel, useStore, type RemotePlayer } from '../../state/store';
import { ChatIcon, SupportIcon } from '../../ui/icons';
import { registerLobby } from '../../ui/lobbies';
import { registerOverlay } from '../../ui/overlays';
import { registerPanel, type PanelDef } from '../../ui/panels';
import { registerPersonDetail } from '../../ui/PeoplePanel';
import { registerTopBarItem } from '../../ui/topbar';
import { registerItemInteraction, registerNearbyAction, registerWorldModule } from '../../world/extensions';
import { walkTo } from '../../world/movement';
import { registerConvView } from '../chat/state';
import { CustomerCard, CustomerChat, useCustomerBadge } from './Customer';
import { CustomerLobby } from './CustomerLobby';
import { CustomerNames, DeskCard, OfferCard, toggleDeskCard } from './Overlays';
import { supportDesks } from './places';
import { StaffPanel, useStaffBadge } from './Staff';
import { attach, myDesk, sitAtDesk, takeDesk, useSupport } from './state';
import { ticketsOnScreen } from './TicketChat';
import './support.css';

// Customer support workspaces ("Intercom in 3D"): customers come in with the customer link, wait in
// the lobby with things to look at, and are called to a support desk one at a time; staff take a
// desk, call the next customer and talk with them face to face. Each conversation is a ticket with
// its own chat. The server side is server/features/support; the contract is shared/support.ts.

registerLobby({ id: 'support-customer', match: (info) => isCustomer(info.role, info.kind), Component: CustomerLobby, media: { mic: true, cam: false } });
registerWorldModule(() => import('./scene'));
registerTopBarItem({ id: 'support-customer', order: 1, Component: CustomerCard });
registerOverlay({ id: 'support-desk', order: 12, Component: DeskCard });
registerOverlay({ id: 'support-offer', order: 13, Component: OfferCard });
registerOverlay({ id: 'support-names', order: 4, Component: CustomerNames });
registerItemInteraction([SUPPORT_DESK], { onClick: toggleDeskCard });

onSession('support', attach);

// ---------- Panels: staff get Support; customers' Chat is their ticket ----------

const staffPanel: PanelDef = { id: 'support', title: 'Support', icon: SupportIcon, Component: StaffPanel, order: 5, useBadge: useStaffBadge };
// The same id as the chat feature's panel, which customers don't get: Enter and the dock open it alike.
const customerChat: PanelDef = { id: 'chat', title: 'Chat', icon: ChatIcon, Component: CustomerChat, order: 10, shortcut: 'Enter', useBadge: useCustomerBadge };

let removeStaff: (() => void) | null = null;
let removeChat: (() => void) | null = null;
const syncPanels = () => {
  const { role, kind } = getState();
  const staff = kind === 'support' && !!role && role !== 'guest';
  const customer = isCustomer(role, kind);
  if (staff && !removeStaff) removeStaff = registerPanel(staffPanel);
  else if (!staff && removeStaff) {
    removeStaff();
    removeStaff = null;
  }
  if (customer && !removeChat) removeChat = registerPanel(customerChat);
  else if (!customer && removeChat) {
    removeChat();
    removeChat = null;
  }
};
syncPanels();
useStore.subscribe(syncPanels);

// ---------- Ticket chats (`t:<id>`), kept by the chat feature and shown here ----------

/** Your tickets' chats: the customer's own, or the ones staff are serving or helping with. */
function myTicketConvs(): string[] {
  const s = useSupport.getState();
  const ids = s.as === 'customer' ? [s.ticket?.id] : [s.queue.mine?.id, s.queue.helping?.id];
  return ids.filter((id): id is string => !!id).map(ticketConv);
}

registerConvView('t:', {
  // Staff serve from the Support panel's Desk tab; customers' Chat panel is their ticket.
  open: () => {
    const staff = useSupport.getState().as === 'staff';
    if (staff) useSupport.setState({ tab: 'desk' });
    if (getState().panel !== (staff ? 'support' : 'chat')) setPanel(staff ? 'support' : 'chat');
  },
  looking: (conv) => ticketsOnScreen.has(conv),
  notify: (conv) => myTicketConvs().includes(conv),
  guestIsMe: (conv) => useSupport.getState().as === 'customer' && myTicketConvs().includes(conv),
});

// ---------- E near a support desk ----------

const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)');
const SEAT_RANGE = 1.3;

// Staff take a free desk (or sit at theirs); customers are told they'll be called, and sit down only
// at the desk serving them. (Seats of items with a click action of their own aren't offered by E.)
registerNearbyAction('support-desk', (office, x, z) => {
  const st = useSupport.getState();
  if (!st.as) return null;
  let best: { desk: ReturnType<typeof supportDesks>[number]; d: number } | null = null;
  for (const desk of supportDesks(office)) {
    for (const seat of seatsOf(desk.item)) {
      const d = Math.hypot(seat.x - x, seat.z - z);
      if (d < SEAT_RANGE && (!best || d < best.d)) best = { desk, d };
    }
  }
  if (!best) return null;
  const { item, label } = best.desk;
  const distance = best.d;
  const key = touchOnly.matches ? 'Tap the desk' : 'Press E';
  const card = () => toggleDeskCard(item);
  if (st.as === 'customer') {
    const yours = st.ticket?.status === 'active' && st.ticket.agent?.deskItemId === item.id;
    if (!yours) return { distance, hint: 'We’ll call you to a desk', run: card };
    const seat = seatsOf(item)[CUSTOMER_SEAT];
    return {
      distance,
      hint: `${key} to sit`,
      run: () => walkTo(seat.x, seat.z, { ...seat, itemId: item.id }),
    };
  }
  const mine = myDesk();
  if (mine?.itemId === item.id) return { distance, hint: `${key} to sit`, run: () => sitAtDesk(item) };
  const taken = st.queue.desks.find((d) => d.itemId === item.id);
  if (taken) return { distance, hint: `${label} is ${taken.name}’s`, run: card };
  if (st.queue.mine) return { distance, hint: `You’re serving someone at ${mine?.label ?? 'your desk'}`, run: card };
  return { distance, hint: `${key} to ${mine ? 'move to' : 'take'} ${label}`, run: () => void takeDesk(item) };
});

// ---------- People panel: who's behind a visitor number (staff) ----------

function PersonTicket({ player }: { player: RemotePlayer }) {
  const ticket = useSupport((s) =>
    s.as !== 'staff'
      ? undefined
      : [s.queue.mine, s.queue.helping].find((t) => t?.playerId === player.id) ?? s.queue.waiting.find((t) => t.playerId === player.id),
  );
  const helping = useSupport((s) => !!ticket && ticket.id === s.queue.helping?.id);
  if (!ticket) return null;
  const what = helping ? `helping ${ticket.assignee?.name ?? 'a colleague'}` : ticket.status === 'active' ? 'your customer' : `waiting, #${ticket.number}`;
  return (
    <span className="small person-ticket">
      {ticket.customerName} · {what}
    </span>
  );
}

registerPersonDetail({ id: 'support', order: 5, Component: PersonTicket });
