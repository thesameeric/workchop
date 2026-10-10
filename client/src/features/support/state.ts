import { create } from 'zustand';
import { sanitizeAvatar } from '../../../../shared/avatar';
import { seatsOf } from '../../../../shared/catalog';
import { findPath } from '../../../../shared/geometry';
import {
  CUSTOMER_SEAT,
  STAFF_SEAT,
  SUPPORT_DESK,
  SUMMON_TIMEOUT_MS,
  ticketConv,
  visitorName,
  type HistoryRequest,
  type MyTicket,
  type Summon,
  type SupportBoard,
  type SupportQueue,
  type Ticket,
} from '../../../../shared/support';
import type { AvatarConfig, ClientToServerEvents, OfficeItem } from '../../../../shared/types';
import { isCustomer } from '../../../../shared/workspace';
import { local } from '../../lib/positions';
import { getSession, type OfficeSession } from '../../lib/session';
import { getState, setState, toast, useStore } from '../../state/store';
import { SupportIcon } from '../../ui/icons';
import { sitOn, standUp, walkTo } from '../../world/movement';
import { officeData } from '../../world/officeCache';
import { loadConv } from '../chat/state';

// Customer support workspaces, on this side: what you are here (staff or customer), the queue and
// your ticket, and what to do about them. The server (server/features/support) decides; this
// keeps what it last said.

type SupportRole = 'staff' | 'customer';
/** The staff panel's tabs. */
export type StaffTab = 'desk' | 'queue' | 'history';

interface SupportState {
  /** Null outside support workspaces (and until the server has answered). */
  as: SupportRole | null;
  /** Staff: the queue, the desks in use and the ticket you're serving. */
  queue: SupportQueue;
  /** Everyone: the Now serving screen. */
  board: SupportBoard;
  /** Customers: your ticket. */
  ticket: MyTicket | null;
  /** Customers: your question is on its way to the queue. */
  entering: boolean;
  /** Customers: the "How can we help?" form is open (before a ticket, or for another question). */
  asking: boolean;
  /** Customers: what that form starts with (the question whose place in the queue ran out). */
  draft: string;
  /** Customers: the desk you were called to, until you sit down there. */
  summon: Summon | null;
  /** Customers: the ticket you took out of the queue yourself (it ends as abandoned, like one you were away too long from). */
  left: string | null;
  /** The support desk whose card is open. */
  deskCard: string | null;
  /** Staff: the panel's tab. */
  tab: StaffTab;
}

const EMPTY_QUEUE: SupportQueue = { waiting: [], desks: [], mine: null };
const EMPTY_BOARD: SupportBoard = { serving: [], waiting: 0 };

const initial = (): SupportState => ({
  as: null,
  queue: EMPTY_QUEUE,
  board: EMPTY_BOARD,
  ticket: null,
  entering: false,
  asking: false,
  draft: '',
  summon: null,
  left: null,
  deskCard: null,
  tab: 'desk',
});

export const useSupport = create<SupportState>()(initial);
const get = useSupport.getState;
const set = useSupport.setState;

// ---------- requests ----------

type Events = ClientToServerEvents;
type Params<E extends keyof Events> = Parameters<Events[E]>;
type Args<E extends keyof Events> = Params<E> extends [...infer A, unknown] ? A : never;
type Answer<E extends keyof Events> = Params<E> extends [...unknown[], infer Ack] ? (NonNullable<Ack> extends (res: infer R) => void ? R : never) : never;

const NOT_CONNECTED = 'Not connected. Check your connection and try again.';

/** Sends a request and waits for the answer (rejects when not connected, or after 15 s without one). */
function request<E extends keyof Events>(event: E, ...args: Args<E>): Promise<Answer<E>> {
  const s = getSession()?.socket;
  if (!s?.connected) return Promise.reject(new Error(NOT_CONNECTED));
  const timed = s.timeout(15_000) as unknown as { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
  return timed.emitWithAck(event, ...args) as Promise<Answer<E>>;
}

/** The answer when it worked, or null after saying what went wrong. */
async function ask<T extends object>(work: Promise<({ ok: true } & T) | { ok: false; error: string }>): Promise<T | null> {
  try {
    const res = await work;
    if (res.ok) return res;
    toast(res.error, 'error');
  } catch (err) {
    toast((err as Error).message === NOT_CONNECTED ? NOT_CONNECTED : 'The server didn’t answer. Try again.', 'error');
  }
  return null;
}

// ---------- customers: who you are and your question ----------

/** What a customer tells us before coming in. */
export interface Question {
  name: string;
  email: string;
  message: string;
}

const KEY_PREFIX = 'workchop:support-key:';
const SAVED_PREFIX = 'workchop:support:';
/** For browsers that keep nothing (private windows): this tab's key. */
const keys = new Map<string, string>();

/**
 * This browser's secret for this workspace (localStorage, 43 random characters): the server keeps its
 * hash, and the same key gets the same open ticket back after a reload, a reconnect or a restart.
 */
export function customerKey(officeId: string): string {
  const id = KEY_PREFIX + officeId;
  try {
    const have = localStorage.getItem(id);
    if (have && have.length >= 32) return have;
  } catch {
    // Not available: this tab's key.
  }
  let key = keys.get(officeId);
  if (!key) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    keys.set(officeId, key);
  }
  try {
    localStorage.setItem(id, key);
  } catch {
    // Kept for this tab only.
  }
  return key;
}

/** What this browser keeps for a workspace's customer. */
export interface Saved {
  name: string;
  email: string;
  /** The character you had, so you look the same when you come back. */
  avatar: AvatarConfig | null;
  /** The question of the ticket that was open when you were last here, to pick it up again. */
  open: string | null;
  /** "Remember me on this device": keep the name and email after the ticket closes. */
  remember: boolean;
}

const NOTHING_SAVED: Saved = { name: '', email: '', avatar: null, open: null, remember: false };

export function loadSaved(officeId: string): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_PREFIX + officeId) ?? '{}') as Partial<Saved>;
    return {
      name: typeof raw.name === 'string' ? raw.name : '',
      email: typeof raw.email === 'string' ? raw.email : '',
      avatar: raw.avatar && typeof raw.avatar === 'object' ? sanitizeAvatar(raw.avatar) : null,
      open: typeof raw.open === 'string' && raw.open ? raw.open : null,
      remember: raw.remember === true,
    };
  } catch {
    return NOTHING_SAVED;
  }
}

function save(officeId: string, saved: Saved): void {
  try {
    localStorage.setItem(SAVED_PREFIX + officeId, JSON.stringify(saved));
  } catch {
    // Not kept; fine.
  }
}

/** "Not you? Start over": forgets this browser's key and everything kept for this workspace. */
export function forgetMe(officeId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + officeId);
    localStorage.removeItem(SAVED_PREFIX + officeId);
  } catch {
    // Nothing was kept.
  }
  keys.delete(officeId);
  last = null;
}

/** Forgets the open question here (you'd rather ask something else). */
export function forgetOpen(officeId: string): void {
  const saved = loadSaved(officeId);
  if (saved.open) save(officeId, { ...saved, open: null });
}

/** The question from the lobby, asked once you're in (null: pick up where you left off). */
let pending: Question | null = null;
/** Your latest question here (to ask again when its place in the queue ran out). */
let last: Question | null = null;
/** Your character before you came in as a visitor, given back when you leave. */
let before: ReturnType<typeof getState>['me'] | null = null;

/**
 * From the customer lobby, just before going in: a new question (or null to pick up where you left
 * off), the look you'll have (customers come in as "Visitor"), and whether to remember you here.
 */
export function prepareVisit(officeId: string, question: Question | null, avatar: AvatarConfig, remember: boolean): void {
  const saved = loadSaved(officeId);
  save(officeId, question ? { ...saved, name: question.name, email: question.email, avatar, remember } : { ...saved, avatar });
  pending = question;
  last = question ?? (saved.open ? { name: saved.name, email: saved.email, message: saved.open } : null);
  before ??= getState().me;
  setState((s) => ({ me: { ...s.me, name: 'Visitor', avatar } }));
}

/** Who you said you are, for another question: as remembered here, or from this visit. */
export function lastDetails(officeId: string): Question {
  const saved = loadSaved(officeId);
  return { name: saved.name || last?.name || '', email: saved.email || last?.email || '', message: last?.message ?? '' };
}

/**
 * Sends support:enter: a new question, or (`resume`, an empty message) whatever your key has: the
 * open ticket, or how your last one ended. A resume that finds nothing just opens the question form.
 */
async function enterWith(question: Question, resume: boolean): Promise<boolean> {
  const officeId = getSession()?.officeId;
  if (!officeId) return false;
  set({ entering: true });
  let res: Answer<'support:enter'> | null = null;
  try {
    res = await request('support:enter', { name: question.name, email: question.email || undefined, message: question.message, key: customerKey(officeId) });
  } catch (err) {
    if (!resume) toast((err as Error).message === NOT_CONNECTED ? NOT_CONNECTED : 'The server didn’t answer. Try again.', 'error');
  }
  if (!res?.ok) {
    if (res && !resume) toast(res.error, 'error');
    set((s) => ({ entering: false, asking: s.asking || !s.ticket }));
    return false;
  }
  if (question.message) last = question;
  onTicket(res.ticket);
  // What was said while you were away (or before a reload).
  void loadConv(ticketConv(res.ticket.id), true);
  return true;
}

/** Puts a new question in the queue (your open ticket comes back instead, if there is one). */
export const enter = (question: Question) => enterWith(question, false);

/** Opens the question form, with `message` already in it (asking again after your place ran out). */
export function askAnother(message = ''): void {
  set({ asking: true, draft: message });
}

/** Asks again what you asked last (after your place in the queue ran out). */
export const askAgain = () => askAnother(last?.message ?? '');

export async function leaveQueue(): Promise<void> {
  const id = get().ticket?.id ?? null;
  if (await ask(request('support:leave-queue'))) set({ left: id });
}

export async function rate(rating: number): Promise<void> {
  const ticket = get().ticket;
  if (!ticket) return;
  set({ ticket: { ...ticket, rating } });
  if (!(await ask(request('support:rate', rating)))) set((s) => (s.ticket?.id === ticket.id ? { ticket: { ...s.ticket, rating: ticket.rating } } : {}));
}

const isOpen = (t: MyTicket | null) => t?.status === 'waiting' || t?.status === 'active';

/**
 * Keeps what's needed to pick your ticket up again while it's open; once it's closed, forgets it (and,
 * on a computer you didn't ask to be remembered on, your name and email too).
 */
function keep(officeId: string, ticket: MyTicket): void {
  const saved = loadSaved(officeId);
  if (isOpen(ticket)) {
    const next = last ? { ...saved, name: last.name, email: last.email, open: last.message || saved.open } : saved;
    if (next.open !== saved.open || next.name !== saved.name || next.email !== saved.email) save(officeId, next);
  } else if (saved.open || (!saved.remember && (saved.name || saved.email))) {
    save(officeId, saved.remember ? { ...saved, open: null } : { ...NOTHING_SAVED, avatar: saved.avatar });
  }
}

/**
 * Your ticket changed. Null only says this connection has no ticket yet: it's picked up again with
 * your key (see sync), so nothing is forgotten.
 */
function onTicket(ticket: MyTicket | null): void {
  if (!ticket) {
    if (!get().entering) set({ ticket: null, summon: null });
    return;
  }
  const was = get().ticket;
  set((s) => ({
    ticket,
    entering: false,
    draft: isOpen(ticket) ? '' : s.draft,
    // A closed ticket coming back doesn't close the question form you're filling in.
    asking: isOpen(ticket) ? false : s.asking,
    summon: ticket.status === 'active' ? s.summon : null,
  }));
  const officeId = getSession()?.officeId;
  if (officeId) keep(officeId, ticket);
  // Your number over your head, as the others see it.
  const name = visitorName(ticket.number);
  if (getState().me.name !== name) setState((s) => ({ me: { ...s.me, name } }));
  if (ticket.status === 'active' && (was?.id !== ticket.id || was.status !== 'active') && ticket.agent) {
    toast(`${ticket.agent.name} at ${ticket.agent.desk} is ready for you`, { icon: SupportIcon, duration: 8000 });
    // The chat opens beside the office where there's room for both.
    if (window.matchMedia('(min-width: 721px)').matches) setState({ panel: 'chat', mode: 'play' });
    // Back at your desk after a reload (a new call also comes with support:summon).
    const desk = getState().office?.items.find((i) => i.id === ticket.agent!.deskItemId);
    const seat = desk && seatsOf(desk)[CUSTOMER_SEAT];
    if (seat && !get().summon) onSummon({ ticketId: ticket.id, deskItemId: desk.id, seat, agentName: ticket.agent.name });
  }
  // Done at the desk: up from the customer's seat, so the next one can sit there.
  if (was?.status === 'active' && ticket.id === was.id && ticket.status !== 'active' && local.seat?.itemId === was.agent?.deskItemId) {
    standUp();
  }
}

// ---------- customers: being called ----------

let summonTimer: ReturnType<typeof setTimeout> | undefined;

const seatedAt = (seat: { x: number; z: number; itemId: string }) =>
  local.seat?.itemId === seat.itemId && Math.hypot(local.seat.x - seat.x, local.seat.z - seat.z) < 0.1;

/** You're called: walk to the desk's customer seat and sit down (or be put there if you can't). */
function onSummon(summon: Summon): void {
  const seat = { ...summon.seat, itemId: summon.deskItemId };
  clearTimeout(summonTimer);
  // Already sitting there (called again after a reconnect): nothing to do.
  if (seatedAt(seat)) {
    set({ summon: null });
    return;
  }
  set({ summon });
  const office = getState().office;
  if (!office) return;
  const path = findPath({ x: local.x, z: local.z }, seat, officeData(office).colliders, office.settings);
  // A tab in the background draws no frames, so it would never walk there: sit down at once.
  if (path?.length && document.visibilityState !== 'hidden') walkTo(seat.x, seat.z, seat);
  else sitOn(seat);
  summonTimer = setTimeout(() => {
    const { ticket } = get();
    if (ticket?.id === summon.ticketId && ticket.status === 'active' && !seatedAt(seat)) sitOn(seat);
  }, SUMMON_TIMEOUT_MS);
}

/** Whether you've reached the seat you were called to (then the summon is done). */
export function checkArrived(): void {
  const { summon } = get();
  if (summon && seatedAt({ ...summon.seat, itemId: summon.deskItemId })) set({ summon: null });
}

// ---------- staff ----------

export async function takeDesk(item: OfficeItem): Promise<void> {
  if (!(await ask(request('support:desk', item.id)))) return;
  const seat = seatsOf(item)[STAFF_SEAT];
  if (!seat) return;
  sitOn({ ...seat, itemId: item.id });
  set({ deskCard: null });
}

export async function leaveDesk(): Promise<void> {
  const desk = myDesk();
  if (!(await ask(request('support:desk', null)))) return;
  set({ deskCard: null });
  if (desk && local.seat?.itemId === desk.itemId) standUp();
}

/** Sits you back down at your desk. */
export function sitAtDesk(item: OfficeItem): void {
  const seat = seatsOf(item)[STAFF_SEAT];
  if (!seat) return;
  walkTo(seat.x, seat.z, { ...seat, itemId: item.id });
  set({ deskCard: null });
}

export async function callNext(): Promise<Ticket | null> {
  return (await ask(request('support:next')))?.ticket ?? null;
}

export async function resolve(): Promise<boolean> {
  const ticket = get().queue.mine;
  const ok = !!(await ask(request('support:resolve')));
  if (ok && ticket) toast(`Ticket #${ticket.number} resolved`);
  return ok;
}

/** Takes a customer out of the workspace (their open ticket ends, and they can't come back for a while). */
export async function removeVisitor(playerId: string): Promise<boolean> {
  const ok = !!(await ask(request('support:remove', playerId)));
  if (ok) toast('Visitor removed');
  return ok;
}

export async function fetchHistory(req: HistoryRequest): Promise<{ tickets: Ticket[]; more: boolean } | null> {
  return ask(request('support:history', req));
}

/** The desk you've taken, if any. */
export function myDesk(): SupportQueue['desks'][number] | undefined {
  const userId = getState().account?.id;
  return userId ? get().queue.desks.find((d) => d.userId === userId) : undefined;
}

export function useMyDesk(): SupportQueue['desks'][number] | undefined {
  const userId = useStore((s) => s.account?.id);
  return useSupport((s) => (userId ? s.queue.desks.find((d) => d.userId === userId) : undefined));
}

/** The oldest waiting ticket whose customer is here: who Next calls. */
export const nextUp = (queue: SupportQueue): Ticket | undefined => queue.waiting.find((t) => t.present);

// ---------- the session ----------

/** The support desk whose staff seat you're sitting in, if any. */
function deskSeatedAt(): string | null {
  const seat = local.seat;
  const item = seat ? getState().office?.items.find((i) => i.id === seat.itemId && i.type === SUPPORT_DESK) : undefined;
  const staff = item && seatsOf(item)[STAFF_SEAT];
  return seat && staff && Math.hypot(staff.x - seat.x, staff.z - seat.z) < 0.1 ? item.id : null;
}

/** Asks what you are here after every join (a reconnect is a new connection for the server too). */
async function sync(session: OfficeSession, rejoin: boolean): Promise<void> {
  const { role, kind } = getState();
  if (kind !== 'support') return;
  // Customers pick their ticket up again below; until then, "no ticket" from the server means nothing.
  if (isCustomer(role, kind)) set({ entering: true });
  // Staff: the desk you had before the connection dropped (or the one you're sitting at).
  const hadDesk = rejoin ? (myDesk()?.itemId ?? deskSeatedAt()) : null;
  let res: Answer<'support:state'>;
  try {
    res = await request('support:state');
  } catch {
    set({ entering: false });
    return;
  }
  if (res.as === 'staff') {
    set({ as: 'staff', queue: res.queue, board: res.board, entering: false });
    // Back on this connection: take your desk again (it waits a moment for you, and moves to this one).
    if (hadDesk) {
      void ask(request('support:desk', hadDesk));
      return;
    }
    // Back after a reload, with a desk that waited for you: sit down at it again (and see who you're serving).
    const desk = myDesk();
    const item = !rejoin && desk && getState().office?.items.find((i) => i.id === desk.itemId);
    const seat = item && seatsOf(item)[STAFF_SEAT];
    if (item && seat) sitOn({ ...seat, itemId: item.id });
    if (item && res.queue.mine && getState().panel === 'none') setState({ panel: 'support', mode: 'play' });
  } else if (res.as === 'customer') {
    set({ as: 'customer', board: res.board });
    // The question from the lobby; otherwise pick up where you left off (after a reload, a reconnect or a restart).
    const question = pending;
    pending = null;
    if (res.ticket) onTicket(res.ticket);
    else if (question) await enterWith(question, false);
    else await enterWith({ ...lastDetails(session.officeId), message: '' }, true);
  } else {
    set({ as: null, entering: false });
  }
}

/** Wires a support workspace's session: its events, and hearing your agent (or customer) at full volume. */
export function attach(session: OfficeSession): () => void {
  set(initial());
  const s = session.socket;
  const onQueue = (queue: SupportQueue) => set({ queue });
  const onBoard = (board: SupportBoard) => set({ board });
  s.on('support:queue', onQueue);
  s.on('support:board', onBoard);
  s.on('support:ticket', onTicket);
  s.on('support:summon', onSummon);
  const offJoined = session.onJoined((rejoin) => void sync(session, rejoin));
  // Made a member while you were here as a customer: you're staff now.
  const onRole = () => {
    if (get().as !== 'customer' || isCustomer(getState().role, getState().kind)) return;
    clearTimeout(summonTimer);
    pending = last = null;
    set(initial());
    if (before) {
      setState({ me: before });
      before = null;
    }
    void sync(session, false);
  };
  s.on('office:role', onRole);
  // The other side of your ticket is heard as if they were next to you, wherever they are.
  const partner = (st: SupportState) =>
    st.as === 'customer' ? (st.ticket?.status === 'active' ? (st.ticket.agent?.playerId ?? null) : null) : st.as === 'staff' ? (st.queue.mine?.playerId ?? null) : null;
  const unsub = useSupport.subscribe((st, prev) => {
    if (partner(st) !== partner(prev)) session.setFullVolume(partner(st));
  });
  return () => {
    s.off('support:queue', onQueue);
    s.off('support:board', onBoard);
    s.off('support:ticket', onTicket);
    s.off('support:summon', onSummon);
    s.off('office:role', onRole);
    offJoined();
    unsub();
    clearTimeout(summonTimer);
    pending = last = null;
    set(initial());
    // Back to who you were before coming in as a visitor.
    if (before) {
      const me = before;
      before = null;
      setState({ me });
    }
  };
}
