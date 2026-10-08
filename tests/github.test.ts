import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rateLimitedUntil } from '../server/features/github/api';
import { bucketOf, fallbackUrl, parseCheckSuite, parseWorkflowRun, toItem, webUrl, type Thread } from '../server/features/github/classify';
import { decryptToken, encryptToken, parseTokenKey } from '../server/features/github/crypto';
import { normalizeScopes } from '../server/features/github/links';

const key = crypto.randomBytes(32);
const bases = { apiBase: 'https://api.github.com', webBase: 'https://github.com' };

describe('token encryption', () => {
  it('round-trips with a fresh IV each time', () => {
    const a = encryptToken(key, 'u1', 'access', 'gho_secret');
    const b = encryptToken(key, 'u1', 'access', 'gho_secret');
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('gho_secret');
    expect(decryptToken(key, 'u1', 'access', a)).toBe('gho_secret');
    expect(decryptToken(key, 'u1', 'access', b)).toBe('gho_secret');
  });

  it('refuses changed values, other users, other fields and other keys', () => {
    const stored = encryptToken(key, 'u1', 'refresh', 'ghr_secret');
    const [v, iv, ct, tag] = stored.split('.');
    /** Flips one bit of a base64url part. */
    const flip = (part: string) => {
      const bytes = Buffer.from(part, 'base64url');
      bytes[0] ^= 1;
      return bytes.toString('base64url');
    };
    for (const changed of [
      [v, flip(iv), ct, tag],
      [v, iv, flip(ct), tag],
      [v, iv, ct, flip(tag)],
      [v, iv, ct, tag.slice(0, 16)],
      ['v2', iv, ct, tag],
      [v, iv, ct],
    ]) {
      expect(() => decryptToken(key, 'u1', 'refresh', changed.join('.'))).toThrow();
    }
    expect(() => decryptToken(key, 'u2', 'refresh', stored)).toThrow();
    expect(() => decryptToken(key, 'u1', 'access', stored)).toThrow();
    expect(() => decryptToken(crypto.randomBytes(32), 'u1', 'refresh', stored)).toThrow();
    expect(() => decryptToken(key, 'u1', 'refresh', 'gho_plaintext')).toThrow();
  });

  it('takes exactly 32 bytes of base64 as the key', () => {
    const raw = crypto.randomBytes(32);
    expect(parseTokenKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(parseTokenKey(` ${raw.toString('base64')}\n`)?.equals(raw)).toBe(true);
    expect(parseTokenKey(raw.toString('base64url'))?.equals(raw)).toBe(true);
    for (const bad of [undefined, null, '', 'secret', crypto.randomBytes(31).toString('base64'), crypto.randomBytes(33).toString('base64'), raw.toString('hex')]) {
      expect(parseTokenKey(bad)).toBeNull();
    }
  });
});

describe('classifying notifications', () => {
  it('buckets by reason', () => {
    expect(['mention', 'team_mention', 'assign'].map(bucketOf)).toEqual(['mentions', 'mentions', 'mentions']);
    expect(bucketOf('review_requested')).toBe('reviews');
    expect(['ci_activity', 'approval_requested'].map(bucketOf)).toEqual(['actions', 'actions']);
    for (const reason of ['comment', 'author', 'state_change', 'manual', 'subscribed', 'security_alert', 'invitation', 'member_feature_requested', 'something_new']) {
      expect(bucketOf(reason)).toBe('activity');
    }
  });

  it('reads Actions runs from CheckSuite titles', () => {
    expect(parseCheckSuite('CI workflow run succeeded for main branch')).toEqual({ status: 'success', workflow: 'CI', branch: 'main' });
    expect(parseCheckSuite('CI workflow run failed for main branch')?.status).toBe('failure');
    expect(parseCheckSuite('CI workflow run failed at startup for main branch')?.status).toBe('failure');
    expect(parseCheckSuite('CI workflow run cancelled for main branch')?.status).toBe('cancelled');
    expect(parseCheckSuite('CI workflow run skipped for main branch')?.status).toBe('skipped');
    expect(parseCheckSuite('Build & Test workflow run, Attempt #3 failed for feature/login page branch')).toEqual({
      status: 'failure',
      workflow: 'Build & Test',
      branch: 'feature/login page',
    });
    for (const title of ['CI workflow run timed out for main branch', 'CI run failed for main branch', 'Something else entirely', '']) {
      expect(parseCheckSuite(title)).toBeNull();
    }
  });

  it('reads deployment approvals from WorkflowRun titles, which name no workflow', () => {
    expect(parseWorkflowRun('some-user requested your review to deploy to an environment')).toEqual({ status: 'waiting' });
    for (const title of ['some-user requested your unknown-state to deploy to an environment', 'Deployment review pending', '']) {
      expect(parseWorkflowRun(title)).toBeNull();
    }
  });

  const thread = (subject: Partial<NonNullable<Thread['subject']>>, extra: Partial<Thread> = {}): Thread => ({
    id: '123',
    unread: true,
    reason: 'mention',
    updated_at: '2026-10-07T12:00:00Z',
    subject: { title: 'Fix it', url: null, latest_comment_url: null, type: 'PullRequest', ...subject },
    repository: { full_name: 'octo/hello', html_url: 'https://github.com/octo/hello' },
    ...extra,
  });

  it('links to pages, rewriting API addresses only as a guarded fallback', () => {
    const url = (subject: Partial<NonNullable<Thread['subject']>>, extra?: Partial<Thread>, b = bases) => fallbackUrl(thread(subject, extra), b);
    expect(url({ url: 'https://api.github.com/repos/octo/hello/pulls/42' })).toBe('https://github.com/octo/hello/pull/42');
    expect(url({ url: 'https://api.github.com/repos/octo/hello.js/issues/7', type: 'Issue' })).toBe('https://github.com/octo/hello.js/issues/7');
    expect(url({ type: 'CheckSuite', title: 'CI workflow run failed for main branch' })).toBe(
      'https://github.com/octo/hello/actions?query=workflow%3A%22CI%22+is%3Afailure+branch%3Amain',
    );
    expect(url({ type: 'CheckSuite', title: 'Some check' })).toBe('https://github.com/octo/hello/actions');
    expect(url({ type: 'WorkflowRun', title: 'x requested your review to deploy to an environment' })).toBe('https://github.com/octo/hello/actions');
    // Enterprise Managed Users' logins have an underscore.
    expect(url({ url: 'https://api.github.com/repos/mona_acme/dotfiles/pulls/3' }, { repository: { full_name: 'mona_acme/dotfiles', html_url: 'https://github.com/mona_acme/dotfiles' } })).toBe(
      'https://github.com/mona_acme/dotfiles/pull/3',
    );
    expect(url({ type: 'Discussion' })).toBe('https://github.com/octo/hello/discussions');
    // Anything else, or anything unexpected, goes to the repository.
    for (const subject of [
      { type: 'Release', url: 'https://api.github.com/repos/octo/hello/releases/9' },
      { url: null },
      { url: 'https://evil.example/repos/octo/hello/pulls/1' },
      { url: 'https://api.github.com.evil.example/repos/octo/hello/pulls/1' },
      { url: 'https://api.github.com/repos/octo/../pulls/1' },
      { url: 'https://api.github.com/repos/octo/hello/pulls/1/files' },
      { url: 'https://api.github.com/repos/-octo/hello/pulls/1' },
      { url: 'https://api.github.com/repos/_octo/hello/pulls/1' },
    ]) {
      expect(url(subject)).toBe('https://github.com/octo/hello');
    }
    // Only pages on GitHub: otherwise GitHub itself.
    for (const html_url of ['https://evil.example/octo/hello', 'javascript:alert(1)', 'http://github.com/octo/hello', 'https://user:pw@github.com/octo/hello', null]) {
      expect(url({ type: 'Discussion' }, { repository: { full_name: 'octo/hello', html_url } })).toBe('https://github.com');
    }
    // GitHub Enterprise: the API is under /api/v3.
    const ghes = { apiBase: 'https://git.example.com/api/v3', webBase: 'https://git.example.com' };
    expect(
      url({ url: 'https://git.example.com/api/v3/repos/team/app/pulls/5' }, { repository: { full_name: 'team/app', html_url: 'https://git.example.com/team/app' } }, ghes),
    ).toBe('https://git.example.com/team/app/pull/5');
    expect(webUrl('https://github.com/octo/hello/pull/1#issuecomment-1', 'https://github.com')).toBe('https://github.com/octo/hello/pull/1#issuecomment-1');
    expect(webUrl('https://github.com', 'https://github.com')).toBe('https://github.com/');
    expect(webUrl('https://github.community/x', 'https://github.com')).toBeNull();
  });

  it('turns threads into items', () => {
    expect(toItem(thread({ url: 'https://api.github.com/repos/octo/hello/pulls/42', title: 'Fix\u0000 the\nbug' }), bases)).toEqual({
      id: '123',
      bucket: 'mentions',
      reason: 'mention',
      subjectType: 'PullRequest',
      title: 'Fix  the bug',
      repo: 'octo/hello',
      url: 'https://github.com/octo/hello/pull/42',
      updatedAt: Date.parse('2026-10-07T12:00:00Z'),
      unread: true,
    });
    expect(toItem(thread({ type: 'CheckSuite', title: 'CI workflow run, Attempt #2 cancelled for dev branch' }, { reason: 'ci_activity', unread: false }), bases)).toMatchObject({
      bucket: 'actions',
      unread: false,
      run: { status: 'cancelled', workflow: 'CI', branch: 'dev' },
    });
    expect(toItem(thread({ type: 'CheckSuite', title: 'Odd title' }, { reason: 'ci_activity' }), bases)?.run).toBeUndefined();
    expect(toItem(thread({ type: 'WorkflowRun', title: 'a requested your review to deploy to an environment' }, { reason: 'approval_requested' }), bases)?.run).toEqual({
      status: 'waiting',
    });
    expect(toItem(thread({ type: 'WorkflowRun', title: 'Something else' }, { reason: 'approval_requested' }), bases)?.run).toBeUndefined();
    expect(toItem(thread({}, { id: 99 }), bases)?.id).toBe('99');
    expect(toItem(thread({}, { reason: 'review_requested', subject: null, repository: null }), bases)).toMatchObject({ bucket: 'reviews', title: '', repo: '', url: 'https://github.com' });
    for (const bad of [{ id: 'abc' }, { id: '1'.repeat(21) }, { id: null }, { updated_at: 'yesterday' }, { updated_at: undefined }]) {
      expect(toItem(thread({}, bad), bases)).toBeNull();
    }
    expect(toItem(thread({ title: 'x'.repeat(1000) }), bases)?.title).toHaveLength(300);
  });
});

describe('GitHub answers', () => {
  const at = Date.parse('2026-10-08T10:00:00Z');
  const res = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

  it('tells rate limits from other refusals', () => {
    expect(rateLimitedUntil(res(200), at)).toBeNull();
    expect(rateLimitedUntil(res(403), at)).toBeNull();
    expect(rateLimitedUntil(res(403, { 'retry-after': '120' }), at)).toBe(at + 120_000);
    expect(rateLimitedUntil(res(429, { 'retry-after': '30' }), at)).toBe(at + 30_000);
    expect(rateLimitedUntil(res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(at / 1000 + 600) }), at)).toBe(at + 600_000);
    expect(rateLimitedUntil(res(403, { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': String(at / 1000 + 600) }), at)).toBeNull();
    expect(rateLimitedUntil(res(429), at)).toBe(at + 60_000);
    // Never sooner than a second, never longer than an hour.
    expect(rateLimitedUntil(res(403, { 'retry-after': '0' }), at)).toBe(at + 1000);
    expect(rateLimitedUntil(res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(at / 1000 - 5) }), at)).toBe(at + 1000);
    expect(rateLimitedUntil(res(403, { 'retry-after': '999999' }), at)).toBe(at + 3600_000);
  });

  it('keeps scopes in one form', () => {
    expect(normalizeScopes('repo, notifications')).toBe('notifications,repo');
    expect(normalizeScopes('notifications,repo,notifications')).toBe('notifications,repo');
    expect(normalizeScopes('')).toBe('');
  });
});
