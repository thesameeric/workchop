#!/usr/bin/env node
// Workchop desktop helper: tells your Workchop office which app you're using ("In Figma").
//
// Every 5 seconds it reads ONLY the identifier of the app in front (a macOS bundle id, a Windows
// process name or a Linux window class), never window titles, URLs or anything on screen. It maps
// that to an id from Workchop's list ON THIS COMPUTER (unknown apps become "other") and sends just
// that id when it changes, plus a heartbeat every 15 s.
//
//   node workchop-presence.cjs pair <workchop address> [token]   (or pipe the token in)
//   node workchop-presence.cjs run
//   node workchop-presence.cjs status | unpair
//
// Needs Node.js 18 or newer, no packages. CommonJS on purpose: Node 22/24 can build a single
// executable (SEA) only from a CommonJS script.
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 5000;
const HEARTBEAT_MS = 15000;
const REFRESH_LIST_MS = 24 * 60 * 60 * 1000;
const TOKEN_FORMAT = /^wcp_[A-Za-z0-9_-]{43}$/;

// --- Config ---------------------------------------------------------------------------------------

/** ~/.config/workchop/helper.json, or %APPDATA%\Workchop\helper.json on Windows. */
function configPath(env = process.env, platform = process.platform) {
  if (env.WORKCHOP_HELPER_CONFIG) return env.WORKCHOP_HELPER_CONFIG;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Workchop', 'helper.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'workchop', 'helper.json');
}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Readable only by you (0600): it holds the token. */
function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// --- Matching (the same rules as matchApp in Workchop's shared/apps.ts) ---------------------------

function matchApp(matchers, platform, candidates) {
  const values = candidates.map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : '')).filter(Boolean);
  const ignore = (matchers && matchers.ignore && matchers.ignore[platform]) || [];
  if (!values.length || values.some((v) => ignore.includes(v))) return null;
  const apps = (matchers && matchers.apps) || [];
  for (const value of values) {
    for (const app of apps) {
      const patterns = (app.match && app.match[platform]) || [];
      if (patterns.some((p) => (p.endsWith('*') ? value.startsWith(p.slice(0, -1)) : value === p))) return app.id;
    }
  }
  return 'other';
}

// --- Reading the frontmost app --------------------------------------------------------------------

/** Runs a command and resolves with its output; `exec` can be swapped out in tests. */
function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, { timeout: 4000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

const missing = (err) => err && (err.code === 'ENOENT' || err.code === 'EACCES');

// macOS: NSWorkspace through JXA (no Apple Events, so no Automation, Accessibility or Screen
// Recording prompt). A fresh osascript each time: NSWorkspace only updates while a run loop runs.
const JXA =
  'ObjC.import("AppKit");(function(){try{return ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)||""}catch(e){return ""}})()';

function macDetector(exec) {
  return async () => {
    try {
      return { candidates: [(await exec('osascript', ['-l', 'JavaScript', '-e', JXA])).trim()] };
    } catch (err) {
      return missing(err) ? { unsupported: true } : { candidates: [] };
    }
  };
}

// Windows: one long-lived PowerShell (compiling Add-Type each time is slow) reading the foreground
// window's process name. The script goes in on stdin, one statement per line. It stops by itself
// when this process is gone.
function windowsScript(parentPid) {
  return [
    "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { [Console]::Out.WriteLine('!unsupported'); [Console]::Out.Flush(); exit }",
    'Add-Type -Namespace W -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);\'',
    `while ($true) { if (-not (Get-Process -Id ${parentPid} -EA 0)) { exit }; $h = [W.U]::GetForegroundWindow(); $n = ''; if ($h -ne [IntPtr]::Zero) { [uint32]$p = 0; [void][W.U]::GetWindowThreadProcessId($h, [ref]$p); if ($p -ne 0) { $n = (Get-Process -Id $p -EA 0).ProcessName } }; [Console]::Out.WriteLine('=' + $n); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${POLL_MS} }`,
    '',
    '',
  ].join('\r\n');
}

function windowsDetector(spawn, log) {
  let latest = '';
  let unsupported = false;
  let child = null;
  let restarts = 0;
  let stopped = false;
  // Settles with PowerShell's first answer (its first start can take a few seconds).
  let answered;
  const ready = new Promise((resolve) => (answered = resolve));
  const start = () => {
    let buffer = '';
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      unsupported = true;
      answered();
      return;
    }
    child.on('error', () => {
      unsupported = true;
      answered();
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line === '!unsupported') unsupported = true;
        else if (line.startsWith('=')) {
          latest = line.slice(1).trim();
          restarts = 0;
        } else continue;
        answered();
      }
    });
    child.on('exit', () => {
      child = null;
      if (stopped || unsupported) return;
      // PowerShell shouldn't stop; if it keeps doing so, this computer can't be read.
      if (++restarts > 5) {
        log('PowerShell keeps stopping; showing nothing.');
        unsupported = true;
        answered();
        return;
      }
      setTimeout(() => !stopped && start(), 5000 * restarts).unref();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(windowsScript(process.pid));
  };
  start();
  const detect = async () => (unsupported ? { unsupported: true } : { candidates: [latest] });
  detect.ready = ready;
  detect.stop = () => {
    stopped = true;
    if (child) child.kill();
  };
  return detect;
}

/** The focused window in a Sway tree: its app_id, or its X11 class for XWayland windows. */
function swayFocused(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.focused && (node.type === 'con' || node.type === 'floating_con')) {
    const props = node.window_properties || {};
    return [node.app_id, props.class, props.instance];
  }
  for (const child of [...(node.nodes || []), ...(node.floating_nodes || [])]) {
    const found = swayFocused(child);
    if (found) return found;
  }
  return null;
}

/** GNOME's "Focused Window D-Bus" extension answers GVariant text: ('{"wm_class": …}',). */
function parseGnome(out) {
  const m = /^\('(.*)',\)\s*$/s.exec(out.trim());
  if (!m) return [];
  const info = JSON.parse(m[1].replace(/\\(.)/g, '$1'));
  // It sends the title too: only the class is kept.
  return [info.wm_class_instance, info.wm_class];
}

// Linux: X11 via xprop (WM_CLASS only, never the title). Wayland only on desktops that offer a way:
// Sway, Hyprland, niri, and GNOME with the "Focused Window D-Bus" extension.
function linuxDetector(exec, env) {
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY;
  const desktop = String(env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const json = async (cmd, args) => JSON.parse(await exec(cmd, args));
  let read;
  if (wayland && env.SWAYSOCK) read = async () => swayFocused(await json('swaymsg', ['-t', 'get_tree'])) || [];
  else if (wayland && env.HYPRLAND_INSTANCE_SIGNATURE) {
    read = async () => {
      const w = await json('hyprctl', ['-j', 'activewindow']);
      return [w && w.class, w && w.initialClass];
    };
  } else if (wayland && env.NIRI_SOCKET) {
    read = async () => {
      const w = await json('niri', ['msg', '--json', 'focused-window']);
      return [w && w.app_id];
    };
  } else if (wayland && desktop.includes('gnome')) {
    read = async () =>
      parseGnome(
        await exec('gdbus', [
          'call',
          '--session',
          '--dest',
          'org.gnome.Shell',
          '--object-path',
          '/org/gnome/shell/extensions/FocusedWindow',
          '--method',
          'org.gnome.shell.extensions.FocusedWindow.Get',
        ]),
      );
  } else if (!wayland && env.DISPLAY) {
    read = async () => {
      const root = await exec('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW']);
      const id = /window id # (0x[0-9a-f]+)/i.exec(root);
      if (!id || Number(id[1]) === 0) return [];
      const cls = await exec('xprop', ['-id', id[1], '-notype', 'WM_CLASS']);
      return [...cls.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    };
  } else {
    return async () => ({ unsupported: true });
  }
  let failures = 0;
  return async () => {
    try {
      const candidates = await read();
      failures = 0;
      return { candidates };
    } catch (err) {
      // No such command, or a desktop without the extension: say so instead of guessing.
      if (missing(err) || /UnknownMethod|ServiceUnknown|No such interface|doesn't exist/i.test(String(err && err.message)) || ++failures >= 3) {
        return { unsupported: true };
      }
      return { candidates: [] };
    }
  };
}

function platformName(platform = process.platform) {
  return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : null;
}

function createDetector({ platform, exec = defaultExec, spawn = childProcess.spawn, env = process.env, log = () => {} }) {
  if (platform === 'macos') return macDetector(exec);
  if (platform === 'windows') return windowsDetector(spawn, log);
  return linuxDetector(exec, env);
}

// --- Talking to Workchop --------------------------------------------------------------------------

function apiUrl(server, p) {
  return new URL(p, server.endsWith('/') ? server : server + '/').toString();
}

async function fetchMatchers(server, fetchFn = fetch) {
  const res = await fetchFn(apiUrl(server, 'api/app-presence/apps'), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Workchop answered ${res.status}`);
  const m = await res.json();
  if (!m || m.v !== 1 || !Array.isArray(m.apps)) throw new Error('That does not look like a Workchop server.');
  return m;
}

function retryAfterMs(res, fallback) {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 3600) * 1000 : fallback;
}

class Unpaired extends Error {}

async function send(server, token, body, fetchFn = fetch) {
  return fetchFn(apiUrl(server, 'api/me/app-presence'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'workchop-presence/1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

/**
 * The main loop: read the app, send it when it changes or a heartbeat is due, and back off when
 * Workchop says so (Retry-After: nobody of yours online, the server asleep, or too many reports).
 */
function createHelper(opts) {
  const { config, platform, detect, file } = opts;
  const fetchFn = opts.fetch || fetch;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const state = { last: undefined, sentAt: 0, waitUntil: 0, failures: 0 };

  async function step() {
    const r = await detect();
    const unsupported = !!r.unsupported;
    const app = unsupported ? null : matchApp(config.matchers, platform, r.candidates || []);
    const t = now();
    const changed = app !== state.last;
    if (t < state.waitUntil || (!changed && t - state.sentAt < HEARTBEAT_MS)) return app;
    let res;
    try {
      res = await send(config.server, config.token, { app, platform, v: 1, ...(unsupported ? { unsupported: true } : {}) }, fetchFn);
    } catch (err) {
      state.failures++;
      state.waitUntil = t + Math.min(60000, POLL_MS * 2 ** state.failures);
      if (state.failures === 1) log(`Can't reach Workchop (${err && err.message}); retrying.`);
      return app;
    }
    state.failures = 0;
    await res.body?.cancel().catch(() => {});
    if (res.status === 401) throw new Unpaired('This computer was removed from your Workchop account. Pair it again: Settings > Desktop helper.');
    if (res.status === 204) {
      if (changed) log(unsupported ? "This desktop can't tell which app is in front." : `Now: ${app || 'nothing'}`);
      state.last = app;
      state.sentAt = t;
      const idle = res.headers.has('retry-after');
      state.waitUntil = idle ? t + retryAfterMs(res, 60000) : 0;
      if (!idle && t - (config.matchersAt || 0) > REFRESH_LIST_MS) await refreshList();
    } else {
      state.waitUntil = t + retryAfterMs(res, res.status === 429 || res.status >= 500 ? 5000 : 60000);
      if (res.status !== 429) log(`Workchop answered ${res.status}; trying again later.`);
    }
    return app;
  }

  async function refreshList() {
    try {
      config.matchers = await fetchMatchers(config.server, fetchFn);
      config.matchersAt = now();
      if (file) writeConfig(file, config);
    } catch {
      // Keep the list we have.
    }
  }

  /** Clears your app in Workchop right away (when stopping), rather than after the timeout. */
  async function clear() {
    if (state.last === undefined || state.last === null) return;
    await send(config.server, config.token, { app: null, platform, v: 1 }, fetchFn)
      .then((res) => res.body?.cancel())
      .catch(() => {});
  }

  return { step, clear, state };
}

// --- Command line ---------------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdout.write('Paste the token from Workchop (Settings > Desktop helper): ');
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (process.stdin.isTTY && data.includes('\n')) process.stdin.destroy();
      if (data.includes('\n')) resolve(data.trim());
    });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function pair(args, { file, fetchFn = fetch, platform }) {
  const [address, given] = args;
  let server;
  try {
    server = new URL(address).origin;
  } catch {
    throw new Error('Usage: node workchop-presence.cjs pair <workchop address> [token]');
  }
  // From stdin by default, so the token doesn't show up in the process list.
  const token = given || (await readStdin());
  if (!TOKEN_FORMAT.test(token)) throw new Error('That is not a desktop helper token (it starts with wcp_).');
  const matchers = await fetchMatchers(server, fetchFn);
  const res = await send(server, token, { app: null, platform, v: 1 }, fetchFn);
  await res.body?.cancel().catch(() => {});
  if (res.status === 401) throw new Error('Workchop did not accept this token. Create a new one in Settings > Desktop helper.');
  if (res.status !== 204 && res.status !== 429) throw new Error(`Workchop answered ${res.status}.`);
  writeConfig(file, { server, token, matchers, matchersAt: Date.now() });
  console.log(`Paired with ${server}. Start it with: node ${path.basename(process.argv[1] || 'workchop-presence.cjs')} run`);
}

async function main(argv) {
  const [command = 'help', ...args] = argv;
  const file = configPath();
  const platform = platformName();
  const verbose = args.includes('--verbose');
  const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (!platform && command !== 'help') throw new Error(`This helper runs on macOS, Windows and Linux (not ${process.platform}).`);

  if (command === 'pair') return pair(args.filter((a) => !a.startsWith('--')), { file, platform });

  if (command === 'unpair') {
    fs.rmSync(file, { force: true });
    console.log('Removed the token from this computer. Remove the computer in Workchop too: Settings > Desktop helper.');
    return;
  }

  if (command === 'status' || command === 'run') {
    const config = readConfig(file);
    if (!config || !config.server || !config.token) throw new Error('Not paired yet. In Workchop, open Settings > Desktop helper and pair this computer.');
    const detect = createDetector({ platform, log });
    if (command === 'status') {
      if (detect.ready) {
        // Up to 10 s for the first answer.
        let timer;
        await Promise.race([detect.ready, new Promise((resolve) => (timer = setTimeout(resolve, 10000)))]);
        clearTimeout(timer);
      }
      const r = await detect();
      detect.stop?.();
      console.log(`Paired with ${config.server} (${file})`);
      console.log(r.unsupported ? "This desktop can't tell which app is in front." : `In front now: ${matchApp(config.matchers, platform, r.candidates || []) || 'nothing'}`);
      return;
    }
    const helper = createHelper({ config, platform, detect, file, log });
    log(`Sharing your current app with ${config.server}. Stop with Ctrl+C.`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      detect.stop?.();
      await Promise.race([helper.clear(), new Promise((resolve) => setTimeout(resolve, 3000))]);
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    for (;;) {
      try {
        const app = await helper.step();
        if (verbose) log(`detected ${app}`);
      } catch (err) {
        if (err instanceof Unpaired) throw err;
        log(`Something went wrong: ${err && err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  console.log(`Workchop desktop helper: shows your office which app you're using.

  node workchop-presence.cjs pair <workchop address> [token]   pair this computer (or pipe the token in)
  node workchop-presence.cjs run [--verbose]                    share your current app
  node workchop-presence.cjs status                             what it would send now
  node workchop-presence.cjs unpair                             forget the token

Only the app's id from Workchop's list is sent (unknown apps as "other"), never window titles.
Config: ${configPath()}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { matchApp, createDetector, createHelper, configPath, readConfig, writeConfig, swayFocused, parseGnome, windowsScript, pair, HEARTBEAT_MS, POLL_MS };
