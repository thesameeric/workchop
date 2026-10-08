# Feature: GitHub integration

Owner's words: "Add github integration, devs can see mentions on PR, actions, e.t.c"

Follow docs/specs/research-github.md exactly (OAuth App, not GitHub App; notifications scope; expiring tokens with
refresh; poll with If-Modified-Since + X-Poll-Interval; reason buckets; CheckSuite title parsing like
gitify; link fallbacks; org access restrictions hint).

## Server
- Env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY (base64 32 bytes; refuse to enable
  GitHub without it), PUBLIC_URL (from foundation). Integration hidden when unset.
- Migration 500+: github_links(user_id pk, github_id bigint unique-ish, login, access_token_enc,
  refresh_token_enc null, access_expires_at null, refresh_expires_at null, scopes text, created_at,
  updated_at, needs_reconnect bool), github_oauth_tx(state_hash pk, user_id, code_verifier, return_to,
  expires_at).
- Routes (signed-in only): GET /api/integrations/github/connect?scope=basic|private → 302 to GitHub
  (PKCE S256 + state); GET /api/integrations/github/callback; POST /api/integrations/github/disconnect
  (DELETE /applications/{client_id}/token for just this token); GET /api/integrations/github/status.
- Token crypto: AES-256-GCM, random 12-byte IV, authTagLength 16 on both sides, AAD
  `github:${userId}:${field}`, format v1.<iv>.<ct>.<tag> base64url. Never log tokens.
- Refresh single-flight per user with a DB lock (pg_advisory_xact_lock(hash(user))), persist both new
  tokens atomically; bad_refresh_token/401 → needs_reconnect.
- Poller: only for users with a live socket; per-user state {lastModified, pollInterval, items};
  GET /notifications?all=false&participating=false&per_page=50 (follow Link for up to 2 pages), headers
  per research; 304 → nothing; diff by id+updated_at; push github:inbox / github:item to `user:<id>`.
  Every ≥5 min, search API counts: open PRs review-requested:@me, assigned issues/PRs (public only
  without repo scope). Back off on 403/429 using retry-after / x-ratelimit-reset. Stop when the user
  disconnects.
- Actions: classify ci_activity CheckSuite titles (succeeded/failed/cancelled/skipped/failed at startup)
  and approval_requested WorkflowRun; failed runs also trigger a toast.
- Socket events: github:inbox (full list on connect), github:item, github:remove; client→server:
  github:read(threadId) → PATCH thread, github:done(threadId) → DELETE, github:readAll → PUT.

## Client
- Settings > Integrations: Connect GitHub / connected as @login (avatar) / Disconnect / "Include
  private repos & Actions" (re-auth with repo scope, with a clear warning that GitHub's repo scope is
  broad) / setup hints (enable "On GitHub" notifications incl. Actions; org access approval link
  https://github.com/settings/connections/applications/{client_id}; SAML SSO note).
- GitHub panel (dock button with GitHub glyph from Hugeicons ("github" icon) and a badge = unread
  mentions + review requests + failed runs): tabs/sections Mentions, Reviews, Actions, Activity; items
  show repo, title, type icon (PR/issue/check), reason, relative time, status colour for Actions
  (green/red/grey); click opens GitHub in a new tab and marks read; hover actions: mark read, done;
  "Mark all read". Empty states with setup hints. Light/dark.
- Micro-interaction: when a failed Actions run arrives, a small red badge pulses on your desk monitor
  (if the world feature shows screens; coordinate via a store flag — optional).

## Tests
Server: token crypto round trip + tamper detection; OAuth connect/callback with a mock GitHub (local
HTTP server standing in for github.com/api.github.com via configurable GITHUB_OAUTH_BASE/
GITHUB_API_BASE env used only in tests); refresh single-flight; poller 200/304/X-Poll-Interval handling,
diffing; reason bucketing; CheckSuite parsing (all statuses); URL fallback rewriting; disconnect.
Browser: with the mock GitHub, connect, see items in each bucket, mark read, done, badge counts.
