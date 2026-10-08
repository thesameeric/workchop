import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  DAILY_COINS,
  MAX_TIP,
  MAX_TIP_NOTE,
  MIN_TIP,
  PRESENCE_COINS,
  PRESENCE_DAILY_CAP,
  PRESENCE_MINUTES,
  QUICK_AMOUNTS,
  type CoinKind,
  type LedgerEntry,
} from '../../../../shared/coins';
import { backToLobby, getSession } from '../../lib/session';
import { ago } from '../../lib/time';
import { toast, useStore } from '../../state/store';
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CalendarCheckIcon,
  ClockIcon,
  CoinsIcon,
  GiftIcon,
  MinusIcon,
  PlusIcon,
  SendIcon,
  type IconComponent,
} from '../../ui/icons';
import { loadMore, loadWallet, sendTip, useCoins, uuid } from './state';

const fmt = new Intl.NumberFormat();

/** Counts smoothly from the previous value to `value`. */
function useCountUp(value: number | null): number | null {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (value === null || from.current === null || from.current === value || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = from.current;
    const began = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - began) / 700);
      const eased = 1 - (1 - k) ** 3;
      const v = Math.round(start + (value - start) * eased);
      from.current = v;
      setShown(v);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return shown;
}

const KINDS: Record<CoinKind, { icon: IconComponent; label: (e: LedgerEntry) => string }> = {
  welcome: { icon: GiftIcon, label: () => 'Welcome bonus' },
  daily: { icon: CalendarCheckIcon, label: () => 'Daily check-in' },
  presence: { icon: ClockIcon, label: () => 'Time in the office' },
  tip_in: { icon: ArrowDownLeftIcon, label: (e) => `From ${e.counterparty?.name || 'someone'}` },
  tip_out: { icon: ArrowUpRightIcon, label: (e) => `To ${e.counterparty?.name || 'someone'}` },
};

function HistoryRow({ entry }: { entry: LedgerEntry }) {
  const { icon: Icon, label } = KINDS[entry.kind];
  const plus = entry.delta > 0;
  return (
    <li className="coin-row">
      <span className={`coin-row-icon ${entry.kind}`}>
        <Icon size={16} />
      </span>
      <div className="coin-row-info">
        <strong>{label(entry)}</strong>
        {entry.note && <span className="coin-row-note">“{entry.note}”</span>}
        <span className="muted small">{ago(entry.at)}</span>
      </div>
      <span className={`coin-delta ${plus ? 'plus' : 'minus'}`}>
        {plus ? '+' : '−'}
        {fmt.format(Math.abs(entry.delta))}
      </span>
    </li>
  );
}

function SendForm({ balance }: { balance: number }) {
  const players = useStore((s) => s.players);
  const accountId = useStore((s) => s.account?.id);
  const sendTo = useCoins((s) => s.sendTo);
  const [amount, setAmount] = useState(10);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per tip: kept for a retry of the same tip, new once anything changes or it went through.
  const key = useRef(uuid());
  const [sent, setSent] = useState(0);

  // Signed-in people here, once each (someone may have the office open twice).
  const people = useMemo(() => {
    const byUser = new Map<string, { userId: string; name: string }>();
    for (const p of Object.values(players)) if (p.userId && p.userId !== accountId && !byUser.has(p.userId)) byUser.set(p.userId, { userId: p.userId, name: p.name });
    return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [players, accountId]);
  const to = people.find((p) => p.userId === sendTo) ?? null;

  useEffect(() => {
    if (sendTo && !people.some((p) => p.userId === sendTo)) useCoins.setState({ sendTo: null });
  }, [people, sendTo]);

  useEffect(() => {
    key.current = uuid();
    setError(null);
  }, [sendTo, amount, note, sent]);

  const valid = Number.isInteger(amount) && amount >= MIN_TIP && amount <= MAX_TIP;
  const short = valid && amount > balance;
  const clamp = (n: number) => Math.max(MIN_TIP, Math.min(MAX_TIP, Math.round(n) || MIN_TIP));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!to || !valid || short || busy) return;
    setBusy(true);
    setError(null);
    const res = await sendTip(to.userId, amount, note.trim(), key.current);
    setBusy(false);
    if (!res.ok) {
      if (!res.uncertain) key.current = uuid();
      return setError(res.error);
    }
    setNote('');
    setSent((n) => n + 1);
    toast(`Sent ${fmt.format(amount)} ${amount === 1 ? 'coin' : 'coins'} to ${to.name}`, { icon: CoinsIcon });
  };

  if (!people.length) {
    return <p className="muted small coin-empty">No one here can get coins yet: they need to be signed in.</p>;
  }

  return (
    <form className="coin-send" onSubmit={submit}>
      <label className="field">
        <span>To</span>
        <select value={to?.userId ?? ''} onChange={(e) => useCoins.setState({ sendTo: e.target.value || null })}>
          <option value="">Choose someone…</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Amount</span>
        <div className="coin-stepper">
          <button type="button" className="icon-btn" onClick={() => setAmount((a) => clamp(a - 1))} disabled={amount <= MIN_TIP} aria-label="One coin less">
            <MinusIcon size={16} />
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_TIP}
            max={MAX_TIP}
            value={Number.isFinite(amount) ? amount : ''}
            onChange={(e) => setAmount(e.target.value === '' ? NaN : Math.round(Number(e.target.value)))}
            onBlur={() => setAmount((a) => clamp(a))}
            aria-label="Amount"
          />
          <button type="button" className="icon-btn" onClick={() => setAmount((a) => clamp(a + 1))} disabled={amount >= MAX_TIP} aria-label="One coin more">
            <PlusIcon size={16} />
          </button>
        </div>
        <div className="chips coin-quick">
          {QUICK_AMOUNTS.map((n) => (
            <button type="button" key={n} className={`chip${amount === n ? ' active' : ''}`} aria-pressed={amount === n} onClick={() => setAmount(n)} disabled={n > balance}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={MAX_TIP_NOTE} placeholder="Thanks for the help!" />
      </label>
      {!valid && <p className="form-error">Send between {MIN_TIP} and {MAX_TIP} coins.</p>}
      {short && <p className="form-error">You have {fmt.format(balance)} coins.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary wide" disabled={!to || !valid || short || busy}>
        <SendIcon size={16} />
        {busy ? 'Sending…' : valid ? `Send ${fmt.format(amount)} ${amount === 1 ? 'coin' : 'coins'}` : 'Send coins'}
      </button>
      <p className="muted small">Everyone here sees a shout-out with your note.</p>
    </form>
  );
}

function OfficeSwitch() {
  const enabled = useCoins((s) => s.enabled);
  const [busy, setBusy] = useState(false);
  const change = async (on: boolean) => {
    const session = getSession();
    if (!session) return;
    setBusy(true);
    try {
      const res = await session.socket.timeout(8000).emitWithAck('coins:office', on);
      if (!res.ok) toast(res.error, 'error');
    } catch {
      toast('No answer from the server. Please try again.', 'error');
    }
    setBusy(false);
  };
  return (
    <label className="coin-switch">
      <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void change(e.target.checked)} />
      <span>
        <strong>Coins in this office</strong>
        <span className="muted small">{enabled ? 'People here can send each other coins.' : 'Tips are hidden here. Wallets stay as they are.'}</span>
      </span>
    </label>
  );
}

function SignInToGetAWallet() {
  return (
    <div className="coin-guest">
      <span className="coin-glyph big">
        <CoinsIcon size={28} />
      </span>
      <strong>Sign in to get a wallet</strong>
      <p className="muted small">Members get {DAILY_COINS} coins a day for dropping by, and can thank coworkers with coins. Just for fun: no real money.</p>
      <button className="btn" onClick={backToLobby}>
        Sign in
      </button>
      <p className="muted small">Takes you to the lobby; come back in after signing in.</p>
    </div>
  );
}

export function WalletPanel() {
  const account = useStore((s) => s.account);
  const isOwner = useStore((s) => s.isOwner);
  // Field by field: the store also holds everyone's celebrations, which change often.
  const balance = useCoins((s) => s.balance);
  const entries = useCoins((s) => s.entries);
  const more = useCoins((s) => s.more);
  const loadingMore = useCoins((s) => s.loadingMore);
  const error = useCoins((s) => s.error);
  const enabled = useCoins((s) => s.enabled);
  const shown = useCountUp(balance);

  if (!account) {
    return (
      <div className="panel-body coins">
        <SignInToGetAWallet />
        {isOwner && <OfficeSwitch />}
      </div>
    );
  }

  return (
    <div className="panel-body coins">
      <div className="coin-balance">
        <span className="coin-glyph big">
          <CoinsIcon size={26} />
        </span>
        <div>
          <strong className="coin-amount">{shown === null ? '…' : fmt.format(shown)}</strong>
          <span className="muted small">coins · virtual, just for fun</span>
        </div>
      </div>

      <section className="coin-section">
        <h3>Send coins</h3>
        {!enabled ? <p className="muted small coin-empty">Coins are off in this office.</p> : balance !== null && <SendForm balance={balance} />}
      </section>

      <section className="coin-section">
        <h3>History</h3>
        {error && (
          <p className="form-error" role="alert">
            {error}{' '}
            <button className="link-btn" onClick={() => void loadWallet()}>
              Try again
            </button>
          </p>
        )}
        {!entries.length && !error && <p className="muted small coin-empty">{balance === null ? 'Loading…' : 'Nothing yet.'}</p>}
        <ul className="coin-history">
          {entries.map((e) => (
            <HistoryRow key={e.id} entry={e} />
          ))}
        </ul>
        {more && (
          <button className="btn small wide" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show older'}
          </button>
        )}
      </section>

      <section className="coin-section">
        <h3>How to earn</h3>
        <ul className="coin-earn">
          <li>
            <CalendarCheckIcon size={16} /> <span>Daily check-in</span> <b>+{DAILY_COINS}</b>
          </li>
          <li>
            <ClockIcon size={16} />
            <span>
              Every {PRESENCE_MINUTES} min here (up to {PRESENCE_DAILY_CAP} a day)
            </span>
            <b>+{PRESENCE_COINS}</b>
          </li>
          <li>
            <ArrowDownLeftIcon size={16} /> <span>Tips from coworkers</span>
          </li>
        </ul>
      </section>

      {isOwner && (
        <section className="coin-section">
          <OfficeSwitch />
        </section>
      )}
    </div>
  );
}
