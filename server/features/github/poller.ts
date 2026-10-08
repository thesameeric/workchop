import type { GithubCounts, GithubInbox, GithubItem } from '../../../shared/github';
import type { ServerToClientEvents } from '../../../shared/types';
import { NeedsReconnect, NotLinked, RateLimited, type Api } from './api';
import { toItem, webUrl, type Bases, type Thread } from './classify';
import { hasRepoScope, normalizeScopes } from './links';
import { drain } from './oauth';

// Polls GitHub notifications for people who are in an office right now, as GitHub asks: If-Modified-Since
// with its Last-Modified, never sooner than X-Poll-Interval, and backing off when it says so.

/** Runs `fn` after `ms`; returns a function that cancels it. */
export type Schedule = (fn: () => void, ms: number) => () => void;

export const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

const MIN_POLL_S = 60;
const MAX_POLL_S = 3600;
const COUNTS_EVERY = 5 * 60_000;
const MAX_BACKOFF = 15 * 60_000;
/** How long someone's inbox is kept after they leave, so coming back (or reloading) doesn't poll early. */
const LINGER = 10 * 60_000;
/** Pages of 50 threads read per poll. */
const PAGES = 2;
/** Threads whose page address is looked up per poll (with the repo scope). */
const LOOKUPS_PER_POLL = 10;
const LOOKUP_CACHE = 300;
const NOTIFICATIONS = '/notifications?all=false&participating=false&per_page=50';
const SEARCHES = {
  reviewRequests: 'is:open is:pr review-requested:@me archived:false',
  assigned: 'is:open assignee:@me archived:false',
} as const;

interface UserPoll {
  userId: string;
  stopped: boolean;
  /** The first poll finished (until then there's no inbox to send). */
  loaded: boolean;
  /** Why GitHub couldn't be read, while no list has arrived yet. */
  problem: GithubInbox['problem'];
  lastModified: string | null;
  /**
   * Up to when (on GitHub's clock, ms since 1970) the list the user sees goes: its newest thread (an
   * empty list: its Last-Modified). Mark all read marks read on GitHub up to there, so what came later
   * stays unread.
   */
  seenUntil: number | null;
  /** Seconds between polls (X-Poll-Interval, at least 60). */
  pollInterval: number;
  items: Map<string, GithubItem>;
  counts: GithubCounts;
  countsDueAt: number;
  failures: number;
  /** When the next poll is due (ms since 1970). */
  nextAt: number;
  /** A poll is under way. */
  busy: boolean;
  /** Nobody is in an office: not polling, kept for a while in case they come back. */
  idle: boolean;
  /** The token has the repo scope (from X-OAuth-Scopes). */
  repo: boolean;
  /** Cancels the next poll (or, while idle, forgetting the inbox). */
  cancel: (() => void) | null;
  /** Threads marked read or done here, with their updatedAt then: GitHub's list may lag behind. */
  read: Map<string, number>;
  done: Map<string, number>;
  /** Everything updated before this was marked read ("Mark all read"). */
  readBefore: number;
  /** Page addresses looked up (subject.url → html_url), with ETags to ask again cheaply. */
  pages: Map<string, { etag: string; url: string }>;
}

type ServerEvent = keyof ServerToClientEvents;

export interface PollerDeps {
  api: Api;
  bases: Bases;
  now: () => number;
  schedule: Schedule;
  emitToUser<E extends ServerEvent>(userId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void;
}

const notLinked = (err: unknown) => err instanceof NotLinked || err instanceof NeedsReconnect;

/** GitHub answered a list request with an error. */
class Answered extends Error {
  constructor(readonly status: number) {
    super(`GitHub answered ${status}`);
  }
}

const problemOf = (err: unknown): GithubInbox['problem'] =>
  err instanceof RateLimited ? 'rate-limited' : err instanceof Answered && err.status === 403 ? 'forbidden' : 'unavailable';

/** The next page from a Link header, only if it is the same list on the same API. */
function nextPage(link: string | null, apiBase: string): string | null {
  const m = link && /<([^>]+)>\s*;\s*rel="?next"?/.exec(link);
  if (!m) return null;
  try {
    const url = new URL(m[1]);
    return url.href.startsWith(`${apiBase}/notifications?`) ? url.href : null;
  } catch {
    return null;
  }
}

async function threadsOf(res: Response): Promise<Thread[]> {
  const body = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(body)) throw new Error('GitHub sent an unexpected answer');
  return body.slice(0, 50).filter((t): t is Thread => !!t && typeof t === 'object');
}

export function createPoller(deps: PollerDeps) {
  const { api, bases, now, schedule } = deps;
  const polls = new Map<string, UserPoll>();

  const inboxOf = (p: UserPoll): GithubInbox => ({ items: [...p.items.values()], counts: { ...p.counts }, ...(p.problem && { problem: p.problem }) });

  /** Applies the marks made here to an item from GitHub's list; false when it was marked done (and hasn't changed since). */
  function applyMarks(p: UserPoll, item: GithubItem): boolean {
    const done = p.done.get(item.id);
    if (done !== undefined) {
      if (item.updatedAt <= done) return false;
      p.done.delete(item.id);
    }
    const read = p.read.get(item.id);
    if (item.updatedAt <= p.readBefore || (read !== undefined && item.updatedAt <= read)) item.unread = false;
    return true;
  }

  /** Finds page addresses for new threads with the repo scope (GitHub says not to build them). */
  async function lookUpPages(p: UserPoll, items: GithubItem[], threads: Map<string, Thread>) {
    let budget = LOOKUPS_PER_POLL;
    for (const item of items) {
      if (budget <= 0 || p.stopped) return;
      const subject = threads.get(item.id)?.subject;
      const target = [subject?.latest_comment_url, subject?.url].find((u): u is string => typeof u === 'string' && u.startsWith(`${bases.apiBase}/repos/`));
      if (!target) continue;
      budget--;
      const cached = p.pages.get(target);
      try {
        const res = await api.call(p.userId, target, { headers: cached ? { 'If-None-Match': cached.etag } : {} });
        if (res.status === 304 && cached) {
          item.url = cached.url;
          await drain(res);
          continue;
        }
        if (!res.ok) {
          await drain(res);
          continue;
        }
        const url = webUrl(((await res.json().catch(() => null)) as { html_url?: unknown } | null)?.html_url, bases.webBase);
        const etag = res.headers.get('etag');
        if (!url) continue;
        item.url = url;
        if (etag) {
          p.pages.delete(target);
          p.pages.set(target, { etag, url });
          if (p.pages.size > LOOKUP_CACHE) p.pages.delete(p.pages.keys().next().value!);
        }
      } catch (err) {
        if (notLinked(err)) throw err;
        // Rate limited or unreachable: the fallback link will do.
        return;
      }
    }
  }

  /** Takes a fresh list from GitHub: tells the user what's new, changed and gone. */
  async function apply(p: UserPoll, threads: Thread[]) {
    const next = new Map<string, GithubItem>();
    const byId = new Map<string, Thread>();
    for (const thread of threads) {
      const item = toItem(thread, bases);
      if (!item || byId.has(item.id)) continue;
      byId.set(item.id, thread);
      if (!applyMarks(p, item)) continue;
      const old = p.items.get(item.id);
      if (old && old.updatedAt === item.updatedAt) item.url = old.url;
      next.set(item.id, item);
    }
    // Once GitHub's list no longer has them, it has caught up.
    for (const marks of [p.read, p.done]) for (const id of marks.keys()) if (!byId.has(id)) marks.delete(id);
    const fresh = [...next.values()].filter((i) => !p.items.has(i.id) || p.items.get(i.id)!.updatedAt !== i.updatedAt);
    if (p.repo) {
      await lookUpPages(p, fresh, byId);
      if (p.stopped) return;
      // Marked read or done while the pages were looked up.
      for (const item of next.values()) if (!applyMarks(p, item)) next.delete(item.id);
    }
    const before = p.items;
    p.items = next;
    if (!p.loaded) return;
    for (const item of next.values()) {
      if (JSON.stringify(before.get(item.id)) !== JSON.stringify(item)) deps.emitToUser(p.userId, 'github:item', item);
    }
    for (const id of before.keys()) if (!next.has(id)) deps.emitToUser(p.userId, 'github:remove', id);
  }

  async function pollNotifications(p: UserPoll) {
    const first = await api.call(p.userId, NOTIFICATIONS, { headers: p.lastModified ? { 'If-Modified-Since': p.lastModified } : {} });
    // Error answers may come without it; the last one GitHub sent still holds.
    const interval = first.headers.get('x-poll-interval')?.trim();
    if (interval && /^\d+$/.test(interval)) p.pollInterval = Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, Number(interval)));
    const scopes = first.headers.get('x-oauth-scopes');
    if (scopes !== null) p.repo = hasRepoScope(normalizeScopes(scopes));
    if (first.status === 304) {
      await drain(first);
      return;
    }
    if (!first.ok) {
      await drain(first);
      throw new Answered(first.status);
    }
    const threads = await threadsOf(first);
    let next = nextPage(first.headers.get('link'), bases.apiBase);
    for (let page = 2; next && page <= PAGES; page++) {
      const res = await api.call(p.userId, next);
      if (!res.ok) {
        await drain(res);
        throw new Answered(res.status);
      }
      threads.push(...(await threadsOf(res)));
      next = nextPage(res.headers.get('link'), bases.apiBase);
    }
    if (p.stopped) return;
    await apply(p, threads);
    p.lastModified = first.headers.get('last-modified');
    const newest = Math.max(0, ...[...p.items.values()].map((item) => item.updatedAt));
    p.seenUntil = newest || Date.parse(p.lastModified ?? '') || Date.parse(first.headers.get('date') ?? '') || now();
  }

  async function count(p: UserPoll, q: string): Promise<number> {
    const res = await api.call(p.userId, `/search/issues?${new URLSearchParams({ q, per_page: '1' })}`);
    const body = (await res.json().catch(() => null)) as { total_count?: unknown } | null;
    if (!res.ok || typeof body?.total_count !== 'number') throw new Error(`GitHub's search answered ${res.status}`);
    return body.total_count;
  }

  /** Open review requests and assignments (GitHub's search; public repositories only without the repo scope). */
  async function pollCounts(p: UserPoll) {
    try {
      const counts: GithubCounts = { reviewRequests: await count(p, SEARCHES.reviewRequests), assigned: await count(p, SEARCHES.assigned) };
      p.countsDueAt = now() + COUNTS_EVERY;
      if (p.stopped || (counts.reviewRequests === p.counts.reviewRequests && counts.assigned === p.counts.assigned)) return;
      p.counts = counts;
      if (p.loaded) deps.emitToUser(p.userId, 'github:inbox', inboxOf(p));
    } catch (err) {
      if (notLinked(err)) throw err;
      // The search has its own, smaller rate limit; notifications carry on.
      p.countsDueAt = Math.max(now() + COUNTS_EVERY, err instanceof RateLimited ? err.until : 0);
    }
  }

  const run = (p: UserPoll) => () => void tick(p).catch((err) => console.error('[github] a poll failed:', err));

  async function tick(p: UserPoll) {
    p.cancel = null;
    if (p.stopped) return;
    p.busy = true;
    let wait = 0;
    try {
      await pollNotifications(p);
      if (!p.stopped && now() >= p.countsDueAt) await pollCounts(p);
      if (p.stopped) return;
      p.failures = 0;
      if (!p.loaded) {
        p.loaded = true;
        p.problem = undefined;
        deps.emitToUser(p.userId, 'github:inbox', inboxOf(p));
      }
    } catch (err) {
      if (p.stopped) return;
      if (notLinked(err)) {
        stop(p.userId, p);
        return;
      }
      p.failures++;
      if (err instanceof RateLimited) wait = err.until - now();
      else {
        wait = Math.min(MAX_BACKOFF, p.pollInterval * 1000 * 2 ** Math.min(p.failures - 1, 4));
        if (p.failures === 1) console.warn('[github] could not get notifications:', (err as Error).message);
      }
      // No list yet: the panel says why instead of waiting.
      const problem = problemOf(err);
      if (!p.loaded && problem !== p.problem) {
        p.problem = problem;
        deps.emitToUser(p.userId, 'github:inbox', inboxOf(p));
      }
    } finally {
      p.busy = false;
    }
    const delay = Math.max(p.pollInterval * 1000, wait);
    p.nextAt = now() + delay;
    if (!p.idle) p.cancel = schedule(run(p), delay);
  }

  function stop(userId: string, only?: UserPoll) {
    const p = polls.get(userId);
    if (!p || (only && p !== only)) return;
    p.stopped = true;
    p.cancel?.();
    polls.delete(userId);
  }

  return {
    /** Polls for the user (who is in an office), unless that already happens; picks up a recent inbox. */
    start(userId: string) {
      const known = polls.get(userId);
      if (known) {
        if (!known.idle) return;
        known.idle = false;
        known.cancel?.();
        known.cancel = known.busy ? null : schedule(run(known), Math.max(0, known.nextAt - now()));
        return;
      }
      const p: UserPoll = {
        userId,
        stopped: false,
        loaded: false,
        problem: undefined,
        lastModified: null,
        seenUntil: null,
        pollInterval: MIN_POLL_S,
        items: new Map(),
        counts: { reviewRequests: null, assigned: null },
        countsDueAt: 0,
        failures: 0,
        nextAt: 0,
        busy: false,
        idle: false,
        repo: false,
        cancel: null,
        read: new Map(),
        done: new Map(),
        readBefore: 0,
        pages: new Map(),
      };
      polls.set(userId, p);
      run(p)();
    },

    /** Stops polling (they left every office), keeping the inbox for a while. */
    leave(userId: string) {
      const p = polls.get(userId);
      if (!p || p.idle) return;
      p.idle = true;
      p.cancel?.();
      p.cancel = schedule(() => stop(userId, p), LINGER);
    },

    /** Stops polling and forgets the inbox (disconnected, or needs reconnecting). */
    stop: (userId: string) => stop(userId),

    /** The user's inbox once the first poll is done (or failed); null before that or when not polling. */
    inbox(userId: string): GithubInbox | null {
      const p = polls.get(userId);
      return p && (p.loaded || p.problem) ? inboxOf(p) : null;
    },

    /** Marks a thread read on GitHub. */
    async read(userId: string, id: string): Promise<boolean> {
      const res = await api.call(userId, `/notifications/threads/${id}`, { method: 'PATCH' });
      await drain(res);
      if (!res.ok) return false;
      const p = polls.get(userId);
      const item = p?.items.get(id);
      if (p && item) {
        p.read.set(id, item.updatedAt);
        if (item.unread) {
          const updated = { ...item, unread: false };
          p.items.set(id, updated);
          deps.emitToUser(userId, 'github:item', updated);
        }
      }
      return true;
    },

    /** Marks a thread done on GitHub: it leaves the inbox. */
    async done(userId: string, id: string): Promise<boolean> {
      const res = await api.call(userId, `/notifications/threads/${id}`, { method: 'DELETE' });
      await drain(res);
      if (!res.ok) return false;
      const p = polls.get(userId);
      if (p) {
        p.done.set(id, p.items.get(id)?.updatedAt ?? now());
        if (p.items.delete(id)) deps.emitToUser(userId, 'github:remove', id);
      }
      return true;
    },

    /** Marks read on GitHub everything in the list the user sees: what came after it stays unread. */
    async readAll(userId: string): Promise<boolean> {
      const at = polls.get(userId)?.seenUntil;
      if (typeof at !== 'number') return false;
      const res = await api.call(userId, '/notifications', { method: 'PUT', body: { last_read_at: new Date(at).toISOString(), read: true } });
      await drain(res);
      if (!res.ok) return false;
      const p = polls.get(userId);
      if (p) {
        p.readBefore = Math.max(p.readBefore, at);
        for (const [id, item] of p.items) if (item.unread && item.updatedAt <= at) p.items.set(id, { ...item, unread: false });
        if (p.loaded) deps.emitToUser(userId, 'github:inbox', inboxOf(p));
      }
      return true;
    },
  };
}
