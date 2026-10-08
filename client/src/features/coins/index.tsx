import { compactCoins, type BalanceEvent, type TipEvent } from '../../../../shared/coins';
import { onSession } from '../../lib/session';
import { getState, setPanel, toast, useStore, type RemotePlayer } from '../../state/store';
import { CalendarCheckIcon, CoinsIcon, GiftIcon, WalletIcon } from '../../ui/icons';
import { registerOverlay } from '../../ui/overlays';
import { registerPanel } from '../../ui/panels';
import { registerPersonAction } from '../../ui/personActions';
import { Celebrations } from './Celebrations';
import { addBurst, balanceChanged, loadWallet, resetWallet, useCoins } from './state';
import { WalletPanel } from './WalletPanel';
import './coins.css';

// Coins are off unless the server runs with COINS=on (README: "Coins (off for now)"). Then, when you
// join an office, it says whether they're on there ('coins:office'), and only then do the wallet, the
// "Send coins" buttons and the celebrations appear. Without that, nothing shows and nothing is asked.

function openWallet(): void {
  if (getState().panel !== 'wallet') setPanel('wallet');
}

function SendCoinsButton({ player }: { player: RemotePlayer }) {
  const me = useStore((s) => s.account?.id);
  const enabled = useCoins((s) => s.enabled);
  if (!me || !enabled || !player.userId || player.userId === me) return null;
  return (
    <button
      className="icon-btn"
      title={`Send coins to ${player.name}`}
      onClick={() => {
        useCoins.setState({ sendTo: player.userId });
        openWallet();
      }}
    >
      <CoinsIcon size={16} />
    </button>
  );
}

let hide: (() => void) | null = null;

/** Adds (or takes away) everything coins show: the server has them, or you left the office. */
function showCoins(on: boolean): void {
  if (on && !hide) {
    const off = [
      registerPanel({
        id: 'wallet',
        title: 'Wallet',
        icon: WalletIcon,
        Component: WalletPanel,
        order: 35,
        inMore: true,
        badgeTone: 'neutral',
        useBadge: () => {
          const balance = useCoins((s) => s.balance);
          const signedIn = useStore((s) => !!s.account);
          return signedIn && balance !== null ? compactCoins(balance) : null;
        },
      }),
      registerPersonAction({ id: 'coins', order: 10, Component: SendCoinsButton }),
      // Over the name tags.
      registerOverlay({ id: 'coins', order: 5, Component: Celebrations }),
    ];
    hide = () => off.forEach((remove) => remove());
  } else if (!on && hide) {
    hide();
    hide = null;
  }
}

onSession('coins', (session) => {
  const { socket } = session;

  const onBalance = (e: BalanceEvent) => {
    balanceChanged(e.balance);
    if (e.kind === 'welcome') toast(`Welcome! Here are ${e.delta} coins to start.`, { icon: GiftIcon, duration: 5000 });
    else if (e.kind === 'daily') toast(`+${e.delta} coins: daily check-in`, { icon: CalendarCheckIcon });
    else if (e.kind === 'presence') {
      const self = getState().selfId;
      if (self) addBurst(self, e.delta, null);
    }
  };
  const onTipped = (e: TipEvent) => {
    if (e.to.playerId) addBurst(e.to.playerId, e.amount, e.from.name, e.note);
    if (e.to.userId !== getState().account?.id) return;
    const coins = `${e.amount} ${e.amount === 1 ? 'coin' : 'coins'}`;
    toast(e.note ? `${e.from.name} sent you ${coins}: ${e.note}` : `${e.from.name} sent you ${coins}!`, {
      icon: CoinsIcon,
      duration: 6000,
      action: { label: 'Wallet', run: openWallet },
    });
  };
  // The server has coins: it says so on every join. Your wallet loads then (again after a rejoin).
  let due = true;
  const onOffice = ({ enabled }: { enabled: boolean }) => {
    useCoins.setState({ enabled });
    showCoins(true);
    if (!due) return;
    due = false;
    if (getState().account) void loadWallet();
    else resetWallet();
  };

  socket.on('coins:balance', onBalance);
  socket.on('coins:tipped', onTipped);
  socket.on('coins:office', onOffice);
  const offJoined = session.onJoined(() => {
    due = true;
  });

  return () => {
    socket.off('coins:balance', onBalance);
    socket.off('coins:tipped', onTipped);
    socket.off('coins:office', onOffice);
    offJoined();
    showCoins(false);
    resetWallet();
    useCoins.setState({ enabled: true });
  };
});
