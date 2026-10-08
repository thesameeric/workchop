import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appMatchers, matchApp, type AppPlatform } from '../shared/apps';
import { until } from './helpers/http';

// The desktop helper (helper/workchop-presence.cjs) against a fake Workchop server, with the
// commands it runs to read the frontmost app stubbed out.

type Exec = (cmd: string, args: string[]) => Promise<string>;
type Detect = () => Promise<{ candidates?: string[]; unsupported?: boolean }>;
interface Helper {
  step(): Promise<string | null>;
  clear(): Promise<void>;
  state: { last: string | null | undefined; waitUntil: number };
}
const helper = createRequire(import.meta.url)('../helper/workchop-presence.cjs') as {
  matchApp(m: unknown, platform: AppPlatform, candidates: string[]): string | null;
  createDetector(opts: { platform: AppPlatform; exec?: Exec; env?: Record<string, string>; spawn?: () => unknown }): Detect & { ready?: Promise<void>; stop?: () => void };
  createHelper(opts: { config: object; platform: AppPlatform; detect: Detect; fetch?: typeof fetch; now?: () => number }): Helper;
  swayFocused(tree: unknown): (string | null | undefined)[] | null;
  parseGnome(out: string): string[];
  windowsScript(pid: number): string;
  HEARTBEAT_MS: number;
};
const HELPER = path.resolve('helper/workchop-presence.cjs');

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

let server: Server;
let base: string;
const requests: Seen[] = [];
/** How the fake server answers a report. */
let answer: (req: Seen) => { status: number; headers?: Record<string, string> } = () => ({ status: 204 });

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const seen = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: await readBody(req) };
    requests.push(seen);
    if (req.url === '/api/app-presence/apps') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(appMatchers()));
      return;
    }
    const { status, headers } = answer(seen);
    res.writeHead(status, headers).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests.length = 0;
  answer = () => ({ status: 204 });
});

const TOKEN = `wcp_${'A'.repeat(43)}`;
const config = () => ({ server: base, token: TOKEN, matchers: appMatchers() });
const reports = () => requests.filter((r) => r.url === '/api/me/app-presence').map((r) => JSON.parse(r.body));

/** An X11 desktop whose active window has this WM_CLASS ("0x0" for none). */
function x11(state: { window: string; cls: string }, calls: string[][]): Exec {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'xprop') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (args.includes('-root')) return `_NET_ACTIVE_WINDOW: window id # ${state.window}\n`;
    if (args.includes('WM_CLASS')) return `WM_CLASS = ${state.cls}\n`;
    throw new Error('unexpected xprop call');
  };
}

describe('desktop helper', () => {
  it('matches apps exactly like the server', () => {
    const cases: [AppPlatform, string[]][] = [
      ['macos', ['com.figma.Desktop']],
      ['macos', ['com.google.Chrome.beta']],
      ['macos', ['com.apple.loginwindow']],
      ['windows', ['Code']],
      ['windows', ['Idle']],
      ['windows', ['NotOnTheList']],
      ['linux', ['code', 'Code']],
      ['linux', []],
    ];
    for (const [platform, candidates] of cases) expect(helper.matchApp(appMatchers(), platform, candidates)).toBe(matchApp(platform, candidates));
  });

  it('reads only WM_CLASS on X11, and sends only on change or heartbeat', async () => {
    const window = { window: '0x3a00007', cls: '"code", "Code"' };
    const calls: string[][] = [];
    let t = 1_000_000;
    const h = helper.createHelper({
      config: config(),
      platform: 'linux',
      detect: helper.createDetector({ platform: 'linux', exec: x11(window, calls), env: { DISPLAY: ':0' } }),
      now: () => t,
    });
    expect(await h.step()).toBe('vscode');
    expect(reports()).toEqual([{ app: 'vscode', platform: 'linux', v: 1 }]);
    expect(requests[0].method).toBe('PUT');
    expect(requests[0].auth).toBe(`Bearer ${TOKEN}`);
    // Never titles: only the active window id and its class are asked for.
    expect(calls.flat().some((a) => /NAME/.test(a))).toBe(false);

    t += 5000;
    await h.step();
    expect(reports()).toHaveLength(1);
    t += helper.HEARTBEAT_MS;
    await h.step();
    expect(reports()).toHaveLength(2);

    // Unknown apps leave as "other", without their name.
    window.cls = '"secret-diary", "Secret-diary"';
    t += 5000;
    expect(await h.step()).toBe('other');
    expect(reports().at(-1)).toEqual({ app: 'other', platform: 'linux', v: 1 });
    expect(requests.some((r) => r.body.includes('secret'))).toBe(false);

    // No active window: nothing.
    window.window = '0x0';
    t += 5000;
    expect(await h.step()).toBeNull();
    expect(reports().at(-1)).toEqual({ app: null, platform: 'linux', v: 1 });
  });

  it('backs off when Workchop says so, and stops when unpaired', async () => {
    const window = { window: '0x1', cls: '"slack", "Slack"' };
    let t = 2_000_000;
    const h = helper.createHelper({
      config: config(),
      platform: 'linux',
      detect: helper.createDetector({ platform: 'linux', exec: x11(window, []), env: { DISPLAY: ':0' } }),
      now: () => t,
    });
    answer = () => ({ status: 204, headers: { 'Retry-After': '60' } });
    await h.step();
    expect(reports()).toHaveLength(1);
    // Nobody online: even a change waits for the Retry-After.
    window.cls = '"figma-linux", "figma-linux"';
    t += 30_000;
    await h.step();
    expect(reports()).toHaveLength(1);
    t += 31_000;
    answer = () => ({ status: 429, headers: { 'Retry-After': '2' } });
    await h.step();
    expect(reports()).toHaveLength(2);
    t += 1000;
    await h.step();
    expect(reports()).toHaveLength(2);
    t += 1500;
    answer = () => ({ status: 204 });
    await h.step();
    expect(reports().at(-1)).toEqual({ app: 'figma', platform: 'linux', v: 1 });

    answer = () => ({ status: 401 });
    window.cls = '"code", "Code"';
    t += 5000;
    await expect(h.step()).rejects.toThrow(/removed/);
  });

  it('says so when a Wayland desktop gives no way to tell', async () => {
    const h = helper.createHelper({
      config: config(),
      platform: 'linux',
      detect: helper.createDetector({ platform: 'linux', exec: x11({ window: '0x1', cls: '"code"' }, []), env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' } }),
    });
    expect(await h.step()).toBeNull();
    expect(reports()).toEqual([{ app: null, platform: 'linux', v: 1, unsupported: true }]);
  });

  it('reads Sway, Hyprland, niri and GNOME without titles', async () => {
    const tree = {
      type: 'root',
      nodes: [{ type: 'output', nodes: [{ type: 'workspace', nodes: [{ type: 'con', focused: false, app_id: 'foot', name: 'term' }] }] }],
      floating_nodes: [{ type: 'floating_con', focused: true, app_id: null, name: 'Private - Slack', window_properties: { class: 'Slack', instance: 'slack', title: 'Private' } }],
    };
    expect(helper.swayFocused(tree)).toEqual([null, 'Slack', 'slack']);
    expect(helper.parseGnome(`('{"title":"Secret plan - Visual Studio Code","wm_class":"Code","wm_class_instance":"code","pid":42}',)`)).toEqual(['code', 'Code']);
    expect(helper.parseGnome(`('{"title":"It\\'s mine","wm_class":"firefox","wm_class_instance":"Navigator"}',)`)).toEqual(['Navigator', 'firefox']);

    const outputs: Record<string, string> = {
      swaymsg: JSON.stringify(tree),
      hyprctl: JSON.stringify({ class: 'code', title: 'secret', initialClass: 'code' }),
      niri: JSON.stringify({ app_id: 'org.gnome.ptyxis', title: 'secret' }),
    };
    const exec: Exec = async (cmd) => outputs[cmd];
    const detect = (env: Record<string, string>) => helper.createDetector({ platform: 'linux', exec, env: { WAYLAND_DISPLAY: 'wayland-1', ...env } })();
    expect(matchApp('linux', (await detect({ SWAYSOCK: '/run/sway' })).candidates!)).toBe('slack');
    expect(matchApp('linux', (await detect({ HYPRLAND_INSTANCE_SIGNATURE: 'x' })).candidates!)).toBe('vscode');
    expect(matchApp('linux', (await detect({ NIRI_SOCKET: '/run/niri' })).candidates!)).toBe('terminal');
    // GNOME without the extension installed can't tell.
    const noExtension: Exec = async () => {
      throw new Error('GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Object does not exist');
    };
    expect(await helper.createDetector({ platform: 'linux', exec: noExtension, env: { WAYLAND_DISPLAY: 'w', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' } })()).toEqual({ unsupported: true });
  });

  it('uses NSWorkspace on macOS and the foreground window on Windows', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return 'com.figma.Desktop\n';
    };
    const r = await helper.createDetector({ platform: 'macos', exec })();
    expect(matchApp('macos', r.candidates!)).toBe('figma');
    expect(calls[0].slice(0, 3)).toEqual(['osascript', '-l', 'JavaScript']);
    expect(calls[0].join(' ')).toContain('NSWorkspace');
    expect(calls[0].join(' ')).not.toMatch(/System Events|localizedName/);

    const ps = helper.windowsScript(1234);
    expect(ps).toContain('GetForegroundWindow');
    expect(ps).toContain('FullLanguage');
    expect(ps).toContain('[IntPtr]::Zero');
    expect(ps).toContain('Get-Process -Id 1234');
    expect(ps).not.toMatch(/MainWindowTitle|GetWindowText/);
  });

  it('can wait for PowerShell’s first answer on Windows (its first start can be slow)', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { on() {}, end() {} }, kill() {} });
    const detect = helper.createDetector({ platform: 'windows', spawn: () => child });
    expect(await detect()).toEqual({ candidates: [''] });
    setTimeout(() => child.stdout.emit('data', 'noise\r\n=Co'), 20);
    setTimeout(() => child.stdout.emit('data', 'de\r\n'), 40);
    await detect.ready;
    expect(await detect()).toEqual({ candidates: ['Code'] });
    detect.stop!();
  });
});

describe('desktop helper command line', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'workchop-helper-'));
    // A stand-in xprop: VS Code is in front.
    const xprop = path.join(dir, 'xprop');
    writeFileSync(
      xprop,
      `#!/bin/sh
case "$*" in
  *-root*) echo "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2c00004" ;;
  *WM_CLASS*) echo 'WM_CLASS(STRING) = "code", "Code"' ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(xprop, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], input?: string) => {
    const env: NodeJS.ProcessEnv = {
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      HOME: dir,
      DISPLAY: ':0',
      WORKCHOP_HELPER_CONFIG: path.join(dir, 'conf', 'helper.json'),
    };
    const child = spawn(process.execPath, [HELPER, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.stdin.end(input ?? '');
    const done = new Promise<number | null>((resolve) => child.on('exit', resolve));
    return { child, done, output: () => out };
  };

  it.skipIf(process.platform !== 'linux')('pairs with a piped token, then reports and clears on exit', async () => {
    const bad = run(['pair', base], 'not-a-token\n');
    expect(await bad.done).toBe(1);
    expect(bad.output()).toMatch(/not a desktop helper token/);

    const pair = run(['pair', `${base}/office/abc`], `${TOKEN}\n`);
    expect(await pair.done).toBe(0);
    const file = path.join(dir, 'conf', 'helper.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ server: base, token: TOKEN, matchers: { v: 1 } });
    expect(reports()).toEqual([{ app: null, platform: 'linux', v: 1 }]);
    requests.length = 0;

    const helperRun = run(['run']);
    await until(() => reports().some((r) => r.app === 'vscode'), 10_000);
    helperRun.child.kill('SIGTERM');
    expect(await helperRun.done).toBe(0);
    expect(reports().at(-1)).toEqual({ app: null, platform: 'linux', v: 1 });
    expect(requests.every((r) => r.auth === `Bearer ${TOKEN}` || r.method === 'GET')).toBe(true);
  }, 20_000);
});
