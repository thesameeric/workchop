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
  /** Who the Send form is set to (an account id), e.g. from the People panel. */
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
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) }).catch(() => {
    throw new Error('Couldn’t reach the server');
  });
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

// Bumped when the wallet is reset (leaving, another account), so late answers are dropped.
let generation = 0;

export async function loadMore(): Promise<void> {
  const { entries, loadingMore } = get();
  const last = entries[entries.length - 1];
  if (!last || loadingMore) return;
  const gen = generation;
  set({ loadingMore: true });
  try {
    const page = await getJson<WalletHistoryResponse>(`/api/me/wallet/history?before=${last.id}`);
    if (gen !== generation) return;
    set((s) => ({ entries: [...s.entries, ...page.entries.filter((e) => e.id < last.id)], more: page.more }));
  } catch (err) {
    if (gen === generation) set({ error: (err as Error).message });
  } finally {
    if (gen === generation) set({ loadingMore: false });
  }
}

let refresh: ReturnType<typeof setTimeout> | undefined;
/** Your balance changed: show it now, and fetch the new history rows soon after. */
export function balanceChanged(balance: number): void {
  // A load already on its way may be older than this.
  loads++;
  set({ balance });
  clearTimeout(refresh);
  refresh = setTimeout(() => void loadWallet(), 400);
}

export function resetWallet(): void {
  clearTimeout(refresh);
  loads++;
  generation++;
  set({ balance: null, entries: [], more: false, loadingMore: false, error: null, sendTo: null, bursts: [] });
}

let burstId = 0;
export function addBurst(playerId: string, amount: number, from: string | null, note = ''): void {
  const id = ++burstId;
  set((s) => ({ bursts: [...s.bursts.slice(-5), { id, playerId, amount, from, note }] }));
  setTimeout(() => set((s) => ({ bursts: s.bursts.filter((b) => b.id !== id) })), note ? 4200 : 2600);
}

/** A random uuid (crypto.randomUUID needs https, which a LAN address doesn't have). */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Sends a tip, retrying once with the same key if the answer doesn't come (the server makes a tip
 * at most once per key). `uncertain`: it may have gone through, so send again only with this key.
 */
export async function sendTip(toUserId: string, amount: number, note: string, key: string): Promise<TipAnswer & { uncertain?: boolean }> {
  const session = getSession();
  if (!session) return { ok: false, error: 'Not in an office' };
  const req = { toUserId, amount, note, key };
  let timedOut = false;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await session.socket.timeout(8000).emitWithAck('coins:tip', req);
      if (res.ok) {
        loads++;
        set({ balance: res.balance });
        return res;
      }
      // After a lost answer, an error now (e.g. while reconnecting) doesn't mean the first try failed.
      if (timedOut) return { ok: false, uncertain: true, error: 'Not sure this tip went through. Press Send again: it won’t be sent twice.' };
      return res;
    } catch {
      timedOut = true;
      if (attempt >= 2) return { ok: false, uncertain: true, error: 'No answer from the server. Press Send again: it won’t be sent twice.' };
    }
  }
}
