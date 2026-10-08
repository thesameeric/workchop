import { createRoot } from 'react-dom/client';
import { compactCoins, type BalanceEvent, type TipEvent } from '../../../../shared/coins';
import { onSession } from '../../lib/session';
import { getState, setPanel, toast, useStore, type RemotePlayer } from '../../state/store';
import { CalendarCheckIcon, CoinsIcon, GiftIcon, WalletIcon } from '../../ui/icons';
import { registerPanel } from '../../ui/panels';
import { registerPersonAction } from '../../ui/personActions';
import { Celebrations } from './Celebrations';
import { addBurst, balanceChanged, loadWallet, resetWallet, useCoins } from './state';
import { WalletPanel } from './WalletPanel';
import './coins.css';

function openWallet(): void {
  if (getState().panel !== 'wallet') setPanel('wallet');
}

registerPanel({
  id: 'wallet',
  title: 'Wallet',
  icon: WalletIcon,
  Component: WalletPanel,
  order: 35,
  badgeTone: 'neutral',
  useBadge: () => {
    const balance = useCoins((s) => s.balance);
    const signedIn = useStore((s) => !!s.account);
    return signedIn && balance !== null ? compactCoins(balance) : null;
  },
});

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

registerPersonAction({ id: 'coins', order: 10, Component: SendCoinsButton });

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
  const onOffice = ({ enabled }: { enabled: boolean }) => useCoins.setState({ enabled });

  socket.on('coins:balance', onBalance);
  socket.on('coins:tipped', onTipped);
  socket.on('coins:office', onOffice);
  const offJoined = session.onJoined(() => {
    if (getState().account) void loadWallet();
    else resetWallet();
  });

  // The celebrations sit over the 3D world, under the panels: inside the office view, once it's there.
  const host = document.createElement('div');
  const root = createRoot(host);
  root.render(<Celebrations />);
  let frame = 0;
  const mount = () => {
    const office = document.querySelector('.office');
    if (office) office.append(host);
    else frame = requestAnimationFrame(mount);
  };
  mount();

  return () => {
    socket.off('coins:balance', onBalance);
    socket.off('coins:tipped', onTipped);
    socket.off('coins:office', onOffice);
    offJoined();
    cancelAnimationFrame(frame);
    // Not while React may be rendering (leaving can start from inside an update).
    setTimeout(() => {
      root.unmount();
      host.remove();
    });
    resetWallet();
    useCoins.setState({ enabled: true });
  };
});
