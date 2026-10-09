import {
  channelNameError,
  cleanMessageText,
  cleanTopic,
  dmKey,
  dmPartner,
  findMention,
  isReactionEmoji,
  MAX_ATTACHMENTS,
  MENTION_TOKEN,
  mentionToken,
  normalizeChannelName,
  parseMentionTokens,
  reactorId,
  toggleReaction,
  type ChatAttachment,
  type ChatMention,
  type ChatMessage,
} from '../../../shared/chat';
import type { PlayerState } from '../../../shared/types';
import { isCustomer } from '../../../shared/workspace';
import type { Feature, ServerContext } from '../../features';
import { randomId } from '../../officeStore';
import { roomName } from '../../realtime';
import { conversationOf as registered, type ConvAccess, type Conversation } from './conversations';
import { migrations } from './migrations';
import { ChatError, ChatStore, isUniqueViolation, parentPreview, toChannel, toMessage, type ChannelRow, type MessageRow } from './store';

export { registerConversation, type ConvAccess, type Conversation } from './conversations';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** Open channels per office. */
const MAX_CHANNELS = 200;
/** Mentions resolved per message (any more are left as plain text). */
const MAX_MENTIONS = 20;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const HOUR = 60 * 60 * 1000;

export interface ChatOptions {
  /** Delete conversations quiet for this many days (null keeps everything). Default: CHAT_RETENTION_DAYS. */
  retentionDays?: number | null;
  /** How often old conversations and unattached files are looked for, at most (default hourly, checked when someone joins). */
  sweepEveryMs?: number;
}

export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.CHAT_RETENTION_DAYS?.trim();
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) throw new Error(`CHAT_RETENTION_DAYS must be a whole number of days, 1 or more (got "${raw}")`);
  return days;
}

/** Answers a request with what `work` returns, or with the reason it failed. */
function answer<T extends object>(ack: unknown, work: () => Promise<T>): void {
  const reply = typeof ack === 'function' ? (ack as (res: unknown) => void) : () => {};
  work().then(
    (res) => reply({ ok: true, ...res }),
    (err) => {
      if (!(err instanceof ChatError)) console.error('[chat] a request failed:', err);
      reply({ ok: false, error: err instanceof ChatError ? err.message : 'Something went wrong. Please try again.' });
    },
  );
}

/** Where a message goes: a channel, saved direct message or feature's conversation, or live (to people present now). */
type Target =
  | { kind: 'channel'; channel: ChannelRow; conv: string }
  | { kind: 'dm'; dmKey: string; users: [string, string]; conv: string }
  | { kind: 'conv'; conv: string; owner: Conversation; access: ConvAccess }
  | { kind: 'nearby' }
  | { kind: 'live'; to: PlayerState };

/** Who a message's mentions reach. */
interface Mentioned {
  text: string;
  mentions: ChatMention[];
  users: string[];
  players: string[];
  here: boolean;
}

interface Here {
  officeId: string;
  me: PlayerState;
  players: ReadonlyMap<string, PlayerState>;
}

export function chatFeature(opts: ChatOptions = {}): Feature {
  return {
    name: 'chat',
    migrations,
    register: (ctx) => registerChat(ctx, opts.retentionDays !== undefined ? opts.retentionDays : retentionFromEnv(), opts.sweepEveryMs ?? HOUR),
  };
}

export const feature = chatFeature();

/** Mention tokens in text that doesn't go through mention checks, as plain text. */
const unmention = (text: string) => text.replace(MENTION_TOKEN, (token) => (token === '<!here>' ? '@here' : '@unknown'));

/**
 * Saves a message in a feature's conversation on someone's behalf (a ticket's first message) and
 * sends it to the conversation's audience.
 */
export async function postToConversation(
  ctx: Pick<ServerContext, 'db' | 'io'>,
  m: { officeId: string; key: string; userId: string | null; playerId: string; name: string; text: string },
): Promise<ChatMessage> {
  const owner = registered(ctx, m.key);
  if (!owner) throw new Error(`No feature owns the conversation ${m.key}`);
  const { message } = await new ChatStore(ctx.db).insert({
    officeId: m.officeId,
    channelId: null,
    dmKey: null,
    convKey: m.key,
    parentId: null,
    inChannel: false,
    userId: m.userId,
    playerId: m.playerId,
    name: m.name,
    text: unmention(cleanMessageText(m.text)),
    attachments: [],
    mentions: [],
    mentionUsers: [],
    conv: m.key,
  });
  const msg = toMessage(message);
  const ids = owner.audience(m.officeId, m.key);
  if (ids.length) ctx.io.to(ids).emit('chat:message', msg);
  return msg;
}

/** Deletes features' conversations, with their files. */
export async function deleteConversations(ctx: Pick<ServerContext, 'db' | 'uploads'>, officeId: string, keys: string[]): Promise<void> {
  await ctx.uploads.remove(await new ChatStore(ctx.db).deleteConversations(officeId, keys));
}

function registerChat(ctx: ServerContext, retentionDays: number | null, sweepEveryMs: number): void {
  const store = new ChatStore(ctx.db);
  const { realtime, io } = ctx;
  const conversationOf = (key: unknown) => registered(ctx, key);

  let lastSweep = 0;
  const sweep = async () => {
    lastSweep = Date.now();
    try {
      // Files are uploaded to be attached: ones still unattached after a day go.
      await ctx.uploads.remove(await store.unattached());
      if (!retentionDays) return;
      const { threads, uploads } = await store.sweep(retentionDays);
      await ctx.uploads.remove(uploads);
      if (threads) console.log(`[chat] deleted ${threads} messages (with their threads) quiet for over ${retentionDays} days`);
    } catch (err) {
      console.error('[chat] could not delete old messages and files:', err);
    }
  };
  // No timers to stop: it runs when people come in, at most every sweepEveryMs.
  realtime.onJoin(() => {
    if (Date.now() - lastSweep >= sweepEveryMs) void sweep();
  });

  /** This person's connections in the office. */
  const socketsOf = (officeId: string, userId: string) =>
    realtime
      .playersOfUser(userId)
      .filter((p) => p.officeId === officeId)
      .map((p) => p.player.id);

  /** Customers (guests of support workspaces) only chat in their tickets. */
  const isCustomerPlayer = (officeId: string, playerId: string) => isCustomer(realtime.contextOf(playerId)?.role(), ctx.store.peek(officeId)?.kind);
  /** Everyone in the office who sees its channels: all but customers. */
  const channelAudience = (officeId: string) => {
    const customers = ctx.store.peek(officeId)?.kind === 'support' ? realtime.players(officeId).filter((p) => isCustomerPlayer(officeId, p.id)) : [];
    return io.to(roomName(officeId)).except(customers.map((p) => p.id));
  };

  /**
   * Sends a saved message to those who can see it: the office for channels, the two people for
   * direct messages, a feature's audience for its conversations.
   */
  const deliver = (officeId: string, row: MessageRow, event: 'chat:message' | 'chat:updated' | 'chat:deleted', msg: ChatMessage = toMessage(row)) => {
    let ids: string[] = [];
    if (row.channel_id) return void channelAudience(officeId).emit(event, msg);
    if (row.dm_key) ids = row.dm_key.split(':').flatMap((u) => socketsOf(officeId, u));
    else if (row.conv_key) ids = conversationOf(row.conv_key)?.audience(officeId, row.conv_key) ?? [];
    if (ids.length) io.to(ids).emit(event, msg);
  };

  /** Tells mentioned people (not the author, nor customers) about a channel message. */
  const notify = (h: Here, row: MessageRow, who: { users: string[]; players: string[]; here: boolean }) => {
    const author = row.author_user_id;
    const targets = new Set<string>();
    for (const u of who.users) if (u !== author) socketsOf(h.officeId, u).forEach((id) => targets.add(id));
    for (const p of who.players) if (p !== row.author_player_id) targets.add(p);
    if (who.here) for (const p of h.players.values()) if (p.id !== row.author_player_id && (!author || p.userId !== author)) targets.add(p.id);
    for (const id of targets) if (isCustomerPlayer(h.officeId, id)) targets.delete(id);
    if (targets.size) io.to([...targets]).emit('chat:mention', { conv: `c:${row.channel_id}`, message: toMessage(row) });
  };

  /** Signed-in people a channel message's mentions are kept for (everyone online, for @here). */
  const mentionUsersOf = (h: Here, m: Mentioned, author: string | null) => {
    const users = new Set(m.users);
    if (m.here) for (const p of h.players.values()) if (p.userId) users.add(p.userId);
    if (author) users.delete(author);
    return [...users];
  };

  realtime.onSocket((s) => {
    const canSend = s.limiter(1, 6);
    const canChange = s.limiter(2, 10);
    const canReact = s.limiter(4, 16);
    const canRead = s.limiter(5, 20);
    const canQuery = s.limiter(10, 40);
    const canCreate = s.limiter(1 / 20, 3);
    const canManage = s.limiter(1, 6);

    const here = (): Here => {
      const room = s.room();
      const me = s.me();
      if (!room || !me) throw new ChatError('Join the office first.');
      return { officeId: room.officeId, me, players: room.players };
    };
    const limit = (ok: boolean, why = 'You’re doing that too quickly. Please wait a moment.') => {
      if (!ok) throw new ChatError(why);
    };
    /** Customers (guests of support workspaces) only chat in their tickets. */
    const customer = () => {
      const room = s.room();
      return !!room && isCustomer(s.role(), ctx.store.peek(room.officeId)?.kind);
    };
    /**
     * Your own message: by your account, this connection, or (`guestOwner`) in a feature's
     * conversation whose guest messages are yours.
     */
    const isMine = (row: MessageRow, guestOwner = false) =>
      row.author_user_id ? row.author_user_id === s.user?.id : row.author_player_id === s.socket.id || guestOwner;
    const ownsGuestMessages = (row: MessageRow) => !!row.conv_key && !!conversationOf(row.conv_key)?.ownsGuestMessage(s, row.conv_key);
    /** Renaming and archiving channels and deleting others' messages: the owner and admins. */
    const mayModerate = () => s.isOwner() || s.role() === 'admin';
    const moderators = (what: string) => new ChatError(`Only the owner and admins can ${what}.`);
    /** What this person may do with a message's conversation: null when they can't see it. */
    const accessTo = async (row: MessageRow, officeId: string): Promise<ConvAccess | null> => {
      if (row.office_id !== officeId) return null;
      if (row.conv_key) return (await conversationOf(row.conv_key)?.access(s, row.conv_key, officeId)) ?? null;
      if (customer()) return null;
      return row.channel_id || (s.user && row.dm_key?.split(':').includes(s.user.id)) ? { write: true } : null;
    };
    /** The conversation a message is in, as this person names it. */
    const convOf = (row: MessageRow) => row.conv_key ?? (row.channel_id ? `c:${row.channel_id}` : `d:${dmPartner(row.dm_key ?? '', s.user?.id ?? '')}`);
    const savedConv = (row: MessageRow) => row.conv_key ?? (row.channel_id ? `c:${row.channel_id}` : `dm:${row.dm_key}`);

    const visible = async (id: unknown, officeId: string, write = false) => {
      const row = isUuid(id) ? await store.message(id) : null;
      const access = row && (await accessTo(row, officeId));
      if (!row || !access) throw new ChatError('That message no longer exists.');
      // Channels and direct messages check what may be changed themselves.
      if (write && !access.write) throw new ChatError(access.why);
      return row;
    };
    const cursor = (v: unknown) => {
      if (v === undefined || v === null) return undefined;
      if (!isUuid(v)) throw new ChatError('Bad request');
      return v;
    };

    const target = async (conv: unknown, h: Here): Promise<Target> => {
      if (typeof conv !== 'string') throw new ChatError('Pick a conversation.');
      const owner = conversationOf(conv);
      if (owner) {
        const access = await owner.access(s, conv, h.officeId);
        if (!access) throw new ChatError('That conversation doesn’t exist.');
        return { kind: 'conv', conv, owner, access };
      }
      if (customer()) throw new ChatError('That conversation doesn’t exist.');
      if (conv === 'nearby') return { kind: 'nearby' };
      const id = conv.slice(2);
      if (conv.startsWith('c:') && isUuid(id)) {
        const channel = await store.channel(h.officeId, id);
        if (channel) return { kind: 'channel', channel, conv: `c:${channel.id}` };
      } else if (conv.startsWith('d:') && ID.test(id)) {
        if (!s.user) throw new ChatError('Sign in to send messages people get when they’re away.');
        if (id === s.user.id) throw new ChatError('That’s you.');
        if ((await store.membersAmong(h.officeId, [id])).has(id)) {
          const key = dmKey(s.user.id, id);
          return { kind: 'dm', dmKey: key, users: key.split(':') as [string, string], conv: `dm:${key}` };
        }
      } else if (conv.startsWith('p:')) {
        const to = h.players.get(id);
        if (to && isCustomerPlayer(h.officeId, to.id)) throw new ChatError('Visitors chat in their ticket.');
        if (to && to.id !== h.me.id) return { kind: 'live', to };
        throw new ChatError('They’ve left the office.');
      }
      throw new ChatError('That conversation doesn’t exist.');
    };

    /**
     * Checks a message's mention tokens: people who are members of the office (or, in a direct
     * message, its two people), guests here now (whose tokens of signed-in people become theirs),
     * and @here in channels. When editing, the mentions the message already has stay as they were
     * (a guest mentioned earlier may have left). Anything else becomes plain "@unknown".
     */
    const resolveMentions = async (
      text: string,
      h: Here,
      scope: { kind: 'channel' } | { kind: 'dm'; users: string[] } | { kind: 'live' },
      kept: ChatMention[] = [],
    ): Promise<Mentioned> => {
      const out: Mentioned = { text, mentions: [], users: [], players: [], here: false };
      const tokens = parseMentionTokens(text);
      if (!tokens.length) return out;
      const userOf = (t: { kind: string; id?: string }) => (t.kind === 'user' ? t.id : t.kind === 'player' ? h.players.get(t.id ?? '')?.userId : undefined);
      const wanted = [...new Set(tokens.slice(0, MAX_MENTIONS).map(userOf).filter((u): u is string => !!u))];
      const members =
        scope.kind === 'live' ? new Map<string, string>() : await store.membersAmong(h.officeId, scope.kind === 'dm' ? wanted.filter((u) => scope.users.includes(u)) : wanted);
      const replace = new Map<string, string>();
      tokens.forEach((t, i) => {
        const token = mentionToken(t);
        if (i >= MAX_MENTIONS) return void replace.set(token, '@unknown');
        if (t.kind === 'here') {
          if (scope.kind !== 'channel') return void replace.set(token, '@here');
          out.mentions.push({ kind: 'here' });
          out.here = true;
          return;
        }
        const userId = userOf(t);
        if (userId && members.has(userId)) {
          if (!out.users.includes(userId)) {
            out.users.push(userId);
            out.mentions.push({ kind: 'user', id: userId, name: members.get(userId)! });
          }
          if (t.kind === 'player') replace.set(token, `<@u:${userId}>`);
          return;
        }
        const guest = t.kind === 'player' ? h.players.get(t.id!) : undefined;
        if (guest && !guest.userId && scope.kind === 'channel' && !isCustomerPlayer(h.officeId, guest.id)) {
          out.players.push(guest.id);
          out.mentions.push({ kind: 'player', id: guest.id, name: guest.name });
          return;
        }
        // Kept as it was, without notifying anyone again.
        const before = findMention(kept, t.kind, t.id);
        if (before) return void out.mentions.push(before);
        replace.set(token, '@unknown');
      });
      if (replace.size) out.text = text.replace(MENTION_TOKEN, (token) => replace.get(token) ?? token);
      return out;
    };

    const attachmentsFor = async (raw: unknown, h: Here): Promise<ChatAttachment[]> => {
      if (raw === undefined || raw === null) return [];
      if (!Array.isArray(raw)) throw new ChatError('Bad request');
      if (raw.length > MAX_ATTACHMENTS) throw new ChatError(`Up to ${MAX_ATTACHMENTS} files per message.`);
      const dim = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 20000 ? v : undefined);
      const wanted = raw.map((a) => ({ id: (a as { id?: unknown })?.id, w: dim((a as { w?: unknown })?.w), h: dim((a as { h?: unknown })?.h) }));
      if (!wanted.every((a) => isUuid(a.id))) throw new ChatError('Bad request');
      const ids = [...new Set(wanted.map((a) => (a.id as string).toLowerCase()))];
      const found = await store.attachable(h.officeId, ids, s.user?.id ?? null);
      if (found.size !== wanted.length) throw new ChatError('Some files couldn’t be attached. Please upload them again.');
      return wanted.map((a) => {
        const id = (a.id as string).toLowerCase();
        const f = found.get(id)!;
        const out: ChatAttachment = { id, url: `/api/uploads/${id}/${encodeURIComponent(f.name)}`, name: f.name, contentType: f.contentType, size: f.size };
        if (a.w && a.h && IMAGE_TYPES.has(f.contentType)) Object.assign(out, { w: a.w, h: a.h });
        return out;
      });
    };

    s.socket.on('chat:channels', (ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canQuery());
        if (customer()) return { channels: [], dms: [], counts: {} };
        await store.ensureDefault(h.officeId);
        const channels = (await store.channels(h.officeId)).map(toChannel);
        if (!s.user) return { channels, dms: [], counts: {} };
        const dms = await store.dms(s.user.id, h.officeId);
        const counts = await store.channelCounts(s.user.id, h.officeId);
        for (const d of dms) if (d.unread) counts[`d:${d.userId}`] = { unread: d.unread, mentions: 0 };
        return { channels, dms: dms.map(({ userId, name, lastMessageAt }) => ({ userId, name, lastMessageAt })), counts };
      }),
    );

    s.socket.on('chat:people', (ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canQuery());
        // Who belongs to the office is for its members to know.
        return { people: s.role() === 'guest' ? [] : await store.people(h.officeId) };
      }),
    );

    s.socket.on('chat:history', (req, ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canQuery());
        const conv = req?.conv;
        const before = cursor(req?.before);
        // Live conversations have no history on the server.
        if (conv === 'nearby' || (typeof conv === 'string' && conv.startsWith('p:'))) return { messages: [], hasMore: false };
        const t = await target(conv, h);
        if (t.kind !== 'channel' && t.kind !== 'dm' && t.kind !== 'conv') return { messages: [], hasMore: false };
        const where =
          t.kind === 'channel' ? { channelId: t.channel.id } : t.kind === 'dm' ? { officeId: h.officeId, dmKey: t.dmKey } : { officeId: h.officeId, convKey: t.conv };
        const page = await store.history(where, before);
        return { messages: page.rows.map(toMessage), hasMore: page.hasMore };
      }),
    );

    s.socket.on('chat:thread', (req, ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canQuery());
        const parent = await visible(req?.id, h.officeId);
        if (parent.parent_id) throw new ChatError('That’s a reply; open its thread instead.');
        const page = await store.replies(parent.id, cursor(req?.before));
        return { parent: toMessage(parent), replies: page.rows.map(toMessage), hasMore: page.hasMore };
      }),
    );

    s.socket.on('chat:locate', (id, ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canQuery());
        const row = await visible(id, h.officeId);
        return { conv: convOf(row), parentId: row.parent_id };
      }),
    );

    s.socket.on('chat:send', (req, ack) =>
      answer(ack, async () => {
        const h = here();
        if (!req || typeof req !== 'object') throw new ChatError('Bad request');
        limit(canSend(), 'You’re sending messages too quickly. Please wait a moment.');
        const text = cleanMessageText(req.text);
        const nonce = typeof req.nonce === 'string' ? req.nonce.slice(0, 40) : undefined;

        let parent: MessageRow | null = null;
        let t: Target;
        if (req.parentId !== undefined && req.parentId !== null) {
          parent = await visible(req.parentId, h.officeId);
          if (parent.parent_id) throw new ChatError('Reply in the thread of the first message.');
          if (parent.deleted_at) throw new ChatError('That message was deleted.');
          t =
            parent.channel_id || parent.conv_key
              ? await target(parent.conv_key ?? `c:${parent.channel_id}`, h)
              : { kind: 'dm', dmKey: parent.dm_key!, users: parent.dm_key!.split(':') as [string, string], conv: `dm:${parent.dm_key}` };
        } else t = await target(req.conv, h);
        if (t.kind === 'channel' && t.channel.archived_at) throw new ChatError('This channel is archived.');
        if (t.kind === 'conv' && !t.access.write) throw new ChatError(t.access.why);
        const attachments = await attachmentsFor(req.attachments, h);
        if (!text && !attachments.length) throw new ChatError('Write a message first.');

        if (t.kind === 'nearby' || t.kind === 'live') {
          const m = await resolveMentions(text, h, { kind: 'live' });
          await store.claimLive(attachments.map((a) => a.id));
          const msg: ChatMessage = {
            id: randomId(16),
            channelId: null,
            dm: null,
            conv: null,
            live: t.kind === 'nearby' ? 'nearby' : 'dm',
            parentId: null,
            inChannel: false,
            userId: s.user?.id ?? null,
            playerId: h.me.id,
            name: h.me.name,
            text: m.text,
            attachments,
            mentions: [],
            reactions: [],
            replyCount: 0,
            lastReplyAt: null,
            replyNames: [],
            createdAt: Date.now(),
            editedAt: null,
            deleted: false,
          };
          if (nonce) msg.nonce = nonce;
          if (t.kind === 'live') msg.to = t.to.id;
          const nearby = () => realtime.linkedPeers(h.officeId, h.me.id).filter((id) => !isCustomerPlayer(h.officeId, id));
          io.to(t.kind === 'live' ? [h.me.id, t.to.id] : [h.me.id, ...nearby()]).emit('chat:message', msg);
          return { message: msg };
        }

        // Features' conversations have no mentions.
        const m = await resolveMentions(text, h, t.kind === 'channel' ? { kind: 'channel' } : t.kind === 'dm' ? { kind: 'dm', users: t.users } : { kind: 'live' });
        const { message, parent: updatedParent } = await store.insert({
          officeId: h.officeId,
          channelId: t.kind === 'channel' ? t.channel.id : null,
          dmKey: t.kind === 'dm' ? t.dmKey : null,
          dmUsers: t.kind === 'dm' ? t.users : undefined,
          convKey: t.kind === 'conv' ? t.conv : null,
          parentId: parent?.id ?? null,
          inChannel: !!parent && req.alsoToChannel === true,
          userId: s.user?.id ?? null,
          playerId: h.me.id,
          name: (t.kind === 'conv' && t.owner.nameOf?.(s, t.conv)) || h.me.name,
          text: m.text,
          attachments,
          mentions: m.mentions,
          mentionUsers: t.kind === 'channel' ? mentionUsersOf(h, m, s.user?.id ?? null) : [],
          conv: t.conv,
        });
        const msg = toMessage(message);
        if (parent && message.in_channel) msg.parent = { name: parent.author_name, text: parentPreview(parent.text, parent.mentions) };
        if (nonce) msg.nonce = nonce;
        deliver(h.officeId, message, 'chat:message', msg);
        if (updatedParent) deliver(h.officeId, updatedParent, 'chat:updated');
        if (t.kind === 'channel') notify(h, message, m);
        return { message: msg };
      }),
    );

    s.socket.on('chat:edit', (id, rawText, ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canChange());
        const row = await visible(id, h.officeId, true);
        const guestOwner = ownsGuestMessages(row);
        if (!isMine(row, guestOwner)) throw new ChatError('You can only edit your own messages.');
        const text = cleanMessageText(rawText);
        if (!text && !row.attachments.length) throw new ChatError('A message can’t be empty. Delete it instead.');
        const scope = row.channel_id ? { kind: 'channel' as const } : row.dm_key ? { kind: 'dm' as const, users: row.dm_key.split(':') } : { kind: 'live' as const };
        const m = await resolveMentions(text, h, scope, row.mentions);
        const mentionUsers = row.channel_id ? mentionUsersOf(h, m, row.author_user_id) : [];
        const { message, added } = await store.edit(row.id, m.text, m.mentions, mentionUsers, savedConv(row), (fresh) => {
          if (!isMine(fresh, guestOwner)) throw new ChatError('You can only edit your own messages.');
        });
        deliver(h.officeId, message, 'chat:updated');
        if (row.channel_id) {
          // Only people mentioned for the first time hear about it.
          const before = row.mentions;
          notify(h, message, {
            users: added.filter((u) => m.users.includes(u)),
            players: m.players.filter((p) => !before.some((b) => b.kind === 'player' && b.id === p)),
            here: m.here && !before.some((b) => b.kind === 'here'),
          });
        }
        return { message: toMessage(message) };
      }),
    );

    s.socket.on('chat:delete', (id, ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canChange());
        const row = await visible(id, h.officeId, true);
        const guestOwner = ownsGuestMessages(row);
        // Your own, or in a channel anyone's for moderators.
        const allowed = (r: MessageRow) => isMine(r, guestOwner) || (!!r.channel_id && mayModerate());
        if (!allowed(row)) throw new ChatError('You can only delete your own messages.');
        const { message, parent, uploads } = await store.remove(row.id, (fresh) => {
          if (!allowed(fresh)) throw new ChatError('You can only delete your own messages.');
        });
        void ctx.uploads.remove(uploads);
        deliver(h.officeId, message, 'chat:deleted');
        if (parent) deliver(h.officeId, parent, 'chat:updated');
        return {};
      }),
    );

    s.socket.on('chat:react', (id, emoji, ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canReact());
        if (!isReactionEmoji(emoji)) throw new ChatError('Pick an emoji.');
        const row = await visible(id, h.officeId, true);
        const name = (row.conv_key && conversationOf(row.conv_key)?.nameOf?.(s, row.conv_key)) || h.me.name;
        const who = { id: reactorId(s.user?.id, h.me.id), name };
        const updated = await store.react(row.id, (fresh) => toggleReaction(fresh.reactions, emoji, who));
        deliver(h.officeId, updated, 'chat:updated');
        return {};
      }),
    );

    s.socket.on('chat:read', (conv) => {
      const user = s.user;
      const room = s.room();
      // Guests' read markers live in their browser.
      if (!user || !room || typeof conv !== 'string' || !canRead()) return;
      const id = conv.slice(2);
      void (async () => {
        let saved: string | null = null;
        if (conv.startsWith('c:') && isUuid(id)) {
          const channel = await store.channel(room.officeId, id);
          if (channel) saved = `c:${channel.id}`;
        } else if (conv.startsWith('d:') && ID.test(id) && id !== user.id) saved = `dm:${dmKey(user.id, id)}`;
        if (!saved) return;
        await store.markRead(user.id, room.officeId, saved);
        const others = socketsOf(room.officeId, user.id).filter((sid) => sid !== s.socket.id);
        if (others.length) io.to(others).emit('chat:seen', conv);
      })().catch((err) => console.error('[chat] could not save a read marker:', err));
    });

    s.socket.on('channel:create', (req, ack) =>
      answer(ack, async () => {
        const h = here();
        if (customer()) throw new ChatError('Only staff can create channels here.');
        const name = normalizeChannelName(req?.name);
        const error = channelNameError(name);
        if (error) throw new ChatError(error);
        limit(canCreate(), 'You’re creating channels too quickly. Please wait a minute.');
        await store.ensureDefault(h.officeId);
        if ((await store.openChannelCount(h.officeId)) >= MAX_CHANNELS) throw new ChatError(`An office can have up to ${MAX_CHANNELS} channels. Archive some first.`);
        let row: ChannelRow;
        try {
          row = await store.createChannel(h.officeId, name, cleanTopic(req?.topic), { userId: s.user?.id ?? null, name: h.me.name });
        } catch (err) {
          if (isUniqueViolation(err)) throw new ChatError(`#${name} already exists.`);
          throw err;
        }
        const channel = toChannel(row);
        channelAudience(h.officeId).emit('channel:created', channel);
        return { channel };
      }),
    );

    const managed = async (id: unknown, h: Here) => {
      const row = isUuid(id) && !customer() ? await store.channel(h.officeId, id) : null;
      if (!row) throw new ChatError('That channel doesn’t exist.');
      return row;
    };

    s.socket.on('channel:update', (req, ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canManage());
        const row = await managed(req?.id, h);
        const patch: { name?: string; topic?: string } = {};
        if (req.name !== undefined) {
          const name = normalizeChannelName(req.name);
          const error = channelNameError(name);
          if (error) throw new ChatError(error);
          if (name !== row.name) {
            if (!mayModerate()) throw moderators('rename channels');
            if (row.is_default) throw new ChatError('#general can’t be renamed.');
            patch.name = name;
          }
        }
        // Anyone may set the topic, as in most chat apps.
        if (req.topic !== undefined) patch.topic = cleanTopic(req.topic);
        let updated: ChannelRow;
        try {
          updated = await store.updateChannel(row.id, patch);
        } catch (err) {
          if (isUniqueViolation(err)) throw new ChatError(`#${patch.name} already exists.`);
          throw err;
        }
        const channel = toChannel(updated);
        channelAudience(h.officeId).emit('channel:updated', channel);
        return { channel };
      }),
    );

    s.socket.on('channel:archive', (id, archived, ack) =>
      answer(ack, async () => {
        const h = here();
        limit(canManage());
        const row = await managed(id, h);
        if (!mayModerate()) throw moderators('archive channels');
        if (row.is_default) throw new ChatError('#general can’t be archived.');
        if (!archived && (await store.openChannelCount(h.officeId)) >= MAX_CHANNELS) throw new ChatError(`An office can have up to ${MAX_CHANNELS} channels.`);
        let updated: ChannelRow;
        try {
          updated = await store.archiveChannel(row.id, archived === true);
        } catch (err) {
          if (isUniqueViolation(err)) throw new ChatError(`There’s another #${row.name} now. Rename one of them first.`);
          throw err;
        }
        const channel = toChannel(updated);
        channelAudience(h.officeId).emit('channel:updated', channel);
        return { channel };
      }),
    );
  });
}
