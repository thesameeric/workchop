import { clip } from './text';
import type { UploadedFile } from './uploads';

// Chat: channels (saved), direct messages (saved between signed-in people, live otherwise),
// threads, mentions, reactions and file attachments.

export const MAX_MESSAGE = 4000;
export const MAX_ATTACHMENTS = 5;
export const MAX_CHANNEL_NAME = 32;
export const MAX_TOPIC = 120;
/** Messages per page of history. */
export const PAGE_SIZE = 50;
/** Distinct emoji on one message. */
export const MAX_REACTIONS = 20;

/**
 * A conversation, as the client names it:
 * - `c:<channel id>` a channel
 * - `d:<user id>` a saved direct message with that (signed-in) person
 * - `p:<player id>` a live direct message with someone in the office (a guest is involved)
 * - `nearby` the people you're in a call with (live)
 */
export type ConvKey = string;

export interface ChatAttachment extends UploadedFile {
  /** An image's size in pixels (given by the sender, to keep the layout steady while it loads). */
  w?: number;
  h?: number;
}

export type ChatMention =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'player'; id: string; name: string }
  | { kind: 'here' };

export interface ChatReaction {
  emoji: string;
  /** Who reacted: `u:<user id>` for signed-in people, `p:<player id>` for guests. */
  by: { id: string; name: string }[];
}

export interface ChatMessage {
  id: string;
  channelId: string | null;
  /** A saved direct message: the two user ids, sorted, joined with ":". */
  dm: string | null;
  /** Not saved: shown to the people around you, or a direct message involving a guest. */
  live?: 'nearby' | 'dm';
  /** A live direct message's recipient (a player id). */
  to?: string;
  /** A thread reply's parent message. */
  parentId: string | null;
  /** A thread reply that was also sent to the channel. */
  inChannel: boolean;
  /** For replies also sent to the channel: who wrote the parent, and its start. */
  parent?: { name: string; text: string } | null;
  userId: string | null;
  playerId: string | null;
  name: string;
  /** Text with mention tokens (see MENTION_TOKEN) and light formatting (shared/chatText.ts). */
  text: string;
  attachments: ChatAttachment[];
  mentions: ChatMention[];
  reactions: ChatReaction[];
  replyCount: number;
  lastReplyAt: number | null;
  /** Who replied last, newest first (up to 3). */
  replyNames: string[];
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  /** Echoed back to the sender so it can replace its pending copy. */
  nonce?: string;
}

export interface ChatChannel {
  id: string;
  name: string;
  topic: string;
  /** #general: every office has it, and it can't be renamed or archived. */
  isDefault: boolean;
  archived: boolean;
  createdAt: number;
}

/** Someone a signed-in person has saved direct messages with in this office. */
export interface DmPartner {
  userId: string;
  name: string;
  lastMessageAt: number;
}

/** A signed-in member of the office (for mentions and direct messages). */
export interface ChatPerson {
  userId: string;
  name: string;
}

export interface ConvCounts {
  unread: number;
  mentions: number;
}

export type ChatResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ChannelsAnswer {
  channels: ChatChannel[];
  dms: DmPartner[];
  /** Unread messages and mentions by conversation (signed-in people only; guests start at zero). */
  counts: Record<ConvKey, ConvCounts>;
}

export interface HistoryAnswer {
  /** Oldest first. */
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface ThreadAnswer {
  parent: ChatMessage;
  /** Oldest first. */
  replies: ChatMessage[];
  hasMore: boolean;
}

export interface SendRequest {
  conv: ConvKey;
  text: string;
  /** Files uploaded with session.upload (at most MAX_ATTACHMENTS). */
  attachments?: { id: string; w?: number; h?: number }[];
  /** Reply in this message's thread. */
  parentId?: string;
  /** With parentId: show the reply in the channel too. */
  alsoToChannel?: boolean;
  nonce?: string;
}

/** A mention of you (or of everyone online, @here). */
export interface MentionNotice {
  conv: ConvKey;
  message: ChatMessage;
}

declare module './types' {
  interface ClientToServerEvents {
    'chat:channels': (ack: (res: ChatResult<ChannelsAnswer>) => void) => void;
    /** Signed-in members of the office, for mentions and direct messages. */
    'chat:people': (ack: (res: ChatResult<{ people: ChatPerson[] }>) => void) => void;
    /** A page of history, newest first in the database, oldest first in the answer; `before` is a message id. */
    'chat:history': (req: { conv: ConvKey; before?: string }, ack: (res: ChatResult<HistoryAnswer>) => void) => void;
    'chat:thread': (req: { id: string; before?: string }, ack: (res: ChatResult<ThreadAnswer>) => void) => void;
    /** Where a message is (for links to it): its conversation and thread. */
    'chat:locate': (id: string, ack: (res: ChatResult<{ conv: ConvKey; parentId: string | null }>) => void) => void;
    'chat:send': (req: SendRequest, ack: (res: ChatResult<{ message: ChatMessage }>) => void) => void;
    'chat:edit': (id: string, text: string, ack: (res: ChatResult<{ message: ChatMessage }>) => void) => void;
    'chat:delete': (id: string, ack: (res: ChatResult) => void) => void;
    /** Adds your reaction, or takes it back if it's there. */
    'chat:react': (id: string, emoji: string, ack: (res: ChatResult) => void) => void;
    /** You've seen a conversation: its unread messages and mentions are cleared. */
    'chat:read': (conv: ConvKey) => void;
    'channel:create': (req: { name: string; topic?: string }, ack: (res: ChatResult<{ channel: ChatChannel }>) => void) => void;
    'channel:update': (req: { id: string; name?: string; topic?: string }, ack: (res: ChatResult<{ channel: ChatChannel }>) => void) => void;
    'channel:archive': (id: string, archived: boolean, ack: (res: ChatResult<{ channel: ChatChannel }>) => void) => void;
  }
  interface ServerToClientEvents {
    'chat:message': (m: ChatMessage) => void;
    /** Edited, reacted to, or replied to. */
    'chat:updated': (m: ChatMessage) => void;
    /** The message as it now is (deleted: no text or files). */
    'chat:deleted': (m: ChatMessage) => void;
    'chat:mention': (n: MentionNotice) => void;
    /** You read a conversation in another tab. */
    'chat:seen': (conv: ConvKey) => void;
    'channel:created': (c: ChatChannel) => void;
    'channel:updated': (c: ChatChannel) => void;
  }
}

/** Mention tokens in a message's text: <@u:USER_ID>, <@p:PLAYER_ID> and <!here>. */
export const MENTION_TOKEN = /<@([up]):([A-Za-z0-9_-]{1,40})>|<!here>/g;

export function mentionToken(m: ChatMention): string {
  return m.kind === 'here' ? '<!here>' : `<@${m.kind === 'user' ? 'u' : 'p'}:${m.id}>`;
}

/** The mention tokens in a text, each once. */
export function parseMentionTokens(text: string): { kind: 'user' | 'player' | 'here'; id?: string }[] {
  const seen = new Set<string>();
  const out: { kind: 'user' | 'player' | 'here'; id?: string }[] = [];
  for (const m of text.matchAll(MENTION_TOKEN)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    if (m[0] === '<!here>') out.push({ kind: 'here' });
    else out.push({ kind: m[1] === 'u' ? 'user' : 'player', id: m[2] });
  }
  return out;
}

/** The mention a token stands for, if the message has it. */
export function findMention(mentions: ChatMention[], kind: 'user' | 'player' | 'here', id?: string): ChatMention | undefined {
  return mentions.find((m) => m.kind === kind && (m.kind === 'here' || m.id === id));
}

/** Control characters other than tab and newline. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** A message's text as stored: no control characters, \n line breaks, at most MAX_MESSAGE long, trimmed. */
export function cleanMessageText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return clip(v.replace(/\r\n?/g, '\n').replace(CONTROL, ''), MAX_MESSAGE).trim();
}

/** What people type as a channel name, the way it's saved: lowercase, dashes for spaces, no leading #. */
export function normalizeChannelName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
}

/** Why a (normalized) channel name isn't allowed, or null if it is. */
export function channelNameError(name: string): string | null {
  if (!name) return 'Give the channel a name.';
  if (name.length > MAX_CHANNEL_NAME) return `Channel names can be up to ${MAX_CHANNEL_NAME} characters.`;
  if (!/^[a-z0-9_-]+$/.test(name)) return 'Use lowercase letters, numbers, - and _ only.';
  if (!/[a-z0-9]/.test(name)) return 'Use at least one letter or number.';
  return null;
}

export function cleanTopic(v: unknown): string {
  if (typeof v !== 'string') return '';
  return clip(v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), MAX_TOPIC);
}

/** One emoji (with skin tone, ZWJ sequences, flags…) and nothing else. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[‍️⃣])+$/u;
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export function isReactionEmoji(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 16 && EMOJI_ONLY.test(v) && PICTOGRAPH.test(v);
}

/** The reactions offered first. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '🔥', '✅', '😮', '😢', '🚀', '💯'];

/** The key for a saved direct message between two signed-in people. */
export function dmKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** The other person in a saved direct message. */
export function dmPartner(key: string, me: string): string {
  const [a, b] = key.split(':');
  return a === me ? b : a;
}

/** Whose reaction this is: `u:<user id>` when signed in, else `p:<player id>`. */
export function reactorId(userId: string | null | undefined, playerId: string): string {
  return userId ? `u:${userId}` : `p:${playerId}`;
}

/** Turns a reaction on or off for someone; returns the new list (the old one is left as is). */
export function toggleReaction(reactions: ChatReaction[], emoji: string, who: { id: string; name: string }): ChatReaction[] | null {
  const at = reactions.findIndex((r) => r.emoji === emoji);
  if (at < 0) {
    if (reactions.length >= MAX_REACTIONS) return null;
    return [...reactions, { emoji, by: [who] }];
  }
  const r = reactions[at];
  const mine = r.by.some((b) => b.id === who.id);
  const by = mine ? r.by.filter((b) => b.id !== who.id) : [...r.by, who].slice(-200);
  const next = [...reactions];
  if (by.length) next[at] = { emoji, by };
  else next.splice(at, 1);
  return next;
}
