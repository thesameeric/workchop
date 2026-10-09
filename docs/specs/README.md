# Feature specs for parallel work

Homeoffice's next features are being built in parallel. These specs are for the ones built **outside**
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
  (auto-loaded). Migration id ranges: **presence 300–399, weather 400–499, github 500–599, coins 600–699** (100–299 and 700+ are taken by the other features: chat 100 and 101, world 200, support 700–799 (see support.md), billing 800–899).
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
  migrations?, register(ctx) }`. If register throws, the server does not start. A feature that is off
  by a setting either registers nothing (its routes answer 404; coins are left out of the list unless
  `COINS=on`) or answers a status route saying so (weather, GitHub), so the client can hide it.
- Migrations: `{ id, name, sql }`, global ids (core 1–99: accounts take 4 and workspaces 5; features use the ranges above). Run in id
  order in a transaction under an advisory lock with checksums. SQL must run on Postgres 16 and PGlite
  (PG18). Pass jsonb as `jsonb(x)` (from server/db) with `$n::jsonb`. Never edit an applied migration;
  add a new one.
- ServerContext (ctx): `app` (router at /api, after express.json, before the API 404; a guard rejects
  cross-site POST/PATCH/DELETE), `io`, `db`, `store`, `uploads`, `publicOrigin`,
  `auth.userFromRequest(req)`, `auth.requireUser` (401 or res.locals.user), `auth.onUserUpdated(user => …)`
  (after a Profile change; their players in open offices are already updated), `realtime`,
  `clientIp(req)` (the visitor's IP, from CLIENT_IP_HEADER behind a proxy), `socketIp(socket)` (the same
  for a connection; guests get a new socket each time they reconnect), `quiet` (true in tests:
  skip "it works" log lines), `onClose(fn)` (runs when the server closes, before the database: stop
  timers there), `mailer` (send email; `mailer.kind === 'off'` sends nothing, as in production
  without Resend, so show anything important in the app too), `keepRawBody(path)` (JSON requests to
  `/api<path>` keep their bytes in `req.rawBody`, type `WithRawBody` from server/features.ts, to check
  a webhook's signature) and `workspaces.setPolicy(policy)` (one feature only, billing; see below). `uploads.remove(ids)` deletes stored files; `uploads.addCheck((socketId, officeId,
  bytes) => why | null)` refuses an upload (403) before its body is read. Files not attached to a
  chat message within a day are deleted by chat's sweep. Socket ids are visible to everyone in an
  office, so an HTTP route that takes X-Workchop-Socket should also limit by `clientIp`.
- Workspace policy (`WorkspacePolicy` in server/workspaces.ts, set with `ctx.workspaces.setPolicy`):
  who may come into an office and how many people it may have. `access(officeId, kind)` →
  `{ locked, guestCap, staffCap }` is asked for everyone coming in but the owner (and the owner key of an
  office nobody owns): `locked` refuses everyone but the owner and admins (AccessDenied `'locked'`, on
  GET /api/offices/:id and on joins; billing locks a paused workspace and a support workspace not paid
  yet), `guestCap` caps guests at once (default MAX_GUESTS_PER_ROOM, 90; support customers stay at the
  default), and `staffCap` caps admins coming into a locked office (people at once, LOCKED_STAFF_CAP
  for billing; the owner always gets in). `seatLimit(tx, officeId)` → a number, null (no limit)
  or `'locked'` is asked inside `Workspaces.add()`'s transaction after `lockSeats(tx, officeId)`: seats
  are counted before and after (`usedSeats(q, officeId)`: memberships plus open invitations; guests
  and customers never count), so turning an invitation into a membership always works, and adding
  someone past the limit answers 402 `{code: 'seats-full'}` (403 `{code: 'locked'}` when locked).
  `notes(offices)` adds `billing` ('locked' | 'past-due' | 'unpaid') to GET /api/me/spaces cards, and
  `ownerChanged(officeId, from, to)` runs after an ownership transfer (not awaited; failures logged).
  Take `lockSeats` for any change to an office's seats or plan. Without a policy nothing is counted
  or locked. With one, invitations that expired no longer hold a seat, so they can't be resent (404):
  the address is added again instead; without one they can, as before. An admin made a member while
  the office is locked is taken out at once (`lockChanged`).
- RealtimeApi (ctx.realtime): `onSocket(s => s.socket.on(...))`, `onJoin(s => ...)`,
  `onLeave((s, {officeId, player}) => ...)` (may be async; failures are logged), `emitToOffice`,
  `emitToUser`, `playersOfUser`, `players(officeId)` (who is in the office now), `updatePlayer`
  (broadcasts player:updated), `contextOf`, `onlineCount`,
  `linkedPeers(officeId, playerId)` (who they're in a call with), `addLinkRule((officeId) => ((a, b) =>
  boolean | null) | null)` (set up once per check of an office's calls, so look up what you need
  there; the pair rule is asked before the usual rules: any false keeps them apart, otherwise any
  true links them whatever the distance or private areas, otherwise distance and areas decide;
  support uses it), `relink(officeId, playerIds?)` (re-checks those players' calls, or everyone's,
  after a rule's answers changed), `addJoinCheck((officeId, s, role) => why | null)` (refuses
  someone coming in, at the end of a join), `removePlayer(officeId, playerId, reason)`
  (office:removed), `onRoleChange((s, before) => …)` (after setRole changed someone's role; a
  customer made a member is already shown as themselves), `onOfficeChange((officeId, office) => …)`
  (after an office:op), `setRole(officeId, userId, role | null)`
  (after a member's role changed: `office:role` to them, or with null `office:removed` and out of the
  office), `removeGuests(officeId)` and `accessChanged(officeId, guests)` (after the guest link
  changed: `office:role` to everyone, guests out when it's off), and `lockChanged(officeId, locked,
  staffCap?)` (after the workspace policy locked or unlocked the office: when locked, everyone but the
  owner and admins is taken out with `office:removed` 'locked', then the admins who came in last
  until `staffCap` people are left; never the owner or the owner key's holder). The workspace routes
  call these; features rarely need to.
- SocketContext (s): `socket`, `user` (null for guests), `room()`, `me()`, `office()`, `role()` (the
  person's role in the office: 'owner' | 'admin' | 'member' | 'guest', null before joining),
  `isOwner()` (the owner, or the owner-key holder of an office nobody has claimed), `mayEdit()`
  (`may(role, 'build', …)`), `mayChangeWorld()` (false for customers, i.e. `isCustomer(role, kind)`
  from shared/workspace.ts: guests of support workspaces; check it before changing what everyone
  shares, like lights, music or notes), `limiter(rate, burst)`. Check permissions with `may()` from
  shared/workspace.ts; signed in is not the same as a member (signed-in people can be guests).
- Chat conversations of your own (server/features/chat): `registerConversation(ctx, prefix, { access,
  audience, ownsGuestMessage, nameOf? })` makes the chat handle keys `<prefix>:<id>` (support: `t:<ticket id>`)
  like channels: `access(s, key, officeId)` → `{ write: true } | { write: false, why } | null` (null:
  they can't see it), `audience(officeId, key)` → socket ids that get new, edited and deleted
  messages, `ownsGuestMessage(s, key)` → whether this connection is the guest who wrote its guest
  messages (guests are a new socket after a reload), `nameOf(s, key)` → the name they write and react
  under there (null: their player's). It returns a remover for `ctx.onClose`.
  `postToConversation(ctx, …)` saves a message on someone's behalf; `deleteConversations(ctx,
  officeId, keys)` deletes them with their files (the chat's retention sweep leaves them alone).
  Saved messages carry `conv` (the key). Customers only ever get their own ticket's conversation:
  no channels, people, direct, live or nearby messages.
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
- Panels: `registerPanel({ id, title, icon, Component, order, dock?, hideOnMobile?, inMore?, useBadge?,
  badgeTone?: 'alert'|'neutral', shortcut? })` from client/src/ui/panels.tsx (Support 5 for staff in
  support workspaces, chat 10, music 20, people 30, coins' wallet 35 when on, My desk 40, GitHub 45;
  customers' chat panel is the support feature's, under the same id `chat`; build is dock:false). On
  phone-sized screens the dock shows at most two panel buttons, the first by order that aren't
  `inMore` or `hideOnMobile`; the rest (always the `inMore` ones) go in its More menu, and their alert
  badges show on the More button. Store
  `panel` is a string id; open with `setPanel(id)`. Returns a function that removes the panel (for
  features shown only on some servers or to some people). `shortcut` only names a key in the tooltip
  (chat: Enter); don't reuse the office's keys (WASD/arrows, Shift, E, M, V, H, B, Enter, Esc, 1–9, 0,
  and R, Del, Ctrl+D in build mode).
- Settings sections: `registerSettingsSection({ id, title, icon, order, Component })` from
  client/src/ui/settings.tsx (Workspace 5, Billing 6, Appearance 10, Audio & video 20, Privacy & status 30, Desktop helper
  35, Weather 40, Integrations 45).
- Pages: `registerPage({ path, Component })` from client/src/ui/pages.ts, a page of the feature's own
  at a path outside the offices (billing's /billing/return), registered when the module loads. The
  router shows it in the store's `'page'` phase (`page` is its path), with nothing else around it.
- Top bar: `registerTopBarItem({ id, order, Component })` from client/src/ui/topbar.ts (after the
  music; billing 5, weather 10). People panel: `registerPersonDetail({ id, order, Component })` from
  client/src/ui/PeoplePanel.tsx, a line under each other person's name (`Component` gets `{ player }`;
  weather 10), and `registerPersonAction({ id, order, Component })` from client/src/ui/personActions.ts,
  a button next to them (coins 10, when on). All render null when there's nothing to show.
- Over the office: `registerOverlay({ id, order, Component })` from client/src/ui/overlays.tsx (world's
  item card 10; coins' celebrations 5, when on).
- 3D scene: `registerSceneLayer({ id, order, Component })` from client/src/world/layers.ts, rendered in
  the Canvas after the office, each in its own Suspense and error boundary (weather 10). Change the
  sky, fog, light or wind through `sceneLighting` from useFrame with priority -1, and call
  `resetSceneLighting()` on unmount.
- 3D world (client/src/world/extensions.ts): `registerItemModel(type, Component)`,
  `registerItemDecor({ id, order, types, Component })` (extra parts on items, e.g. desk screens),
  `registerItemInteraction(types, { onClick, onHover? })` (E doesn't sit people on items that have
  one: they decide who sits there, like support desks), `registerNearbyAction(id, find)` (what E
  does nearby), and `registerWorldModule(() => import('./scene'))` to load your three.js code with the
  scene rather than with the landing page.
- Catalog (shared/catalog.ts): `seats: [{ x, z, turn? }]` (`turn` quarter turns added to the item's
  facing by seatsOf: 2 faces back across it, like a support desk's customer seat) and `kinds?:
  OfficeKind[]` (Build offers the item only in those workspace types). shared/geometry.ts:
  `standUpSpot(seat, solid, colliders, bounds)` (where you stand after getting up: forward, or back
  when there's no room in front) and `inFrontOf(item, gap?)` (a spot to stand and look at an item).
- Lobbies: `registerLobby({ id, match(info), Component, media? })` from client/src/ui/lobbies.ts: a
  feature's own lobby for some visitors (support customers) instead of the usual one; the first whose
  `match(info: OfficeInfo)` is true wins, and `media: { mic, cam }` picks which start on.
- Chat: `registerConvView(prefix, { open, looking, notify })` from client/src/features/chat/state.ts
  shows a feature's own saved conversations (like `t:`) outside the chat panel: `open(conv)`,
  `looking(conv)` (on screen now, so read), `notify(conv)` (a new message gets a toast).
- Session hooks: `onSession('<unique-id>', (session) => cleanup)` from client/src/lib/session.ts. Runs
  when an office session is created (before connect) or at once if already in one; cleanup on leave /
  re-registration — undo everything (socket.off, unsubscribe). session.socket (typed with augmented
  events), session.officeId, session.selfId(), session.onJoined((rejoin) => …) (returns unsubscribe;
  runs at once if already joined), session.onLeave(fn), session.upload(file, {name?, onProgress?,
  signal?}) → {id, url, name, contentType, size}, session.setFullVolume(playerId | null) (hear that
  person at full volume wherever they are: a support agent and their customer).
- Account: getState().account (AccountUser | null); saveAccountSettings({key: value}) merges into
  profile.settings (≤50 keys per account — use few, short keys); saveCharacter(...).
- Toasts: toast(text, 'error' | { kind, icon, action: {label, run}, duration }) → id; dismissToast(id).
  Toasts are silent and show the same with headphones on.
- PlayerState already has focus?: boolean (client-set via profile patch), app?: string | null
  (server-set only via realtime.updatePlayer) and customer?: boolean (server-set: true on join for
  customers, the guests of support workspaces, who carry no userId; false in a player:updated when
  one is made a member; see isCustomer in shared/workspace.ts). office:removed reasons: 'removed',
  'guests-off', 'idle' (a customer without an open ticket for CUSTOMER_IDLE_MS), 'locked' (the
  workspace was paused for not being paid; see shared/billing.ts). OfficeItem.data is ItemData; catalog entries may define
  sanitizeData(raw) used by sanitizeItem; build moves keep data for an unchanged type.
