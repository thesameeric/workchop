import type { GithubBucket, GithubItem, GithubRunStatus } from '../../../shared/github';
import { clip } from '../../../shared/text';

// Turns GitHub notification threads into panel items: the bucket, an Actions run's outcome (GitHub only
// puts it in the title; parsed the way gitify does), and a link (threads have no html_url).

/** A notification thread as GET /notifications returns it (only what we use; anything may be missing). */
export interface Thread {
  id?: unknown;
  unread?: unknown;
  reason?: unknown;
  updated_at?: unknown;
  subject?: { title?: unknown; url?: unknown; latest_comment_url?: unknown; type?: unknown } | null;
  repository?: { full_name?: unknown; html_url?: unknown } | null;
}

export const THREAD_ID = /^\d{1,20}$/;

/** Where a reason goes. The reason sticks to a thread: it says why you're subscribed, not what just happened. */
export function bucketOf(reason: string): GithubBucket {
  switch (reason) {
    case 'mention':
    case 'team_mention':
    case 'assign':
      return 'mentions';
    case 'review_requested':
      return 'reviews';
    case 'ci_activity':
    case 'approval_requested':
      return 'actions';
    default:
      return 'activity';
  }
}

const CHECK_SUITE = /^(?<workflow>.*?) workflow run(?:, Attempt #\d+)? (?<status>.*?) for (?<branch>.*?) branch$/;
const CHECK_STATUS: Record<string, GithubRunStatus> = {
  succeeded: 'success',
  failed: 'failure',
  'failed at startup': 'failure',
  cancelled: 'cancelled',
  skipped: 'skipped',
};

/** "CI workflow run, Attempt #2 failed for main branch" → the run; null when it doesn't parse. */
export function parseCheckSuite(title: string): { status: GithubRunStatus; workflow: string; branch: string } | null {
  const m = CHECK_SUITE.exec(title);
  const status = m?.groups && Object.hasOwn(CHECK_STATUS, m.groups.status) ? CHECK_STATUS[m.groups.status] : undefined;
  if (!m?.groups || !status) return null;
  return { status, workflow: m.groups.workflow, branch: m.groups.branch };
}

const APPROVAL = /^(?<user>.*?) requested your (?<status>.*?) to deploy to an environment$/;

/** "octocat requested your review to deploy to an environment" → a run waiting for your approval (the title names no workflow). */
export function parseWorkflowRun(title: string): { status: 'waiting' } | null {
  return APPROVAL.exec(title)?.groups?.status === 'review' ? { status: 'waiting' } : null;
}

export interface Bases {
  /** https://api.github.com (or GitHub Enterprise's /api/v3). */
  apiBase: string;
  /** https://github.com: every link we make is a page under it. */
  webBase: string;
}

/** `url` if it is a page under webBase (so never another site, nor javascript:), else null. */
export function webUrl(url: unknown, webBase: string): string | null {
  if (typeof url !== 'string' || url.length > 2000) return null;
  try {
    const u = new URL(url);
    const base = new URL(webBase);
    const prefix = base.pathname.replace(/\/$/, '');
    return u.origin === base.origin && u.pathname.startsWith(`${prefix}/`) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** GitHub logins and organizations; Enterprise Managed Users' have an underscore (octo_acme). */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The page for a thread without asking GitHub. GitHub says not to build page addresses from API
 * ones, so rewriting is only a fallback; the repository's page is the last resort.
 */
export function fallbackUrl(thread: Thread, { apiBase, webBase }: Bases): string {
  const repoUrl = webUrl(thread.repository?.html_url, webBase);
  const subject = thread.subject ?? {};
  const title = typeof subject.title === 'string' ? subject.title : '';
  if (repoUrl) {
    if (subject.type === 'CheckSuite') {
      const run = parseCheckSuite(title);
      if (!run) return `${repoUrl}/actions`;
      const query = `workflow:"${run.workflow}" is:${run.status} branch:${run.branch}`;
      return `${repoUrl}/actions?${new URLSearchParams({ query })}`;
    }
    if (subject.type === 'WorkflowRun') return `${repoUrl}/actions`;
    if (subject.type === 'Discussion') return `${repoUrl}/discussions`;
  }
  if (typeof subject.url === 'string' && subject.url.startsWith(`${apiBase}/repos/`)) {
    const [owner, repo, kind, number, ...rest] = subject.url.slice(apiBase.length + '/repos/'.length).split('/');
    if (!rest.length && OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..' && /^\d{1,10}$/.test(number ?? '')) {
      if (kind === 'pulls') return `${webBase}/${owner}/${repo}/pull/${number}`;
      if (kind === 'issues') return `${webBase}/${owner}/${repo}/issues/${number}`;
    }
  }
  return repoUrl ?? webBase;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? clip(v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), max) : '');

/** The panel's item for a thread, or null when the thread is malformed. */
export function toItem(thread: Thread, bases: Bases): GithubItem | null {
  const id = typeof thread.id === 'string' || typeof thread.id === 'number' ? String(thread.id) : '';
  const updatedAt = typeof thread.updated_at === 'string' ? Date.parse(thread.updated_at) : NaN;
  if (!THREAD_ID.test(id) || !Number.isFinite(updatedAt)) return null;
  const reason = text(thread.reason, 40) || 'subscribed';
  const subjectType = text(thread.subject?.type, 40);
  const title = text(thread.subject?.title, 300);
  const item: GithubItem = {
    id,
    bucket: bucketOf(reason),
    reason,
    subjectType,
    title,
    repo: text(thread.repository?.full_name, 200),
    url: fallbackUrl(thread, bases),
    updatedAt,
    unread: thread.unread !== false,
  };
  if (subjectType === 'CheckSuite') {
    const run = parseCheckSuite(title);
    if (run) item.run = run;
  } else if (subjectType === 'WorkflowRun' && reason === 'approval_requested') {
    const run = parseWorkflowRun(title);
    if (run) item.run = run;
  }
  return item;
}
