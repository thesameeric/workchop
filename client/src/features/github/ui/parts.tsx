import { useEffect, useState } from 'react';
import type { GithubItem, GithubStatus } from '../../../../../shared/github';
import { SignInOptions } from '../../../ui/Account';
import {
  ActionsIcon,
  BellIcon,
  ChatIcon,
  ClockIcon,
  CommitIcon,
  FailureIcon,
  GithubIcon,
  IssueIcon,
  PullRequestIcon,
  StoppedIcon,
  SuccessIcon,
  TagIcon,
  type IconComponent,
} from '../../../ui/icons';

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** Why GitHub may show you less than you expect, and what to do about it. */
export function SetupHints({ clientId }: { clientId?: string }) {
  return (
    <ul className="gh-hints">
      <li>
        In{' '}
        <a href="https://github.com/settings/notifications" {...EXTERNAL}>
          GitHub’s notification settings
        </a>
        , choose “On GitHub” for Participating and Watching, and for Actions under System.
      </li>
      {clientId && (
        <li>
          Missing an organization? Its owner may need to approve Workchop:{' '}
          <a href={`https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`} {...EXTERNAL}>
            request access
          </a>
          .
        </li>
      )}
      <li>Organizations with SAML single sign-on: sign in to them on GitHub before you connect.</li>
    </ul>
  );
}

const RUN_ICONS: Record<NonNullable<GithubItem['run']>['status'], IconComponent> = {
  success: SuccessIcon,
  failure: FailureIcon,
  cancelled: StoppedIcon,
  skipped: StoppedIcon,
  waiting: ClockIcon,
};

const TYPE_ICONS: Record<string, IconComponent> = {
  PullRequest: PullRequestIcon,
  Issue: IssueIcon,
  CheckSuite: ActionsIcon,
  WorkflowRun: ActionsIcon,
  Discussion: ChatIcon,
  Release: TagIcon,
  Commit: CommitIcon,
};

/** What screen readers say for the icon (a run's outcome is in the text after it). */
const TYPE_NAMES: Record<string, string> = {
  PullRequest: 'Pull request',
  Issue: 'Issue',
  CheckSuite: 'Actions run',
  WorkflowRun: 'Actions run',
  Discussion: 'Discussion',
  Release: 'Release',
  Commit: 'Commit',
};

/** The item's kind (pull request, issue, run…), or for a run its outcome, in the outcome's colour. */
export function ItemIcon({ item }: { item: GithubItem }) {
  const Icon = item.run ? RUN_ICONS[item.run.status] : (TYPE_ICONS[item.subjectType] ?? BellIcon);
  const name = TYPE_NAMES[item.subjectType] ?? 'Notification';
  return <Icon size={18} className={`gh-type${item.run ? ` gh-run ${item.run.status}` : ''}`} role="img" aria-hidden={false} aria-label={name} />;
}

/** Your GitHub picture, or the GitHub mark. */
export function GithubAvatar({ status, size = 40 }: { status: GithubStatus; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!status.avatarUrl || broken) {
    return (
      <span className="gh-avatar" style={{ width: size, height: size }}>
        <GithubIcon size={Math.round(size * 0.6)} />
      </span>
    );
  }
  return <img className="gh-avatar" src={status.avatarUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

/** For guests: GitHub needs an account, and connecting is a step of its own (signing in with GitHub too). */
export function SignInToConnect() {
  return (
    <div className="gh-sign-in">
      <p>
        <strong>Sign in, then connect GitHub here.</strong>
      </p>
      <p className="muted small">Your GitHub connection is kept with your Workchop account.</p>
      <SignInOptions />
    </div>
  );
}

/** Re-renders every `ms`, for times like "5 min. ago". */
export function useTick(ms: number): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
