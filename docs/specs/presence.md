# Feature: current app indicator (Tandem-like) — manual status + optional desktop helper

Research notes with sources: docs/specs/research-active-app.md (per-OS detection, permissions, privacy, Node SEA limits, Cloudflare keep-awake pitfall).

Owner's words: "It can show the current app I'm on like on tandem (can be turned off in setting)".

Browsers cannot see the user's frontmost desktop app (see docs/specs/research-active-app.md). Build:

## In the app
- `app?: AppPresence | null` on PlayerState (id from an allowlist, e.g. 'figma', 'vscode', 'slack',
  'chrome', 'notion', 'linear', 'zoom', 'terminal', 'xcode', 'jira', 'docs', 'sheets', 'excel', 'word',
  'photoshop', 'other') — shared/apps.ts defines id → label, Hugeicons icon name (or brand-ish colour
  chip), and per-platform matchers (macOS bundle ids, Windows ProcessName, Linux WM_CLASS) used by
  the helper. Unknown apps → 'other' shown as "Working".
- Shown on: the person's name label (small chip "Figma"), people panel, video tile, and the desk
  monitor when seated (the world feature renders `app` on the screen; coordinate by using the same
  field).
- Manual status picker (Settings > Privacy & status, and a quick menu on your own avatar chip in the
  dock): "Working in …" list + "Heads-down" + clear; optional expiry (30 min / 1 h / today). Manual wins
  over the helper.
- Setting "Share what app I'm using" (default ON once a helper is paired; OFF hides it everywhere
  immediately). Auto-hidden when status is busy/away or headphones focus is on? (show only "Focusing").
- Server: in-memory presence map userId → {app, source, until}, TTL 45 s for helper updates; broadcast
  through player:updated to every office room where the user has a live player. Clear on TTL/disable.

## Desktop helper (optional, for signed-in users)
- Settings > Desktop helper: "Pair a device" creates a per-device token (wcp_ + 32 random bytes
  base64url, shown once, stored as SHA-256 in api_tokens(id, user_id, token_hash, scope 'presence:write',
  label, created_at, last_used_at, revoked_at) — migration 300+), list/revoke devices, copy-paste
  install command.
- helper/workchop-presence.cjs (CommonJS so it can become a Node SEA on Node 22/24; zero npm deps):
  every 5 s reads ONLY the frontmost app identifier (never window titles):
  macOS: fresh `osascript -l JavaScript` NSWorkspace frontmostApplication (bundleIdentifier) — not
  System Events; Windows: one long-lived powershell reading GetForegroundWindow → ProcessName via
  stdin script (`-Command -`), windowsHide, handle 0 handle / Idle / LockApp → null, ConstrainedLanguage
  → 'unsupported'; Linux: X11 xprop WM_CLASS only; Wayland: Sway/Hyprland/niri CLI if present, GNOME via
  the Focused Window D-Bus extension if installed, else unsupported. Map to allowlist ids ON DEVICE; send
  {app: id|'other'|null, platform, v:1} via PUT /api/me/app-presence (Authorization: Bearer wcp_…)
  only on change + 15 s heartbeat; config file ~/.config/workchop/helper.json (0600) or
  %APPDATA%\Workchop\helper.json; `node workchop-presence.cjs pair <url> <token>` and `run`.
- Server endpoint: validate token (cache hash→user in memory, throttle last_used_at writes), rate limit
  ~1 req/2 s per token, 204. If the user has no live socket, respond 204 with {active:false} /
  Retry-After 300 so the helper backs off. IMPORTANT (research): on Cloudflare the Worker must NOT start
  a stopped container for /api/me/app-presence — answer 204 directly when the container isn't running
  (edit cloudflare/worker.ts), and these requests must not keep it awake forever (don't reset the
  inactivity timeout for them if possible; document the behaviour).
- README: how to run the helper on macOS/Windows/Linux, privacy (only app id, allowlist, never titles),
  Wayland limitations.

## Tests
Unit: allowlist mapping for each platform matcher; token hashing/verification; presence TTL; sanitizing
app ids; manual vs helper precedence; disabled sharing hides it. Run the helper script against a fake
server with stubbed platform commands (inject an exec function) on Linux X11-style output. Browser: two
users, set manual "In Figma" → visible on label/people/monitor when seated; toggle off → disappears.
