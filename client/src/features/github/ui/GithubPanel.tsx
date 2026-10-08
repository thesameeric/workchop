import { useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import type { GithubBucket, GithubCounts, GithubInbox, GithubItem, GithubStatus } from '../../../../../shared/github';
import { useStore } from '../../../state/store';
import { CheckAllIcon, CheckIcon, GithubIcon, MarkReadIcon } from '../../../ui/icons';
import type { GithubScope } from '../api';
import { connectGithub, markAllRead, markDone, markRead, rejoin } from '../data';
import { reasonText, relativeTime, RUN_STATUS, webUrl } from '../format';
import { needsYou, useGithub } from '../state';
import { ItemIcon, SetupHints, SignInToConnect, useTick } from './parts';

const TABS: { id: GithubBucket; label: string; empty: string }[] = [
  { id: 'mentions', label: 'Mentions', empty: 'No mentions or assignments right now.' },
  { id: 'reviews', label: 'Reviews', empty: 'No review requests right now.' },
  { id: 'actions', label: 'Actions', empty: 'No Actions runs right now.' },
  { id: 'activity', label: 'Activity', empty: 'Nothing else new.' },
];

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** GitHub's search for what the assigned count counts (open issues and pull requests). */
const ASSIGNED_URL = `https://github.com/search?${new URLSearchParams({ q: 'is:open assignee:@me archived:false', type: 'issues' })}`;

const PROBLEMS: Record<NonNullable<GithubInbox['problem']>, string> = {
  unavailable: 'GitHub isn’t answering right now.',
  forbidden: 'GitHub refused access. Try reconnecting.',
  'rate-limited': 'GitHub’s rate limit was reached. Trying again soon.',
};

/** The dock badge: unread mentions, review requests and failed runs ("!" when GitHub needs reconnecting). */
export function useGithubBadge(): number | string | null {
  return useGithub((s) => {
    if (!s.status?.connected) return null;
    if (s.status.needsReconnect) return '!';
    const n = Object.values(s.items).filter(needsYou).length;
    return n > 9 ? '9+' : n;
  });
}

function Prompt({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className="panel-body">
      <div className={`gh-prompt ${className}`}>
        <GithubIcon size={36} className="gh-prompt-icon" />
        {children}
      </div>
    </div>
  );
}

function ConnectButton({ label, scope }: { label: string; scope: GithubScope }) {
  const connecting = useGithub((s) => s.connecting);
  return (
    <button className="btn primary" disabled={connecting} onClick={() => connectGithub(scope)}>
      {connecting ? 'Connecting…' : label}
    </button>
  );
}

/** The panel's "waiting for you" line from GitHub's search, when it knows. */
function Outstanding({ tab, counts, includesPrivate }: { tab: GithubBucket; counts: GithubCounts; includesPrivate: boolean }) {
  const where = includesPrivate ? '' : ' in public repos';
  if (tab === 'reviews' && counts.reviewRequests) {
    const n = counts.reviewRequests;
    return (
      <a className="gh-outstanding" href="https://github.com/pulls/review-requested" {...EXTERNAL}>
        {n === 1 ? '1 pull request is' : `${n} pull requests are`} waiting for your review{where}
      </a>
    );
  }
  if (tab === 'mentions' && counts.assigned) {
    const n = counts.assigned;
    return (
      <a className="gh-outstanding" href={ASSIGNED_URL} {...EXTERNAL}>
        {n === 1 ? '1 open issue or pull request' : `${n} open issues and pull requests`} assigned to you{where}
      </a>
    );
  }
  return null;
}

/** Under the list: it has only unread notifications (GitHub's newest 100), and the rest are on GitHub. */
function Foot({ more }: { more: boolean }) {
  return (
    <p className="gh-foot">
      {more ? 'Showing your newest 100 unread notifications.' : 'Read notifications leave this list.'}{' '}
      <a href="https://github.com/notifications" {...EXTERNAL}>
        See all on GitHub
      </a>
    </p>
  );
}

/**
 * Done takes the item away: from the keyboard (a click with no mouse press, detail 0), the focus goes to
 * the next one, else the one before, else the open tab.
 */
function focusNear(e: MouseEvent<HTMLButtonElement>): void {
  if (e.detail !== 0) return;
  const li = e.currentTarget.closest('li');
  const near = li?.nextElementSibling ?? li?.previousElementSibling;
  const target = near?.querySelector<HTMLElement>('.gh-link') ?? li?.closest('.gh-inbox')?.querySelector<HTMLElement>('.gh-tabs .active');
  target?.focus();
}

function Item({ item, now }: { item: GithubItem; now: number }) {
  const updated = new Date(item.updatedAt);
  const doneRef = useRef<HTMLButtonElement>(null);
  return (
    <li className={`gh-item${item.unread ? ' unread' : ''}`}>
      <a className="gh-link" href={webUrl(item.url)} {...EXTERNAL} onClick={() => markRead(item.id)} onAuxClick={(e) => e.button === 1 && markRead(item.id)}>
        <ItemIcon item={item} />
        <span className="gh-text">
          <span className="gh-repo">
            {item.unread && <span className="gh-dot" title="Unread" />}
            <span className="gh-repo-name" title={item.repo}>
              {item.repo}
            </span>
          </span>
          <span className="gh-title">{item.title}</span>
          <span className="gh-meta">
            {item.run ? <span className={`gh-status ${item.run.status}`}>{RUN_STATUS[item.run.status]}</span> : <span>{reasonText(item.reason)}</span>}
            {item.run?.branch && <span className="gh-branch">{item.run.branch}</span>}
            <time dateTime={updated.toISOString()} title={updated.toLocaleString()}>
              {relativeTime(item.updatedAt, now)}
            </time>
          </span>
        </span>
      </a>
      <div className="gh-actions">
        {item.unread && (
          <button
            className="icon-btn"
            title="Mark read"
            aria-label={`Mark read: ${item.title}`}
            onClick={(e) => {
              // The button goes away: from the keyboard, Done takes its place (not after a mouse click,
              // which would leave the focus on a hidden Done that Space would press).
              if (e.detail === 0) doneRef.current?.focus();
              markRead(item.id);
            }}
          >
            <MarkReadIcon size={16} />
          </button>
        )}
        <button
          ref={doneRef}
          className="icon-btn"
          title="Done"
          aria-label={`Done: ${item.title}`}
          onClick={(e) => {
            focusNear(e);
            markDone(item.id);
          }}
        >
          <CheckIcon size={16} />
        </button>
      </div>
    </li>
  );
}

function Inbox({ status }: { status: GithubStatus }) {
  const items = useGithub((s) => s.items);
  const counts = useGithub((s) => s.counts);
  const more = useGithub((s) => s.more);
  const loaded = useGithub((s) => s.loaded);
  const problem = useGithub((s) => s.problem);
  const tab = useGithub((s) => s.tab);
  useTick(60_000);
  const all = useMemo(() => Object.values(items).sort((a, b) => b.updatedAt - a.updatedAt), [items]);
  const list = all.filter((i) => i.bucket === tab);
  const now = Date.now();
  const empty = TABS.find((t) => t.id === tab)?.empty;

  return (
    <div className="panel-body gh-inbox">
      <div className="gh-tabs" role="group" aria-label="Notifications">
        {TABS.map(({ id, label }) => {
          const unread = all.filter((i) => i.bucket === id && i.unread).length;
          return (
            <button
              key={id}
              className={`tab${tab === id ? ' active' : ''}`}
              aria-pressed={tab === id}
              aria-label={unread ? `${label}, ${unread} unread` : undefined}
              onClick={() => useGithub.setState({ tab: id })}
            >
              {label}
              {unread > 0 && (
                <span className="gh-count" aria-hidden>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="gh-bar">
        <span className="gh-who" title={`Connected to GitHub as @${status.login ?? ''}`}>
          <GithubIcon size={15} />
          <span className="gh-who-name">@{status.login}</span>
        </span>
        <button className="btn small ghost" disabled={!all.some((i) => i.unread)} onClick={markAllRead} title="Mark all your GitHub notifications read">
          <CheckAllIcon size={16} />
          Mark all read
        </button>
      </div>
      <div className="gh-scroll">
        <Outstanding tab={tab} counts={counts} includesPrivate={status.private} />
        {list.length > 0 ? (
          <ul className="gh-list">
            {list.map((item) => (
              <Item key={item.id} item={item} now={now} />
            ))}
          </ul>
        ) : problem ? (
          <div className="gh-empty">
            <p className="muted">{PROBLEMS[problem]}</p>
            {problem === 'forbidden' && <ConnectButton label="Reconnect GitHub" scope={status.private ? 'private' : 'basic'} />}
          </div>
        ) : !loaded && !all.length ? (
          <p className="muted center pad">Loading your notifications…</p>
        ) : (
          <div className="gh-empty">
            <p className="muted">{empty}</p>
            <details className="gh-help" open={!all.length}>
              <summary>Missing something?</summary>
              <SetupHints clientId={status.clientId} />
            </details>
          </div>
        )}
        {loaded && (list.length > 0 || more) && <Foot more={more} />}
      </div>
    </div>
  );
}

/** The GitHub side panel: your notifications, or what to do to see them. */
export function GithubPanel() {
  const availability = useGithub((s) => s.availability);
  const status = useGithub((s) => s.status);
  const joinedAs = useGithub((s) => s.joinedAs);
  const accountId = useStore((s) => s.account?.id ?? null);

  if (availability === 'guest') {
    return (
      <Prompt className="gh-guest">
        <SignInToConnect />
      </Prompt>
    );
  }
  if (!status) {
    return (
      <div className="panel-body">
        <p className="muted center pad">Loading…</p>
      </div>
    );
  }
  if (!status.connected) {
    return (
      <Prompt>
        <p>
          <strong>Your GitHub inbox, in the office</strong>
        </p>
        <p className="muted small">See mentions, review requests and Actions runs while you work. Workchop only asks for your notifications.</p>
        <ConnectButton label="Connect GitHub" scope="basic" />
      </Prompt>
    );
  }
  if (status.needsReconnect) {
    return (
      <Prompt>
        <p>
          <strong>Reconnect GitHub</strong>
        </p>
        <p className="muted small">GitHub no longer accepts Workchop’s access{status.login ? ` for @${status.login}` : ''}. Connect again to see your notifications.</p>
        <ConnectButton label="Reconnect GitHub" scope={status.private ? 'private' : 'basic'} />
      </Prompt>
    );
  }
  if (joinedAs !== undefined && joinedAs !== accountId) {
    return (
      <Prompt>
        <p>
          <strong>Rejoin to see your inbox</strong>
        </p>
        <p className="muted small">You signed in after joining this office. Come in again to see your GitHub notifications here.</p>
        <button className="btn primary" onClick={rejoin}>
          Rejoin
        </button>
      </Prompt>
    );
  }
  return <Inbox status={status} />;
}
