# Feature specs for parallel work

Workchop's next features are being built in parallel. These specs are for the ones built **outside**
the main cloud session: weather (`weather.md`) and the GitHub integration (`github.md`) on the owner's
computer, and the current-app indicator (`presence.md`) and coins wallet (`coins.md`) in separate cloud
sessions. Where there are fact-checked research notes (`research-*.md`), read them; they contain real
pitfalls (API terms, rate limits, token expiry, OS permissions) that matter.

Chat, world interactions (desk screens, lights, plants, desk notes) and headphones & reactions are
being built in the main session at the same time, so keep your changes inside your feature's own files
where the hooks below allow it, to keep merges easy.

## Ground rules
- Start from branch `claude/vibrant-clarke-yfiw34` and work on your own branch: `feature/weather`,
  `feature/github`, `feature/presence` or `feature/coins`. Push your branch when done; it gets merged
  into the main work.
- Plug into the foundation instead of editing shared central files (APIs below). Server code goes in
  `server/features/<name>/`, registered in `server/features/index.ts`; socket events are declared in
  `shared/<name>.ts` by augmenting the event maps; client code goes in `client/src/features/<name>/`
  (auto-loaded). Migration id ranges: **presence 300–399, weather 400–499, github 500–599, coins 600–699** (100–299 and 700+ are taken by the other features).
- Icons: only Hugeicons. Add names (from `scripts/hugeicons/icons.css`) to
  `client/src/ui/icon-names.json`, export components in `client/src/ui/icons.tsx`, run `npm run icons`
  (needs `pip install fonttools brotli`). It's fine if another branch also adds icons; the merge
  regenerates the font.
- Theme: use the CSS variables in `client/src/styles.css`; check light and dark (Settings > Appearance).
- Accounts: GitHub needs a signed-in user (sign-in exists: Google/Apple, or the dev login with
  `DEV_LOGIN=true` locally). Guests must keep working; show "Sign in to …" where an account is needed.
- Every new env var goes into the README (Configuration table + a feature section), `.env.example`,
  `docker-compose.yml` (app environment) and `cloudflare/worker.ts` (Env + PASSED_TO_SERVER).
- Quality bar: `npm run typecheck`, `npm test` (add tests for server and shared logic; mock external
  APIs in tests), `npm run build`. Try it in the browser with `DEV_LOGIN=true npm run dev` (two browser
  windows for multi-user flows), in light and dark, desktop and narrow widths. Locally you can also test
  against the real Open-Meteo and GitHub APIs (the cloud sandbox can't reach them).
- Code style: match the surrounding code; short plain comments; no dead code; short user-facing text.
- Storage: without `DATABASE_URL` the server uses an embedded PGlite database in `./data/db` (only one
  server process may open it at a time). With Docker you can test on Postgres too:
  `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine` and
  `TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test`.

## Server hook API
- Add a module to the list in server/features/index.ts exporting `feature: Feature = { name,
  migrations?, register(ctx) }`. If register throws, the server does not start.
- Migrations: `{ id, name, sql }`, global ids (core 1–99; features use the ranges above). Run in id
  order in a transaction under an advisory lock with checksums. SQL must run on Postgres 16 and PGlite
  (PG18). Pass jsonb as `jsonb(x)` (from server/db) with `$n::jsonb`. Never edit an applied migration;
  add a new one.
- ServerContext (ctx): `app` (router at /api, after express.json, before the API 404; a guard rejects
  cross-site POST/PATCH/DELETE), `io`, `db`, `store`, `uploads`, `publicOrigin`,
  `auth.userFromRequest(req)`, `auth.requireUser` (401 or res.locals.user), `realtime`.
- RealtimeApi (ctx.realtime): `onSocket(s => s.socket.on(...))`, `onJoin(s => ...)`,
  `onLeave((s, {officeId, player}) => ...)` (may be async; failures are logged), `emitToOffice`,
  `emitToUser`, `playersOfUser`, `updatePlayer` (broadcasts player:updated), `contextOf`, `onlineCount`.
- SocketContext (s): `socket`, `user` (null for guests), `room()`, `me()`, `office()`, `isOwner()`,
  `mayEdit()`, `limiter(rate, burst)`.
- Catch errors in your own socket.on handlers: an async handler that rejects can still crash the server.
- Socket events: declare in shared/<feature>.ts with `declare module './types' { interface
  ClientToServerEvents {…}; interface ServerToClientEvents {…}; interface PlayerState {…} }`.
- Uploads: POST /api/offices/<id>/uploads with the file as the body, headers X-Filename (URL-encoded),
  X-Workchop-Socket (= selfId) and X-Workchop-Upload-Key (= uploadKey from the join answer). Answer
  {id, url, name, contentType, size}. On 429/503 retry after Retry-After. Prefer the client helper
  `session.upload(...)` from the client foundation.
- Use shared/text.ts (`clip`, `wellFormed`) for user text you store.

## Client plug-in API
- Put client code in client/src/features/<name>/index.ts(x): files there load automatically at
  startup; nothing else needs editing to register them.
- Panels: `registerPanel({ id, title, icon, Component, order, dock?, hideOnMobile?, useBadge?,
  badgeTone?: 'alert'|'neutral', shortcut? })` from client/src/ui/panels.tsx (chat 10, music 20,
  people 30; build is dock:false). Store `panel` is a string id; open with `setPanel(id)`.
- Settings sections: `registerSettingsSection({ id, title, icon, order, Component })` from
  client/src/ui/settings.tsx (Appearance 10, Audio & video 20). Use orders 30+ for new sections.
- Session hooks: `onSession('<unique-id>', (session) => cleanup)` from client/src/lib/session.ts. Runs
  when an office session is created (before connect) or at once if already in one; cleanup on leave /
  re-registration — undo everything (socket.off, unsubscribe). session.socket (typed with augmented
  events), session.officeId, session.selfId(), session.onJoined((rejoin) => …) (returns unsubscribe;
  runs at once if already joined), session.onLeave(fn), session.upload(file, {name?, onProgress?,
  signal?}) → {id, url, name, contentType, size}.
- Account: getState().account (AccountUser | null); saveAccountSettings({key: value}) merges into
  profile.settings (≤50 keys per account — use few, short keys); saveCharacter(...).
- Toasts: toast(text, 'error' | { kind, icon, action: {label, run}, duration }) → id; dismissToast(id).
- PlayerState already has focus?: boolean (client-set via profile patch) and app?: string | null
  (server-set only via realtime.updatePlayer). OfficeItem.data is ItemData; catalog entries may define
  sanitizeData(raw) used by sanitizeItem; build moves keep data for an unchanged type.
