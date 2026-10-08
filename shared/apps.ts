// The apps Workchop can show next to someone's name ("In Figma"), and how the desktop helper
// recognises them. The helper maps the frontmost app to one of these ids on the person's own
// computer and sends only the id: never app names it doesn't know, and never window titles.

export type AppPlatform = 'macos' | 'windows' | 'linux';
export const APP_PLATFORMS: readonly AppPlatform[] = ['macos', 'windows', 'linux'];

export interface AppDef {
  id: string;
  label: string;
  /** A Hugeicons name (client/src/ui/icon-names.json). */
  icon: string;
  /** Brand-ish accent colour for the chip. */
  color: string;
  /**
   * What the helper matches, lower case: macOS bundle ids, Windows process names (without .exe),
   * Linux WM_CLASS / Wayland app ids. A trailing * matches a prefix. None: only picked by hand.
   */
  match?: Partial<Record<AppPlatform, string[]>>;
}

/** Shown as "Working" for any app that isn't in the list. */
export const OTHER_APP = 'other';
/** Picked by hand only: busy with something, please don't disturb. */
export const HEADS_DOWN = 'focus';

export const APPS: readonly AppDef[] = [
  {
    id: 'figma',
    label: 'Figma',
    icon: 'figma',
    color: '#a259ff',
    match: { macos: ['com.figma.desktop', 'com.figma.agent'], windows: ['figma'], linux: ['figma-linux', 'figma'] },
  },
  {
    id: 'vscode',
    label: 'VS Code',
    icon: 'visual-studio-code',
    color: '#1f8ad2',
    match: {
      macos: ['com.microsoft.vscode', 'com.microsoft.vscodeinsiders', 'com.vscodium'],
      windows: ['code', 'code - insiders', 'vscodium'],
      linux: ['code', 'code-oss', 'code - insiders', 'vscodium', 'com.visualstudio.code'],
    },
  },
  {
    id: 'slack',
    label: 'Slack',
    icon: 'slack',
    color: '#e01e5a',
    match: { macos: ['com.tinyspeck.slackmacgap'], windows: ['slack'], linux: ['slack', 'com.slack.slack'] },
  },
  {
    id: 'chrome',
    label: 'Chrome',
    icon: 'chrome',
    color: '#1a73e8',
    match: {
      macos: ['com.google.chrome', 'com.google.chrome.*', 'org.chromium.chromium'],
      windows: ['chrome'],
      linux: ['google-chrome', 'google-chrome-*', 'chromium', 'chromium-browser', 'com.google.chrome'],
    },
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: 'browser',
    color: '#0f9d8a',
    match: {
      macos: ['com.apple.safari', 'org.mozilla.firefox', 'com.microsoft.edgemac', 'company.thebrowser.browser', 'com.brave.browser'],
      windows: ['firefox', 'msedge', 'brave', 'arc', 'opera'],
      linux: ['firefox', 'firefox-esr', 'org.mozilla.firefox', 'navigator', 'microsoft-edge', 'brave-browser', 'zen'],
    },
  },
  { id: 'notion', label: 'Notion', icon: 'notion-01', color: '#787774', match: { macos: ['notion.id'], windows: ['notion'], linux: ['notion', 'notion-app'] } },
  { id: 'linear', label: 'Linear', icon: 'kanban', color: '#5e6ad2', match: { macos: ['com.linear'], windows: ['linear'], linux: ['linear'] } },
  {
    id: 'zoom',
    label: 'Zoom',
    icon: 'computer-video-call',
    color: '#2d8cff',
    match: { macos: ['us.zoom.xos'], windows: ['zoom'], linux: ['zoom', 'us.zoom.zoom'] },
  },
  {
    id: 'teams',
    label: 'Teams',
    icon: 'user-multiple',
    color: '#6264a7',
    match: { macos: ['com.microsoft.teams2', 'com.microsoft.teams'], windows: ['ms-teams', 'teams'], linux: ['teams-for-linux'] },
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: 'computer-terminal-01',
    color: '#4d5b6b',
    match: {
      macos: ['com.apple.terminal', 'com.googlecode.iterm2', 'dev.warp.warp-stable', 'com.mitchellh.ghostty', 'net.kovidgoyal.kitty', 'org.alacritty', 'com.github.wez.wezterm'],
      windows: ['windowsterminal', 'cmd', 'powershell', 'pwsh', 'wezterm-gui', 'alacritty'],
      linux: [
        'gnome-terminal-server',
        'org.gnome.terminal',
        'org.gnome.ptyxis',
        'org.gnome.console',
        'kgx',
        'konsole',
        'org.kde.konsole',
        'kitty',
        'alacritty',
        'foot',
        'footclient',
        'xterm',
        'wezterm',
        'org.wezfurlong.wezterm',
        'tilix',
        'terminator',
        'com.mitchellh.ghostty',
      ],
    },
  },
  { id: 'xcode', label: 'Xcode', icon: 'source-code', color: '#147efb', match: { macos: ['com.apple.dt.xcode'] } },
  { id: 'jira', label: 'Jira', icon: 'check-list', color: '#2684ff' },
  { id: 'docs', label: 'Docs', icon: 'google-doc', color: '#4285f4' },
  { id: 'sheets', label: 'Sheets', icon: 'google-sheet', color: '#0f9d58' },
  { id: 'excel', label: 'Excel', icon: 'file-spreadsheet', color: '#1d8f4e', match: { macos: ['com.microsoft.excel'], windows: ['excel'] } },
  { id: 'word', label: 'Word', icon: 'file-text', color: '#2b6cd4', match: { macos: ['com.microsoft.word'], windows: ['winword'] } },
  {
    id: 'photoshop',
    label: 'Photoshop',
    icon: 'adobe-photoshop',
    color: '#31a8ff',
    match: { macos: ['com.adobe.photoshop'], windows: ['photoshop'] },
  },
];

/** Not an app someone is working in (lock screen, login window, nothing focused): reported as nothing. */
export const IGNORED_APPS: Readonly<Record<AppPlatform, readonly string[]>> = {
  macos: ['com.apple.loginwindow', 'com.apple.screensaver.engine', 'com.apple.screensaver'],
  windows: ['idle', 'lockapp', 'logonui', 'searchhost', 'shellexperiencehost'],
  linux: [],
};

const OTHER_DEF: AppDef = { id: OTHER_APP, label: 'Working', icon: 'work', color: '#7b8494' };
const HEADS_DOWN_DEF: AppDef = { id: HEADS_DOWN, label: 'Heads-down', icon: 'center-focus', color: '#e2913a' };
const BY_ID = new Map<string, AppDef>([...APPS, OTHER_DEF, HEADS_DOWN_DEF].map((a) => [a.id, a]));

/** An app's details; unknown ids show as "Working". */
export function appInfo(id: string): AppDef {
  return BY_ID.get(id) ?? OTHER_DEF;
}

/** What a desktop helper may report: an app id, "other", or nothing. Anything else is nothing. */
export function sanitizeHelperApp(v: unknown): string | null {
  return typeof v === 'string' && v !== HEADS_DOWN && BY_ID.has(v) ? v : null;
}

/** What someone may pick by hand: any app id, "other" or heads-down. */
export function sanitizeManualApp(v: unknown): string | null {
  return typeof v === 'string' && BY_ID.has(v) ? v : null;
}

export function isAppPlatform(v: unknown): v is AppPlatform {
  return typeof v === 'string' && (APP_PLATFORMS as readonly string[]).includes(v);
}

/** The matchers the desktop helper downloads (GET /api/app-presence/apps). */
export interface AppMatchers {
  v: 1;
  apps: { id: string; match: Partial<Record<AppPlatform, string[]>> }[];
  ignore: Record<AppPlatform, readonly string[]>;
}

export function appMatchers(): AppMatchers {
  return { v: 1, apps: APPS.filter((a) => a.match).map((a) => ({ id: a.id, match: a.match! })), ignore: IGNORED_APPS };
}

const matches = (pattern: string, value: string) => (pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern);

/**
 * The app id for what a computer reports as frontmost: `candidates` are its identifiers (on Linux
 * WM_CLASS has two: instance and class), tried in order. Unknown apps are "other"; nothing (or the
 * lock screen) is null. The helper (helper/workchop-presence.cjs) does exactly the same.
 */
export function matchApp(platform: AppPlatform, candidates: (string | null | undefined)[], m: AppMatchers = appMatchers()): string | null {
  const values = candidates.map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : '')).filter(Boolean);
  if (!values.length || values.some((v) => m.ignore[platform].includes(v))) return null;
  for (const value of values) {
    for (const app of m.apps) if (app.match[platform]?.some((p) => matches(p, value))) return app.id;
  }
  return OTHER_APP;
}

/** How long a helper's report counts without a heartbeat. */
export const HELPER_TTL_MS = 45_000;
/** Longest a hand-picked status can be set to last ("today" is at most this). */
export const MANUAL_MAX_MS = 24 * 60 * 60 * 1000;
