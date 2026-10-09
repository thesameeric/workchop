import type { Migration } from '../../features';

// Billing's tables (ids 800–899). Only tables: workspaces that existed when billing was switched on
// get their 30 days the first time the server starts with a Paystack key (see launch() in store.ts).
// Money is in kobo and Paystack's ids are 64-bit, so both are bigint.

export const migrations: Migration[] = [
  {
    id: 800,
    name: 'billing',
    sql: `
      -- When billing was switched on (one row).
      CREATE TABLE billing_launch (
        id          boolean PRIMARY KEY DEFAULT true CHECK (id),
        launched_at timestamptz NOT NULL
      );
      -- Each office's plan, as last stored; who may come in is worked out from its dates (state.ts).
      CREATE TABLE billing_accounts (
        office_id            text PRIMARY KEY REFERENCES offices ON DELETE CASCADE,
        status               text NOT NULL CHECK (status IN ('free', 'incomplete', 'active', 'past_due', 'locked')),
        comp                 boolean NOT NULL DEFAULT false,
        seats                int NOT NULL DEFAULT 0 CHECK (seats >= 0),
        seats_next           int CHECK (seats_next >= 1),
        currency             text NOT NULL DEFAULT 'NGN',
        unit_amount          bigint CHECK (unit_amount > 0),
        interval             text CHECK (interval IN ('month', 'year')),
        anchor_at            timestamptz,
        period_start         timestamptz,
        period_end           timestamptz,
        cancel_at_period_end boolean NOT NULL DEFAULT false,
        auto_renew           boolean NOT NULL DEFAULT true,
        grace_reason         text CHECK (grace_reason IN ('payment_failed', 'action_needed', 'no_card', 'cancelled', 'launch')),
        grace_ends_at        timestamptz,
        retry_count          int NOT NULL DEFAULT 0,
        next_retry_at        timestamptz,
        -- Owed at the next renewal (positive) or credit (negative).
        carry_amount         bigint NOT NULL DEFAULT 0,
        payer_user_id        text REFERENCES users ON DELETE SET NULL,
        paystack_email       text,
        customer_code        text,
        authorization_code   text,
        card_signature       text,
        card_brand           text,
        card_last4           text,
        card_exp_month       int,
        card_exp_year        int,
        card_bank            text,
        action_url           text,
        disputed_at          timestamptz,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX billing_accounts_open_idx ON billing_accounts (status) WHERE status <> 'free';
      -- The ledger: kept when an office is deleted (no foreign key), with its name as it was.
      CREATE TABLE billing_charges (
        id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        reference         text NOT NULL UNIQUE,
        office_id         text NOT NULL,
        office_name       text NOT NULL,
        purpose           text NOT NULL CHECK (purpose IN ('subscribe', 'pay_due', 'renewal', 'seats', 'card_update')),
        status            text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'abandoned', 'action_needed', 'superseded', 'refunded')),
        seats             int NOT NULL,
        unit_amount       bigint NOT NULL,
        amount            bigint NOT NULL CHECK (amount > 0),
        currency          text NOT NULL,
        carry_applied     bigint NOT NULL DEFAULT 0,
        tax_rate          numeric(6, 4) NOT NULL DEFAULT 0,
        tax_amount        bigint NOT NULL DEFAULT 0,
        fees              bigint,
        period_start      timestamptz,
        period_end        timestamptz,
        attempt           int NOT NULL DEFAULT 1,
        actor_user_id     text,
        payer_email       text NOT NULL,
        paystack_tx_id    bigint UNIQUE,
        gateway_response  text,
        authorization_url text,
        card_last4        text,
        card_brand        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        settled_at        timestamptz
      );
      CREATE INDEX billing_charges_office_idx ON billing_charges (office_id, created_at DESC);
      CREATE INDEX billing_charges_pending_idx ON billing_charges (created_at) WHERE status IN ('pending', 'action_needed');
      -- One renewal per office and period at a time, and one seats charge per office.
      CREATE UNIQUE INDEX billing_charges_one_renewal_idx ON billing_charges (office_id, period_start)
        WHERE purpose = 'renewal' AND status IN ('pending', 'succeeded');
      CREATE UNIQUE INDEX billing_charges_one_seats_idx ON billing_charges (office_id) WHERE purpose = 'seats' AND status = 'pending';
      -- Paystack's webhooks, once each.
      CREATE TABLE billing_events (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event       text NOT NULL,
        key         text NOT NULL,
        reference   text,
        payload     jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        handled_at  timestamptz,
        UNIQUE (event, key)
      );
      -- Emails sent, so each goes out once.
      CREATE TABLE billing_notices (
        office_id  text NOT NULL,
        kind       text NOT NULL,
        period_key text NOT NULL,
        sent_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (office_id, kind, period_key)
      );
      -- Who changed what.
      CREATE TABLE billing_log (
        id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        office_id     text NOT NULL,
        at            timestamptz NOT NULL DEFAULT now(),
        actor_user_id text,
        action        text NOT NULL,
        before        jsonb,
        after         jsonb
      );
      CREATE INDEX billing_log_office_idx ON billing_log (office_id, at DESC);`,
  },
  {
    id: 801,
    name: 'billing charges: seats, refunds, checks',
    sql: `
      -- A seats charge's seats before it (it's only granted if they're still that many).
      ALTER TABLE billing_charges ADD COLUMN seats_from int;
      -- A payment for something already paid: its refund is due, asked of Paystack, or refused by it.
      ALTER TABLE billing_charges ADD COLUMN refund text CHECK (refund IN ('due', 'requested', 'refused'));
      -- When the scheduled run last asked Paystack about it.
      ALTER TABLE billing_charges ADD COLUMN checked_at timestamptz;
      CREATE INDEX billing_charges_refund_idx ON billing_charges (created_at) WHERE refund = 'due';
      -- A seats charge waiting for the bank also counts as under way. An office with two (made before
      -- this) keeps the newer.
      UPDATE billing_charges c SET status = 'abandoned'
        WHERE c.purpose = 'seats' AND c.status IN ('pending', 'action_needed') AND EXISTS (
          SELECT 1 FROM billing_charges n WHERE n.office_id = c.office_id AND n.purpose = 'seats' AND n.status IN ('pending', 'action_needed') AND n.id > c.id);
      DROP INDEX billing_charges_one_seats_idx;
      CREATE UNIQUE INDEX billing_charges_one_seats_idx ON billing_charges (office_id) WHERE purpose = 'seats' AND status IN ('pending', 'action_needed');`,
  },
];
