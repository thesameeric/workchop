import { normalizeEmail } from './account';
import type { OfficeItem } from './types';

// Customer support workspaces: staff sit at support desks, customers come in with the public
// customer link (no account), wait in the lobby and are called to a desk one at a time. Each
// conversation is a ticket; its chat is the conversation `t:<ticketId>`.

export type TicketStatus = 'waiting' | 'active' | 'resolved' | 'abandoned';

export const MAX_CUSTOMER_NAME = 60;
export const MAX_CUSTOMER_EMAIL = 254;
export const MAX_FIRST_MESSAGE = 500;
/** Customers who leave keep their place in the queue this long. */
export const AWAY_GRACE_MS = 10 * 60_000;
/** A called customer who isn't seated by then is placed in the seat. */
export const SUMMON_TIMEOUT_MS = 25_000;
/** Customers here this long without an open ticket are taken out (office:removed 'idle'). */
export const CUSTOMER_IDLE_MS = 15 * 60_000;
/** Customers in one workspace from one address (an IPv4 address or an IPv6 /64) at once. */
export const MAX_CUSTOMERS_PER_ADDRESS = 3;
/** support:enter with no message gives back the key's ticket closed within this time. */
export const CLOSED_TICKET_RECALL_MS = 24 * 3600_000;
/** On a support desk's seats (catalog order): where the staff member sits, and the customer. */
export const STAFF_SEAT = 0;
export const CUSTOMER_SEAT = 1;
/** What others see over a customer's head ('Visitor #45'); staff see the real name in their panel. */
export const visitorName = (number: number) => `Visitor #${number}`;
/** The conversation key of a ticket's chat. */
export const ticketConv = (ticketId: string) => `t:${ticketId}`;
/** The catalog type of a help desk. */
export const SUPPORT_DESK = 'support-desk';
/** Colleagues who may help with one ticket at once, besides the agent serving it. */
export const MAX_HELPERS = 2;
/** An offer to take a ticket over, or to help with it, lapses after this long unanswered. */
export const OFFER_MS = 60_000;
/** How long a colleague helping with a ticket may be gone (a reload) before their part ends. */
export const HELPER_AWAY_MS = 30_000;

/**
 * A customer's email address as saved, or null if it isn't one. Characters that would change a
 * mailto: link (? & % # / \ and spaces) are refused.
 */
export function customerEmail(v: unknown): string | null {
  const email = normalizeEmail(v);
  return email && email.length <= MAX_CUSTOMER_EMAIL && !/[?&%#/\\\s]/.test(email) ? email : null;
}

/** "Desk 1", "Desk 2"… by item id: support desks numbered west to east, then north to south. */
export function deskLabels(items: OfficeItem[]): Map<string, string> {
  const desks = items.filter((i) => i.type === SUPPORT_DESK).sort((a, b) => a.z - b.z || a.x - b.x);
  return new Map(desks.map((d, i) => [d.id, `Desk ${i + 1}`]));
}

/** A colleague the agent serving a ticket invited into its conversation. */
export interface TicketHelper {
  userId: string;
  name: string;
  /** Their connection; null while they're away (HELPER_AWAY_MS to come back). */
  playerId: string | null;
}

/**
 * What happened on a ticket besides its chat (its history). Names are the accounts' names now
 * ('Someone' when the account is gone).
 */
export type TicketEvent =
  | { kind: 'transferred'; at: number; from: string; to: string }
  | { kind: 'joined'; at: number; helper: string; by: string }
  /** `by`: the agent who ended their part; null when they left (or were away too long). */
  | { kind: 'left'; at: number; helper: string; by: string | null };

/** A ticket as staff see it. */
export interface Ticket {
  id: string;
  /** Counts up per workspace: "#45". */
  number: number;
  status: TicketStatus;
  customerName: string;
  customerEmail: string | null;
  firstMessage: string;
  /** The customer's player id while they're in the office. */
  playerId: string | null;
  /** Whether the customer is in the office now (waiting tickets of absent customers are "away"). */
  present: boolean;
  assignee: { userId: string; name: string } | null;
  deskItemId: string | null;
  rating: number | null;
  createdAt: number;
  assignedAt: number | null;
  closedAt: number | null;
  /** Colleagues helping with it now (only while it's active). */
  helpers: TicketHelper[];
  /** Its history besides the chat: only in support:history answers. */
  events?: TicketEvent[];
}

/** A customer's own ticket. */
export interface MyTicket {
  id: string;
  number: number;
  status: TicketStatus;
  /** Waiting: how many tickets are ahead (customers away within the grace time count). */
  ahead: number | null;
  /** Active: who is serving you, at which desk. */
  agent: { name: string; playerId: string | null; deskItemId: string; desk: string } | null;
  rating: number | null;
  /** Active: colleagues helping too, by name ([] otherwise). */
  helpers: { name: string; playerId: string | null }[];
}

/** A desk someone has taken. `label` is "Desk 2" (desks numbered west to east, then north to south). */
export interface TakenDesk {
  itemId: string;
  label: string;
  userId: string;
  name: string;
  /** Null while they're away: they have AWAY_GRACE_MS to come back before their ticket goes back to the queue. */
  playerId: string | null;
  ticketId: string | null;
}

/** What staff see: the queue (oldest first), the desks in use and the ticket you're serving. */
export interface SupportQueue {
  waiting: Ticket[];
  desks: TakenDesk[];
  mine: Ticket | null;
  /** The ticket you're helping with (another agent's), if any. */
  helping: Ticket | null;
  /** The other staff who are here or have a desk (not you), for handing over and inviting. */
  colleagues: Colleague[];
  /** Your open offers: the one you sent, and the one you got. */
  offers: { outgoing: TicketOffer | null; incoming: TicketOffer | null };
}

/** The "Now serving" screen, for everyone in the office. */
export interface SupportBoard {
  serving: { number: number; desk: string }[];
  waiting: number;
}

/**
 * A colleague as the offer picker sees them: serving someone at their desk, helping with a ticket,
 * at a desk but not here ('away'), at a desk and free, or here without a desk.
 */
export type ColleagueState = 'free' | 'serving' | 'helping' | 'away' | 'no-desk';

/** Another staff member who is here, or has a desk. */
export interface Colleague {
  userId: string;
  name: string;
  /** Their connection; null while they're not here. */
  playerId: string | null;
  /** Their desk ("Desk 3"), if they've taken one. */
  desk: string | null;
  state: ColleagueState;
  /** The ticket they're helping with ('helping'). */
  helping: string | null;
}

/** Whether you can hand ticket `ticketId` (yours) to this colleague: here, at a desk, serving nobody, helping with nothing else. */
export const canTransferTo = (c: Colleague, ticketId: string): boolean =>
  !!c.playerId && !!c.desk && (c.state === 'free' || (c.state === 'helping' && c.helping === ticketId));

/** Whether you can invite this colleague into your ticket's conversation: here, serving nobody, helping with nothing, and there's room. */
export const canInvite = (c: Colleague, ticket: Pick<Ticket, 'helpers'>): boolean =>
  !!c.playerId && (c.state === 'free' || c.state === 'no-desk') && ticket.helpers.length < MAX_HELPERS;

/** 'transfer': take the ticket over at your desk; 'invite': join its conversation. */
export type OfferKind = 'transfer' | 'invite';

/** An offer from the agent serving a ticket to a colleague; one open at a time per sender and per recipient. */
export interface TicketOffer {
  id: string;
  kind: OfferKind;
  ticketId: string;
  number: number;
  customerName: string;
  firstMessage: string;
  from: { userId: string; name: string; desk: string };
  to: { userId: string; name: string };
  /** When it lapses unanswered (server time; OFFER_MS after it was made). */
  expiresAt: number;
}

export interface OfferRequest {
  kind: OfferKind;
  /** The colleague's user id. */
  to: string;
}

/** How an offer ended: 'gone' when it no longer works (the ticket closed, someone became busy…). */
export type OfferEnd = 'accepted' | 'declined' | 'expired' | 'cancelled' | 'gone';

export interface OfferEnded {
  offer: TicketOffer;
  why: OfferEnd;
  /** For 'gone': why, in a few words, for the sender ("Tunde is serving someone."). */
  note?: string;
}

/** A colleague's part in a conversation ended, not by their own Leave. */
export interface HelpingEnded {
  ticketId: string;
  number: number;
  /** removed: the agent ended it; resolved: the ticket was resolved; ended: closed or back in the queue. */
  why: 'removed' | 'resolved' | 'ended';
  /** The agent serving it. */
  agent: string;
}

/**
 * Sent by a customer to open a ticket, or to get theirs back after a reload or a restart:
 * - The open ticket of `key` comes back, whatever else is sent.
 * - Otherwise, with an empty message: the key's last ticket closed within CLOSED_TICKET_RECALL_MS
 *   (status 'resolved': thank them and ask for a rating if `rating` is null; 'abandoned': their place
 *   ran out, or they left the queue), or the error "How can we help? Write a message first."
 * - Otherwise a new ticket, which needs a name and a message (one open ticket per connection).
 * Others then see the customer as visitorName(number).
 */
export interface EnterRequest {
  name: string;
  email?: string;
  message: string;
  /**
   * A random secret this browser keeps for this workspace (localStorage), at least 32 characters.
   * The server stores its hash; the same key gets the same open ticket back.
   */
  key: string;
}

export interface HistoryRequest {
  /** Matches the customer's name or email, or the ticket number. */
  query?: string;
  /** Tickets closed before this ticket number (paging). */
  before?: number;
}

export interface Summon {
  ticketId: string;
  deskItemId: string;
  /** The customer seat to walk to and sit in. */
  seat: { x: number; z: number; ry: number };
  agentName: string;
}

export type SupportResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** The answer to support:state: what this connection is in this office. */
export type SupportState =
  | { as: 'staff'; queue: SupportQueue; board: SupportBoard }
  | { as: 'customer'; ticket: MyTicket | null; board: SupportBoard }
  | { as: 'none' };

declare module './types' {
  interface ClientToServerEvents {
    /** Staff and customers, after joining a support workspace (and after every rejoin). */
    'support:state': (ack: (res: SupportState) => void) => void;
    /** Customers: open (or resume, by key) a ticket; send it again after every rejoin to resume. */
    'support:enter': (req: EnterRequest, ack: (res: SupportResult<{ ticket: MyTicket }>) => void) => void;
    /** Customers: give up a waiting ticket. */
    'support:leave-queue': (ack: (res: SupportResult) => void) => void;
    /** Customers: rate your last resolved ticket (1–5). */
    'support:rate': (rating: number, ack: (res: SupportResult) => void) => void;
    /** Staff: take a support desk (its item id), or leave yours (null). One desk per person. */
    'support:desk': (itemId: string | null, ack: (res: SupportResult) => void) => void;
    /** Staff at a desk and not serving: call the next customer who is here. */
    'support:next': (ack: (res: SupportResult<{ ticket: Ticket }>) => void) => void;
    /** Staff: close the ticket you're serving. */
    'support:resolve': (ack: (res: SupportResult) => void) => void;
    /** Staff: closed tickets, newest first. */
    'support:history': (req: HistoryRequest, ack: (res: SupportResult<{ tickets: Ticket[]; more: boolean }>) => void) => void;
    /**
     * Staff: take a customer (their player id) out of the workspace: their open ticket ends, they get
     * office:removed 'removed', and they can't open tickets with that key for hours (nor come back
     * from that address for an hour).
     */
    'support:remove': (playerId: string, ack: (res: SupportResult) => void) => void;
    /** The agent serving a ticket: offer it to a colleague (transfer), or invite them into its conversation. */
    'support:offer': (req: OfferRequest, ack: (res: SupportResult<{ offer: TicketOffer }>) => void) => void;
    /** The colleague an offer is for: accept or decline it. */
    'support:offer:answer': (offerId: string, accept: boolean, ack: (res: SupportResult) => void) => void;
    /** Whoever sent an offer: take it back. */
    'support:offer:cancel': (offerId: string, ack: (res: SupportResult) => void) => void;
    /** A colleague helping: leave the conversation. */
    'support:helper:leave': (ack: (res: SupportResult) => void) => void;
    /** The agent serving a ticket: end a colleague's part in it (their user id). */
    'support:helper:remove': (userId: string, ack: (res: SupportResult) => void) => void;
  }
  interface ServerToClientEvents {
    /** Staff: whenever the queue, the desks or your ticket change. */
    'support:queue': (queue: SupportQueue) => void;
    /**
     * Customers who opened or resumed a ticket on this connection: it changed (position, called,
     * resolved), or null when it's gone. Nothing is sent before support:enter.
     */
    'support:ticket': (ticket: MyTicket | null) => void;
    /** Customers: you were called; walk to the seat. */
    'support:summon': (summon: Summon) => void;
    /** Everyone in a support workspace: the Now serving screen. */
    'support:board': (board: SupportBoard) => void;
    /**
     * Staff: an offer you sent or got ended. Sent to the side that didn't end it (the sender when
     * the recipient accepted, declined or couldn't accept; the recipient when the sender cancelled),
     * and to both when it lapsed or stopped working.
     */
    'support:offer:ended': (ended: OfferEnded) => void;
    /** Staff: your part in a ticket's conversation ended (not by your own Leave). */
    'support:helping:ended': (ended: HelpingEnded) => void;
  }
}
