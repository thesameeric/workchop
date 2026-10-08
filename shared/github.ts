// The GitHub integration (docs/specs/github.md): a signed-in person's GitHub notifications (mentions,
// review requests, Actions runs…) in a panel, from the server's poller. Tokens never leave the server.

/** Where an item goes in the panel, from its notification's reason and subject. */
export type GithubBucket = 'mentions' | 'reviews' | 'actions' | 'activity';

/** An Actions run's outcome: from a CheckSuite title, or 'waiting' for a deployment approval. */
export type GithubRunStatus = 'success' | 'failure' | 'cancelled' | 'skipped' | 'waiting';

/** One notification thread, as the panel shows it. */
export interface GithubItem {
  /** GitHub's notification thread id. */
  id: string;
  bucket: GithubBucket;
  /** Why GitHub notified you: mention, team_mention, review_requested, assign, ci_activity, approval_requested, comment… */
  reason: string;
  /** PullRequest, Issue, CheckSuite, WorkflowRun, Discussion, Release, Commit… */
  subjectType: string;
  title: string;
  /** "owner/name". */
  repo: string;
  /** Where clicking it goes: a https://github.com/ page. */
  url: string;
  /** When the thread last changed (ms since 1970). */
  updatedAt: number;
  unread: boolean;
  /** Actions items only; a deployment approval's title names no workflow. */
  run?: { status: GithubRunStatus; workflow?: string; branch?: string };
}

/** Counts from GitHub's search that stay until the work is done (null: unknown or not available). */
export interface GithubCounts {
  /** Open pull requests waiting for your review. */
  reviewRequests: number | null;
  /** Open issues and pull requests assigned to you. */
  assigned: number | null;
}

/** Everything in your GitHub inbox right now: sent in full when you join an office, and when it changes a lot. */
export interface GithubInbox {
  items: GithubItem[];
  counts: GithubCounts;
  /** Why no list has come from GitHub yet (`items` is then empty): it isn't answering, it refused access, or its rate limit was reached. Later failures keep the last list. */
  problem?: 'unavailable' | 'forbidden' | 'rate-limited';
}

/** GET /api/integrations/github/status (signed in): whether and how you're connected. */
export interface GithubStatus {
  connected: boolean;
  /** Your GitHub login and avatar, when connected. */
  login?: string;
  avatarUrl?: string;
  /** Connected with the `repo` scope (private repositories and Actions details). */
  private: boolean;
  /** GitHub stopped accepting the saved token: connect again. */
  needsReconnect: boolean;
  /** The OAuth app's client id, for the "request organization access" link. */
  clientId: string;
}

declare module './types' {
  interface ServerToClientEvents {
    /** Your whole inbox (on joining an office, and after big changes). */
    'github:inbox': (inbox: GithubInbox) => void;
    /** A new or changed item. */
    'github:item': (item: GithubItem) => void;
    /** An item that is gone (done, or no longer in your inbox). */
    'github:remove': (id: string) => void;
    /** Your connection changed (connected, disconnected, or needs reconnecting). */
    'github:status': (status: GithubStatus) => void;
  }
  interface ClientToServerEvents {
    /** Mark a thread read on GitHub. */
    'github:read': (id: string, ack?: (ok: boolean) => void) => void;
    /** Mark a thread done on GitHub (it leaves the inbox). */
    'github:done': (id: string, ack?: (ok: boolean) => void) => void;
    /** Mark everything read on GitHub. */
    'github:readAll': (ack?: (ok: boolean) => void) => void;
  }
}
