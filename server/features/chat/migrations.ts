import type { Migration } from '../../features';

export const migrations: Migration[] = [
  {
    id: 100,
    name: 'chat',
    sql: `
      CREATE TABLE chat_channels (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        office_id          text NOT NULL REFERENCES offices ON DELETE CASCADE,
        name               text NOT NULL,
        topic              text NOT NULL DEFAULT '',
        -- #general: one per office, never renamed or archived.
        is_default         boolean NOT NULL DEFAULT false,
        created_by_user_id text REFERENCES users ON DELETE SET NULL,
        created_by_name    text NOT NULL DEFAULT '',
        created_at         timestamptz NOT NULL DEFAULT now(),
        archived_at        timestamptz
      );
      -- Names are unique among an office's open channels (an archived name can be used again).
      CREATE UNIQUE INDEX chat_channels_name_idx ON chat_channels (office_id, lower(name)) WHERE archived_at IS NULL;
      CREATE UNIQUE INDEX chat_channels_default_idx ON chat_channels (office_id) WHERE is_default;

      -- Messages in channels, and saved direct messages between two signed-in people (dm_key is
      -- their two user ids, sorted, joined with ":"). Live messages (nearby, with guests) aren't stored.
      CREATE TABLE chat_messages (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        office_id        text NOT NULL REFERENCES offices ON DELETE CASCADE,
        channel_id       uuid REFERENCES chat_channels ON DELETE CASCADE,
        dm_key           text,
        parent_id        uuid REFERENCES chat_messages ON DELETE CASCADE,
        -- A thread reply also shown in the channel.
        in_channel       boolean NOT NULL DEFAULT false,
        author_user_id   text REFERENCES users ON DELETE SET NULL,
        author_name      text NOT NULL,
        author_player_id text,
        text             text NOT NULL,
        attachments      jsonb NOT NULL DEFAULT '[]',
        mentions         jsonb NOT NULL DEFAULT '[]',
        reactions        jsonb NOT NULL DEFAULT '[]',
        reply_count      int NOT NULL DEFAULT 0,
        last_reply_at    timestamptz,
        reply_names      jsonb NOT NULL DEFAULT '[]',
        -- Milliseconds, as the clients see them.
        created_at       timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
        edited_at        timestamptz,
        deleted_at       timestamptz,
        CHECK ((channel_id IS NULL) <> (dm_key IS NULL))
      );
      CREATE INDEX chat_messages_channel_idx ON chat_messages (channel_id, created_at, id);
      CREATE INDEX chat_messages_parent_idx ON chat_messages (parent_id, created_at, id);
      CREATE INDEX chat_messages_dm_idx ON chat_messages (office_id, dm_key, created_at, id) WHERE dm_key IS NOT NULL;
      -- For the foreign key (an office's messages go with it).
      CREATE INDEX chat_messages_office_idx ON chat_messages (office_id);

      -- Which message each uploaded file belongs to (a file is attached once). Files sent in live
      -- messages, which aren't saved, have no message.
      CREATE TABLE chat_attachments (
        upload_id  uuid PRIMARY KEY REFERENCES uploads ON DELETE CASCADE,
        message_id uuid REFERENCES chat_messages ON DELETE CASCADE
      );
      CREATE INDEX chat_attachments_message_idx ON chat_attachments (message_id);

      -- Saved direct message conversations, for listing them.
      CREATE TABLE chat_dms (
        office_id       text NOT NULL REFERENCES offices ON DELETE CASCADE,
        dm_key          text NOT NULL,
        user_a          text NOT NULL REFERENCES users ON DELETE CASCADE,
        user_b          text NOT NULL REFERENCES users ON DELETE CASCADE,
        last_message_at timestamptz NOT NULL,
        PRIMARY KEY (office_id, dm_key)
      );
      CREATE INDEX chat_dms_a_idx ON chat_dms (office_id, user_a);
      CREATE INDEX chat_dms_b_idx ON chat_dms (office_id, user_b);

      -- How far each signed-in person has read a conversation ("c:<channel id>" or "dm:<dm key>").
      CREATE TABLE chat_reads (
        user_id      text NOT NULL REFERENCES users ON DELETE CASCADE,
        office_id    text NOT NULL REFERENCES offices ON DELETE CASCADE,
        conv         text NOT NULL,
        last_read_at timestamptz NOT NULL,
        PRIMARY KEY (user_id, office_id, conv)
      );

      -- Mentions of signed-in people, kept until they've seen them (also when they were away).
      CREATE TABLE chat_mentions (
        user_id    text NOT NULL REFERENCES users ON DELETE CASCADE,
        message_id uuid NOT NULL REFERENCES chat_messages ON DELETE CASCADE,
        office_id  text NOT NULL REFERENCES offices ON DELETE CASCADE,
        conv       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        read_at    timestamptz,
        PRIMARY KEY (user_id, message_id)
      );
      CREATE INDEX chat_mentions_unread_idx ON chat_mentions (user_id, office_id) WHERE read_at IS NULL;
      CREATE INDEX chat_mentions_message_idx ON chat_mentions (message_id);

      -- Every office starts with #general.
      INSERT INTO chat_channels (office_id, name, is_default) SELECT id, 'general', true FROM offices;`,
  },
  {
    id: 101,
    name: 'chat_conversations',
    sql: `
      -- Conversations other features own (a support ticket's chat is "t:<ticket id>"). They are
      -- deleted by their feature, not by the retention sweep.
      ALTER TABLE chat_messages ADD COLUMN conv_key text;
      ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_check;
      ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_one_conv CHECK (num_nonnulls(channel_id, dm_key, conv_key) = 1);
      CREATE INDEX chat_messages_conv_idx ON chat_messages (office_id, conv_key, created_at, id) WHERE conv_key IS NOT NULL;`,
  },
];
