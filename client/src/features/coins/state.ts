import { create } from 'zustand';
import type { LedgerEntry, TipAnswer, WalletHistoryResponse, WalletResponse } from '../../../../shared/coins';
import { getSession } from '../../lib/session';

interface CoinsState {
  /** Your balance, once loaded (null for guests). */
  balance: number | null;
  /** History, newest first. */
  entries: LedgerEntry[];
  more: boolean;
  loadingMore: boolean;
  error: string | null;
  /** Coins are on in the office you're in. */
  enabled: boolean;
  /** Who the Send form is set to (a player id), e.g. from the People panel. */
  sendTo: string | null;
  /** Celebrations over people who just got coins, and "+5" floats over you. */
  bursts: { id: number; playerId: string; amount: number; from: string | null; note: string }[];
}

export const useCoins = create<CoinsState>()(() => ({
  balance: null,
  entries: [],
  more: false,
  loadingMore: false,
  error: null,
  enabled: true,
  sendTo: null,
  bursts: [],
}));

const set = useCoins.setState;
const get = useCoins.getState;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

const PAGE = 20;
let loads = 0;

/** Loads your balance and newest history, keeping older pages already loaded. */
export async function loadWallet(): Promise<void> {
  const run = ++loads;
  try {
    const w = await getJson<WalletResponse>('/api/me/wallet');
    if (run !== loads) return;
    const { entries } = get();
    const newest = entries[0]?.id ?? 0;
    const fresh = w.recent.filter((e) => e.id > newest);
    // Merge only onto history that overlaps what came back; otherwise start from this page.
    const overlaps = !entries.length || w.recent.some((e) => e.id === newest);
    set({
      balance: w.balance,
      entries: overlaps ? [...fresh, ...entries] : w.recent,
      more: overlaps && entries.length ? get().more : w.recent.length >= PAGE,
      error: null,
    });
  } catch (err) {
    if (run === loads) set({ error: (err as Error).message });
  }
}

export async function loadMore(): Promise<void> {
  const { entries, loadingMore } = get();
  const last = entries[entries.length - 1];
  if (!last || loadingMore) return;
  set({ loadingMore: true });
  try {
    const page = await getJson<WalletHistoryResponse>(`/api/me/wallet/history?before=${last.id}`);
    set((s) => ({ entries: [...s.entries, ...page.entries.filter((e) => e.id < last.id)], more: page.more }));
  } catch (err) {
    set({ error: (err as Error).message });
  } finally {
    set({ loadingMore: false });
  }
}

let refresh: ReturnType<typeof setTimeout> | undefined;
/** Your balance changed: show it now, and fetch the new history rows soon after. */
export function balanceChanged(balance: number): void {
  set({ balance });
  clearTimeout(refresh);
  refresh = setTimeout(() => void loadWallet(), 400);
}

export function resetWallet(): void {
  clearTimeout(refresh);
  loads++;
  set({ balance: null, entries: [], more: false, error: null, sendTo: null, bursts: [] });
}

let burstId = 0;
export function addBurst(playerId: string, amount: number, from: string | null, note = ''): void {
  const id = ++burstId;
  set((s) => ({ bursts: [...s.bursts.slice(-5), { id, playerId, amount, from, note }] }));
  setTimeout(() => set((s) => ({ bursts: s.bursts.filter((b) => b.id !== id) })), note ? 4200 : 2600);
}

/** A random uuid (crypto.randomUUID needs https, which a LAN address doesn't have). */
function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Sends a tip, retrying once with the same key if the answer doesn't come (it's sent at most once). */
export async function sendTip(toPlayerId: string, amount: number, note: string): Promise<TipAnswer> {
  const session = getSession();
  if (!session) return { ok: false, error: 'Not in an office' };
  const req = { toPlayerId, amount, note, key: uuid() };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await session.socket.timeout(8000).emitWithAck('coins:tip', req);
      if (res.ok) set({ balance: res.balance });
      return res;
    } catch {
      if (attempt >= 2) return { ok: false, error: 'No answer from the server. Check your balance before trying again.' };
    }
  }
}
