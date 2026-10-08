import { create } from 'zustand';
import type { GithubBucket, GithubCounts, GithubInbox, GithubItem, GithubStatus } from '../../../../shared/github';

export interface GithubState {
  /**
   * Whether you can use GitHub here: 'unknown' until the server answers, 'off' when this server has
   * no GitHub (nothing is shown), 'guest' when you need to sign in first, 'on' with `status`.
   */
  availability: 'unknown' | 'off' | 'guest' | 'on';
  status: GithubStatus | null;
  /** Your inbox by thread id (from the server's poller, while you're in an office). */
  items: Record<string, GithubItem>;
  counts: GithubCounts;
  /** A list from GitHub arrived (so items that come after it may be new). */
  loaded: boolean;
  /** Why GitHub can't be read right now, if it can't. */
  problem: GithubInbox['problem'] | null;
  /** The connect window is open. */
  connecting: boolean;
  /** Who the office connection was made as: an account id, null for a guest, undefined outside an office. */
  joinedAs: string | null | undefined;
  /** The panel's open tab. */
  tab: GithubBucket;
}

const NO_COUNTS: GithubCounts = { reviewRequests: null, assigned: null };

/** No inbox: signed out, disconnected, or waiting for it. */
export const EMPTY_INBOX = { items: {}, counts: NO_COUNTS, loaded: false, problem: null } satisfies Partial<GithubState>;

export const useGithub = create<GithubState>()(() => ({
  availability: 'unknown',
  status: null,
  ...EMPTY_INBOX,
  connecting: false,
  joinedAs: undefined,
  tab: 'mentions',
}));

/** The items the dock badge counts: unread mentions, review requests and failed runs. */
export function needsYou(item: GithubItem): boolean {
  return item.unread && (item.bucket === 'mentions' || item.bucket === 'reviews' || isFailedRun(item));
}

function isFailedRun(item: GithubItem): boolean {
  return item.bucket === 'actions' && item.run?.status === 'failure';
}

/**
 * Tells a failed run that just happened (a new thread, or a newer run on one we had) from an old
 * thread coming back into the server's newest 100 after a Done: that one is older than the newest
 * item of the inbox it was left out of, or no newer than when we last saw it.
 */
export function failureWatch() {
  /** When each thread last changed, as far as we know (also after it left the inbox). */
  const seen = new Map<string, number>();
  let inboxNewest = 0;
  return {
    /** A whole inbox arrived (it never counts as new). */
    inbox(items: GithubItem[]): void {
      inboxNewest = 0;
      for (const item of items) {
        seen.set(item.id, item.updatedAt);
        inboxNewest = Math.max(inboxNewest, item.updatedAt);
      }
    },
    /** One item arrived: whether it is an unread failed run that just happened. */
    isNew(item: GithubItem): boolean {
      const before = seen.get(item.id);
      seen.set(item.id, Math.max(before ?? 0, item.updatedAt));
      return isFailedRun(item) && item.unread && item.updatedAt > (before ?? inboxNewest);
    },
  };
}

/** Connected, and GitHub still takes the saved token. */
export function isLive(status: GithubStatus | null): boolean {
  return !!status?.connected && !status.needsReconnect;
}
