import crypto from 'node:crypto';
import { sanitizeName } from '../../../shared/avatar';
import { seatsOf } from '../../../shared/catalog';
import { cleanMessageText } from '../../../shared/chat';
import {
  AWAY_GRACE_MS,
  CLOSED_TICKET_RECALL_MS,
  CUSTOMER_IDLE_MS,
  CUSTOMER_SEAT,
  customerEmail,
  deskLabels,
  HELPER_AWAY_MS,
  MAX_CUSTOMER_NAME,
  MAX_CUSTOMERS_PER_ADDRESS,
  MAX_FIRST_MESSAGE,
  MAX_HELPERS,
  OFFER_MS,
  SUPPORT_DESK,
  ticketConv,
  visitorName,
  type Colleague,
  type ColleagueState,
  type HelpingEnded,
  type MyTicket,
  type OfferEnd,
  type SupportBoard,
  type SupportQueue,
  type SupportState,
  type TakenDesk,
  type Ticket,
  type TicketOffer,
} from '../../../shared/support';
import { clip } from '../../../shared/text';
import type { OfficeItem, PlayerState } from '../../../shared/types';
import { isCustomer } from '../../../shared/workspace';
import type { Feature, ServerContext, SocketContext } from '../../features';
import { addressKey, windowLimiter } from '../../limits';
import { deleteConversations, postToConversation, registerConversation, retentionFromEnv } from '../chat';
import { supportLink, type SupportParty } from './link';
import { migrations } from './migrations';
import { positions } from './queue';
import { inQueue, isOpen, SupportStore, toTicket, type TicketRow } from './store';

// Customer support workspaces: customers (guests there) open tickets and wait; staff take a help
// desk and call the next customer, who walks over. Tickets are kept in the database; who is at which
// desk, and which customer is here on which ticket, is kept in memory and rebuilt as people come
// back (after a restart, from the active tickets).

/** A refusal to show as is. */
class SupportError extends Error {}

const TICKET_ID = /^[a-z0-9]{16}$/;
/** A customer's browser secret (EnterRequest.key). */
const KEY = /^[A-Za-z0-9_-]{32,128}$/;
const HOUR = 3600_000;
/** New tickets per hour from one address in one workspace (a helpdesk's customers may share one). */
export const TICKETS_PER_ADDRESS = 30;
/** Open tickets from one address in one workspace at once. */
export const OPEN_TICKETS_PER_ADDRESS = 10;
/** What a customer may upload on one ticket, in all. */
export const CUSTOMER_UPLOAD_BYTES = 20 * 1024 * 1024;
/** A customer staff took out: how long their key can't open tickets, and their address can't come in. */
export const REMOVED_KEY_MS = 4 * HOUR;
export const REMOVED_ADDRESS_MS = HOUR;
const EXPIRY_BATCH = 500;
const MAX_NUMBER = 2 ** 31 - 1;

export interface SupportOptions {
  /** How long customers (and agents serving someone) may be away; default AWAY_GRACE_MS. */
  awayGraceMs?: number;
  /** How long a desk waits for its agent when they aren't serving anyone (default 30 s). */
  idleDeskMs?: number;
  /** Customers here this long without an open ticket are taken out (default CUSTOMER_IDLE_MS). */
  customerIdleMs?: number;
  /** How often away people, idle customers and old tickets are looked for (default every minute). */
  sweepEveryMs?: number;
  /** Delete closed tickets (with their chat) after this many days; default CHAT_RETENTION_DAYS (null keeps them). */
  retentionDays?: number | null;
  /** How long a colleague helping with a ticket may be gone before their part ends (default HELPER_AWAY_MS). */
  helperAwayMs?: number;
  /** How long an offer waits for an answer (default OFFER_MS). */
  offerMs?: number;
}

/** A help desk someone has taken. */
interface Desk {
  itemId: string;
  /** Where the desk stood when it was taken: moving it in build mode frees it. */
  at: { x: number; z: number; rot: number };
  userId: string;
  name: string;
  /** Their connection; null while they're away. */
  playerId: string | null;
  ticketId: string | null;
  awaySince: number | null;
  /** Frees the desk if its agent (not serving anyone) doesn't come back. */
  release?: ReturnType<typeof setTimeout>;
}

/** A colleague the agent serving a ticket invited into its conversation. */
interface Helper {
  userId: string;
  name: string;
  /** The ticket's number, for telling them when their part ends. */
  number: number;
  /** Their connection; null while they're away. */
  playerId: string | null;
  /** Ends their part if they don't come back. */
  release?: ReturnType<typeof setTimeout>;
}

/** An open offer, and the timer that ends it unanswered. */
interface Offer {
  offer: TicketOffer;
  timer: ReturnType<typeof setTimeout>;
}

/** A customer connection on a ticket (`closed`: how it ended, for the thanks and the rating). */
interface Customer {
  ticketId: string;
  keyHash: string;
  /** The name on the ticket, which their messages in its chat carry. */
  name: string;
  closed: MyTicket | null;
}

/** A customer connection here, with or without a ticket. */
interface Visitor {
  address: string;
  /** Since when they've had no open ticket (null while they have one). */
  idleSince: number | null;
}

interface Snapshot {
  waiting: TicketRow[];
  active: TicketRow[];
  ahead: Map<string, number>;
  labels: Map<string, string>;
  /** Open tickets whose customers are here, with their newest connection. */
  present: Map<string, string>;
  board: SupportBoard;
}

/** A support workspace's live state. */
interface Office {
  officeId: string;
  /** Loading the active tickets' desks (after a restart they wait for their agents); see loaded(). */
  loading: Promise<void> | null;
  desks: Map<string, Desk>;
  /** By socket id. */
  customers: Map<string, Customer>;
  /** Every customer connection here, by socket id. */
  visitors: Map<string, Visitor>;
  /** Everyone here (socket ids). */
  sockets: Set<string>;
  /** Customer connections with a support:enter in progress (one at a time each). */
  entering: Set<string>;
  /** Bytes customers uploaded, by ticket. */
  uploaded: Map<string, number>;
  /** Colleagues helping, by ticket id (at most MAX_HELPERS each). */
  helpers: Map<string, Helper[]>;
  /** Open offers, by id. */
  offers: Map<string, Offer>;
  /** Updates are sent one at a time; `queued` is the one not started yet. */
  chain: Promise<void>;
  queued: Promise<void> | null;
  /** What was sent last: the snapshot, and to each socket (and the board), to send only changes. */
  snap: Snapshot | null;
  sent: Map<string, string>;
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
/** Sorts desks by number ("Desk 2" is 2). */
const byDesk = (labels: Map<string, string>, itemId: string | null) => Number(labels.get(itemId ?? '')?.slice(5)) || 0;
const placeOf = (item: OfficeItem) => ({ x: item.x, z: item.z, rot: item.rot });
const closedTicket = (r: TicketRow): MyTicket => ({ id: r.id, number: r.number, status: r.status, ahead: null, agent: null, rating: r.rating, helpers: [] });
/** What stops an offer working now (besides someone not being here): see offerTexts. */
type Problem = 'not-serving' | 'no-desk' | 'serving' | 'helping' | 'already' | 'full';

export function supportFeature(opts: SupportOptions = {}): Feature {
  return {
    name: 'support',
    migrations,
    register: (ctx) =>
      registerSupport(ctx, {
        graceMs: opts.awayGraceMs ?? AWAY_GRACE_MS,
        idleDeskMs: opts.idleDeskMs ?? 30_000,
        customerIdleMs: opts.customerIdleMs ?? CUSTOMER_IDLE_MS,
        sweepEveryMs: opts.sweepEveryMs ?? 60_000,
        retentionDays: opts.retentionDays !== undefined ? opts.retentionDays : retentionFromEnv(),
        helperAwayMs: opts.helperAwayMs ?? HELPER_AWAY_MS,
        offerMs: opts.offerMs ?? OFFER_MS,
      }),
  };
}

export const feature = supportFeature();

function registerSupport(
  ctx: ServerContext,
  opts: { graceMs: number; idleDeskMs: number; customerIdleMs: number; sweepEveryMs: number; retentionDays: number | null; helperAwayMs: number; offerMs: number },
): void {
  const { realtime, store: offices, io } = ctx;
  const tickets = new SupportStore(ctx.db);
  const live = new Map<string, Office>();
  const newTickets = windowLimiter(TICKETS_PER_ADDRESS, HOUR);
  /** Keys and addresses of customers staff took out, until when ("<office>:<key hash or address>"). */
  const blockedKeys = new Map<string, number>();
  const blockedAddresses = new Map<string, number>();
  const blocked = (map: Map<string, number>, key: string) => (map.get(key) ?? 0) > Date.now();

  const isSupport = (officeId: string) => offices.peek(officeId)?.kind === 'support';
  const addressOf = (s: SocketContext) => addressKey(ctx.socketIp(s.socket));
  const staffHere = (st: Office) => [...st.sockets].filter((id) => !st.visitors.has(id));
  const deskOfUser = (st: Office, userId: string) => [...st.desks.values()].find((d) => d.userId === userId);
  const deskOfPlayer = (st: Office, playerId: string) => [...st.desks.values()].find((d) => d.playerId === playerId);
  const customerSockets = (st: Office, ticketId: string | null) => [...st.customers].filter(([, c]) => c.ticketId === ticketId).map(([id]) => id);
  const relink = (st: Office, ids: (string | null)[]) => realtime.relink(st.officeId, ids.filter((id): id is string => !!id));

  /** The live state of a support workspace someone is in. */
  const officeOf = (officeId: string): Office => {
    let st = live.get(officeId);
    if (!st) {
      st = {
        officeId,
        loading: null,
        desks: new Map(),
        customers: new Map(),
        visitors: new Map(),
        sockets: new Set(),
        entering: new Set(),
        uploaded: new Map(),
        helpers: new Map(),
        offers: new Map(),
        chain: Promise.resolve(),
        queued: null,
        snap: null,
        sent: new Map(),
      };
      live.set(officeId, st);
      void loaded(st).catch(() => {});
    }
    return st;
  };

  /** The workspace's state once its active tickets' desks are in (tried again after a failure). */
  const loaded = async (st: Office): Promise<Office> => {
    st.loading ??= (async () => {
      const items = offices.peek(st.officeId)?.office.items ?? [];
      for (const r of await tickets.open(st.officeId)) {
        if (r.status !== 'active' || !r.assignee_user_id || !r.desk_item_id) continue;
        // Agents serving someone when the server stopped get their desk back if they return in time
        // (unless the desk is gone meanwhile: then the customer goes back to the queue).
        const item = items.find((i) => i.id === r.desk_item_id && i.type === SUPPORT_DESK);
        if (!item || st.desks.has(item.id) || deskOfUser(st, r.assignee_user_id)) {
          await tickets.requeue(r.id, r.assignee_user_id);
          continue;
        }
        st.desks.set(item.id, { itemId: item.id, at: placeOf(item), userId: r.assignee_user_id, name: r.assignee_name ?? '', playerId: null, ticketId: r.id, awaySince: Date.now() });
      }
    })().catch((err) => {
      st.loading = null;
      console.error('[support] could not load the desks in use:', err);
      throw err;
    });
    await st.loading;
    return st;
  };

  /** Forgets a workspace nobody is in, unless a desk is waiting for its agent. */
  const forget = (st: Office) => {
    if (!st.sockets.size && !st.desks.size && !st.helpers.size && !st.offers.size && live.get(st.officeId) === st) live.delete(st.officeId);
  };

  /** A staff member's connections here. */
  const staffSockets = (st: Office, userId: string) => staffHere(st).filter((id) => realtime.contextOf(id)?.user?.id === userId);
  /** The ticket someone helps with, and their part in it. */
  const helpingOf = (st: Office, userId: string): { ticketId: string; helper: Helper } | undefined => {
    for (const [ticketId, list] of st.helpers) {
      const helper = list.find((h) => h.userId === userId);
      if (helper) return { ticketId, helper };
    }
    return undefined;
  };
  /** Everyone on a ticket: the agent serving it, its customer's connections and the colleagues helping. */
  const onTicket = (st: Office, ticketId: string) => [
    ...[...st.desks.values()].filter((d) => d.ticketId === ticketId).map((d) => d.playerId),
    ...customerSockets(st, ticketId),
    ...(st.helpers.get(ticketId) ?? []).map((h) => h.playerId),
  ];
  const labelsOf = (st: Office) => deskLabels(offices.peek(st.officeId)?.office.items ?? []);

  /** A colleague's part in a ticket ends (they're relinked; the caller writes any history line). */
  const dropHelper = (st: Office, ticketId: string, helper: Helper) => {
    clearTimeout(helper.release);
    const rest = (st.helpers.get(ticketId) ?? []).filter((h) => h !== helper);
    if (rest.length) st.helpers.set(ticketId, rest);
    else st.helpers.delete(ticketId);
    relink(st, [helper.playerId, ...onTicket(st, ticketId)]);
  };

  const logEvent = (ticketId: string, kind: 'joined' | 'left', actor: string, other: string | null) =>
    void tickets.addEvent(ticketId, kind, actor, other).catch((err) => console.error('[support] could not save a ticket’s history:', err));

  /**
   * Ends an offer, telling the staff who didn't end it: the sender (accepted, declined, a failed
   * accept), the recipient (cancelled), or both (expired, or it stopped working). Callers publish.
   */
  const endOffer = (st: Office, entry: Offer, why: OfferEnd, note?: string, tell: 'from' | 'to' | 'both' = why === 'cancelled' ? 'to' : why === 'accepted' || why === 'declined' ? 'from' : 'both') => {
    if (st.offers.get(entry.offer.id) === entry) st.offers.delete(entry.offer.id);
    clearTimeout(entry.timer);
    const users = tell === 'both' ? [entry.offer.from.userId, entry.offer.to.userId] : [tell === 'from' ? entry.offer.from.userId : entry.offer.to.userId];
    const ids = users.flatMap((u) => staffSockets(st, u));
    if (ids.length) io.to(ids).emit('support:offer:ended', note ? { offer: entry.offer, why, note } : { offer: entry.offer, why });
  };

  /** A ticket's offers stop working (it closed, or went back to the queue): `note` says why, by its visitor's name. */
  const endOffersFor = (st: Office, ticketId: string, note: (visitor: string) => string) => {
    for (const entry of [...st.offers.values()]) if (entry.offer.ticketId === ticketId) endOffer(st, entry, 'gone', note(visitorName(entry.offer.number)));
  };

  /**
   * The colleagues helping with a ticket that closed or went back to the queue are told, and their
   * parts end (`left`: with a history line each, when the ticket stays open).
   */
  const endHelpers = (st: Office, ticketId: string, why: HelpingEnded['why'], agent: string, left: boolean) => {
    const list = st.helpers.get(ticketId) ?? [];
    st.helpers.delete(ticketId);
    for (const helper of list) {
      clearTimeout(helper.release);
      const ids = staffSockets(st, helper.userId);
      if (ids.length) io.to(ids).emit('support:helping:ended', { ticketId, number: helper.number, why, agent });
      if (left) logEvent(ticketId, 'left', helper.userId, null);
    }
    relink(st, list.map((h) => h.playerId));
  };

  /** A ticket is back in the queue (its agent left, or their desk changed). */
  const requeued = (st: Office, ticketId: string, agent: string) => {
    endHelpers(st, ticketId, 'ended', agent, true);
    endOffersFor(st, ticketId, (visitor) => `${visitor} is back in the queue.`);
  };

  /** Frees a desk; a ticket it was serving goes back to the front of the queue. */
  const freeDesk = async (st: Office, desk: Desk) => {
    if (st.desks.get(desk.itemId) === desk) st.desks.delete(desk.itemId);
    clearTimeout(desk.release);
    relink(st, [desk.playerId, ...customerSockets(st, desk.ticketId)]);
    const ticketId = desk.ticketId;
    // Only while it's still theirs: a ticket handed over meanwhile stays with its new agent.
    if (ticketId && (await tickets.requeue(ticketId, desk.userId))) requeued(st, ticketId, desk.name);
  };

  /** Moves a desk to another connection of its agent (a second tab, or back after a reload). */
  const moveDesk = (st: Office, desk: Desk, playerId: string) => {
    const before = desk.playerId;
    desk.playerId = playerId;
    desk.awaySince = null;
    clearTimeout(desk.release);
    relink(st, [before, playerId, ...(desk.ticketId ? onTicket(st, desk.ticketId) : [])]);
  };

  /** A desk whose agent is away and serves nobody waits a moment for them, then is free. */
  const releaseLater = (st: Office, desk: Desk) => {
    clearTimeout(desk.release);
    desk.release = setTimeout(() => {
      if (st.desks.get(desk.itemId) !== desk || desk.playerId || desk.ticketId) return;
      st.desks.delete(desk.itemId);
      changed(st);
      forget(st);
    }, opts.idleDeskMs);
    desk.release.unref();
  };

  /**
   * The customers on a ticket that just closed see how it ended, and are idle from now; the
   * colleagues helping are told, and its offers end.
   */
  const closedFor = (st: Office, row: TicketRow) => {
    for (const [id, c] of st.customers) {
      if (c.ticketId !== row.id) continue;
      c.closed = closedTicket(row);
      const v = st.visitors.get(id);
      if (v) v.idleSince = Date.now();
    }
    const agent = [...st.desks.values()].find((d) => d.ticketId === row.id)?.name ?? row.assignee_name ?? '';
    for (const desk of st.desks.values()) if (desk.ticketId === row.id) desk.ticketId = null;
    endHelpers(st, row.id, row.status === 'resolved' ? 'resolved' : 'ended', agent, false);
    endOffersFor(st, row.id, (visitor) => `${visitor}’s ticket is closed.`);
  };

  // ---------- what people see ----------

  const snapshot = async (st: Office): Promise<Snapshot> => {
    await loaded(st);
    const rows = await tickets.open(st.officeId);
    // Tickets closed elsewhere (another tab, a race with Resolve) are closed here too.
    const open = new Set(rows.map((r) => r.id));
    for (const [id, c] of [...st.customers]) {
      if (c.closed || open.has(c.ticketId)) continue;
      const row = await tickets.byId(st.officeId, c.ticketId);
      if (row && !isOpen(row.status)) closedFor(st, row);
      else if (!row) {
        st.customers.delete(id);
        st.sent.delete(id);
        io.to(id).emit('support:ticket', null);
      }
    }
    const labels = deskLabels(offices.peek(st.officeId)?.office.items ?? []);
    const ahead = positions(rows.filter((r) => r.status === 'waiting').map(inQueue));
    const waiting = rows.filter((r) => r.status === 'waiting').sort((a, b) => ahead.get(a.id)! - ahead.get(b.id)!);
    const active = rows.filter((r) => r.status === 'active');
    const serving = active
      .sort((a, b) => byDesk(labels, a.desk_item_id) - byDesk(labels, b.desk_item_id))
      .map((r) => ({ number: r.number, desk: labels.get(r.desk_item_id ?? '') ?? 'Desk' }));
    // The newest of a ticket's connections (the customer back on a new one, before the old one's gone).
    const present = new Map<string, string>();
    for (const [socketId, c] of st.customers) if (!c.closed) present.set(c.ticketId, socketId);
    return { waiting, active, ahead, labels, present, board: { serving, waiting: waiting.length } };
  };

  const ticketOf = (st: Office, snap: Snapshot, r: TicketRow): Ticket => ({
    ...toTicket(r, snap.present.get(r.id) ?? null),
    helpers: (st.helpers.get(r.id) ?? []).map((h) => ({ userId: h.userId, name: h.name, playerId: h.playerId })),
  });

  /**
   * The signed-in staff who are here, hold a desk or help with a ticket (you too: queueFor leaves
   * you out), by desk, then name.
   */
  const colleaguesOf = (st: Office, labels: Map<string, string>): Colleague[] => {
    const here = new Map<string, { name: string; playerId: string }>();
    for (const id of staffHere(st)) {
      const s = realtime.contextOf(id);
      if (s?.user && !here.has(s.user.id)) here.set(s.user.id, { name: s.me()?.name ?? s.user.name, playerId: id });
    }
    const users = new Set([...here.keys(), ...[...st.desks.values()].map((d) => d.userId), ...[...st.helpers.values()].flat().map((h) => h.userId)]);
    const deskNumber = (c: Colleague) => Number(c.desk?.slice(5)) || Infinity;
    return [...users]
      .map((userId): Colleague => {
        const desk = deskOfUser(st, userId);
        const helping = helpingOf(st, userId);
        const state: ColleagueState = desk?.ticketId ? 'serving' : helping ? 'helping' : desk && !desk.playerId ? 'away' : desk ? 'free' : 'no-desk';
        return {
          userId,
          name: desk?.name ?? helping?.helper.name ?? here.get(userId)?.name ?? '',
          playerId: desk?.playerId ?? helping?.helper.playerId ?? here.get(userId)?.playerId ?? null,
          desk: desk ? (labels.get(desk.itemId) ?? 'Desk') : null,
          state,
          helping: helping?.ticketId ?? null,
        };
      })
      .sort((a, b) => deskNumber(a) - deskNumber(b) || a.name.localeCompare(b.name));
  };

  const queueFor = (st: Office, snap: Snapshot, userId: string | null, colleagues = colleaguesOf(st, snap.labels)): SupportQueue => {
    const desks: TakenDesk[] = [...st.desks.values()]
      .sort((a, b) => byDesk(snap.labels, a.itemId) - byDesk(snap.labels, b.itemId))
      .map((d) => ({ itemId: d.itemId, label: snap.labels.get(d.itemId) ?? 'Desk', userId: d.userId, name: d.name, playerId: d.playerId, ticketId: d.ticketId }));
    const mine = userId ? snap.active.find((r) => r.assignee_user_id === userId) : undefined;
    const helpingId = userId ? helpingOf(st, userId)?.ticketId : undefined;
    const helping = helpingId ? snap.active.find((r) => r.id === helpingId) : undefined;
    const offers = [...st.offers.values()].map((e) => e.offer);
    return {
      waiting: snap.waiting.map((r) => ticketOf(st, snap, r)),
      desks,
      mine: mine ? ticketOf(st, snap, mine) : null,
      helping: helping ? ticketOf(st, snap, helping) : null,
      colleagues: colleagues.filter((c) => c.userId !== userId),
      offers: { outgoing: offers.find((o) => o.from.userId === userId) ?? null, incoming: offers.find((o) => o.to.userId === userId) ?? null },
    };
  };

  const ticketFor = (st: Office, snap: Snapshot, c: Customer | undefined): MyTicket | null => {
    if (!c) return null;
    if (c.closed) return c.closed;
    const r = [...snap.waiting, ...snap.active].find((t) => t.id === c.ticketId);
    if (!r) return null;
    const desk = r.desk_item_id ? st.desks.get(r.desk_item_id) : undefined;
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      ahead: r.status === 'waiting' ? (snap.ahead.get(r.id) ?? 0) : null,
      agent:
        r.status === 'active' && r.desk_item_id
          ? { name: desk?.name ?? r.assignee_name ?? '', playerId: desk?.playerId ?? null, deskItemId: r.desk_item_id, desk: snap.labels.get(r.desk_item_id) ?? 'Desk' }
          : null,
      rating: r.rating,
      helpers: r.status === 'active' ? (st.helpers.get(r.id) ?? []).map((h) => ({ name: h.name, playerId: h.playerId })) : [],
    };
  };

  /**
   * Sends what changed: the queue to staff, each customer on a ticket their ticket (nothing to those
   * who haven't sent support:enter yet), everyone the board.
   */
  const publish = (st: Office): Promise<void> => {
    if (st.queued) return st.queued;
    const run = st.chain.then(async () => {
      st.queued = null;
      checkOffers(st);
      const snap = await snapshot(st);
      st.snap = snap;
      const colleagues = colleaguesOf(st, snap.labels);
      const send = (to: string, json: string, emit: () => void) => {
        if (st.sent.get(to) === json) return;
        st.sent.set(to, json);
        emit();
      };
      send('board', JSON.stringify(snap.board), () => realtime.emitToOffice(st.officeId, 'support:board', snap.board));
      for (const id of st.sockets) {
        const s = realtime.contextOf(id);
        if (!s) continue;
        if (st.visitors.has(id)) {
          const c = st.customers.get(id);
          if (!c) continue;
          const ticket = ticketFor(st, snap, c);
          send(id, JSON.stringify(ticket), () => io.to(id).emit('support:ticket', ticket));
        } else {
          const queue = queueFor(st, snap, s.user?.id ?? null, colleagues);
          send(id, JSON.stringify(queue), () => io.to(id).emit('support:queue', queue));
        }
      }
    });
    st.queued = run;
    st.chain = run.catch((err) => console.error('[support] could not send the queue:', err));
    return run;
  };
  const changed = (st: Office) => void publish(st).catch(() => {});

  // ---------- offers ----------

  /**
   * What stops an offer working now, besides someone not being here: the sender no longer serving
   * the ticket, or the recipient busy (or, for an invite, the conversation full).
   */
  const problemOf = (st: Office, o: Pick<TicketOffer, 'kind' | 'ticketId' | 'from' | 'to'>): Problem | null => {
    if (deskOfUser(st, o.from.userId)?.ticketId !== o.ticketId) return 'not-serving';
    const desk = deskOfUser(st, o.to.userId);
    if (o.kind === 'transfer' && !desk) return 'no-desk';
    if (desk?.ticketId) return 'serving';
    const helping = helpingOf(st, o.to.userId)?.ticketId;
    if (helping && helping !== o.ticketId) return 'helping';
    if (o.kind === 'invite' && helping) return 'already';
    if (o.kind === 'invite' && (st.helpers.get(o.ticketId)?.length ?? 0) >= MAX_HELPERS) return 'full';
    return null;
  };

  /** A problem's words: to the sender when sending, to the recipient accepting, and to the sender when it stops working. */
  const offerTexts = (problem: Problem, o: Pick<TicketOffer, 'number' | 'from' | 'to'>): { send: string; accept: string; note: string } => {
    const visitor = visitorName(o.number);
    const to = o.to.name;
    switch (problem) {
      case 'not-serving':
        return { send: 'You’re not serving anyone.', accept: `${o.from.name} isn’t serving ${visitor} any more.`, note: `${visitor} isn’t at your desk any more.` };
      case 'no-desk':
        return { send: `${to} isn’t at a desk.`, accept: 'Take a desk first.', note: `${to} isn’t at a desk.` };
      case 'serving':
        return { send: `${to} is serving someone.`, accept: 'Resolve your ticket first.', note: `${to} is serving someone.` };
      case 'helping':
        return { send: `${to} is helping with another ticket.`, accept: 'Leave the conversation you’re helping with first.', note: `${to} is helping with another ticket.` };
      case 'already':
        return { send: `${to} is already helping.`, accept: 'That offer is no longer open.', note: `${to} is already helping.` };
      case 'full':
        return { send: 'Two colleagues are helping already.', accept: 'Two colleagues are helping already.', note: 'Two colleagues are helping already.' };
    }
  };

  /** Open offers that stopped working end (at the start of every publish). */
  const checkOffers = (st: Office) => {
    for (const entry of [...st.offers.values()]) {
      const problem = problemOf(st, entry.offer);
      if (problem) endOffer(st, entry, 'gone', offerTexts(problem, entry.offer).note);
    }
  };

  // ---------- calls ----------

  // Who is a customer and who serves whom is looked up once per check of the office's calls.
  realtime.addLinkRule((officeId) => {
    if (!isSupport(officeId)) return null;
    const st = officeOf(officeId);
    const served = new Set<string>();
    const serving = new Map<string, string>();
    for (const d of st.desks.values()) {
      if (!d.ticketId) continue;
      served.add(d.ticketId);
      if (d.playerId) serving.set(d.playerId, d.ticketId);
    }
    const helping = new Map<string, string>();
    for (const [ticketId, list] of st.helpers) for (const h of list) if (h.playerId) helping.set(h.playerId, ticketId);
    const parties = new Map<string, SupportParty>();
    const party = (p: PlayerState): SupportParty => {
      let found = parties.get(p.id);
      if (!found) {
        const c = st.customers.get(p.id);
        const ticketId = c && !c.closed && served.has(c.ticketId) ? c.ticketId : null;
        found = p.customer ? { customer: true, serving: ticketId } : { customer: false, serving: serving.get(p.id) ?? null, helping: helping.get(p.id) ?? null };
        parties.set(p.id, found);
      }
      return found;
    };
    return (a, b) => supportLink(party(a), party(b));
  });

  // ---------- who may come in, and upload ----------

  // A few customers per address, so one can't fill the lobby; none from an address staff took out.
  realtime.addJoinCheck((officeId, s, role) => {
    if (!isCustomer(role, offices.peek(officeId)?.kind)) return null;
    const address = addressOf(s);
    if (blocked(blockedAddresses, `${officeId}:${address}`)) return 'You can’t come in right now. Please try again later.';
    const here = [...(live.get(officeId)?.visitors.values() ?? [])].filter((v) => v.address === address).length;
    return here >= MAX_CUSTOMERS_PER_ADDRESS ? 'There are a few visitors from your network here already. Please try again later.' : null;
  });

  // Customers send files only in an open ticket, and not too many.
  ctx.uploads.addCheck((socketId, officeId, bytes) => {
    const st = live.get(officeId);
    if (!isCustomer(realtime.contextOf(socketId)?.role(), offices.peek(officeId)?.kind)) return null;
    const c = st?.customers.get(socketId);
    if (!st || !c || c.closed) return 'Open a ticket to send files.';
    const used = st.uploaded.get(c.ticketId) ?? 0;
    if (used + bytes > CUSTOMER_UPLOAD_BYTES) return 'That’s a lot of files for one question. Send a link instead.';
    st.uploaded.set(c.ticketId, used + bytes);
    return null;
  });

  // ---------- ticket chat ----------

  ctx.onClose(
    registerConversation(ctx, 't', {
      async access(s, key, officeId) {
        const id = key.slice(2);
        if (!TICKET_ID.test(id) || !isSupport(officeId)) return null;
        const customer = isCustomer(s.role(), 'support');
        if (customer && live.get(officeId)?.customers.get(s.socket.id)?.ticketId !== id) return null;
        if (!s.role()) return null;
        const row = await tickets.byId(officeId, id);
        if (!row) return null;
        const closed = { write: false as const, why: 'This ticket is closed.' };
        if (customer) {
          // The customer on it (checked against the ticket itself) reads it, and writes while it's open.
          if (row.customer_key !== live.get(officeId)?.customers.get(s.socket.id)?.keyHash) return null;
          return isOpen(row.status) ? { write: true } : closed;
        }
        // Staff read every ticket; whoever is serving it writes, and the colleagues helping.
        const userId = s.user?.id;
        const helping = !!userId && !!live.get(officeId)?.helpers.get(id)?.some((h) => h.userId === userId);
        if (row.status === 'active' && (row.assignee_user_id === s.user?.id || helping)) return { write: true };
        return isOpen(row.status) ? { write: false, why: 'Only the people helping with this ticket can write here.' } : closed;
      },
      audience(officeId, key) {
        const st = live.get(officeId);
        return st ? [...staffHere(st), ...customerSockets(st, key.slice(2))] : [];
      },
      ownsGuestMessage(s, key) {
        const room = s.room();
        return !!room && live.get(room.officeId)?.customers.get(s.socket.id)?.ticketId === key.slice(2);
      },
      // Customers write under the name on their ticket (only staff and they see the chat).
      nameOf(s, key) {
        const room = s.room();
        const c = room ? live.get(room.officeId)?.customers.get(s.socket.id) : undefined;
        return c?.ticketId === key.slice(2) ? c.name : null;
      },
    }),
  );

  // ---------- requests ----------

  /** Answers a request with what `work` returns, or with why it failed. */
  const answer = <T extends object>(ack: unknown, work: () => Promise<T>) => {
    const reply = typeof ack === 'function' ? (ack as (res: unknown) => void) : () => {};
    work().then(
      (res) => reply({ ok: true, ...res }),
      (err) => {
        if (!(err instanceof SupportError)) console.error('[support] a request failed:', err);
        reply({ ok: false, error: err instanceof SupportError ? err.message : 'Something went wrong. Please try again.' });
      },
    );
  };

  /** Where this connection is: a support workspace, and whether as staff or as a customer. */
  const where = async (s: SocketContext, as?: 'staff' | 'customer') => {
    const room = s.room();
    if (!room || !isSupport(room.officeId)) throw new SupportError('This isn’t a support workspace.');
    const customer = isCustomer(s.role(), 'support');
    if (as === 'staff' && customer) throw new SupportError('Only staff can do that.');
    if (as === 'customer' && !customer) throw new SupportError('Only customers can do that.');
    return { st: await loaded(officeOf(room.officeId)), officeId: room.officeId, customer };
  };

  const summon = (st: Office, desk: Desk, ticketId: string) => {
    const item = offices.peek(st.officeId)?.office.items.find((i) => i.id === desk.itemId);
    if (!item) return;
    const seat = seatsOf(item)[CUSTOMER_SEAT] ?? { x: item.x, z: item.z, ry: 0 };
    const ids = customerSockets(st, ticketId);
    if (ids.length) io.to(ids).emit('support:summon', { ticketId, deskItemId: desk.itemId, seat, agentName: desk.name });
  };

  realtime.onSocket((s) => {
    const { socket } = s;
    const canState = s.limiter(5, 20);
    const canEnter = s.limiter(1, 8);
    const canAct = s.limiter(2, 12);
    const canSearch = s.limiter(3, 10);
    const limit = (ok: boolean) => {
      if (!ok) throw new SupportError('You’re doing that too quickly. Please wait a moment.');
    };

    socket.on('support:state', (ack) => {
      // Asked too often: no answer.
      if (typeof ack !== 'function' || !canState()) return;
      void (async (): Promise<SupportState> => {
        const room = s.room();
        if (!room || !isSupport(room.officeId)) return { as: 'none' };
        const st = await loaded(officeOf(room.officeId));
        const snap = st.snap ?? (await snapshot(st));
        const id = socket.id;
        if (isCustomer(s.role(), 'support')) {
          const c = st.customers.get(id);
          const ticket = ticketFor(st, snap, c);
          if (c) st.sent.set(id, JSON.stringify(ticket));
          return { as: 'customer', ticket, board: snap.board };
        }
        const queue = queueFor(st, snap, s.user?.id ?? null);
        st.sent.set(id, JSON.stringify(queue));
        return { as: 'staff', queue, board: snap.board };
      })().then(ack, (err) => {
        console.error('[support] could not answer support:state:', err);
        ack({ as: 'none' });
      });
    });

    socket.on('support:enter', (req, ack) =>
      answer(ack, async () => {
        const { st, officeId } = await where(s, 'customer');
        limit(canEnter());
        const key = req && typeof req === 'object' ? req.key : undefined;
        if (typeof key !== 'string' || !KEY.test(key)) throw new SupportError('Reload the page and try again.');
        const keyHash = sha256(key);
        if (blocked(blockedKeys, `${officeId}:${keyHash}`)) throw new SupportError('You can’t open tickets here right now.');
        const mine = st.customers.get(socket.id);
        // Back on the ticket this connection is already on, with nothing new: what we know will do.
        if (mine && !mine.closed && mine.keyHash === keyHash && st.snap) {
          const ticket = ticketFor(st, st.snap, mine);
          if (ticket) return { ticket };
        }
        if (st.entering.has(socket.id)) throw new SupportError('One moment…');
        st.entering.add(socket.id);
        try {
          return await enter(s, st, officeId, keyHash, req, mine);
        } finally {
          st.entering.delete(socket.id);
        }
      }),
    );

    socket.on('support:leave-queue', (ack) =>
      answer(ack, async () => {
        const { st } = await where(s, 'customer');
        limit(canAct());
        const c = st.customers.get(socket.id);
        if (!c || c.closed) throw new SupportError('You’re not in the queue.');
        const row = await tickets.close(c.ticketId, ['waiting']);
        if (!row) throw new SupportError('You’re being helped right now.');
        closedFor(st, row);
        await publish(st);
        return {};
      }),
    );

    socket.on('support:rate', (rating, ack) =>
      answer(ack, async () => {
        const { st, officeId } = await where(s, 'customer');
        limit(canAct());
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new SupportError('Pick 1 to 5 stars.');
        const c = st.customers.get(socket.id);
        if (!c) throw new SupportError('There’s nothing to rate yet.');
        const rated = await tickets.rate(officeId, c.keyHash, rating);
        if (rated === 'none') throw new SupportError('There’s nothing to rate yet.');
        if (rated === 'rated') throw new SupportError('You’ve rated it already. Thanks!');
        for (const other of st.customers.values()) if (other.closed?.id === rated.id) other.closed = { ...other.closed, rating };
        await publish(st);
        return {};
      }),
    );

    socket.on('support:desk', (itemId, ack) =>
      answer(ack, async () => {
        const { st, officeId } = await where(s, 'staff');
        limit(canAct());
        const user = s.user;
        const me = s.me();
        if (!user || !me) throw new SupportError('Sign in to take a desk.');
        const mine = deskOfUser(st, user.id);
        if (itemId === null) {
          if (mine?.ticketId) throw new SupportError('Resolve your ticket first.');
          if (mine) await freeDesk(st, mine);
        } else {
          const item = typeof itemId === 'string' ? offices.peek(officeId)?.office.items.find((i) => i.id === itemId && i.type === SUPPORT_DESK) : undefined;
          if (!item) throw new SupportError('That desk is gone.');
          const taken = st.desks.get(item.id);
          if (taken && taken.userId !== user.id) throw new SupportError(`${taken.name} is at this desk.`);
          if (mine && mine.itemId !== item.id) {
            if (mine.ticketId) throw new SupportError('Resolve your ticket first.');
            await freeDesk(st, mine);
          }
          // Taking your own desk again (from another tab, or after a reload) moves it to this connection.
          const desk = taken ?? { itemId: item.id, at: placeOf(item), userId: user.id, name: me.name, playerId: null, ticketId: null, awaySince: null };
          st.desks.set(item.id, desk);
          moveDesk(st, desk, socket.id);
        }
        await publish(st);
        return {};
      }),
    );

    socket.on('support:next', (ack) =>
      answer(ack, async () => {
        const { st, officeId } = await where(s, 'staff');
        limit(canAct());
        const desk = s.user ? deskOfUser(st, s.user.id) : undefined;
        const helping = 'Leave the conversation you’re helping with first.';
        if (s.user && helpingOf(st, s.user.id)) throw new SupportError(helping);
        if (!desk) throw new SupportError('Take a desk first.');
        // Asked from another tab: the desk moves there.
        if (desk.playerId !== socket.id) moveDesk(st, desk, socket.id);
        if (desk.ticketId) throw new SupportError('Resolve your ticket first.');
        const present = new Set([...st.customers.values()].filter((c) => !c.closed).map((c) => c.ticketId));
        const row = await tickets.claimNext(officeId, present, desk.userId, desk.itemId);
        if (row === 'serving') throw new SupportError('Resolve your ticket first.');
        if (!row) throw new SupportError((await snapshot(st)).waiting.length ? 'Nobody waiting is here right now.' : 'Nobody is waiting.');
        // They left the desk (or the office), or joined a colleague's conversation, meanwhile: the
        // ticket goes back where it was.
        const joined = !!helpingOf(st, desk.userId);
        if (st.desks.get(desk.itemId) !== desk || desk.ticketId || joined) {
          await tickets.requeue(row.id, desk.userId);
          changed(st);
          throw new SupportError(joined ? helping : 'Take a desk first.');
        }
        desk.ticketId = row.id;
        summon(st, desk, row.id);
        relink(st, [desk.playerId, ...customerSockets(st, row.id)]);
        await publish(st);
        return { ticket: ticketOf(st, st.snap!, st.snap!.active.find((r) => r.id === row.id) ?? row) };
      }),
    );

    socket.on('support:resolve', (ack) =>
      answer(ack, async () => {
        const { st, officeId } = await where(s, 'staff');
        limit(canAct());
        const desk = s.user ? deskOfUser(st, s.user.id) : undefined;
        if (!desk?.ticketId) throw new SupportError('You’re not serving anyone.');
        const ticketId = desk.ticketId;
        // An offer of it made by this agent is taken back first.
        for (const entry of [...st.offers.values()]) if (entry.offer.ticketId === ticketId && entry.offer.from.userId === desk.userId) endOffer(st, entry, 'cancelled');
        const row = await tickets.resolve(ticketId, desk.userId);
        if (!row) {
          // Handed over meanwhile: it's the other agent's to resolve.
          const now = await tickets.byId(officeId, ticketId);
          if (now?.status === 'active' && now.assignee_user_id !== desk.userId) {
            changed(st);
            throw new SupportError(`${now.assignee_name ?? 'Someone else'} has this ticket now.`);
          }
        }
        if (desk.ticketId === ticketId) desk.ticketId = null;
        if (row) closedFor(st, row);
        relink(st, [desk.playerId, ...customerSockets(st, ticketId)]);
        await publish(st);
        return {};
      }),
    );

    socket.on('support:history', (req, ack) =>
      answer(ack, async () => {
        const { officeId } = await where(s, 'staff');
        limit(canSearch());
        const query = typeof req?.query === 'string' ? req.query.trim().slice(0, 100) : '';
        const before = req?.before;
        const page = await tickets.history(officeId, query, Number.isInteger(before) && before! > 0 && before! <= MAX_NUMBER ? before! : null);
        const events = await tickets.events(page.rows.map((r) => r.id));
        return { tickets: page.rows.map((r) => ({ ...toTicket(r, null), events: events.get(r.id) ?? [] })), more: page.more };
      }),
    );

    socket.on('support:remove', (playerId, ack) =>
      answer(ack, async () => {
        const { st, officeId } = await where(s, 'staff');
        limit(canAct());
        const v = typeof playerId === 'string' ? st.visitors.get(playerId) : undefined;
        if (!v) throw new SupportError('They’re not a visitor here.');
        const c = st.customers.get(playerId);
        // Kept out for a while: their browser for hours, their address for an hour.
        const now = Date.now();
        blockedAddresses.set(`${officeId}:${v.address}`, now + REMOVED_ADDRESS_MS);
        if (c) blockedKeys.set(`${officeId}:${c.keyHash}`, now + REMOVED_KEY_MS);
        if (c && !c.closed) {
          const row = await tickets.close(c.ticketId, ['waiting', 'active']);
          if (row) closedFor(st, row);
        }
        // Their other tabs go too.
        const gone = [...st.visitors.keys()].filter((id) => id === playerId || (!!c && st.customers.get(id)?.keyHash === c.keyHash));
        for (const id of gone) realtime.removePlayer(officeId, id, 'removed');
        await publish(st);
        return {};
      }),
    );

    socket.on('support:offer', (req, ack) =>
      answer(ack, async () => {
        const { st, officeId } = await where(s, 'staff');
        limit(canAct());
        const user = s.user;
        const desk = user ? deskOfUser(st, user.id) : undefined;
        if (!user || !desk?.ticketId) throw new SupportError('You’re not serving anyone.');
        const kind = req && typeof req === 'object' ? req.kind : undefined;
        const to = req && typeof req === 'object' ? req.to : undefined;
        if ((kind !== 'transfer' && kind !== 'invite') || typeof to !== 'string') throw new SupportError('Reload the page and try again.');
        const row = await tickets.byId(officeId, desk.ticketId);
        // From here on nothing waits.
        if (!row || row.status !== 'active' || row.assignee_user_id !== user.id || deskOfUser(st, user.id)?.ticketId !== row.id) throw new SupportError('You’re not serving anyone.');
        if (desk.playerId !== socket.id) moveDesk(st, desk, socket.id);
        const open = [...st.offers.values()].map((e) => e.offer);
        const waiting = open.find((o) => o.from.userId === user.id);
        if (waiting) throw new SupportError(`You’re waiting for an answer from ${waiting.to.name}.`);
        if (to === user.id) throw new SupportError('That’s you.');
        const colleague = colleaguesOf(st, labelsOf(st)).find((c) => c.userId === to);
        if (!colleague) throw new SupportError('They’re not here.');
        if (open.some((o) => o.to.userId === to)) throw new SupportError(`${colleague.name} has another offer to answer. Try again in a moment.`);
        const offer: TicketOffer = {
          id: crypto.randomBytes(12).toString('base64url'),
          kind,
          ticketId: row.id,
          number: row.number,
          customerName: row.customer_name,
          firstMessage: row.first_message,
          from: { userId: user.id, name: desk.name, desk: labelsOf(st).get(desk.itemId) ?? 'Desk' },
          to: { userId: colleague.userId, name: colleague.name },
          expiresAt: Date.now() + opts.offerMs,
        };
        // The same checks as canTransferTo and canInvite (what the picker shows), with their reasons.
        const problem = problemOf(st, offer);
        if (problem) throw new SupportError(offerTexts(problem, offer).send);
        if (kind === 'transfer' && colleague.state === 'away') throw new SupportError(`${colleague.name} is away.`);
        if (!colleague.playerId) throw new SupportError(`${colleague.name} isn’t here.`);
        const expire = () => {
          endOffer(st, entry, 'expired');
          changed(st);
        };
        const entry: Offer = { offer, timer: setTimeout(expire, opts.offerMs) };
        entry.timer.unref();
        st.offers.set(offer.id, entry);
        await publish(st);
        return { offer };
      }),
    );

    socket.on('support:offer:answer', (offerId, accept, ack) =>
      answer(ack, async () => {
        const { st, officeId } = await where(s, 'staff');
        limit(canAct());
        const user = s.user;
        const entry = typeof offerId === 'string' ? st.offers.get(offerId) : undefined;
        if (!user || !entry || entry.offer.to.userId !== user.id) throw new SupportError('That offer is no longer open.');
        const { offer } = entry;
        if (accept !== true) {
          endOffer(st, entry, 'declined');
          await publish(st);
          return {};
        }
        // Out of the open offers before anything waits: a second click finds nothing.
        st.offers.delete(offer.id);
        clearTimeout(entry.timer);
        const problem = problemOf(st, offer);
        if (problem) {
          const { accept: mine, note } = offerTexts(problem, offer);
          endOffer(st, entry, 'gone', note, 'from');
          changed(st);
          throw new SupportError(mine);
        }
        const fromDesk = deskOfUser(st, offer.from.userId)!;
        const ticketId = offer.ticketId;
        if (offer.kind === 'invite') {
          const helpers = st.helpers.get(ticketId) ?? [];
          helpers.push({ userId: user.id, name: s.me()?.name ?? user.name, number: offer.number, playerId: socket.id });
          st.helpers.set(ticketId, helpers);
          endOffer(st, entry, 'accepted');
          relink(st, onTicket(st, ticketId));
          await publish(st);
          logEvent(ticketId, 'joined', user.id, offer.from.userId);
          return {};
        }
        const toDesk = deskOfUser(st, user.id)!;
        if (toDesk.playerId !== socket.id) moveDesk(st, toDesk, socket.id);
        const moved = await tickets.transfer(officeId, ticketId, { userId: fromDesk.userId, deskItemId: fromDesk.itemId }, { userId: user.id, deskItemId: toDesk.itemId });
        if (moved === null || moved === 'busy') {
          const { accept: mine, note } = offerTexts(moved === 'busy' ? 'serving' : 'not-serving', offer);
          endOffer(st, entry, 'gone', note, 'from');
          changed(st);
          throw new SupportError(mine);
        }
        // Their desk was moved or left meanwhile: the visitor goes back to the queue.
        if (st.desks.get(toDesk.itemId) !== toDesk || toDesk.ticketId) {
          await tickets.requeue(ticketId, user.id);
          if (fromDesk.ticketId === ticketId) fromDesk.ticketId = null;
          requeued(st, ticketId, toDesk.name);
          endOffer(st, entry, 'gone', `${visitorName(offer.number)} is back in the queue.`, 'from');
          relink(st, [fromDesk.playerId, ...customerSockets(st, ticketId)]);
          await publish(st);
          throw new SupportError(`Your desk changed. ${visitorName(offer.number)} is back in the queue.`);
        }
        if (fromDesk.ticketId === ticketId) fromDesk.ticketId = null;
        toDesk.ticketId = ticketId;
        // A colleague helping who takes it over is its agent now (the other one keeps helping).
        const was = st.helpers.get(ticketId)?.find((h) => h.userId === user.id);
        if (was) dropHelper(st, ticketId, was);
        // The old desk, with its agent away, waits for them as an idle one does.
        if (!fromDesk.playerId && st.desks.get(fromDesk.itemId) === fromDesk) releaseLater(st, fromDesk);
        summon(st, toDesk, ticketId);
        relink(st, [fromDesk.playerId, ...onTicket(st, ticketId)]);
        endOffer(st, entry, 'accepted');
        await publish(st);
        return {};
      }),
    );

    socket.on('support:offer:cancel', (offerId, ack) =>
      answer(ack, async () => {
        const { st } = await where(s, 'staff');
        limit(canAct());
        const entry = typeof offerId === 'string' ? st.offers.get(offerId) : undefined;
        if (!s.user || !entry || entry.offer.from.userId !== s.user.id) throw new SupportError('That offer is no longer open.');
        endOffer(st, entry, 'cancelled');
        await publish(st);
        return {};
      }),
    );

    socket.on('support:helper:leave', (ack) =>
      answer(ack, async () => {
        const { st } = await where(s, 'staff');
        limit(canAct());
        const helping = s.user ? helpingOf(st, s.user.id) : undefined;
        if (!helping) throw new SupportError('You’re not helping anyone.');
        dropHelper(st, helping.ticketId, helping.helper);
        await publish(st);
        logEvent(helping.ticketId, 'left', helping.helper.userId, null);
        return {};
      }),
    );

    socket.on('support:helper:remove', (userId, ack) =>
      answer(ack, async () => {
        const { st } = await where(s, 'staff');
        limit(canAct());
        const desk = s.user ? deskOfUser(st, s.user.id) : undefined;
        const helper = desk?.ticketId && typeof userId === 'string' ? st.helpers.get(desk.ticketId)?.find((h) => h.userId === userId) : undefined;
        if (!desk?.ticketId || !helper) throw new SupportError('They’re not helping you.');
        const ticketId = desk.ticketId;
        const ids = staffSockets(st, helper.userId);
        if (ids.length) io.to(ids).emit('support:helping:ended', { ticketId, number: helper.number, why: 'removed', agent: desk.name });
        dropHelper(st, ticketId, helper);
        await publish(st);
        logEvent(ticketId, 'left', helper.userId, desk.userId);
        return {};
      }),
    );
  });

  /** support:enter, one at a time per connection, past the quick answers. */
  const enter = async (s: SocketContext, st: Office, officeId: string, keyHash: string, req: { name?: unknown; email?: unknown; message?: unknown }, mine: Customer | undefined) => {
    const { socket } = s;
    let found = await tickets.find(officeId, keyHash);
    let created = false;
    if (!found) {
      const message = clip(cleanMessageText(req.message), MAX_FIRST_MESSAGE);
      if (!message) {
        // Nothing open: how their last ticket ended (thanks and a rating, or their place ran out).
        const last = await tickets.lastClosed(officeId, keyHash, CLOSED_TICKET_RECALL_MS);
        if (!last) throw new SupportError('How can we help? Write a message first.');
        if (s.room()?.officeId !== officeId) throw new SupportError('Join the office first.');
        const ticket = closedTicket(last);
        st.customers.set(socket.id, { ticketId: last.id, keyHash, name: last.customer_name, closed: ticket });
        st.sent.set(socket.id, JSON.stringify(ticket));
        return { ticket };
      }
      if (mine && !mine.closed) throw new SupportError('You already have a ticket open.');
      const name = sanitizeName(req.name, MAX_CUSTOMER_NAME);
      if (!name) throw new SupportError('Tell us your name.');
      const rawEmail = typeof req.email === 'string' ? req.email.trim() : '';
      const email = rawEmail ? customerEmail(rawEmail) : null;
      if (rawEmail && !email) throw new SupportError('Check your email address.');
      const address = addressOf(s);
      // Counted before anything waits, so requests sent at once can't all slip under the limit.
      if (!newTickets(`${officeId}:${address}`)) throw new SupportError('You’ve opened a lot of tickets. Try again later.');
      const made = await tickets.enter(officeId, keyHash, { name, email, message, address: sha256(address) }, OPEN_TICKETS_PER_ADDRESS);
      if (made === 'busy') throw new SupportError('There are a lot of open tickets from your network. Try again later.');
      found = made.row;
      created = made.created;
    }
    const row = found;
    const me = s.me();
    if (!me || s.room()?.officeId !== officeId) throw new SupportError('Join the office first.');
    const c: Customer = { ticketId: row.id, keyHash, name: row.customer_name, closed: null };
    st.customers.set(socket.id, c);
    const v = st.visitors.get(socket.id);
    if (v) v.idleSince = null;
    if (me.name !== visitorName(row.number)) realtime.updatePlayer(officeId, me.id, { name: visitorName(row.number) });
    if (created) {
      try {
        await postToConversation(ctx, { officeId, key: ticketConv(row.id), userId: s.user?.id ?? null, playerId: me.id, name: row.customer_name, text: row.first_message });
      } catch (err) {
        console.error('[support] could not save a ticket’s first message:', err);
      }
    }
    await publish(st);
    // Back on a ticket someone is serving: in a call with them again, and back to the desk.
    relink(st, [socket.id]);
    const desk = row.status === 'active' && row.desk_item_id ? st.desks.get(row.desk_item_id) : undefined;
    if (desk?.ticketId === row.id) summon(st, desk, row.id);
    const ticket = ticketFor(st, st.snap!, c);
    if (!ticket) throw new SupportError('That ticket is gone. Please try again.');
    return { ticket };
  };

  // ---------- coming and going ----------

  realtime.onJoin(async (s) => {
    const room = s.room();
    if (!room || !isSupport(room.officeId)) return;
    const st = officeOf(room.officeId);
    const id = s.socket.id;
    st.sockets.add(id);
    if (isCustomer(s.role(), 'support')) st.visitors.set(id, { address: addressOf(s), idleSince: Date.now() });
    await loaded(st);
    // An agent back in time takes their desk (and the customer they were serving) back, and a
    // colleague helping their part in the conversation.
    const desk = s.user && !st.visitors.has(id) ? deskOfUser(st, s.user.id) : undefined;
    if (desk && !desk.playerId && s.room()?.officeId === st.officeId) moveDesk(st, desk, id);
    const helping = s.user && !st.visitors.has(id) ? helpingOf(st, s.user.id) : undefined;
    if (helping && !helping.helper.playerId && s.room()?.officeId === st.officeId) {
      helping.helper.playerId = id;
      clearTimeout(helping.helper.release);
      relink(st, onTicket(st, helping.ticketId));
    }
    await publish(st);
  });

  realtime.onLeave(async (s, { officeId }) => {
    const st = live.get(officeId);
    if (!st) return;
    const id = s.socket.id;
    st.sockets.delete(id);
    st.sent.delete(id);
    st.visitors.delete(id);
    st.entering.delete(id);
    const c = st.customers.get(id);
    st.customers.delete(id);
    // A desk waits for its agent a while (longer while serving): back on a new connection (a reload,
    // or their newest tab), they take it again in onJoin.
    const desk = deskOfPlayer(st, id);
    if (desk) {
      desk.playerId = null;
      desk.awaySince = Date.now();
      relink(st, desk.ticketId ? onTicket(st, desk.ticketId) : []);
      if (!desk.ticketId) releaseLater(st, desk);
    }
    // A colleague helping with a ticket keeps their part a short while (a reload).
    for (const [ticketId, list] of st.helpers) {
      const helper = list.find((h) => h.playerId === id);
      if (!helper) continue;
      helper.playerId = null;
      relink(st, onTicket(st, ticketId));
      clearTimeout(helper.release);
      helper.release = setTimeout(() => {
        if (helper.playerId || !st.helpers.get(ticketId)?.includes(helper)) return;
        dropHelper(st, ticketId, helper);
        logEvent(ticketId, 'left', helper.userId, null);
        changed(st);
        forget(st);
      }, opts.helperAwayMs);
      helper.release.unref();
    }
    forget(st);
    // Customers keep their place for a while, from now.
    if (c && !c.closed) await tickets.seen([c.ticketId]);
    await publish(st);
  });

  // A customer made a member while inside is staff from now on: their ticket ends.
  realtime.onRoleChange(async (s, before) => {
    const room = s.room();
    const st = room && before === 'guest' ? live.get(room.officeId) : undefined;
    if (!st) return;
    const id = s.socket.id;
    const c = st.customers.get(id);
    st.customers.delete(id);
    st.visitors.delete(id);
    st.entering.delete(id);
    st.sent.delete(id);
    if (c && !c.closed) {
      const row = await tickets.close(c.ticketId, ['waiting', 'active'], true);
      if (row) closedFor(st, row);
    }
    realtime.relink(st.officeId);
    await publish(st);
  });

  // A desk moved or removed in build mode is free again (its customer goes back to the queue).
  realtime.onOfficeChange((officeId, office) => {
    const st = live.get(officeId);
    if (!st) return;
    for (const desk of [...st.desks.values()]) {
      const item = office.items.find((i) => i.id === desk.itemId);
      if (item?.type === SUPPORT_DESK && item.x === desk.at.x && item.z === desk.at.z && item.rot === desk.at.rot) continue;
      void freeDesk(st, desk)
        .then(() => changed(st))
        .catch((err) => console.error('[support] could not free a desk:', err));
    }
  });

  // An agent's new name shows on their desk, a colleague's where they help, and in the colleagues.
  ctx.auth.onUserUpdated((user) => {
    for (const st of live.values()) {
      const desk = deskOfUser(st, user.id);
      if (desk) desk.name = user.name;
      const helping = helpingOf(st, user.id);
      if (helping) helping.helper.name = user.name;
      if (desk || helping || staffSockets(st, user.id).length) changed(st);
    }
  });

  // ---------- every minute ----------

  const sweep = async () => {
    const now = Date.now();
    for (const map of [blockedKeys, blockedAddresses]) for (const [key, until] of map) if (until <= now) map.delete(key);
    // Customers here now were seen now, so time the server was down doesn't count as away.
    const states = [...live.values()];
    await tickets.seen(states.flatMap((st) => [...st.customers.values()].filter((c) => !c.closed).map((c) => c.ticketId)));
    // Waiting customers away too long lose their place; active tickets nobody is serving (after a
    // restart, in a workspace nobody came back to) end the same way.
    const served = states.flatMap((st) => [...st.desks.values()].flatMap((d) => (d.ticketId ? [d.ticketId] : [])));
    for (const officeId of await tickets.abandonAway(opts.graceMs, served)) {
      const st = live.get(officeId);
      if (st) changed(st);
    }
    for (const st of states) {
      // Agents away too long while serving: their customers go back to the front of the queue.
      for (const desk of [...st.desks.values()]) {
        if (!desk.ticketId || desk.awaySince === null || now - desk.awaySince < opts.graceMs) continue;
        await freeDesk(st, desk);
        changed(st);
      }
      // Customers here a long while without an open ticket make room for others.
      for (const [id, v] of st.visitors) if (v.idleSince !== null && now - v.idleSince >= opts.customerIdleMs) realtime.removePlayer(st.officeId, id, 'idle');
      forget(st);
    }
    // Closed tickets past CHAT_RETENTION_DAYS go, with their chat, a batch at a time.
    for (let more = !!opts.retentionDays; more; ) {
      const batch = await tickets.expired(opts.retentionDays!, EXPIRY_BATCH);
      for (const { officeId, ids } of batch) {
        await deleteConversations(ctx, officeId, ids.map(ticketConv));
        await tickets.remove(ids);
      }
      more = batch.reduce((n, b) => n + b.ids.length, 0) === EXPIRY_BATCH;
    }
  };
  let sweeping: Promise<void> | null = null;
  const timer = setInterval(() => {
    sweeping ??= sweep()
      .catch((err) => console.error('[support] could not tidy up the queues:', err))
      .finally(() => {
        sweeping = null;
      });
  }, opts.sweepEveryMs);
  timer.unref();
  ctx.onClose(async () => {
    clearInterval(timer);
    for (const st of live.values()) {
      for (const desk of st.desks.values()) clearTimeout(desk.release);
      for (const helper of [...st.helpers.values()].flat()) clearTimeout(helper.release);
      for (const entry of st.offers.values()) clearTimeout(entry.timer);
    }
    await sweeping;
  });
}
