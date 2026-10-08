import crypto from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

// A stand-in for github.com (OAuth web flow) and its REST API (under /api), for tests and for trying
// the integration and GitHub sign-in in a browser without a real OAuth App:
//
//   npx tsx tests/helpers/github.ts        (PORT=3999 by default; it prints the settings to use)

export interface MockThread {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  last_read_at: string | null;
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string };
  repository: { full_name: string; html_url: string };
  url: string;
}

export interface MockEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export interface MockUser {
  id: number;
  login: string;
  name: string | null;
  /** The public profile email (GET /user), usually null. */
  email: string | null;
  /** GET /user/emails, with the user:email scope. */
  emails: MockEmail[];
}

interface Token {
  userId: number;
  scope: string;
  expiresAt: number | null;
}

export interface ThreadSpec {
  id?: string;
  reason?: string;
  type?: string;
  title?: string;
  repo?: string;
  number?: number;
  unread?: boolean;
  /** ms since 1970; default: now. */
  updated?: number;
  /** Set to put a null subject.url (Discussions, CheckSuites…). */
  noUrl?: boolean;
}

/** What /notifications answers instead of the list, for the next `times` requests. */
export interface Failure {
  status: number;
  headers?: Record<string, string>;
  /** The answer's message (default: "Mock failure"). */
  message?: string;
  times?: number;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const html = (res: ServerResponse, body: string) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Mock GitHub</title><body style="font:15px system-ui;margin:2rem;max-width:40rem">${body}`);
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const random = (prefix: string) => `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;

export class MockGithub {
  readonly clientId = 'mock-client-id';
  readonly clientSecret = 'mock-client-secret';
  /** github.com's stand-in (OAuth pages and web links). */
  base = '';
  /** api.github.com's stand-in. */
  apiBase = '';
  /** Show an Authorize/Cancel page instead of approving at once (for trying it in a browser). */
  interactive = false;
  readonly users = new Map<number, MockUser>();
  /** Who approves the next authorization (default: the first user). */
  authorizeAs: number | null = null;
  /** Send this error back from the next authorization instead of a code (e.g. access_denied). */
  authorizeError: string | null = null;
  /** Answer the next token request with { error }. */
  tokenError: string | null = null;
  /** Answer GET /user/emails with this status instead (e.g. 403, a secondary rate limit). */
  emailsStatus: number | null = null;
  /** Issue expiring tokens with refresh tokens (GitHub's default), in seconds. */
  accessTtl: number | null = 8 * 3600;
  refreshTtl: number | null = 183 * 24 * 3600;
  /** How long a refresh takes (ms), to test refreshes racing. */
  refreshDelay = 0;
  refreshes = 0;
  /** X-Poll-Interval in seconds; null leaves the header out. */
  pollInterval: number | null = 60;
  failure: Failure | null = null;
  revokeFails = false;
  readonly revoked: string[] = [];
  /** Every request: method, path with query, headers, body. */
  readonly requests: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[] = [];
  /** Answers of GET /search/issues per user. */
  readonly counts = new Map<number, { reviewRequests: number; assigned: number }>();
  /** API resources (subject.url → html_url), answered with ETags. */
  readonly pages = new Map<string, string>();
  /** Paths (without the query, e.g. '/api/repos/o/r/pulls/1') answered with a redirect instead. */
  readonly redirects = new Map<string, { status: number; location: string }>();
  private readonly codes = new Map<string, { userId: number; scope: string; challenge: string; redirectUri: string; expiresAt: number }>();
  private readonly tokens = new Map<string, Token>();
  private readonly refreshTokens = new Map<string, Token & { access: string }>();
  private readonly threads = new Map<number, MockThread[]>();
  private readonly modified = new Map<number, number>();
  private nextThread = 1000;
  private server = createServer((req, res) => {
    this.handle(req, res).catch((err) => {
      console.error('[mock github]', err);
      if (!res.headersSent) json(res, 500, { message: 'Mock failure' });
    });
  });

  async start(port = 0, host = '127.0.0.1'): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(port, host, resolve));
    const { port: actual } = this.server.address() as AddressInfo;
    this.base = `http://${host === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:${actual}`;
    this.apiBase = `${this.base}/api`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  addUser(id: number, login: string, more: Partial<Pick<MockUser, 'name' | 'email' | 'emails'>> = {}) {
    this.users.set(id, { id, login, name: null, email: null, emails: [], ...more });
    return this;
  }

  /** Tokens as the token endpoint would issue them, without the browser flow. */
  issue(userId: number, scope = 'notifications') {
    const access = random('gho');
    const now = Date.now();
    this.tokens.set(access, { userId, scope, expiresAt: this.accessTtl === null ? null : now + this.accessTtl * 1000 });
    const body: Record<string, unknown> = { access_token: access, token_type: 'bearer', scope };
    if (this.accessTtl !== null) {
      const refresh = random('ghr');
      this.refreshTokens.set(refresh, { userId, scope, access, expiresAt: this.refreshTtl === null ? null : now + this.refreshTtl * 1000 });
      Object.assign(body, { expires_in: this.accessTtl, refresh_token: refresh, refresh_token_expires_in: this.refreshTtl });
    }
    return body as { access_token: string; scope: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number };
  }

  /** Whether GitHub would accept this access token now. */
  valid(token: string): boolean {
    const t = this.tokens.get(token);
    return !!t && (t.expiresAt === null || t.expiresAt > Date.now());
  }

  /** Makes an access token expire (GitHub then answers 401). */
  expire(token: string) {
    const t = this.tokens.get(token);
    if (t) t.expiresAt = Date.now() - 1000;
  }

  /** Drops every token of a GitHub user, as when they revoke the app on GitHub. */
  forget(userId: number) {
    for (const [token, t] of this.tokens) if (t.userId === userId) this.tokens.delete(token);
    for (const [token, t] of this.refreshTokens) if (t.userId === userId) this.refreshTokens.delete(token);
  }

  scopeOf(token: string): string | undefined {
    return this.tokens.get(token)?.scope;
  }

  /** A notification thread for `userId`, newest first in the list. */
  addThread(userId: number, spec: ThreadSpec = {}): MockThread {
    const repo = spec.repo ?? 'octo/hello';
    const type = spec.type ?? 'PullRequest';
    const number = spec.number ?? this.nextThread % 1000;
    const kind = type === 'Issue' ? 'issues' : type === 'PullRequest' ? 'pulls' : null;
    const url = !spec.noUrl && kind ? `${this.apiBase}/repos/${repo}/${kind}/${number}` : null;
    const thread: MockThread = {
      id: spec.id ?? String(this.nextThread++),
      unread: spec.unread ?? true,
      reason: spec.reason ?? 'mention',
      updated_at: new Date(spec.updated ?? Date.now()).toISOString(),
      last_read_at: null,
      subject: { title: spec.title ?? `Thread about ${repo}`, url, latest_comment_url: url, type },
      repository: { full_name: repo, html_url: `${this.base}/${repo}` },
      url: '',
    };
    thread.url = `${this.apiBase}/notifications/threads/${thread.id}`;
    const list = this.threads.get(userId) ?? [];
    this.threads.set(userId, [thread, ...list.filter((t) => t.id !== thread.id)]);
    this.touch(userId);
    return thread;
  }

  threadsOf(userId: number): MockThread[] {
    return this.threads.get(userId) ?? [];
  }

  /** Changes a thread (new activity: it moves to the top and is unread again). */
  updateThread(userId: number, id: string, patch: Partial<Pick<MockThread, 'unread' | 'reason'>> & { title?: string; updated?: number } = {}) {
    const list = this.threadsOf(userId);
    const thread = list.find((t) => t.id === id);
    if (!thread) throw new Error(`no thread ${id}`);
    thread.updated_at = new Date(patch.updated ?? Math.max(Date.now(), Date.parse(thread.updated_at) + 1000)).toISOString();
    thread.unread = patch.unread ?? true;
    if (patch.reason) thread.reason = patch.reason;
    if (patch.title) thread.subject.title = patch.title;
    this.threads.set(userId, [thread, ...list.filter((t) => t !== thread)]);
    this.touch(userId);
  }

  removeThread(userId: number, id: string) {
    this.threads.set(userId, this.threadsOf(userId).filter((t) => t.id !== id));
    this.touch(userId);
  }

  /** The list changed: a new Last-Modified (always later, even within the same second). */
  touch(userId: number) {
    this.modified.set(userId, Math.max(Math.floor(Date.now() / 1000) * 1000, (this.modified.get(userId) ?? 0) + 1000));
  }

  lastModified(userId: number): string {
    if (!this.modified.has(userId)) this.touch(userId);
    return new Date(this.modified.get(userId)!).toUTCString();
  }

  /** Requests to a path (without the query), e.g. '/api/notifications'. */
  calls(path: string, method = 'GET') {
    return this.requests.filter((r) => r.method === method && r.path.split('?')[0] === path);
  }

  private bearer(req: IncomingMessage): (Token & { token: string }) | null {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return m && this.valid(m[1]) ? { ...this.tokens.get(m[1])!, token: m[1] } : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', this.base);
    const method = req.method ?? 'GET';
    this.requests.push({ method, path: url.pathname + url.search, headers: req.headers, body });
    const redirect = this.redirects.get(url.pathname);
    if (redirect) {
      res.writeHead(redirect.status, { Location: redirect.location }).end();
      return;
    }

    if (url.pathname === '/login/oauth/authorize' && method === 'GET') return this.authorize(url, res);
    if (url.pathname === '/login/oauth/access_token' && method === 'POST') return this.token(req, body, res);
    if (url.pathname.startsWith('/_mock')) return this.control(url, method, res);
    if (!url.pathname.startsWith('/api/')) {
      // A github.com page (where item links go).
      return html(res, `<h1>Mock GitHub</h1><p>This would be <code>${esc(url.pathname + url.search)}</code> on GitHub.</p>`);
    }
    const path = url.pathname.slice('/api'.length);

    const revoke = /^\/applications\/([^/]+)\/token$/.exec(path);
    if (revoke && method === 'DELETE') {
      const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
      if (req.headers.authorization !== expected || decodeURIComponent(revoke[1]) !== this.clientId) return json(res, 401, { message: 'Bad credentials' });
      if (this.revokeFails) return json(res, 500, { message: 'Mock failure' });
      const token = (JSON.parse(body || '{}') as { access_token?: string }).access_token ?? '';
      // An expired token is as unknown as one that never was.
      const known = this.valid(token);
      this.tokens.delete(token);
      if (!known) return json(res, 404, { message: 'Not Found' });
      this.revoked.push(token);
      res.writeHead(204).end();
      return;
    }

    const auth = this.bearer(req);
    if (!auth) return json(res, 401, { message: 'Bad credentials' });
    const granted = auth.scope.split(/[\s,]+/);
    const scopes = { 'X-OAuth-Scopes': granted.join(', ') };
    const user = this.users.get(auth.userId)!;
    const threads = this.threadsOf(auth.userId);

    if (path === '/user' && method === 'GET') {
      const { id, login, name, email } = user;
      return json(res, 200, { id, login, name, email, avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` }, scopes);
    }
    if (path === '/user/emails' && method === 'GET') {
      if (!granted.includes('user:email') && !granted.includes('user')) return json(res, 404, { message: 'Not Found' }, scopes);
      if (this.emailsStatus) return json(res, this.emailsStatus, { message: 'Mock failure' }, scopes);
      return json(res, 200, user.emails, scopes);
    }
    if (path === '/notifications' && method === 'GET') {
      const headers: Record<string, string> = { ...scopes, ...(this.pollInterval !== null && { 'X-Poll-Interval': String(this.pollInterval) }) };
      if (this.failure) {
        const { status, headers: extra, message = 'Mock failure', times = 1 } = this.failure;
        if (times <= 1) this.failure = null;
        else this.failure.times = times - 1;
        return json(res, status, { message }, { ...headers, ...extra });
      }
      const lastModified = this.lastModified(auth.userId);
      if (req.headers['if-modified-since'] === lastModified) {
        res.writeHead(304, headers).end();
        return;
      }
      const all = url.searchParams.get('all') === 'true';
      const perPage = Math.min(50, Number(url.searchParams.get('per_page') ?? 50));
      const page = Number(url.searchParams.get('page') ?? 1);
      const list = threads.filter((t) => all || t.unread).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      const pageItems = list.slice((page - 1) * perPage, page * perPage);
      if (page * perPage < list.length) {
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        Object.assign(headers, { Link: `<${this.apiBase}/notifications${next.search}>; rel="next"` });
      }
      return json(res, 200, pageItems, { ...headers, 'Last-Modified': lastModified });
    }
    if (path === '/notifications' && method === 'PUT') {
      const at = Date.parse((JSON.parse(body || '{}') as { last_read_at?: string }).last_read_at ?? '') || Date.now();
      for (const t of threads) if (Date.parse(t.updated_at) <= at) t.unread = false;
      this.touch(auth.userId);
      res.writeHead(205, scopes).end();
      return;
    }
    const thread = /^\/notifications\/threads\/(\d+)$/.exec(path);
    if (thread) {
      const found = threads.find((t) => t.id === thread[1]);
      if (!found) return json(res, 404, { message: 'Not Found' }, scopes);
      if (method === 'PATCH') {
        found.unread = false;
        found.last_read_at = new Date().toISOString();
        this.touch(auth.userId);
        res.writeHead(205, scopes).end();
        return;
      }
      if (method === 'DELETE') {
        this.removeThread(auth.userId, found.id);
        res.writeHead(204, scopes).end();
        return;
      }
    }
    if (path === '/search/issues' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const counts = this.counts.get(auth.userId) ?? { reviewRequests: 0, assigned: 0 };
      const total = q.includes('review-requested:@me') ? counts.reviewRequests : q.includes('assignee:@me') ? counts.assigned : 0;
      return json(res, 200, { total_count: total, incomplete_results: false, items: [] }, scopes);
    }
    const page = this.pages.get(`${this.apiBase}${path}`);
    if (page && method === 'GET') {
      const etag = `"${crypto.createHash('sha256').update(page).digest('hex').slice(0, 16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ...scopes, ETag: etag }).end();
        return;
      }
      return json(res, 200, { html_url: page }, { ...scopes, ETag: etag });
    }
    json(res, 404, { message: 'Not Found' }, scopes);
  }

  private authorize(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    const redirectUri = q.get('redirect_uri') ?? '';
    if (q.get('client_id') !== this.clientId || !redirectUri) return html(res, '<p>Unknown OAuth App.</p>');
    const back = new URL(redirectUri);
    back.searchParams.set('state', q.get('state') ?? '');
    const decision = q.get('decision');
    if (this.interactive && !decision) {
      const choose = (value: string) => {
        const u = new URL(url);
        u.searchParams.set('decision', value);
        return esc(u.pathname + u.search);
      };
      const users = [...this.users.values()].map((u) => `<a href="${choose(String(u.id))}">Authorize as @${esc(u.login)}</a>`).join(' · ');
      return html(res, `<h1>Authorize Workchop?</h1><p>Scopes: <code>${esc(q.get('scope') ?? '')}</code></p><p>${users} · <a href="${choose('deny')}">Cancel</a></p>`);
    }
    const error = decision === 'deny' ? 'access_denied' : this.authorizeError;
    this.authorizeError = null;
    if (error) {
      back.searchParams.set('error', error);
      back.searchParams.set('error_description', 'The user has denied your application access.');
    } else {
      const userId = decision && /^\d+$/.test(decision) ? Number(decision) : (this.authorizeAs ?? [...this.users.keys()][0]);
      const code = crypto.randomBytes(10).toString('hex');
      this.codes.set(code, { userId, scope: q.get('scope') ?? '', challenge: q.get('code_challenge') ?? '', redirectUri, expiresAt: Date.now() + 600_000 });
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { Location: back.href }).end();
  }

  private async token(req: IncomingMessage, body: string, res: ServerResponse) {
    const p = req.headers['content-type']?.includes('json') ? new URLSearchParams(JSON.parse(body) as Record<string, string>) : new URLSearchParams(body);
    const fail = (error: string) => json(res, 200, { error, error_description: error });
    if (this.tokenError) {
      const error = this.tokenError;
      this.tokenError = null;
      return fail(error);
    }
    if (p.get('client_id') !== this.clientId || p.get('client_secret') !== this.clientSecret) return fail('incorrect_client_credentials');
    if (p.get('grant_type') === 'refresh_token') {
      this.refreshes++;
      if (this.refreshDelay) await new Promise((r) => setTimeout(r, this.refreshDelay));
      const old = this.refreshTokens.get(p.get('refresh_token') ?? '');
      if (!old || (old.expiresAt !== null && old.expiresAt < Date.now())) return fail('bad_refresh_token');
      // Refreshing kills the old pair at once.
      this.refreshTokens.delete(p.get('refresh_token')!);
      this.tokens.delete(old.access);
      return json(res, 200, this.issue(old.userId, old.scope));
    }
    const code = this.codes.get(p.get('code') ?? '');
    this.codes.delete(p.get('code') ?? '');
    if (!code || code.expiresAt < Date.now()) return fail('bad_verification_code');
    if (p.get('redirect_uri') !== code.redirectUri) return fail('redirect_uri_mismatch');
    const verifier = p.get('code_verifier') ?? '';
    if (crypto.createHash('sha256').update(verifier).digest('base64url') !== code.challenge) return fail('bad_verification_code');
    json(res, 200, this.issue(code.userId, code.scope.split(' ').join(',')));
  }

  /** /_mock: a page to add notifications by hand while trying the client. */
  private control(url: URL, method: string, res: ServerResponse) {
    const userId = Number(url.searchParams.get('user')) || [...this.users.keys()][0];
    const kind = url.searchParams.get('kind');
    const specs: Record<string, ThreadSpec> = {
      mention: { reason: 'mention', title: 'Can you take a look at the login page?' },
      review: { reason: 'review_requested', title: 'Add dark mode to the settings' },
      issue: { reason: 'assign', type: 'Issue', title: 'Crash when the office is empty' },
      failure: { reason: 'ci_activity', type: 'CheckSuite', title: 'CI workflow run failed for main branch', noUrl: true },
      success: { reason: 'ci_activity', type: 'CheckSuite', title: 'CI workflow run succeeded for main branch', noUrl: true },
      approval: { reason: 'approval_requested', type: 'WorkflowRun', title: 'octocat requested your review to deploy to an environment', noUrl: true },
      comment: { reason: 'comment', type: 'Issue', title: 'Docs: explain the build mode' },
      release: { reason: 'subscribed', type: 'Release', title: 'v1.2.0', noUrl: true },
    };
    if (method === 'POST' && kind && Object.hasOwn(specs, kind)) {
      this.addThread(userId, specs[kind]);
      if (url.searchParams.get('back')) {
        res.writeHead(303, { Location: '/_mock' }).end();
        return;
      }
      return json(res, 201, { ok: true });
    }
    const buttons = Object.keys(specs)
      .map((k) => `<form method="post" action="/_mock?kind=${k}&back=1&user=${userId}" style="display:inline"><button>${k}</button></form>`)
      .join(' ');
    const list = this.threadsOf(userId)
      .map((t) => `<li>${t.unread ? '<b>unread</b>' : 'read'} · ${esc(t.reason)} · ${esc(t.subject.title)}</li>`)
      .join('');
    html(res, `<h1>Mock GitHub</h1><p>Add a notification for user ${userId} (it shows within a poll, about a minute):</p><p>${buttons}</p><ul>${list}</ul>`);
  }
}

export async function startMockGithub(port = 0, host = '127.0.0.1'): Promise<MockGithub> {
  return new MockGithub()
    .addUser(583231, 'octocat', { name: 'The Octocat', emails: [{ email: 'octocat@example.com', primary: true, verified: true }] })
    .start(port, host);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 3999);
  const mock = await startMockGithub(port, 'localhost');
  mock.interactive = true;
  mock.addUser(9919, 'hubot', { name: 'Hubot', email: 'hubot@example.com' });
  const me = 583231;
  mock.addThread(me, { reason: 'mention', title: 'Can you take a look at the login page?', number: 12 });
  mock.addThread(me, { reason: 'review_requested', title: 'Add dark mode to the settings', number: 14 });
  mock.addThread(me, { reason: 'ci_activity', type: 'CheckSuite', title: 'CI workflow run failed for main branch', noUrl: true });
  mock.addThread(me, { reason: 'ci_activity', type: 'CheckSuite', title: 'Deploy workflow run, Attempt #2 succeeded for main branch', noUrl: true });
  mock.addThread(me, { reason: 'approval_requested', type: 'WorkflowRun', title: 'hubot requested your review to deploy to an environment', noUrl: true });
  mock.addThread(me, { reason: 'comment', type: 'Issue', title: 'Docs: explain the build mode', number: 7 });
  mock.addThread(me, { reason: 'subscribed', type: 'Discussion', title: 'Ideas for the next office theme', noUrl: true });
  mock.counts.set(me, { reviewRequests: 3, assigned: 2 });
  console.log(`Mock GitHub on ${mock.base} (add notifications at ${mock.base}/_mock). Start Workchop with these for
GitHub notifications and GitHub sign-in:

  GITHUB_CLIENT_ID=${mock.clientId} GITHUB_CLIENT_SECRET=${mock.clientSecret} \\
  TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')} \\
  GITHUB_OAUTH_BASE=${mock.base} GITHUB_API_BASE=${mock.apiBase}
`);
}
