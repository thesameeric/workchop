# Research notes: github

Collected and fact-checked against primary sources on 2026-10-07: the recommendation (REC), pitfalls, and a verifier's corrections and additions (NON-CONFIRMED / MISSED). Prefer these over memory, and re-check anything that looks outdated.

```text
KEY github
REC: 1. **Use a GitHub OAuth App, not a GitHub App.** GET /notifications and every /notifications/threads/* endpoint are marked `enabledForGitHubApps: false` in the official OpenAPI and are missing from the list of GitHub App user-token endpoints. The docs say they work only with classic-style tokens, and an OAuth App's `gho_` token is scope-based like a classic token.

2. **What the operator provides:**
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from https://github.com/settings/applications/new (or the org's Developer settings).
   - The callback URL `${PUBLIC_URL}/api/integrations/github/callback`. Up to 10 callback URLs are allowed, so dev and prod can share one app. For apps created after 2026-08-03 matching is exact unless wildcard matching is turned on.
   - Leave "Expire user access tokens" on (now the default). Access tokens then last 8h; refresh tokens last 6 months without use and rotate on every use.
   - `GITHUB_TOKEN_KEY`: 32 random bytes in base64. It encrypts tokens at rest with AES-256-GCM via node:crypto (store iv, tag and ciphertext per field in Postgres). Never store tokens in the JSON-file store; Cloudflare Containers lose their disk.

3. **Scopes:** request only `notifications` by default. It covers reading the inbox, marking threads read, and managing thread subscriptions. GET /user still returns the public profile (numeric id and login) without `read:user`, and `read:org` is not needed (team review requests arrive as reason `review_requested`). Offer an opt-in "private repo details & Actions" re-auth that adds `repo`. That scope is required to fetch private issues/PRs/comments behind `subject.url`, to list private workflow runs, and to search private repos. Warn users that `repo` is full read/write; an OAuth App has no read-only private scope.

4. **Connect (web flow, never device flow — device flow is for headless/CLI apps):**
   - `GET /api/integrations/github/connect` requires a Workchop session.
   - Create `state` (32 random bytes, base64url) and a PKCE verifier. Store `{state, verifier, userId, returnTo}` server-side, single-use, with a 10-minute TTL.
   - Return 302 to `https://github.com/login/oauth/authorize?client_id=…&redirect_uri=…&scope=notifications&state=…&code_challenge=<S256>&code_challenge_method=S256&allow_signup=false`.

5. **Callback (`GET /api/integrations/github/callback`):**
   - If `error=access_denied` (or `application_suspended`) is present, return to the office with a message.
   - Otherwise check that `state` exists, is unexpired and belongs to the same session user, then delete it.
   - `POST https://github.com/login/oauth/access_token` with `Accept: application/json` and form/JSON body `client_id, client_secret, code, redirect_uri, code_verifier`. Treat a JSON `error` field (`bad_verification_code`, `redirect_uri_mismatch`, `incorrect_client_credentials`, `unverified_user_email`) as failure.
   - Store `access_token`, `refresh_token`, `expires_in` (as an absolute expiry), `refresh_token_expires_in` and `scope`.
   - Re-validate identity with `GET https://api.github.com/user` and key the link on the numeric `id`. Store `login` for `actor=`.

6. **Refresh:** when less than 5 minutes remain, `POST https://github.com/login/oauth/access_token` with `grant_type=refresh_token&refresh_token=…&client_id&client_secret`. Run this single-flight per user, because the old refresh and access tokens die immediately. Persist both new tokens in one transaction. On `bad_refresh_token` or a 401, mark the link "needs reconnect".

7. **Poller (server-side, only for users with a live Socket.IO connection):**
   - Request `GET https://api.github.com/notifications?all=false&participating=false&per_page=50` with headers `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` (or 2026-03-10; neither changes the notifications schema), `User-Agent: Workchop`, and `If-Modified-Since: <last Last-Modified, passed exactly>`.
   - Wait at least `X-Poll-Interval` seconds (normally 60). A 304 costs no rate limit; a 200 is diffed by thread `id` and `updated_at` and pushed only to that user's sockets.
   - Clients never see tokens.

8. **Bucket items by `reason`:** `mention`/`team_mention` = Mentions; `review_requested` = Review requests; `assign` = Assigned; `comment`/`author`/`state_change`/`manual`/`subscribed` on PullRequest/Issue = activity; `ci_activity` (subject.type `CheckSuite`) = Actions; `approval_requested` (subject.type `WorkflowRun`) = deployment approvals.

9. **Actions status:** parse the CheckSuite title "<workflow> workflow run[, Attempt #N] <succeeded|failed|cancelled|skipped> for <branch> branch" for success/failure. This is what the gitify client does; GitHub does not document the format.

10. **Clickable links (threads have no `html_url`):**
    - With `repo` scope, GET `subject.url` or `subject.latest_comment_url` (cached with ETag/If-None-Match) and use its `html_url`.
    - Without it, fall back to a guarded rewrite of api.github.com/repos/{o}/{r}/pulls/{n} to github.com/{o}/{r}/pull/{n} (and issues/{n} likewise). GitHub says not to parse URLs, so keep the fallback to `repository.html_url`.
    - For CheckSuite, link to `repository.html_url + '/actions'`.

11. **Mark read/done/all:**
    - Clicking an item sends `PATCH /notifications/threads/{id}` (205).
    - "Done" sends `DELETE /notifications/threads/{id}` (204).
    - "Mark all read" sends `PUT /notifications {last_read_at}` (205, or 202 when processed asynchronously).

12. **Optional extras:**
    - Every ≥5 min, `GET /search/issues?q=is:open+is:pr+review-requested:@me+archived:false` (and `assignee:@me`) gives an "outstanding reviews/assignments" count that survives marking read. Search allows 30 requests/min and returns up to 1,000 results; only public repos are searched without `repo`.
    - Actions runs beyond `ci_activity` can only be listed per repo: `GET /repos/{owner}/{repo}/actions/runs?actor={login}&per_page=10` with ETag, for repos the user pins.

13. **Disconnect:** `DELETE https://api.github.com/applications/{client_id}/grant` with Basic auth `client_id:client_secret` and body `{"access_token": …}`, then delete the row.

14. **Show users a setup hint:** in GitHub Settings → Notifications, enable "On GitHub" for Participating/Watching, and under System → Actions choose "On GitHub" (optionally "failed workflows only"). Otherwise the API returns no `ci_activity` and possibly an empty inbox.

15. **Libraries:** none are required; use Node 22 `fetch` and `node:crypto`. If a helper is wanted, `@octokit/oauth-methods@6.0.5` (published 2026-08-30) covers the code exchange, refresh and grant deletion.
PITFALLS:
 - Do not build this as a GitHub App, and do not accept fine-grained PATs: /notifications is classic-token-only (enabledForGitHubApps:false). A GitHub App would also need installing on every org and loses GET /issues.
 - New OAuth Apps issue expiring tokens by default (8h access, 6-month refresh). Code that assumes long-lived gho_ tokens breaks after 8 hours. Refresh rotates both tokens and kills the old pair, so run refreshes single-flight per user and persist them atomically; concurrent refreshes produce bad_refresh_token and force a reconnect.
 - Do not assume a refresh_token is always returned (e.g. if the operator unticks 'Expire user access tokens'). Handle both shapes: expires_in present or absent.
 - redirect_uri must exactly match a registered callback (apps created after 2026-08-03 have wildcard matching off). Behind the Cloudflare Worker, build it from a configured PUBLIC_URL, not from the incoming Host header.
 - The state parameter must be random, single-use, short-lived (the code dies in 10 minutes) and bound to the Workchop session user. Also verify the GitHub numeric id from GET /user after every exchange, so an account never links to the wrong Workchop user.
 - The token endpoint reports errors as a JSON body with an `error` field (bad_verification_code, redirect_uri_mismatch, incorrect_client_credentials, unverified_user_email). Always send Accept: application/json and check `error`, not just the HTTP status.
 - Never send GitHub tokens to the browser or put them in localStorage, and never write them to the JSON-file office store. Keep them AES-256-GCM-encrypted in Postgres with the key in an env secret. Cloudflare Container disks are ephemeral.
 - Polling: pass the previous Last-Modified back exactly as If-Modified-Since, send Authorization (otherwise a 304 still costs rate limit), and wait at least X-Poll-Interval (usually 60s; it can rise). Use identical query params on every poll, and poll only for users currently online.
 - per_page on /notifications is capped at 50; follow Link headers if there are more. all=false hides read threads, so once a user reads a review request on github.com it disappears from the feed. Use the search API to keep a persistent 'pending reviews' count.
 - reason is per-thread and sticky (e.g. stays 'mention'), so it shows why the user is subscribed, not what just happened. Use updated_at, subject.type and latest_comment_url to describe the latest event.
 - ci_activity only appears if the user enabled Actions notifications 'On GitHub', and only for runs they triggered. Scheduled workflows notify the workflow's creator. Without 'On GitHub' for participating/watching, the inbox (and the API) is empty.
 - Threads have no html_url. Resolving subject.url or latest_comment_url for private repos needs the broad repo scope (full read/write). GitHub says not to string-rewrite API URLs, so treat a rewrite only as a fallback, with repository.html_url as the last resort.
 - For CheckSuite (Actions) threads the status exists only in the title text (format undocumented, parsed by clients such as gitify). subject.url / latest_comment_url may be null for some subject types; code must tolerate nulls even though the OpenAPI marks them as required strings.
 - The search API allows only 30 requests/min per user (shared across apps) and searches only public repos unless the token has repo. review-requested drops a PR after the user reviews; use user-review-requested:@me for direct requests only.
 - There is no cross-repo 'my workflow runs' endpoint; runs must be polled per repo (and need repo scope for private repos). Use ETag/If-None-Match and keep the repo list small.
 - Org policies can hide data. New orgs block OAuth Apps by default (an owner must approve Workchop's app for private org data), and SAML-SSO orgs need an active SSO session when the user authorizes.
 - Each reconnect mints a new token. More than 10 tokens per user/app/scope revokes older ones, and more than 10 per hour triggers a re-authorization prompt, so avoid reconnect loops.
 - Requests must carry a User-Agent header. Pin X-GitHub-Api-Version: 2026-03-10 removes the singular `assignee` and `merge_commit_sha` from issue/PR responses, so don't depend on those fields.
NON-CONFIRMED:
 * [corrected] Rec. item 15: @octokit/oauth-methods@6.0.5 (published 2026-08-30) covers the code exchange, refresh and grant deletion.
   -> The version and date are right: npm registry time is 6.0.5 = 2026-08-30T21:20:01Z (latest tag), engines node >= 20. But the dist-src code does not fit this design. (a) exchangeWebFlowCode sends only client_id, client_secret, code and redirect_uri: there is no code_verifier, so it cannot finish a PKCE flow. (b) For clientType 'oauth-app' it ignores refresh_token, expires_in and refresh_token_expires_in, which it parses only when clientType === 'github-app'. (c) It splits `scope` with /\s+/ although GitHub returns it comma-separated. (d) refreshToken is typed clientType 'github-app' only. deleteAuthorization does work (Basic client_id:client_secret, DELETE /applications/{client_id}/grant). Use
 * [corrected] Rec. item 7: X-GitHub-Api-Version 2022-11-28 or 2026-03-10; neither changes the notifications schema.
   -> Both versions exist (src/rest/lib/config.json lists 2022-11-28 and 2026-03-10), and the thread schema itself is identical. However, the 2026-03-10 breaking-changes list names GET /notifications and GET /notifications/threads/{thread_id} under "Remove deprecated `has_downloads` property from Repository response". 2026-03-10 also removes `merge_commit_sha` and the singular `assignee` from PR/Issue payloads, which matters if enrichment GETs subject.url. These have no practical effect for Workchop, but the claim is not literally true.
 * [corrected] Rec. item 9: CheckSuite title format '<workflow> workflow run[, Attempt #N] <succeeded|failed|cancelled|skipped> for <branch> branch', as gitify parses it.
   -> The regex matches gitify main (commit 261e656, 2026-10-07): /^(?<workflowName>.*?) workflow run(, Attempt #(?<attemptNumber>\d+))? (?<statusDisplayName>.*?) for (?<branchName>.*?) branch$/. Gitify also maps 'failed at startup' to FAILURE, which the recommendation leaves out. Gitify links to repository.html_url + '/actions?query=workflow:"Name"+is:failure+branch:X', un-encoding %2B to '+', which is a better link than bare /actions. For WorkflowRun (approval_requested) titles it parses '^(.*?) requested your (.*?) to deploy to an environment$'. GitHub does not document any of this.
MISSED:
 - ORG ACCESS RESTRICTIONS (biggest design impact): "When you create a new organization, OAuth app access restrictions are enabled by default", and unapproved OAuth Apps get no "API access to private organization resources". Gitify's FAQ: "If an organization shows Request or Disallowed by org owner, you will not get notifications from that organization until access is approved." Register the Workchop OAuth App under the company's GitHub org, since "Applications that are owned by the organization are automatically given access". Show users a 'Request org access' hint linking to https://github.com/settings/connections/applications/{client_id}. Sources: github/docs data/reusables/organizations/oauth_app_restrictions_default.md, content/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions.md, gitify-app/website src/faqs/troubleshooting/notifications
 - SAML SSO orgs: users who have a linked SAML identity "must have an active SAML session for each organization each time you authorize an OAuth app"; otherwise that org's data, notifications included, is missing. Add this to the setup hint (content/apps/oauth-apps/using-oauth-apps/authorizing-oauth-apps.md).
 - @octokit/oauth-methods@6.0.5 has no PKCE (code_verifier) support, drops refresh tokens for clientType 'oauth-app', and splits scope on whitespace, but GitHub returns scopes comma-separated. Hand-roll fetch.
 - Scopes are mutable after the OAuth flow ("users can edit token scopes after the OAuth flow is completed") and the token response `scope` is comma-separated. Read X-OAuth-Scopes on each API response to gate the private-repo/Actions features, rather than trusting the stored value (scopes-for-oauth-apps.md).
 - Rate limit is shared: OAuth App tokens use the user's 5,000/h primary limit, which "is combined with any requests that another GitHub App or OAuth app makes on that user's behalf and any requests that the user makes with a personal access token". Keep enrichment GETs conditional (ETag/If-None-Match) and back off on 403/429 with retry-after (content/rest/using-the-rest-api/rate-limits-for-the-rest-api.md).
 - Token limits: max 10 tokens per user/app/scope combination; extra ones revoke the oldest unused or least recently used. There is also a limit of 10 new tokens per hour, and hitting it triggers a browser re-authorization prompt. Dev and prod sharing one OAuth App count against the same limit. Re-auth to add `repo` creates a new token with a different scope set; revoke the old one with DELETE /applications/{client_id}/token. Tokens unused for a year are auto-revoked (data/reusables/apps/oauth-token-limit.md, token-expiration-and-revocation.md).
 - Disconnect via DELETE /applications/{client_id}/grant revokes every token the app holds for that GitHub user, across all Workchop environments that share the OAuth App. Prefer DELETE /applications/{client_id}/token for a per-link disconnect, or use separate OAuth Apps per environment.
 - subject.url and latest_comment_url are null in practice for some subject types (CheckSuite, Discussion, etc.) even though the OpenAPI marks them required. Null-guard them. Discussion links go to repository.html_url + '/discussions', following gitify.
 - Callback error redirects include `state`, and `error=redirect_uri_mismatch` can also arrive on the callback. Validate and consume state on error paths as well (troubleshooting-authorization-request-errors.md).
 - Design inference, not GitHub-sourced: refresh tokens rotate and die on use, and Workchop may run more than one container instance or restart. Single-flight refresh and the poller therefore need a DB-level lock (SELECT ... FOR UPDATE or pg_advisory_xact_lock on the user's link row), not an in-process mutex, or two instances will race and one will get bad_refresh_token, forcing a needless reconnect.
 - Reason is sticky per thread ("remains as `mention`, regardless of whether you're ever mentioned again"), so buckets show the thread's strongest reason, not the latest event. This matters for the UI wording.
```
