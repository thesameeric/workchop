import type { Migration } from '../../features';

export const migrations: Migration[] = [
  {
    id: 700,
    name: 'support_tickets',
    sql: `
      -- One row per conversation between a customer and the staff of a support workspace. Its chat
      -- is the conversation "t:<id>" in chat_messages.
      CREATE TABLE support_tickets (
        id               text PRIMARY KEY,
        office_id        text NOT NULL REFERENCES offices ON DELETE CASCADE,
        -- Counts up per workspace ("#45").
        number           int NOT NULL,
        status           text NOT NULL CHECK (status IN ('waiting', 'active', 'resolved', 'abandoned')),
        customer_name    text NOT NULL,
        customer_email   text,
        -- SHA-256 of the secret the customer's browser keeps, which gets the open ticket back.
        customer_key     text NOT NULL,
        -- SHA-256 of the address it was opened from (for limits; never the address itself).
        customer_address text NOT NULL,
        first_message    text NOT NULL,
        assignee_user_id text REFERENCES users ON DELETE SET NULL,
        desk_item_id     text,
        rating           smallint CHECK (rating BETWEEN 1 AND 5),
        created_at       timestamptz NOT NULL DEFAULT now(),
        -- When an agent last called it (kept when it goes back to the queue, which puts it first).
        assigned_at      timestamptz,
        closed_at        timestamptz,
        -- When the customer was last here (away customers keep their place for a while).
        last_seen_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (office_id, number)
      );
      -- One open ticket per customer, one customer at a time per agent and per desk.
      CREATE UNIQUE INDEX support_tickets_customer_idx ON support_tickets (office_id, customer_key) WHERE status IN ('waiting', 'active');
      CREATE UNIQUE INDEX support_tickets_agent_idx ON support_tickets (office_id, assignee_user_id) WHERE status = 'active';
      CREATE UNIQUE INDEX support_tickets_desk_idx ON support_tickets (office_id, desk_item_id) WHERE status = 'active';
      -- The queue, and the history (newest first) with its retention sweep.
      CREATE INDEX support_tickets_waiting_idx ON support_tickets (office_id, created_at) WHERE status = 'waiting';
      CREATE INDEX support_tickets_closed_idx ON support_tickets (office_id, number) WHERE status IN ('resolved', 'abandoned');
      CREATE INDEX support_tickets_expiry_idx ON support_tickets (closed_at) WHERE closed_at IS NOT NULL;
      -- For the foreign key (an account's tickets lose their assignee with it).
      CREATE INDEX support_tickets_assignee_idx ON support_tickets (assignee_user_id);
      -- Open tickets per address (a limit).
      CREATE INDEX support_tickets_address_idx ON support_tickets (office_id, customer_address) WHERE status IN ('waiting', 'active');
      -- The last ticket number of each workspace, so numbers never start over (old tickets get deleted).
      CREATE TABLE support_counters (
        office_id   text PRIMARY KEY REFERENCES offices ON DELETE CASCADE,
        last_number int NOT NULL
      );`,
  },
];
