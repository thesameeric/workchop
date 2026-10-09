import { create } from 'zustand';
import {
  dmPartner,
  reactorId,
  toggleReaction,
  type ChatAttachment,
  type ChatChannel,
  type ChatMention,
  type ChatMessage,
  type ChatPerson,
  type ChatResult,
  type ConvCounts,
  type ConvKey,
  type DmPartner,
  type MentionNotice,
  type SendRequest,
} from '../../../../shared/chat';
import { plainText } from '../../../../shared/chatText';
import type { ClientToServerEvents } from '../../../../shared/types';
import { getSession } from '../../lib/session';
import { getState, setState, toast, useStore } from '../../state/store';
import { AtIcon, ChatIcon } from '../../ui/icons';

/** A message as the client keeps it: maybe still on its way, or failed to send. */
export interface UiMessage extends ChatMessage {
  pending?: 'sending' | 'failed';
  error?: string;
  request?: SendRequest;
}

export interface ListState {
  messages: UiMessage[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  hasMore: boolean;
  loadingOlder: boolean;
}

export interface ThreadState extends ListState {
  parent: UiMessage | null;
}

interface ChatState {
  /** The office's channels have been loaded. */
  ready: boolean;
  channels: ChatChannel[];
  dms: DmPartner[];
  /** Signed-in members of the office (for mentions), loaded when first needed. */
  people: ChatPerson[];
  current: ConvKey;
  /** The open thread (its parent message's id). */
  thread: string | null;
  convs: Record<ConvKey, ListState>;
  threads: Record<string, ThreadState>;
  counts: Record<ConvKey, ConvCounts>;
  /** A message to scroll to and highlight. */
  jump: { id: string; at: number } | null;
  /** The message being edited. */
  editing: string | null;
  /** Who live direct messages are with (by "p:<player id>"), to list them after the guest leaves. */
  liveNames: Record<ConvKey, string>;
}

const initial = (): ChatState => ({
  ready: false,
  channels: [],
  dms: [],
  people: [],
  current: '',
  thread: null,
  convs: {},
  threads: {},
  counts: {},
  jump: null,
  editing: null,
  liveNames: {},
});

export const useChat = create<ChatState>()(initial);
const get = useChat.getState;
const set = useChat.setState;

/** Live conversations keep this many messages. */
const LIVE_KEEP = 200;

export const emptyList = (): ListState => ({ messages: [], status: 'idle', hasMore: false, loadingOlder: false });

const socket = () => getSession()?.socket ?? null;
const selfId = () => getSession()?.selfId() ?? getState().selfId;
const myUserId = () => getState().account?.id ?? null;

type Events = ClientToServerEvents;
type Params<E extends keyof Events> = Parameters<Events[E]>;
/** An event's arguments, without its acknowledgement callback. */
type Args<E extends keyof Events> = Params<E> extends [...infer A, unknown] ? A : never;
/** What the server answers to an event. */
type Answer<E extends keyof Events> = Params<E> extends [...unknown[], infer Ack] ? (NonNullable<Ack> extends (res: infer R) => void ? R : never) : never;

/** Sends a request and waits for the answer (rejects when not connected, or after 15 s without one). */
function request<E extends keyof Events>(event: E, ...args: Args<E>): Promise<Answer<E>> {
  const s = socket();
  if (!s?.connected) return Promise.reject(new Error('Not connected'));
  // emitWithAck's types don't survive timeout(); the ones above stand in.
  const timed = s.timeout(15_000) as unknown as { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
  return timed.emitWithAck(event, ...args) as Promise<Answer<E>>;
}

/**
 * A feature's own saved conversations (support tickets, `t:<id>`), shown outside the chat panel: how
 * to show one, whether it's on screen right now, whether a new message in it gets a toast, and
 * whether the messages written in it without an account are yours (a support customer's, in their
 * own ticket: the server lets them edit those after a reload too).
 */
export interface ConvView {
  open(conv: ConvKey): void;
  looking(conv: ConvKey): boolean;
  notify(conv: ConvKey): boolean;
  guestIsMe(conv: ConvKey): boolean;
}

const views = new Map<string, ConvView>();

/** Shows the conversations starting with `prefix` (e.g. 't:') with `view`; returns a function that removes it. */
export function registerConvView(prefix: string, view: ConvView): () => void {
  views.set(prefix, view);
  return () => {
    if (views.get(prefix) === view) views.delete(prefix);
  };
}

/** The feature that shows this conversation, if it isn't the chat panel's. */
export const viewOf = (conv: ConvKey): ConvView | undefined => views.get(conv.slice(0, conv.indexOf(':') + 1));

export const isLive = (conv: ConvKey) => conv === 'nearby' || conv.startsWith('p:');
/** Channels and saved direct messages: the chat panel lists them, remembers them and marks them read on the server. */
const isListed = (conv: ConvKey) => conv.startsWith('c:') || conv.startsWith('d:');
/** Kept by the server (history, catching up after a reconnect): the listed ones and features' own. */
export const isSaved = (conv: ConvKey) => isListed(conv) || !!viewOf(conv);
/** Conversations whose unread messages count on the dock button (not just their mentions). */
export const isDirect = (conv: ConvKey) => conv.startsWith('d:') || conv.startsWith('p:');

/** The conversation a message belongs to, from this person's side. */
export function convOf(m: ChatMessage): ConvKey {
  if (m.conv) return m.conv;
  if (m.channelId) return `c:${m.channelId}`;
  if (m.dm) return `d:${dmPartner(m.dm, myUserId() ?? '')}`;
  if (m.live === 'nearby') return 'nearby';
  return `p:${m.playerId === selfId() ? m.to : m.playerId}`;
}

export function isMine(m: ChatMessage): boolean {
  if (m.userId) return m.userId === myUserId();
  return m.playerId === selfId() || (!!m.conv && !!viewOf(m.conv)?.guestIsMe(m.conv));
}

/** Whether these mentions include you (by name, or @here). */
export function mentionsMe(mentions: ChatMention[]): boolean {
  const me = myUserId();
  const pid = selfId();
  return mentions.some((m) => m.kind === 'here' || (m.kind === 'user' && m.id === me) || (m.kind === 'player' && m.id === pid));
}

/** The chat (or the feature showing it) is open on this conversation (or thread) right now, where you can see it. */
function looking(conv: ConvKey, thread: string | null = null): boolean {
  if (document.hidden) return false;
  const view = viewOf(conv);
  if (view) return !thread && view.looking(conv);
  const s = get();
  return getState().panel === 'chat' && s.current === conv && s.thread === thread;
}

/** Whether you're looking at where this message shows: its conversation, or its thread. */
function seen(conv: ConvKey, m: ChatMessage): boolean {
  return ((!m.parentId || m.inChannel) && looking(conv)) || (!!m.parentId && looking(conv, m.parentId));
}

// ---------- lists ----------

function byTime(a: ChatMessage, b: ChatMessage): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Time order, with messages still on their way (or failed) last. */
const order = (a: UiMessage, b: UiMessage) => Number(!!a.pending) - Number(!!b.pending) || byTime(a, b);

/** `list` with `m` added, or replacing its older copy (by id, or the pending copy with its nonce). */
function upsert(list: UiMessage[], m: UiMessage): UiMessage[] {
  const at = list.findIndex((x) => x.id === m.id || (!!m.nonce && !!x.pending && x.nonce === m.nonce));
  if (at < 0) return [...list, m].sort(order);
  const old = list[at];
  const next = list.filter((x, i) => i === at || x.id !== m.id);
  // The nonce is the row's React key while it lasts: keep it, so the row isn't rebuilt.
  next[next.indexOf(old)] = old.nonce && !m.nonce ? { ...m, nonce: old.nonce } : m;
  return old.pending && !m.pending ? next.sort(order) : next;
}

function patchList(conv: ConvKey, change: (l: ListState) => ListState): void {
  set((s) => ({ convs: { ...s.convs, [conv]: change(s.convs[conv] ?? emptyList()) } }));
}

function patchThread(id: string, change: (t: ThreadState) => ThreadState): void {
  set((s) => {
    const t = s.threads[id];
    return t ? { threads: { ...s.threads, [id]: change(t) } } : {};
  });
}

/** Puts a message wherever it shows: its conversation, its thread, or as a thread's parent. */
function place(m: UiMessage): void {
  const conv = convOf(m);
  if (!m.parentId || m.inChannel) {
    const list = get().convs[conv];
    // A saved conversation that isn't loaded gets the message with its history.
    if ((list && list.status !== 'idle') || isLive(conv)) {
      patchList(conv, (l) => {
        const messages = upsert(l.messages, m);
        return { ...l, status: l.status === 'idle' ? 'ready' : l.status, messages: isLive(conv) ? messages.slice(-LIVE_KEEP) : messages };
      });
    }
  }
  if (m.parentId) patchThread(m.parentId, (t) => ({ ...t, messages: upsert(t.messages, m) }));
  if (get().threads[m.id]) patchThread(m.id, (t) => ({ ...t, parent: m }));
}

function remove(id: string): void {
  set((s) => {
    const convs = { ...s.convs };
    for (const [k, l] of Object.entries(convs)) if (l.messages.some((m) => m.id === id)) convs[k] = { ...l, messages: l.messages.filter((m) => m.id !== id) };
    const threads = { ...s.threads };
    for (const [k, t] of Object.entries(threads)) if (t.messages.some((m) => m.id === id)) threads[k] = { ...t, messages: t.messages.filter((m) => m.id !== id) };
    return { convs, threads };
  });
}

export function findMessage(id: string): UiMessage | undefined {
  const s = get();
  for (const l of Object.values(s.convs)) {
    const m = l.messages.find((x) => x.id === id);
    if (m) return m;
  }
  for (const t of Object.values(s.threads)) {
    if (t.parent?.id === id) return t.parent;
    const m = t.messages.find((x) => x.id === id);
    if (m) return m;
  }
  return undefined;
}

// ---------- unread ----------

function bump(conv: ConvKey, field: keyof ConvCounts): void {
  set((s) => {
    const c = s.counts[conv] ?? { unread: 0, mentions: 0 };
    return { counts: { ...s.counts, [conv]: { ...c, [field]: c[field] + 1 } } };
  });
}

const readTimers = new Map<ConvKey, ReturnType<typeof setTimeout>>();

/** You've seen this conversation: clear its counts (and tell the server, a moment later, once). */
export function markRead(conv: ConvKey): void {
  if (!conv) return;
  if (get().counts[conv]) {
    set((s) => {
      const counts = { ...s.counts };
      delete counts[conv];
      return { counts };
    });
  }
  // Guests' read markers (and features' conversations') stay in this tab.
  if (!myUserId() || !isListed(conv) || readTimers.has(conv)) return;
  readTimers.set(
    conv,
    setTimeout(() => {
      readTimers.delete(conv);
      socket()?.emit('chat:read', conv);
    }, 600),
  );
}

/** The chat came into view (panel opened, tab shown, thread closed): what's on screen is read. */
export function sawCurrent(): void {
  const { current, thread } = get();
  if (current && looking(current, thread)) markRead(current);
}

export function resetChat(): void {
  set(initial());
  for (const t of readTimers.values()) clearTimeout(t);
  readTimers.clear();
  peopleLoadedAt = 0;
}

// ---------- events from the server ----------

function nameOf(conv: ConvKey): string {
  if (conv.startsWith('c:')) return `#${get().channels.find((c) => `c:${c.id}` === conv)?.name ?? 'channel'}`;
  return 'a direct message';
}

function preview(m: ChatMessage): string {
  const text = plainText(m.text, m.mentions, 90);
  if (text) return text;
  return m.attachments.length === 1 ? `sent ${m.attachments[0].name}` : `sent ${m.attachments.length} files`;
}

/** Someone's name, for a direct message conversation that just started. */
function nameOfUser(userId: string): string {
  return Object.values(getState().players).find((p) => p.userId === userId)?.name ?? get().people.find((p) => p.userId === userId)?.name ?? 'Someone';
}

/** Remembers who a live direct message is with, while they're here to ask. */
function rememberLiveName(conv: ConvKey, name: string | undefined): void {
  if (conv.startsWith('p:') && name && get().liveNames[conv] !== name) set((s) => ({ liveNames: { ...s.liveNames, [conv]: name } }));
}

export function onMessage(m: ChatMessage): void {
  place(m);
  const conv = convOf(m);
  rememberLiveName(conv, isMine(m) ? getState().players[conv.slice(2)]?.name : m.name);
  if (m.dm && !get().dms.some((d) => `d:${d.userId}` === conv)) {
    const userId = conv.slice(2);
    set((s) => ({ dms: [{ userId, name: isMine(m) ? nameOfUser(userId) : m.name, lastMessageAt: m.createdAt }, ...s.dms] }));
  }
  if (isMine(m)) return;
  const inConv = !m.parentId || m.inChannel;
  if (seen(conv, m)) {
    if (inConv) markRead(conv);
    return;
  }
  if (!inConv) return;
  bump(conv, 'unread');
  // Direct messages get a toast (mentions get theirs from chat:mention), and so do features' conversations that ask for it.
  if (isDirect(conv) || viewOf(conv)?.notify(conv)) {
    toast(`${m.name}: ${preview(m)}`, { icon: ChatIcon, action: { label: 'Reply', run: () => openConv(conv, { show: true }) } });
  }
}

export function onUpdated(m: ChatMessage): void {
  if (findMessage(m.id)) place(m);
}

export function onMention({ conv, message }: MentionNotice): void {
  if (isMine(message)) return;
  if (seen(conv, message)) {
    // Seen here, so it shouldn't wait for you on the server either.
    markRead(conv);
    return;
  }
  bump(conv, 'mentions');
  toast(`${message.name} in ${nameOf(conv)}: ${preview(message)}`, {
    icon: AtIcon,
    action: { label: 'View', run: () => openMessage(message.id, conv, message.parentId) },
  });
}

export function onSeen(conv: ConvKey): void {
  set((s) => {
    if (!s.counts[conv]) return {};
    const counts = { ...s.counts };
    delete counts[conv];
    return { counts };
  });
}

export function onChannel(c: ChatChannel): void {
  set((s) => ({
    channels: [...s.channels.filter((x) => x.id !== c.id), c].sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name),
    ),
  }));
}

// ---------- loading ----------

let channelsRequest: Promise<void> | null = null;

/** The office's channels, saved direct messages and unread counts (again after a reconnect). */
export function loadChannels(): Promise<void> {
  channelsRequest ??= (async () => {
    try {
      const res = await request('chat:channels');
      if (!res.ok) throw new Error(res.error);
      set((st) => {
        // Live conversations' counts are only known here.
        const counts: Record<ConvKey, ConvCounts> = {};
        for (const [k, c] of Object.entries(st.counts)) if (isLive(k)) counts[k] = c;
        Object.assign(counts, res.counts);
        if (looking(st.current, st.thread)) delete counts[st.current];
        return { ready: true, channels: res.channels, dms: res.dms, counts };
      });
      const { current, channels } = get();
      const valid = current && (!current.startsWith('c:') || channels.some((c) => `c:${c.id}` === current));
      if (!valid) openConv(defaultConv());
    } catch (err) {
      console.warn('[chat] could not load channels:', err);
      set({ ready: true });
      if (!get().current) openConv('nearby');
    }
  })().finally(() => (channelsRequest = null));
  return channelsRequest;
}

const lastConvKey = (officeId: string) => `workchop:chat:${officeId}`;

function defaultConv(): ConvKey {
  const { channels } = get();
  const officeId = getState().officeId;
  let saved: string | null = null;
  try {
    saved = officeId ? localStorage.getItem(lastConvKey(officeId)) : null;
  } catch {
    // Not available.
  }
  if (saved && ((saved.startsWith('c:') && channels.some((c) => `c:${c.id}` === saved && !c.archived)) || (saved.startsWith('d:') && myUserId()))) return saved;
  const general = channels.find((c) => c.isDefault) ?? channels[0];
  return general ? `c:${general.id}` : 'nearby';
}

async function fetchPage(conv: ConvKey, before?: string) {
  const res = await request('chat:history', { conv, before });
  if (!res.ok) throw new Error(res.error);
  return res;
}

/** Loads a conversation's latest messages if it hasn't been (`refresh`: again, after a reconnect). */
export async function loadConv(conv: ConvKey, refresh = false): Promise<void> {
  const list = get().convs[conv];
  if (isLive(conv)) {
    if (!list) patchList(conv, (l) => ({ ...l, status: 'ready' }));
    return;
  }
  if (list && (list.status === 'loading' || (list.status === 'ready' && !refresh))) return;
  patchList(conv, (l) => ({ ...l, status: l.status === 'ready' ? 'ready' : 'loading' }));
  try {
    const page = await fetchPage(conv);
    patchList(conv, (l) => {
      const ids = new Set(page.messages.map((m) => m.id));
      // After a reconnect, older pages stay if they still connect to this one. On a first load,
      // messages that arrived meanwhile stay.
      const overlap = l.messages.some((m) => ids.has(m.id));
      const kept = l.status === 'loading' || overlap ? l.messages.filter((m) => !m.pending && !ids.has(m.id)) : [];
      const pending = l.messages.filter((m) => m.pending);
      return {
        ...l,
        status: 'ready',
        hasMore: l.status !== 'loading' && overlap ? l.hasMore : page.hasMore,
        messages: [...kept, ...page.messages, ...pending].sort(order),
      };
    });
  } catch (err) {
    patchList(conv, (l) => ({ ...l, status: l.status === 'ready' ? 'ready' : 'error' }));
    console.warn('[chat] could not load messages:', err);
  }
}

export async function loadOlder(conv: ConvKey): Promise<boolean> {
  const list = get().convs[conv];
  const oldest = list?.messages.find((m) => !m.pending);
  if (!list || !list.hasMore || list.loadingOlder || !oldest) return false;
  patchList(conv, (l) => ({ ...l, loadingOlder: true }));
  try {
    const page = await fetchPage(conv, oldest.id);
    patchList(conv, (l) => {
      const have = new Set(l.messages.map((m) => m.id));
      return { ...l, loadingOlder: false, hasMore: page.hasMore, messages: [...page.messages.filter((m) => !have.has(m.id)), ...l.messages] };
    });
    return true;
  } catch (err) {
    patchList(conv, (l) => ({ ...l, loadingOlder: false }));
    toast('Couldn’t load older messages.', 'error');
    console.warn('[chat] could not load older messages:', err);
    return false;
  }
}

/** Loads a thread (its parent and latest replies), or with `older` the replies before those. */
export async function loadThread(id: string, older = false): Promise<void> {
  const t = get().threads[id];
  if (t && (t.status === 'loading' || t.loadingOlder)) return;
  if (older && (!t || !t.hasMore)) return;
  const before = older ? t?.messages.find((m) => !m.pending)?.id : undefined;
  set((st) => ({
    threads: {
      ...st.threads,
      // A thread on screen stays there while it's refreshed.
      [id]: older
        ? { ...st.threads[id], loadingOlder: true }
        : { ...(st.threads[id] ?? { ...emptyList(), parent: findMessage(id) ?? null }), status: t?.status === 'ready' ? 'ready' : 'loading' },
    },
  }));
  try {
    const res = await request('chat:thread', { id, before });
    if (!res.ok) throw new Error(res.error);
    patchThread(id, (cur) => {
      const ids = new Set(res.replies.map((m) => m.id));
      const messages = [...res.replies, ...cur.messages.filter((m) => !ids.has(m.id))].sort(order);
      return { ...cur, parent: res.parent, status: 'ready', loadingOlder: false, hasMore: res.hasMore, messages };
    });
  } catch (err) {
    patchThread(id, (cur) => ({ ...cur, status: cur.status === 'loading' ? 'error' : cur.status, loadingOlder: false }));
    if (!older) toast((err as Error).message === 'Not connected' ? 'Couldn’t open the thread.' : (err as Error).message, 'error');
  }
}

let peopleLoadedAt = 0;

/** The office's signed-in members, for mentions (at most once a minute). */
export async function loadPeople(): Promise<void> {
  if (Date.now() - peopleLoadedAt < 60_000) return;
  peopleLoadedAt = Date.now();
  const res = await request('chat:people').catch(() => null);
  if (res?.ok) set({ people: res.people });
  else peopleLoadedAt = 0;
}

// ---------- navigation ----------

/** Shows a conversation (and opens the chat panel, with `show`); a feature's own is shown where it shows it. */
export function openConv(conv: ConvKey, opts: { show?: boolean } = {}): void {
  if (!conv) return;
  const view = viewOf(conv);
  if (view) {
    view.open(conv);
    return;
  }
  set({ current: conv, thread: null, editing: null });
  rememberLiveName(conv, getState().players[conv.slice(2)]?.name);
  const officeId = getState().officeId;
  if (officeId && isListed(conv)) {
    try {
      localStorage.setItem(lastConvKey(officeId), conv);
    } catch {
      // Not saved; fine.
    }
  }
  if (opts.show && getState().panel !== 'chat') setState({ panel: 'chat', mode: 'play' });
  void loadConv(conv);
  sawCurrent();
}

export function openThread(id: string): void {
  set({ thread: id, editing: null });
  void loadThread(id);
}

export function closeThread(): void {
  set({ thread: null, editing: null });
  sawCurrent();
}

/** The conversation for a direct message with someone in the office: saved if you're both signed in. */
export function convWithPlayer(playerId: string): ConvKey {
  const p = getState().players[playerId];
  return p?.userId && myUserId() && p.userId !== myUserId() ? `d:${p.userId}` : `p:${playerId}`;
}

/** Opens the chat at a message: its conversation, its thread if it's a reply, scrolled to it. */
export function openMessage(id: string, conv: ConvKey, parentId: string | null): void {
  openConv(conv, { show: true });
  if (parentId) openThread(parentId);
  set({ jump: { id, at: Date.now() } });
}

/** Follows a link to a message (…?msg=<id>) once you're in the office. */
export async function openLinkedMessage(id: string): Promise<void> {
  const res = await request('chat:locate', id).catch(() => null);
  if (!res?.ok) {
    toast('That message isn’t available.', 'error');
    return;
  }
  openMessage(id, res.conv, res.parentId);
}

/** Loads older pages until a message is there (to jump to it); false if it can't be found. */
export async function reveal(conv: ConvKey, id: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const list = get().convs[conv];
    if (list?.messages.some((m) => m.id === id)) return true;
    if (!list || list.status !== 'ready' || !list.hasMore) return false;
    if (!(await loadOlder(conv))) return false;
  }
  return false;
}

// ---------- sending and changing ----------

const nonce = () => Math.random().toString(36).slice(2, 12);

export interface Draft {
  text: string;
  attachments: ChatAttachment[];
  /** Mentions picked in the composer, to show the message before the server answers. */
  mentions: ChatMention[];
}

/** Sends a message: shown at once as pending, then replaced by the server's copy. */
export function send(conv: ConvKey, draft: Draft, opts: { parentId?: string; alsoToChannel?: boolean } = {}): void {
  const request: SendRequest = {
    conv,
    text: draft.text,
    attachments: draft.attachments.map((a) => ({ id: a.id, w: a.w, h: a.h })),
    parentId: opts.parentId,
    alsoToChannel: opts.alsoToChannel,
    nonce: nonce(),
  };
  const { me, account } = getState();
  const pending: UiMessage = {
    id: `pending:${request.nonce}`,
    channelId: conv.startsWith('c:') ? conv.slice(2) : null,
    dm: null,
    conv: viewOf(conv) ? conv : null,
    live: conv === 'nearby' ? 'nearby' : conv.startsWith('p:') ? 'dm' : undefined,
    to: conv.startsWith('p:') ? conv.slice(2) : undefined,
    parentId: opts.parentId ?? null,
    inChannel: !!opts.alsoToChannel,
    userId: account?.id ?? null,
    playerId: selfId(),
    name: me.name,
    text: draft.text,
    attachments: draft.attachments,
    mentions: draft.mentions,
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    replyNames: [],
    createdAt: Date.now(),
    editedAt: null,
    deleted: false,
    nonce: request.nonce,
    pending: 'sending',
    request,
  };
  placePending(conv, pending);
  void deliverPending(conv, pending);
}

function placePending(conv: ConvKey, m: UiMessage): void {
  if (!m.parentId || m.inChannel) patchList(conv, (l) => ({ ...l, status: l.status === 'idle' ? 'ready' : l.status, messages: upsert(l.messages, m) }));
  if (m.parentId) patchThread(m.parentId, (t) => ({ ...t, messages: upsert(t.messages, m) }));
}

async function deliverPending(conv: ConvKey, m: UiMessage): Promise<void> {
  let error: string;
  try {
    const res = await request('chat:send', m.request!);
    if (res.ok) {
      remove(m.id);
      place(res.message);
      if (isSaved(conv)) markRead(conv);
      return;
    }
    error = res.error;
  } catch (err) {
    error = (err as Error).message === 'Not connected' ? 'Not connected. Check your connection and try again.' : 'The server didn’t answer. Try again.';
  }
  // The server's copy may have come in already (it replaces the pending one).
  if (!findMessage(m.id)) return;
  placePending(conv, { ...m, pending: 'failed', error });
}

export function retry(m: UiMessage): void {
  if (!m.request) return;
  const conv = m.request.conv;
  const again: UiMessage = { ...m, pending: 'sending', error: undefined };
  placePending(conv, again);
  void deliverPending(conv, again);
}

export function discard(m: UiMessage): void {
  remove(m.id);
}

/** The answer to a request, or null after telling the person what went wrong. */
async function ask<T extends object>(work: Promise<ChatResult<T>>, failure: string): Promise<T | null> {
  try {
    const res = await work;
    if (res.ok) return res;
    toast(res.error, 'error');
  } catch {
    toast(failure, 'error');
  }
  return null;
}

export async function editMessage(id: string, text: string): Promise<boolean> {
  const res = await ask(request('chat:edit', id, text), 'Couldn’t save your edit. Try again.');
  if (res) place(res.message);
  return !!res;
}

export async function deleteMessage(id: string): Promise<void> {
  await ask(request('chat:delete', id), 'Couldn’t delete the message. Try again.');
}

/** Adds or takes back your reaction (shown at once). */
export function react(m: ChatMessage, emoji: string): void {
  const pid = selfId();
  if (!pid) return;
  const reactions = toggleReaction(m.reactions, emoji, { id: reactorId(myUserId(), pid), name: getState().me.name });
  if (!reactions) {
    toast('This message has all the reactions it can take.', 'error');
    return;
  }
  place({ ...m, reactions });
  rememberEmoji(emoji);
  request('chat:react', m.id, emoji)
    .then((res) => {
      if (res.ok) return;
      toast(res.error, 'error');
      place(m);
    })
    .catch(() => place(m));
}

const RECENT_KEY = 'workchop:chat:recent-emoji';

export function recentEmoji(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(emoji: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, 8)));
  } catch {
    // Not saved; fine.
  }
}

/** Creates a channel and opens it; returns why it couldn't, or null. */
export async function createChannel(name: string, topic: string): Promise<string | null> {
  try {
    const res = await request('channel:create', { name, topic });
    if (!res.ok) return res.error;
    onChannel(res.channel);
    openConv(`c:${res.channel.id}`);
    return null;
  } catch {
    return 'The server didn’t answer. Try again.';
  }
}

export async function updateChannel(id: string, patch: { name?: string; topic?: string }): Promise<string | null> {
  try {
    const res = await request('channel:update', { id, ...patch });
    if (!res.ok) return res.error;
    onChannel(res.channel);
    return null;
  } catch {
    return 'The server didn’t answer. Try again.';
  }
}

export async function archiveChannel(id: string, archived: boolean): Promise<void> {
  const res = await ask(request('channel:archive', id, archived), 'Couldn’t change the channel. Try again.');
  if (res) onChannel(res.channel);
}

/** The dock button's count: unread mentions plus unread direct messages. */
export function useBadge(): number | string | null {
  const total = useChat((s) => {
    let n = 0;
    for (const [conv, c] of Object.entries(s.counts)) n += c.mentions + (isDirect(conv) ? c.unread : 0);
    return n;
  });
  return total > 9 ? '9+' : total;
}

/** Follows the panel opening, the tab coming back, and "message this person" requests from elsewhere. */
export function watchApp(): () => void {
  const unsub = useStore.subscribe((s, prev) => {
    if (s.chatWith && s.chatWith !== prev.chatWith) {
      const conv = convWithPlayer(s.chatWith);
      setState({ chatWith: null });
      openConv(conv, { show: true });
    }
    if (s.panel === 'chat' && prev.panel !== 'chat') sawCurrent();
  });
  const onVisible = () => !document.hidden && sawCurrent();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    unsub();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
