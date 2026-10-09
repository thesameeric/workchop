import type { ServerContext, SocketContext } from '../../features';

// Conversations other features own (a support ticket's chat, `t:<id>`): saved like channels and
// direct messages, with the feature deciding who reads, who writes and who hears about new messages.

/** What a connection may do in a conversation: read it, and write (or why not). */
export type ConvAccess = { write: true } | { write: false; why: string };

export interface Conversation {
  /** What this connection may do in conversation `key` of the office it's in; null: it can't see it. */
  access(s: SocketContext, key: string, officeId: string): Promise<ConvAccess | null>;
  /** The connections (socket ids) that get new, edited and deleted messages of `key` as they happen. */
  audience(officeId: string, key: string): string[];
  /**
   * Whether this connection is the guest who wrote the conversation's guest messages (a guest is a
   * new socket each visit, so their own messages are found by something they keep, like a key).
   */
  ownsGuestMessage(s: SocketContext, key: string): boolean;
  /** The name this connection writes (and reacts) under in `key`; null, or left out: their player's name. */
  nameOf?(s: SocketContext, key: string): string | null;
}

/** Each server's conversations, by prefix. */
const servers = new WeakMap<object, Map<string, Conversation>>();
const of = (ctx: Pick<ServerContext, 'io'>) => {
  let map = servers.get(ctx.io);
  if (!map) servers.set(ctx.io, (map = new Map()));
  return map;
};

/**
 * Registers the conversations whose keys start with `<prefix>:` (one owner per prefix; the chat's
 * own are `c`, `d`, `p` and `dm`). Returns a function that removes it.
 */
export function registerConversation(ctx: Pick<ServerContext, 'io'>, prefix: string, conversation: Conversation): () => void {
  if (!/^[a-z]+$/.test(prefix) || ['c', 'd', 'p', 'dm', 'nearby'].includes(prefix)) throw new Error(`"${prefix}" can't be a conversation prefix`);
  const map = of(ctx);
  if (map.has(prefix)) throw new Error(`The conversations "${prefix}:" are registered already`);
  map.set(prefix, conversation);
  return () => {
    if (map.get(prefix) === conversation) map.delete(prefix);
  };
}

/** The registered conversation `key` belongs to, if any. */
export function conversationOf(ctx: Pick<ServerContext, 'io'>, key: unknown): Conversation | undefined {
  if (typeof key !== 'string') return undefined;
  const colon = key.indexOf(':');
  return colon > 0 && key.length > colon + 1 && key.length <= 80 ? servers.get(ctx.io)?.get(key.slice(0, colon)) : undefined;
}
