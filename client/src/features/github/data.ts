import type { GithubInbox, GithubItem, GithubStatus } from '../../../../shared/github';
import { getSession, onSession, type AppSocket, type OfficeSession } from '../../lib/session';
import { getState as getAppState, toast, useStore } from '../../state/store';
import { GithubIcon } from '../../ui/icons';
import { connectUrl, fetchStatus, postDisconnect, type GithubScope } from './api';
import { failedRunText, webUrl } from './format';
import { EMPTY_INBOX, failureWatch, isLive, useGithub } from './state';

// Your GitHub connection and inbox: the status from the server (on start, when the account changes,
// on joining an office), the inbox from the office connection, connecting in a window, and marking
// things read or done (shown at once, put back if GitHub refuses).

const { getState: get, setState: set } = useGithub;

/** Counts status changes, so an answer to an older request can't undo a newer change. */
let statusSeq = 0;

function applyStatus(status: GithubStatus): void {
  set(isLive(status) ? { availability: 'on', status } : { availability: 'on', status, ...EMPTY_INBOX });
}

/** Asks the server how you're connected. Failing (offline), it keeps what it knew. */
async function refreshStatus(): Promise<void> {
  const seq = ++statusSeq;
  try {
    const answer = await fetchStatus();
    if (seq !== statusSeq) return;
    if (answer === 'off' || answer === 'guest') set({ availability: answer, status: null, ...EMPTY_INBOX });
    else applyStatus(answer);
  } catch {
    // Asked again on the next join or account change.
  }
}

const RESULTS: Record<string, () => void> = {
  connected: () => toast('GitHub connected', { icon: GithubIcon }),
  cancelled: () => toast('GitHub connection cancelled', { icon: GithubIcon }),
  signin: () => toast('Sign in to connect GitHub', { icon: GithubIcon }),
  busy: () => toast('Too many tries to connect GitHub. Try again in a few minutes.', 'error'),
};

/** Says how connecting went (?github=… from the server). */
function report(result: unknown): void {
  const say = typeof result === 'string' && Object.hasOwn(RESULTS, result) ? RESULTS[result] : null;
  if (say) say();
  else toast('Couldn’t connect GitHub. Please try again.', 'error');
}

let popupTimer: ReturnType<typeof setInterval> | undefined;

/** Where the connect window goes when it can't reach this tab (github-callback.html reads it). */
const RETURN_KEY = 'workchop:github-return';

/**
 * Connects GitHub, or connects again (to add private repositories, or after GitHub stopped taking
 * the token). Call it from a click: it opens GitHub in a window, so the office stays open here.
 */
export function connectGithub(scope: GithubScope): void {
  const width = 600;
  const height = 750;
  const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
  // Before opening: the window gets a copy of this tab's sessionStorage.
  try {
    sessionStorage.setItem(RETURN_KEY, location.pathname + location.search);
  } catch {
    // It goes to the start page instead.
  }
  const popup = window.open(connectUrl(scope, '/github-callback.html'), 'workchop-github', `popup,width=${width},height=${height},left=${left},top=${top}`);
  if (!popup) {
    // Pop-ups are blocked: this page goes instead, and comes back here with ?github=….
    location.assign(connectUrl(scope, location.pathname + location.search));
    return;
  }
  set({ connecting: true });
  clearInterval(popupTimer);
  popupTimer = setInterval(() => {
    if (!popup.closed) return;
    clearInterval(popupTimer);
    set({ connecting: false });
  }, 500);
}

// The connect window's answer (github-callback.html).
window.addEventListener('message', (e: MessageEvent<{ type?: unknown; result?: unknown } | null>) => {
  if (e.origin !== location.origin || e.data?.type !== 'workchop-github') return;
  clearInterval(popupTimer);
  set({ connecting: false });
  report(e.data.result);
  void refreshStatus();
});

// Coming back to this tab while connecting: the window may not have been able to tell us (some
// in-app browsers open it without a way back).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && get().connecting) void refreshStatus();
});

/** Connecting without a window comes back with ?github=…: say how it went, and tidy up the address. */
function reportReturn(): void {
  const url = new URL(location.href);
  const result = url.searchParams.get('github');
  if (result === null) return;
  url.searchParams.delete('github');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  report(result);
}

export async function disconnectGithub(): Promise<void> {
  const seq = ++statusSeq;
  try {
    const status = await postDisconnect();
    if (seq === statusSeq) applyStatus(status);
  } catch (err) {
    toast(`Couldn’t disconnect GitHub: ${(err as Error).message}`, 'error');
  }
}

/**
 * Asks the server to do something on GitHub; `undo` runs if it didn't. Not once you've left that
 * office: its inbox is gone, and the server may well have done it.
 */
function ask(send: (socket: AppSocket) => Promise<unknown>, undo: () => void): void {
  const session = getSession();
  const socket = session?.socket;
  const sent = socket?.connected ? send(socket).then((ok) => ok === true, () => false) : Promise.resolve(false);
  void sent.then((ok) => {
    if (!ok && getSession() === session) undo();
  });
}

const ACK_MS = 15_000;

function without(items: Record<string, GithubItem>, id: string): Record<string, GithubItem> {
  const { [id]: _gone, ...rest } = items;
  return rest;
}

function patchItems(patch: (items: Record<string, GithubItem>) => Record<string, GithubItem> | null): void {
  set((s) => {
    const items = patch(s.items);
    return items ? { items } : {};
  });
}

/** Marks an item read on GitHub (clicking it does too). */
export function markRead(id: string): void {
  const item = get().items[id];
  if (!item?.unread) return;
  patchItems((items) => ({ ...items, [id]: { ...items[id], unread: false } }));
  ask(
    (socket) => socket.timeout(ACK_MS).emitWithAck('github:read', id),
    () => {
      // Unread again, unless it changed meanwhile.
      patchItems((items) => (items[id]?.updatedAt === item.updatedAt && !items[id].unread ? { ...items, [id]: { ...items[id], unread: true } } : null));
      toast('Couldn’t mark it read on GitHub', 'error');
    },
  );
}

/** Marks an item done on GitHub: it leaves your inbox. */
export function markDone(id: string): void {
  const item = get().items[id];
  if (!item) return;
  patchItems((items) => without(items, id));
  ask(
    (socket) => socket.timeout(ACK_MS).emitWithAck('github:done', id),
    () => {
      patchItems((items) => (items[id] ? null : { ...items, [id]: item }));
      toast('Couldn’t mark it done on GitHub', 'error');
    },
  );
}

/** Marks everything read on GitHub. */
export function markAllRead(): void {
  const unread = Object.values(get().items).filter((i) => i.unread);
  if (!unread.length) return;
  patchItems((items) => Object.fromEntries(Object.entries(items).map(([id, i]) => [id, i.unread ? { ...i, unread: false } : i])));
  ask(
    (socket) => socket.timeout(ACK_MS).emitWithAck('github:readAll'),
    () => {
      patchItems((items) => {
        const next = { ...items };
        for (const before of unread) if (next[before.id]?.updatedAt === before.updatedAt) next[before.id] = { ...next[before.id], unread: true };
        return next;
      });
      toast('Couldn’t mark everything read on GitHub', 'error');
    },
  );
}

/** Opens an item on GitHub in a new tab, and marks it read. */
function openItem(item: GithubItem): void {
  const url = webUrl(item.url);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
  markRead(item.id);
}

/** Which failed runs that arrive get a toast. */
const failures = failureWatch();

function githubSession(session: OfficeSession): () => void {
  const { socket } = session;
  const onInbox = (inbox: GithubInbox) => {
    failures.inbox(inbox.items);
    // With a problem, GitHub hasn't sent a list yet (the items are empty).
    set({
      items: Object.fromEntries(inbox.items.map((i) => [i.id, i])),
      counts: inbox.counts,
      more: inbox.more === true,
      loaded: !inbox.problem,
      problem: inbox.problem ?? null,
    });
  };
  const onItem = (item: GithubItem) => {
    const isNew = failures.isNew(item);
    set((s) => ({ items: { ...s.items, [item.id]: item } }));
    if (isNew && get().loaded) {
      toast(failedRunText(item), { kind: 'error', icon: GithubIcon, action: { label: 'Open', run: () => openItem(item) } });
      // And on your desk's monitor, unless you're looking at the panel.
      if (getAppState().panel !== 'github') set((s) => ({ newFailures: [...s.newFailures.filter((id) => id !== item.id), item.id] }));
    }
  };
  const onRemove = (id: string) => patchItems((items) => (items[id] ? without(items, id) : null));
  const onStatus = (status: GithubStatus) => {
    statusSeq++;
    applyStatus(status);
  };
  socket.on('github:inbox', onInbox);
  socket.on('github:item', onItem);
  socket.on('github:remove', onRemove);
  socket.on('github:status', onStatus);
  const offJoined = session.onJoined(() => {
    // The server sends the inbox to signed-in connections when they join.
    set({ joinedAs: getAppState().account?.id ?? null });
    void refreshStatus();
  });
  return () => {
    socket.off('github:inbox', onInbox);
    socket.off('github:item', onItem);
    socket.off('github:remove', onRemove);
    socket.off('github:status', onStatus);
    offJoined();
    clearInterval(popupTimer);
    set({ ...EMPTY_INBOX, connecting: false, joinedAs: undefined });
  };
}

/** The account the status was last asked for (undefined: not yet). */
let statusFor: string | null | undefined;

function accountChanged({ accountReady, account }: { accountReady: boolean; account: { id: string } | null }): void {
  if (!accountReady) return;
  const id = account?.id ?? null;
  if (id === statusFor) return;
  // Someone else's inbox (or none) from now on.
  if (statusFor !== undefined) set({ status: null, ...EMPTY_INBOX });
  statusFor = id;
  void refreshStatus();
}

useStore.subscribe(accountChanged);
accountChanged(useStore.getState());
// Opening the panel is looking at the failed runs: the monitor's badge goes.
useStore.subscribe(({ panel }) => {
  if (panel === 'github' && get().newFailures.length) set({ newFailures: [] });
});
reportReturn();
onSession('github', githubSession);
