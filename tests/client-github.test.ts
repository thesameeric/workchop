import { describe, expect, it } from 'vitest';
import type { GithubItem } from '../shared/github';
import { failedRunText } from '../client/src/features/github/format';
import { failureWatch } from '../client/src/features/github/state';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 12);

function run(id: string, updatedAt: number, status: 'failure' | 'success' = 'failure', unread = true): GithubItem {
  return {
    id,
    bucket: 'actions',
    reason: 'ci_activity',
    subjectType: 'CheckSuite',
    title: `CI workflow run ${status === 'failure' ? 'failed' : 'succeeded'} for main branch`,
    repo: 'octo/hello',
    url: 'https://github.com/octo/hello/actions',
    updatedAt,
    unread,
    run: { status, workflow: 'CI', branch: 'main' },
  };
}

describe('the failed-run toast (client)', () => {
  it('is for new failed runs, not for those already in the inbox', () => {
    const watch = failureWatch();
    watch.inbox([run('1', NOW - 60_000), run('2', NOW - DAY, 'success')]);
    expect(watch.isNew(run('3', NOW))).toBe(true);
    expect(watch.isNew(run('4', NOW + 1000, 'success'))).toBe(false);
    expect(watch.isNew(run('5', NOW + 2000, 'failure', false))).toBe(false);
  });

  it('is for every failure that arrives together, whatever their order', () => {
    const watch = failureWatch();
    watch.inbox([run('1', NOW - 60_000)]);
    expect(watch.isNew(run('2', NOW))).toBe(true);
    expect(watch.isNew(run('3', NOW - 20_000))).toBe(true);
  });

  it('is for a newer run on a thread it already had', () => {
    const watch = failureWatch();
    watch.inbox([run('1', NOW - 60_000)]);
    expect(watch.isNew(run('1', NOW - 60_000))).toBe(false);
    expect(watch.isNew(run('1', NOW))).toBe(true);
  });

  it('is not for an old thread coming back into the newest 100 (after a Done)', () => {
    const watch = failureWatch();
    watch.inbox([run('1', NOW - 60_000), run('2', NOW - DAY)]);
    expect(watch.isNew(run('old', NOW - 30 * DAY))).toBe(false);
    // Nor for one that arrived as new, left the window and came back.
    expect(watch.isNew(run('3', NOW))).toBe(true);
    expect(watch.isNew(run('3', NOW))).toBe(false);
  });

  it('starting from an empty inbox, takes every failure as new', () => {
    const watch = failureWatch();
    watch.inbox([]);
    expect(watch.isNew(run('1', NOW - DAY))).toBe(true);
  });

  it('names the workflow and branch, or the title without a workflow', () => {
    expect(failedRunText(run('1', NOW))).toBe('CI failed on main');
    const item = run('2', NOW);
    item.run = { status: 'failure' };
    expect(failedRunText(item)).toBe('CI workflow run failed for main branch');
    item.run = { status: 'failure', workflow: 'Deploy' };
    expect(failedRunText(item)).toBe('Deploy failed');
  });
});
