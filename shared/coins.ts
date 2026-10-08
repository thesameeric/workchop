import { clip } from './text';

// Coins: a virtual wallet for signed-in members (no real money). The server keeps the ledger.

export const WELCOME_COINS = 100;
export const DAILY_COINS = 20;
export const PRESENCE_COINS = 5;
/** Minutes of active presence that earn PRESENCE_COINS. */
export const PRESENCE_MINUTES = 30;
/** At most this many presence coins per person per UTC day. */
export const PRESENCE_DAILY_CAP = 40;
export const MIN_TIP = 1;
export const MAX_TIP = 500;
export const MAX_TIP_NOTE = 140;
/** Tips each person may send per minute. */
export const TIPS_PER_MINUTE = 10;
export const QUICK_AMOUNTS = [5, 10, 25, 50];

export type CoinKind = 'welcome' | 'daily' | 'presence' | 'tip_in' | 'tip_out';

/** One line of someone's history, newest first in the API. */
export interface LedgerEntry {
  id: number;
  delta: number;
  balanceAfter: number;
  kind: CoinKind;
  /** The other person, for tips. */
  counterparty: { id: string; name: string } | null;
  officeId: string | null;
  note: string | null;
  at: number;
}

/** GET /api/me/wallet */
export interface WalletResponse {
  balance: number;
  recent: LedgerEntry[];
}

/** GET /api/me/wallet/history?before=<id> */
export interface WalletHistoryResponse {
  entries: LedgerEntry[];
  more: boolean;
}

export interface TipRequest {
  /** The recipient's player id in your office, or their account id (one of the two). */
  toPlayerId?: string;
  toUserId?: string;
  amount: number;
  note?: string;
  /** A fresh uuid per tip; sending it again (a retry) never sends the coins twice. */
  key: string;
}

export type TipAnswer = { ok: true; balance: number } | { ok: false; error: string };

/** Someone in the office who took part in a tip. */
export interface TipParty {
  userId: string;
  name: string;
  /** Their player id in this office (to place the celebration). */
  playerId: string | null;
}

export interface TipEvent {
  from: TipParty;
  to: TipParty;
  amount: number;
  note: string;
}

export interface BalanceEvent {
  balance: number;
  delta: number;
  kind: CoinKind;
}

declare module './types' {
  interface ClientToServerEvents {
    /** Send coins to someone signed in, in your office. */
    'coins:tip': (req: TipRequest, ack: (res: TipAnswer) => void) => void;
    /** The owner turns coins on or off for the office. */
    'coins:office': (enabled: boolean, ack: (res: { ok: true } | { ok: false; error: string }) => void) => void;
  }
  interface ServerToClientEvents {
    /** Your balance changed (to all your own tabs). */
    'coins:balance': (e: BalanceEvent) => void;
    /** Someone in the office tipped someone (for the celebration and the recipient's toast). */
    'coins:tipped': (e: TipEvent) => void;
    /** Whether coins are on in this office (sent on join and when the owner changes it). */
    'coins:office': (state: { enabled: boolean }) => void;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A tip request checked for shape and limits, or the reason it can't be sent. */
export function parseTip(raw: unknown): { ok: true; tip: TipRequest & { note: string } } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Bad request' };
  const r = raw as Record<string, unknown>;
  const { amount } = r;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < MIN_TIP || amount > MAX_TIP) {
    return { ok: false, error: `Send between ${MIN_TIP} and ${MAX_TIP} coins` };
  }
  if (typeof r.key !== 'string' || !UUID.test(r.key)) return { ok: false, error: 'Bad request' };
  const toPlayerId = typeof r.toPlayerId === 'string' && r.toPlayerId ? r.toPlayerId.slice(0, 64) : undefined;
  const toUserId = typeof r.toUserId === 'string' && r.toUserId ? r.toUserId.slice(0, 64) : undefined;
  if (!toPlayerId && !toUserId) return { ok: false, error: 'Choose who to send coins to' };
  if (r.note !== undefined && typeof r.note !== 'string') return { ok: false, error: 'Bad request' };
  const note = clip(((r.note as string | undefined) ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), MAX_TIP_NOTE);
  return { ok: true, tip: { toPlayerId, toUserId, amount, note, key: r.key.toLowerCase() } };
}

/** The UTC day of `ms` as YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A balance in few characters, for small badges: 999, 1.2k, 12k, 1.2M. */
export function compactCoins(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${Math.floor(n / 100) / 10}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${Math.floor(n / 100_000) / 10}M`;
}
