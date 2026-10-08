import {
  PAGE_SIZE,
  type ChatAttachment,
  type ChatChannel,
  type ChatMention,
  type ChatMessage,
  type ChatPerson,
  type ChatReaction,
  type ConvCounts,
  type DmPartner,
} from '../../../shared/chat';
import { plainText } from '../../../shared/chatText';
import { clip } from '../../../shared/text';
import { jsonb, type Db, type Tx } from '../../db';

/** A refusal to show as is ("This channel is archived."). */
export class ChatError extends Error {}

export interface ChannelRow {
  id: string;
  office_id: string;
  name: string;
  topic: string;
  is_default: boolean;
  created_at: Date;
  archived_at: Date | null;
}

export interface MessageRow {
  id: string;
  office_id: string;
  channel_id: string | null;
  dm_key: string | null;
  parent_id: string | null;
  in_channel: boolean;
  author_user_id: string | null;
  author_name: string;
  author_player_id: string | null;
  text: string;
  attachments: ChatAttachment[];
  mentions: ChatMention[];
  reactions: ChatReaction[];
  reply_count: number;
  last_reply_at: Date | null;
  reply_names: string[];
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  parent_name?: string | null;
  parent_text?: string | null;
  parent_mentions?: ChatMention[] | null;
}

const ms = (d: Date | null): number | null => (d ? new Date(d).getTime() : null);

export function toChannel(row: ChannelRow): ChatChannel {
  return { id: row.id, name: row.name, topic: row.topic, isDefault: row.is_default, archived: !!row.archived_at, createdAt: ms(row.created_at)! };
}

export function toMessage(row: MessageRow): ChatMessage {
  const msg: ChatMessage = {
    id: row.id,
    channelId: row.channel_id,
    dm: row.dm_key,
    parentId: row.parent_id,
    inChannel: row.in_channel,
    userId: row.author_user_id,
    playerId: row.author_player_id,
    name: row.author_name,
    text: row.text,
    attachments: row.attachments ?? [],
    mentions: row.mentions ?? [],
    reactions: row.reactions ?? [],
    replyCount: row.reply_count,
    lastReplyAt: ms(row.last_reply_at),
    replyNames: row.reply_names ?? [],
    createdAt: ms(row.created_at)!,
    editedAt: ms(row.edited_at),
    deleted: !!row.deleted_at,
  };
  if (row.in_channel && row.parent_name != null) {
    msg.parent = { name: row.parent_name, text: row.parent_text ? parentPreview(row.parent_text, row.parent_mentions ?? []) : '' };
  }
  return msg;
}

/** Of a parent message, this much text is enough for its one-line preview. */
const PREVIEW_SOURCE = 600;

/** The start of a thread's parent, as shown with replies also sent to the channel. */
export function parentPreview(text: string, mentions: ChatMention[]): string {
  // Only the start is parsed; a mention token cut in half there is dropped.
  const start = text.length > PREVIEW_SOURCE ? clip(text, PREVIEW_SOURCE).replace(/<[@!][^>]*$/, '') : text;
  return plainText(start, mentions, 90);
}

/** Messages with, for replies also sent to the channel, the start of their parent. */
const SELECT_MESSAGES = `
  SELECT m.*, p.author_name AS parent_name, left(p.text, ${PREVIEW_SOURCE}) AS parent_text, p.mentions AS parent_mentions
  FROM chat_messages m LEFT JOIN chat_messages p ON m.in_channel AND p.id = m.parent_id`;

/** Messages older than the one with id $n (the "before" cursor): by created_at, then id. */
const before = (n: number) => `($${n}::uuid IS NULL OR (m.created_at, m.id) < (SELECT c.created_at, c.id FROM chat_messages c WHERE c.id = $${n}::uuid))`;

const UNIQUE_VIOLATION = '23505';
export const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === UNIQUE_VIOLATION;

export interface NewMessage {
  officeId: string;
  channelId: string | null;
  dmKey: string | null;
  /** The two people of a saved direct message. */
  dmUsers?: [string, string];
  parentId: string | null;
  inChannel: boolean;
  userId: string | null;
  playerId: string;
  name: string;
  text: string;
  attachments: ChatAttachment[];
  mentions: ChatMention[];
  /** Signed-in people to keep a mention for, with the conversation it's in. */
  mentionUsers: string[];
  conv: string;
}

/** The database side of chat. */
export class ChatStore {
  private withDefault = new Set<string>();

  constructor(private readonly db: Db) {}

  /** Makes sure the office has #general (offices created after the chat migration get it here). */
  async ensureDefault(officeId: string): Promise<void> {
    if (this.withDefault.has(officeId)) return;
    const found = await this.db.query('SELECT 1 FROM chat_channels WHERE office_id = $1 AND is_default', [officeId]);
    if (!found.rowCount) {
      await this.db.query(`INSERT INTO chat_channels (office_id, name, is_default) VALUES ($1, 'general', true) ON CONFLICT DO NOTHING`, [officeId]);
      // Someone may already have made a #general: that one becomes the default.
      await this.db.query(
        `UPDATE chat_channels SET is_default = true
         WHERE office_id = $1 AND name = 'general' AND archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM chat_channels WHERE office_id = $1 AND is_default)`,
        [officeId],
      );
    }
    this.withDefault.add(officeId);
  }

  async channels(officeId: string): Promise<ChannelRow[]> {
    const res = await this.db.query<ChannelRow>('SELECT * FROM chat_channels WHERE office_id = $1 ORDER BY is_default DESC, archived_at IS NOT NULL, name LIMIT 1000', [officeId]);
    return res.rows;
  }

  async channel(officeId: string, id: string): Promise<ChannelRow | null> {
    const res = await this.db.query<ChannelRow>('SELECT * FROM chat_channels WHERE id = $1 AND office_id = $2', [id, officeId]);
    return res.rows[0] ?? null;
  }

  async openChannelCount(officeId: string): Promise<number> {
    const res = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM chat_channels WHERE office_id = $1 AND archived_at IS NULL', [officeId]);
    return res.rows[0].n;
  }

  async createChannel(officeId: string, name: string, topic: string, by: { userId: string | null; name: string }): Promise<ChannelRow> {
    const res = await this.db.query<ChannelRow>(
      'INSERT INTO chat_channels (office_id, name, topic, created_by_user_id, created_by_name) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [officeId, name, topic, by.userId, by.name],
    );
    return res.rows[0];
  }

  async updateChannel(id: string, patch: { name?: string; topic?: string }): Promise<ChannelRow> {
    const res = await this.db.query<ChannelRow>('UPDATE chat_channels SET name = COALESCE($2, name), topic = COALESCE($3, topic) WHERE id = $1 RETURNING *', [
      id,
      patch.name ?? null,
      patch.topic ?? null,
    ]);
    return res.rows[0];
  }

  async archiveChannel(id: string, archived: boolean): Promise<ChannelRow> {
    const res = await this.db.query<ChannelRow>(`UPDATE chat_channels SET archived_at = ${archived ? 'COALESCE(archived_at, now())' : 'NULL'} WHERE id = $1 RETURNING *`, [id]);
    return res.rows[0];
  }

  /** Signed-in people who have been to the office, most recent first. */
  async people(officeId: string): Promise<ChatPerson[]> {
    const res = await this.db.query<{ id: string; name: string }>(
      'SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.office_id = $1 ORDER BY m.last_visit_at DESC LIMIT 500',
      [officeId],
    );
    return res.rows.map((r) => ({ userId: r.id, name: r.name }));
  }

  /** Of these people, the ones who are members of the office, with their names. */
  async membersAmong(officeId: string, userIds: string[]): Promise<Map<string, string>> {
    if (!userIds.length) return new Map();
    const res = await this.db.query<{ id: string; name: string }>(
      'SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.office_id = $1 AND m.user_id = ANY($2::text[])',
      [officeId, userIds],
    );
    return new Map(res.rows.map((r) => [r.id, r.name]));
  }

  /** A signed-in person's saved direct messages in the office. */
  async dms(userId: string, officeId: string): Promise<(DmPartner & { dmKey: string; unread: number })[]> {
    const res = await this.db.query<{ dm_key: string; other: string; name: string; last_message_at: Date; unread: number }>(
      `SELECT d.dm_key, u.id AS other, u.name, d.last_message_at,
         (SELECT count(*)::int FROM (
            SELECT 1 FROM chat_messages m
            WHERE m.office_id = $2 AND m.dm_key = d.dm_key AND (m.parent_id IS NULL OR m.in_channel) AND m.deleted_at IS NULL
              AND m.author_user_id IS DISTINCT FROM $1 AND m.created_at > COALESCE(r.last_read_at, '-infinity')
            LIMIT 99) x) AS unread
       FROM chat_dms d
       JOIN users u ON u.id = CASE WHEN d.user_a = $1 THEN d.user_b ELSE d.user_a END
       LEFT JOIN chat_reads r ON r.user_id = $1 AND r.office_id = $2 AND r.conv = 'dm:' || d.dm_key
       WHERE d.office_id = $2 AND (d.user_a = $1 OR d.user_b = $1)
       ORDER BY d.last_message_at DESC LIMIT 100`,
      [userId, officeId],
    );
    return res.rows.map((r) => ({ userId: r.other, name: r.name, lastMessageAt: ms(r.last_message_at)!, dmKey: r.dm_key, unread: r.unread }));
  }

  /**
   * Unread messages (and mentions) in the office's open channels for a signed-in person, by "c:<id>".
   * Before they first read a channel, messages from before they joined the office don't count.
   */
  async channelCounts(userId: string, officeId: string): Promise<Record<string, ConvCounts>> {
    const unread = await this.db.query<{ conv: string; unread: number }>(
      `SELECT 'c:' || c.id AS conv,
         (SELECT count(*)::int FROM (
            SELECT 1 FROM chat_messages m
            WHERE m.channel_id = c.id AND (m.parent_id IS NULL OR m.in_channel) AND m.deleted_at IS NULL
              AND m.author_user_id IS DISTINCT FROM $1
              AND m.created_at > COALESCE(r.last_read_at, (SELECT joined_at FROM memberships WHERE user_id = $1 AND office_id = $2), now())
            LIMIT 99) x) AS unread
       FROM chat_channels c
       LEFT JOIN chat_reads r ON r.user_id = $1 AND r.office_id = $2 AND r.conv = 'c:' || c.id
       WHERE c.office_id = $2 AND c.archived_at IS NULL`,
      [userId, officeId],
    );
    const mentions = await this.db.query<{ conv: string; n: number }>(
      `SELECT mn.conv, count(*)::int AS n FROM chat_mentions mn
       JOIN chat_channels c ON 'c:' || c.id = mn.conv AND c.archived_at IS NULL
       WHERE mn.user_id = $1 AND mn.office_id = $2 AND mn.read_at IS NULL GROUP BY mn.conv`,
      [userId, officeId],
    );
    const out: Record<string, ConvCounts> = {};
    for (const r of unread.rows) if (r.unread) out[r.conv] = { unread: r.unread, mentions: 0 };
    for (const r of mentions.rows) out[r.conv] = { unread: out[r.conv]?.unread ?? 0, mentions: r.n };
    return out;
  }

  /** A page of a conversation (top-level messages and replies also sent to it), oldest first. */
  async history(where: { channelId: string } | { officeId: string; dmKey: string }, beforeId?: string): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
    const res =
      'channelId' in where
        ? await this.db.query<MessageRow>(
            `${SELECT_MESSAGES} WHERE m.channel_id = $1 AND (m.parent_id IS NULL OR m.in_channel) AND ${before(2)}
             ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE_SIZE + 1}`,
            [where.channelId, beforeId ?? null],
          )
        : await this.db.query<MessageRow>(
            `${SELECT_MESSAGES} WHERE m.office_id = $1 AND m.dm_key = $2 AND (m.parent_id IS NULL OR m.in_channel) AND ${before(3)}
             ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE_SIZE + 1}`,
            [where.officeId, where.dmKey, beforeId ?? null],
          );
    return { rows: res.rows.slice(0, PAGE_SIZE).reverse(), hasMore: res.rows.length > PAGE_SIZE };
  }

  /** A page of a thread's replies, oldest first. */
  async replies(parentId: string, beforeId?: string): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
    const res = await this.db.query<MessageRow>(
      `${SELECT_MESSAGES} WHERE m.parent_id = $1 AND ${before(2)} ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE_SIZE + 1}`,
      [parentId, beforeId ?? null],
    );
    return { rows: res.rows.slice(0, PAGE_SIZE).reverse(), hasMore: res.rows.length > PAGE_SIZE };
  }

  async message(id: string, q: Tx = this.db, lock = false): Promise<MessageRow | null> {
    const res = await q.query<MessageRow>(lock ? 'SELECT * FROM chat_messages WHERE id = $1 FOR UPDATE' : `${SELECT_MESSAGES} WHERE m.id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  /**
   * Uploads that may be attached to a new message: in this office, from this person (signed in) or
   * a guest (not), from the last day, and not attached to anything yet (live messages included).
   * Only the uploader learns an upload's id until it's sent, so for guests' files the id is proof enough.
   */
  async attachable(officeId: string, ids: string[], userId: string | null): Promise<Map<string, { name: string; contentType: string; size: number }>> {
    if (!ids.length) return new Map();
    const res = await this.db.query<{ id: string; filename: string; content_type: string; byte_size: number }>(
      `SELECT u.id, u.filename, u.content_type, u.byte_size FROM uploads u
       WHERE u.id = ANY($1::uuid[]) AND u.office_id = $2 AND u.uploader_user_id IS NOT DISTINCT FROM $3
         AND u.created_at > now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM chat_attachments a WHERE a.upload_id = u.id)`,
      [ids, officeId, userId],
    );
    return new Map(res.rows.map((r) => [r.id, { name: r.filename, contentType: r.content_type, size: r.byte_size }]));
  }

  /** Marks files sent in a live (unsaved) message as used, so they can't be attached again. */
  async claimLive(uploadIds: string[]): Promise<void> {
    if (!uploadIds.length) return;
    try {
      await this.db.query('INSERT INTO chat_attachments (upload_id) SELECT unnest($1::uuid[])', [uploadIds]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ChatError('That file is already attached to another message.');
      throw err;
    }
  }

  /** Saves a message (and updates its thread's parent); returns both. */
  async insert(m: NewMessage): Promise<{ message: MessageRow; parent: MessageRow | null }> {
    return this.db.transaction(async (tx) => {
      let parent: MessageRow | null = null;
      if (m.parentId) {
        parent = await this.message(m.parentId, tx, true);
        if (!parent || parent.deleted_at) throw new ChatError('That message was deleted.');
      }
      const res = await tx.query<MessageRow>(
        `INSERT INTO chat_messages (office_id, channel_id, dm_key, parent_id, in_channel, author_user_id, author_name, author_player_id, text, attachments, mentions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb) RETURNING *`,
        [m.officeId, m.channelId, m.dmKey, m.parentId, m.inChannel, m.userId, m.name, m.playerId, m.text, jsonb(m.attachments), jsonb(m.mentions)],
      );
      const message = res.rows[0];
      if (m.attachments.length) {
        try {
          await tx.query('INSERT INTO chat_attachments (upload_id, message_id) SELECT unnest($1::uuid[]), $2', [m.attachments.map((a) => a.id), message.id]);
        } catch (err) {
          if (isUniqueViolation(err)) throw new ChatError('That file is already attached to another message.');
          throw err;
        }
      }
      if (parent) {
        const names = [m.name, ...parent.reply_names.filter((n) => n !== m.name)].slice(0, 3);
        const updated = await tx.query<MessageRow>(
          'UPDATE chat_messages SET reply_count = reply_count + 1, last_reply_at = $2, reply_names = $3::jsonb WHERE id = $1 RETURNING *',
          [parent.id, message.created_at, jsonb(names)],
        );
        parent = updated.rows[0];
      }
      if (m.dmKey && m.dmUsers) {
        await tx.query(
          `INSERT INTO chat_dms (office_id, dm_key, user_a, user_b, last_message_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (office_id, dm_key) DO UPDATE SET last_message_at = EXCLUDED.last_message_at`,
          [m.officeId, m.dmKey, m.dmUsers[0], m.dmUsers[1], message.created_at],
        );
      }
      // Writing in a conversation means you've seen it.
      if (m.userId) await this.markRead(m.userId, m.officeId, m.conv, tx, message.created_at);
      await this.addMentions(tx, m.mentionUsers, message.id, m.officeId, m.conv);
      return { message, parent };
    });
  }

  private async addMentions(tx: Tx, userIds: string[], messageId: string, officeId: string, conv: string): Promise<void> {
    if (!userIds.length) return;
    await tx.query(
      `INSERT INTO chat_mentions (user_id, message_id, office_id, conv) SELECT unnest($1::text[]), $2, $3, $4 ON CONFLICT DO NOTHING`,
      [userIds, messageId, officeId, conv],
    );
  }

  /** New text (and mentions); returns the message and the people newly mentioned. */
  async edit(id: string, text: string, mentions: ChatMention[], mentionUsers: string[], conv: string, check: (row: MessageRow) => void) {
    return this.db.transaction(async (tx) => {
      const row = await this.message(id, tx, true);
      if (!row || row.deleted_at) throw new ChatError('That message was deleted.');
      check(row);
      await tx.query('UPDATE chat_messages SET text = $2, mentions = $3::jsonb, edited_at = now() WHERE id = $1', [id, text, jsonb(mentions)]);
      await tx.query('DELETE FROM chat_mentions WHERE message_id = $1 AND NOT (user_id = ANY($2::text[]))', [id, mentionUsers]);
      const had = await tx.query<{ user_id: string }>('SELECT user_id FROM chat_mentions WHERE message_id = $1', [id]);
      const added = mentionUsers.filter((u) => !had.rows.some((r) => r.user_id === u));
      await this.addMentions(tx, added, id, row.office_id, conv);
      return { message: (await this.message(id, tx))!, added };
    });
  }

  /** Deletes a message's content (it stays, as "deleted"); returns it, its parent and its files' upload ids. */
  async remove(id: string, check: (row: MessageRow) => void) {
    return this.db.transaction(async (tx) => {
      const row = await this.message(id, tx, true);
      if (!row) throw new ChatError('That message no longer exists.');
      check(row);
      if (row.deleted_at) return { message: row, parent: null, uploads: [] as string[] };
      await tx.query(
        `UPDATE chat_messages SET deleted_at = now(), text = '', attachments = '[]', mentions = '[]', reactions = '[]' WHERE id = $1`,
        [id],
      );
      await tx.query('DELETE FROM chat_mentions WHERE message_id = $1', [id]);
      const uploads = (await tx.query<{ upload_id: string }>('DELETE FROM chat_attachments WHERE message_id = $1 RETURNING upload_id', [id])).rows.map(
        (r) => r.upload_id,
      );
      let parent: MessageRow | null = null;
      if (row.parent_id) {
        parent = (await tx.query<MessageRow>('UPDATE chat_messages SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1 RETURNING *', [row.parent_id]))
          .rows[0] ?? null;
      }
      return { message: (await this.message(id, tx))!, parent, uploads };
    });
  }

  /** Adds or takes back a reaction. */
  async react(id: string, change: (row: MessageRow) => ChatReaction[] | null): Promise<MessageRow> {
    return this.db.transaction(async (tx) => {
      const row = await this.message(id, tx, true);
      if (!row || row.deleted_at) throw new ChatError('That message was deleted.');
      const reactions = change(row);
      if (!reactions) throw new ChatError('This message has all the reactions it can take.');
      await tx.query('UPDATE chat_messages SET reactions = $2::jsonb WHERE id = $1', [id, jsonb(reactions)]);
      return (await this.message(id, tx))!;
    });
  }

  /** Marks a conversation ("c:<id>" or "dm:<key>") read up to `at` (default now), mentions included. */
  async markRead(userId: string, officeId: string, conv: string, q: Tx = this.db, at?: Date): Promise<void> {
    await q.query(
      `INSERT INTO chat_reads (user_id, office_id, conv, last_read_at) VALUES ($1, $2, $3, COALESCE($4, now()))
       ON CONFLICT (user_id, office_id, conv) DO UPDATE SET last_read_at = GREATEST(chat_reads.last_read_at, EXCLUDED.last_read_at)`,
      [userId, officeId, conv, at ?? null],
    );
    await q.query('UPDATE chat_mentions SET read_at = now() WHERE user_id = $1 AND office_id = $2 AND conv = $3 AND read_at IS NULL', [userId, officeId, conv]);
  }

  /**
   * Deletes messages (with their threads) that have been quiet for `days`, a batch at a time, and
   * direct message conversations left empty; returns how many threads went, and the upload ids of
   * their files and of files sent that long ago in live messages.
   */
  async sweep(days: number, batch = 500): Promise<{ threads: number; uploads: string[] }> {
    let threads = 0;
    const uploads: string[] = [];
    for (;;) {
      const done = await this.db.transaction(async (tx) => {
        const old = await tx.query<{ id: string }>(
          `SELECT id FROM chat_messages WHERE parent_id IS NULL AND COALESCE(last_reply_at, created_at) < now() - make_interval(days => $1) LIMIT $2`,
          [days, batch],
        );
        if (!old.rowCount) return true;
        const ids = old.rows.map((r) => r.id);
        const files = await tx.query<{ upload_id: string }>(
          `SELECT a.upload_id FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id WHERE m.id = ANY($1::uuid[]) OR m.parent_id = ANY($1::uuid[])`,
          [ids],
        );
        uploads.push(...files.rows.map((r) => r.upload_id));
        threads += (await tx.query('DELETE FROM chat_messages WHERE id = ANY($1::uuid[])', [ids])).rowCount;
        return old.rowCount < batch;
      });
      if (done) break;
    }
    await this.db.query(
      `DELETE FROM chat_dms d WHERE NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.office_id = d.office_id AND m.dm_key = d.dm_key)`,
    );
    const live = await this.db.query<{ upload_id: string }>(
      `DELETE FROM chat_attachments a USING uploads u
       WHERE a.message_id IS NULL AND u.id = a.upload_id AND u.created_at < now() - make_interval(days => $1)
       RETURNING a.upload_id`,
      [days],
    );
    uploads.push(...live.rows.map((r) => r.upload_id));
    return { threads, uploads };
  }
}
