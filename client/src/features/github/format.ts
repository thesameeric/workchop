import type { GithubItem, GithubRunStatus } from '../../../../shared/github';

// Words for the panel. A thread's reason is why you're subscribed to it (GitHub keeps the first
// strong one, e.g. "mention"), not what happened last.

const REASONS: Record<string, string> = {
  mention: 'Mentioned',
  team_mention: 'Team mentioned',
  review_requested: 'Review requested',
  assign: 'Assigned',
  comment: 'Commented',
  author: 'Your thread',
  state_change: 'State changed',
  manual: 'Subscribed',
  subscribed: 'Watching',
  ci_activity: 'Actions run',
  approval_requested: 'Approval requested',
  security_alert: 'Security alert',
  security_advisory_credit: 'Advisory credit',
  invitation: 'Invitation',
  member_feature_requested: 'Feature request',
};

export function reasonText(reason: string): string {
  if (REASONS[reason]) return REASONS[reason];
  const words = reason.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const RUN_STATUS: Record<GithubRunStatus, string> = {
  success: 'Succeeded',
  failure: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  waiting: 'Waiting for approval',
};

/** "CI failed on main" for a failed run's toast (its title when it names no workflow). */
export function failedRunText(item: GithubItem): string {
  const workflow = item.run?.workflow;
  if (!workflow) return item.title;
  return item.run?.branch ? `${workflow} failed on ${item.run.branch}` : `${workflow} failed`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** "5 min. ago", "yesterday", or after a week the date; a time slightly ahead of this device's clock counts as now. */
export function relativeTime(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - ts) / 1000);
  if (seconds >= 7 * 86400) {
    const date = new Date(ts);
    const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year });
  }
  const step = STEPS.find(([, size]) => seconds >= size);
  return step ? rtf.format(-Math.floor(seconds / step[1]), step[0]) : rtf.format(0, 'second');
}

/** Only web links open (the server sends GitHub pages; anything else stays unclickable). */
export function webUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}
