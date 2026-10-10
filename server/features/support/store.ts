import type { Ticket, TicketEvent, TicketStatus } from '../../../shared/support';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { randomId } from '../../officeStore';
import { nextUp } from './queue';

export interface TicketRow {
  id: string;
  office_id: string;
  number: number;
  status: TicketStatus;
  customer_name: string;
  customer_email: string | null;
  customer_key: string;
  first_message: string;
  assignee_user_id: string | null;
  /** The assignee's account name (joined in). */
  assignee_name: string | null;
  desk_item_id: string | null;
  rating: number | null;
  created_at: Date;
  assigned_at: Date | null;
  closed_at: Date | null;
}

const ms = (d: Date | null): number | null => (d ? new Date(d).getTime() : null);

/** Who is where, for a ticket as staff see it. */
export function toTicket(r: TicketRow, playerId: string | null): Ticket {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    firstMessage: r.first_message,
    playerId,
    present: playerId !== null,
    assignee: r.assignee_user_id ? { userId: r.assignee_user_id, name: r.assignee_name ?? '' } : null,
    deskItemId: r.desk_item_id,
    rating: r.rating,
    createdAt: ms(r.created_at)!,
    assignedAt: ms(r.assigned_at),
    closedAt: ms(r.closed_at),
    helpers: [],
  };
}

export const inQueue = (r: TicketRow) => ({ id: r.id, number: r.number, createdAt: ms(r.created_at)!, assignedAt: ms(r.assigned_at) });
export const isOpen = (status: TicketStatus) => status === 'waiting' || status === 'active';

const COLUMNS = `t.id, t.office_id, t.number, t.status, t.customer_name, t.customer_email, t.customer_key, t.first_message,
  t.assignee_user_id, (SELECT name FROM users WHERE id = t.assignee_user_id) AS assignee_name, t.desk_item_id, t.rating,
  t.created_at, t.assigned_at, t.closed_at`;
const SELECT = `SELECT ${COLUMNS} FROM support_tickets t`;
/** One change to an office's queue at a time (numbering, calling the next customer). */
const lock = (tx: Tx, officeId: string) => tx.query("SELECT pg_advisory_xact_lock(hashtext('support:' || $1))", [officeId]);

export const HISTORY_PAGE = 30;

export interface NewTicket {
  name: string;
  email: string | null;
  message: string;
  /** SHA-256 of the address it comes from. */
  address: string;
}

/** The database side of support tickets. */
export class SupportStore {
  constructor(private readonly db: Db) {}

  async byId(officeId: string, id: string): Promise<TicketRow | null> {
    const res = await this.db.query<TicketRow>(`${SELECT} WHERE t.id = $1 AND t.office_id = $2`, [id, officeId]);
    return res.rows[0] ?? null;
  }

  /** The office's waiting and active tickets. */
  async open(officeId: string): Promise<TicketRow[]> {
    const res = await this.db.query<TicketRow>(`${SELECT} WHERE t.office_id = $1 AND t.status IN ('waiting', 'active')`, [officeId]);
    return res.rows;
  }

  /** The customer's open ticket (they're here: their place is kept from now). */
  async find(officeId: string, keyHash: string): Promise<TicketRow | null> {
    const res = await this.db.query<TicketRow>(
      `UPDATE support_tickets t SET last_seen_at = now() WHERE t.office_id = $1 AND t.customer_key = $2 AND t.status IN ('waiting', 'active') RETURNING ${COLUMNS}`,
      [officeId, keyHash],
    );
    return res.rows[0] ?? null;
  }

  /**
   * The customer's open ticket, or a new one numbered next; 'busy' when its address has
   * `openPerAddress` open tickets already.
   */
  async enter(officeId: string, keyHash: string, make: NewTicket, openPerAddress: number): Promise<{ row: TicketRow; created: boolean } | 'busy'> {
    return this.db.transaction(async (tx) => {
      await lock(tx, officeId);
      const open = await tx.query<TicketRow>(`${SELECT} WHERE t.office_id = $1 AND t.customer_key = $2 AND t.status IN ('waiting', 'active')`, [officeId, keyHash]);
      if (open.rows[0]) return { row: open.rows[0], created: false };
      const fromThere = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM support_tickets WHERE office_id = $1 AND customer_address = $2 AND status IN ('waiting', 'active')",
        [officeId, make.address],
      );
      if (fromThere.rows[0].n >= openPerAddress) return 'busy';
      // Numbers keep counting up even when old tickets are deleted.
      const counted = await tx.query<{ last_number: number }>(
        `INSERT INTO support_counters (office_id, last_number) VALUES ($1, 1)
         ON CONFLICT (office_id) DO UPDATE SET last_number = support_counters.last_number + 1 RETURNING last_number`,
        [officeId],
      );
      const res = await tx.query<TicketRow>(
        `INSERT INTO support_tickets (id, office_id, number, status, customer_name, customer_email, customer_key, customer_address, first_message)
         VALUES ($1, $2, $3, 'waiting', $4, $5, $6, $7, $8)
         RETURNING id, office_id, number, status, customer_name, customer_email, customer_key, first_message, assignee_user_id,
           NULL::text AS assignee_name, desk_item_id, rating, created_at, assigned_at, closed_at`,
        [randomId(16), officeId, counted.rows[0].last_number, make.name, make.email, keyHash, make.address, make.message],
      );
      return { row: res.rows[0], created: true };
    });
  }

  /** The customer's last ticket closed since `withinMs` ago, if any. */
  async lastClosed(officeId: string, keyHash: string, withinMs: number): Promise<TicketRow | null> {
    const res = await this.db.query<TicketRow>(
      `${SELECT} WHERE t.office_id = $1 AND t.customer_key = $2 AND t.status IN ('resolved', 'abandoned')
         AND t.closed_at > now() - make_interval(secs => $3)
       ORDER BY t.closed_at DESC, t.number DESC LIMIT 1`,
      [officeId, keyHash, withinMs / 1000],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Gives the first waiting ticket whose customer is here (`present`) to the agent at the desk. Null
   * when there's nobody to call; 'serving' when the agent or the desk has a ticket already.
   */
  async claimNext(officeId: string, present: ReadonlySet<string>, userId: string, deskItemId: string): Promise<TicketRow | null | 'serving'> {
    try {
      return await this.db.transaction(async (tx) => {
        await lock(tx, officeId);
        const waiting = await tx.query<TicketRow>(`${SELECT} WHERE t.office_id = $1 AND t.status = 'waiting'`, [officeId]);
        const pick = nextUp(waiting.rows.map((r) => ({ ...inQueue(r), row: r })), present);
        if (!pick) return null;
        const res = await tx.query<TicketRow>(
          `UPDATE support_tickets t SET status = 'active', assignee_user_id = $2, desk_item_id = $3, assigned_at = now()
           WHERE t.id = $1 AND t.status = 'waiting' RETURNING ${COLUMNS}`,
          [pick.id, userId, deskItemId],
        );
        return res.rows[0] ?? null;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return 'serving';
      throw err;
    }
  }

  /** Closes an active ticket as resolved by its assignee. */
  async resolve(id: string, userId: string): Promise<TicketRow | null> {
    const res = await this.db.query<TicketRow>(
      `UPDATE support_tickets t SET status = 'resolved', closed_at = now() WHERE t.id = $1 AND t.status = 'active' AND t.assignee_user_id = $2
       RETURNING ${COLUMNS}`,
      [id, userId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Closes an open ticket: abandoned (a customer who gave up, left too long, or was taken out), or,
   * with `served`, resolved when an agent was serving it. `from` limits it to these statuses.
   */
  async close(id: string, from: ('waiting' | 'active')[], served = false): Promise<TicketRow | null> {
    const res = await this.db.query<TicketRow>(
      `UPDATE support_tickets t SET status = CASE WHEN $3::boolean AND t.status = 'active' THEN 'resolved' ELSE 'abandoned' END, closed_at = now()
       WHERE t.id = $1 AND t.status = ANY($2::text[]) RETURNING ${COLUMNS}`,
      [id, from, served],
    );
    return res.rows[0] ?? null;
  }

  /** An active ticket goes back to the queue while `userId` still has it (its agent left); it keeps assigned_at, which puts it first. */
  async requeue(id: string, userId: string): Promise<boolean> {
    const res = await this.db.query(
      "UPDATE support_tickets SET status = 'waiting', assignee_user_id = NULL, desk_item_id = NULL WHERE id = $1 AND status = 'active' AND assignee_user_id = $2",
      [id, userId],
    );
    return res.rowCount > 0;
  }

  /**
   * Hands an active ticket from one agent at their desk to another at theirs, with its history line,
   * under the office's lock. Null when it isn't that agent's at that desk any more; 'busy' when the
   * other agent or their desk has an active ticket already.
   */
  async transfer(
    officeId: string,
    id: string,
    from: { userId: string; deskItemId: string },
    to: { userId: string; deskItemId: string },
  ): Promise<TicketRow | null | 'busy'> {
    try {
      return await this.db.transaction(async (tx) => {
        await lock(tx, officeId);
        // assigned_at stays: it's when the customer was called.
        const res = await tx.query<TicketRow>(
          `UPDATE support_tickets t SET assignee_user_id = $5, desk_item_id = $6
           WHERE t.id = $1 AND t.office_id = $2 AND t.status = 'active' AND t.assignee_user_id = $3 AND t.desk_item_id = $4
           RETURNING ${COLUMNS}`,
          [id, officeId, from.userId, from.deskItemId, to.userId, to.deskItemId],
        );
        const row = res.rows[0];
        if (!row) return null;
        await tx.query("INSERT INTO support_ticket_events (ticket_id, kind, actor_user_id, other_user_id) VALUES ($1, 'transferred', $2, $3)", [id, from.userId, to.userId]);
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return 'busy';
      throw err;
    }
  }

  /** A history line for a ticket. */
  async addEvent(ticketId: string, kind: 'joined' | 'left', actorUserId: string, otherUserId: string | null): Promise<void> {
    await this.db.query('INSERT INTO support_ticket_events (ticket_id, kind, actor_user_id, other_user_id) VALUES ($1, $2, $3, $4)', [ticketId, kind, actorUserId, otherUserId]);
  }

  /** The history lines of these tickets, oldest first. */
  async events(ticketIds: string[]): Promise<Map<string, TicketEvent[]>> {
    const out = new Map<string, TicketEvent[]>();
    if (!ticketIds.length) return out;
    const res = await this.db.query<{ ticket_id: string; kind: TicketEvent['kind']; at: Date; actor: string | null; other: string | null }>(
      `SELECT e.ticket_id, e.kind, e.at, (SELECT name FROM users WHERE id = e.actor_user_id) AS actor,
         (SELECT name FROM users WHERE id = e.other_user_id) AS other
       FROM support_ticket_events e WHERE e.ticket_id = ANY($1::text[]) ORDER BY e.id`,
      [ticketIds],
    );
    for (const r of res.rows) {
      const at = ms(r.at)!;
      const actor = r.actor ?? 'Someone';
      const event: TicketEvent =
        r.kind === 'transferred'
          ? { kind: 'transferred', at, from: actor, to: r.other ?? 'Someone' }
          : r.kind === 'joined'
            ? { kind: 'joined', at, helper: actor, by: r.other ?? 'Someone' }
            : { kind: 'left', at, helper: actor, by: r.other };
      out.set(r.ticket_id, [...(out.get(r.ticket_id) ?? []), event]);
    }
    return out;
  }

  /** Rates the customer's last resolved ticket, once. */
  async rate(officeId: string, keyHash: string, rating: number): Promise<TicketRow | 'none' | 'rated'> {
    const last = await this.db.query<{ id: string }>(
      `SELECT id FROM support_tickets WHERE office_id = $1 AND customer_key = $2 AND status = 'resolved' ORDER BY closed_at DESC, number DESC LIMIT 1`,
      [officeId, keyHash],
    );
    const row = last.rows[0];
    if (!row) return 'none';
    const res = await this.db.query<TicketRow>(`UPDATE support_tickets t SET rating = $2 WHERE t.id = $1 AND t.rating IS NULL RETURNING ${COLUMNS}`, [row.id, rating]);
    return res.rows[0] ?? 'rated';
  }

  /** The customer was here just now (or left just now). */
  async seen(ids: string[]): Promise<void> {
    if (ids.length) await this.db.query("UPDATE support_tickets SET last_seen_at = now() WHERE id = ANY($1::text[]) AND status IN ('waiting', 'active')", [ids]);
  }

  /**
   * Waiting tickets whose customers have been away longer than `graceMs` are abandoned, and so are
   * active ones nobody is serving (`served`: the tickets at desks; after a restart, an office nobody
   * came back to); returns their offices.
   */
  async abandonAway(graceMs: number, served: string[]): Promise<string[]> {
    const res = await this.db.query<{ office_id: string }>(
      `UPDATE support_tickets SET status = 'abandoned', closed_at = now()
       WHERE (status = 'waiting' OR (status = 'active' AND NOT (id = ANY($2::text[])))) AND last_seen_at < now() - make_interval(secs => $1)
       RETURNING office_id`,
      [graceMs / 1000, served],
    );
    return [...new Set(res.rows.map((r) => r.office_id))];
  }

  /** Closed tickets, newest first, matching a name, an email or a number. */
  async history(officeId: string, query: string, before: number | null): Promise<{ rows: TicketRow[]; more: boolean }> {
    const like = query ? `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const number = /^#?\d{1,9}$/.test(query) ? Number(query.replace('#', '')) : null;
    const res = await this.db.query<TicketRow>(
      `${SELECT} WHERE t.office_id = $1 AND t.status IN ('resolved', 'abandoned') AND ($2::int IS NULL OR t.number < $2)
         AND ($3::text IS NULL OR t.customer_name ILIKE $3 OR t.customer_email ILIKE $3 OR t.number = $4)
       ORDER BY t.number DESC LIMIT ${HISTORY_PAGE + 1}`,
      [officeId, before, like, number],
    );
    return { rows: res.rows.slice(0, HISTORY_PAGE), more: res.rows.length > HISTORY_PAGE };
  }

  /** A batch of tickets closed more than `days` ago, by office. */
  async expired(days: number, batch: number): Promise<{ officeId: string; ids: string[] }[]> {
    const res = await this.db.query<{ id: string; office_id: string }>(
      `SELECT id, office_id FROM support_tickets WHERE closed_at < now() - make_interval(days => $1) LIMIT $2`,
      [days, batch],
    );
    const out = new Map<string, string[]>();
    for (const r of res.rows) out.set(r.office_id, [...(out.get(r.office_id) ?? []), r.id]);
    return [...out].map(([officeId, ids]) => ({ officeId, ids }));
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length) await this.db.query('DELETE FROM support_tickets WHERE id = ANY($1::text[])', [ids]);
  }
}
