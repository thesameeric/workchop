import { sanitizeManualApp, type AppPlatform } from './apps';

// The current-app indicator's socket events. PlayerState.app (shared/types.ts) carries what
// everyone sees: an app id from shared/apps.ts, or null.

/** A status picked by hand ("Working in Figma"), until a time or (until: null) until cleared. */
export interface ManualApp {
  app: string;
  until: number | null;
}

/** What you send about yourself. Fields left out stay as they are. */
export interface PresenceUpdate {
  /** Your hand-picked status; null clears it. It wins over the desktop helper. */
  manual?: ManualApp | null;
  /** Show the app your desktop helper reports (the "Share what app I'm using" setting). */
  share?: boolean;
  /** Show apps that aren't in the list as "Working" (otherwise they're hidden). */
  others?: boolean;
  /** Sent after reconnecting: `manual` applies only if the server no longer knows you. */
  restore?: boolean;
}

/** Your own presence, sent only to you whenever it changes. */
export interface PresenceState {
  /** What others see next to your name now. */
  app: string | null;
  manual: ManualApp | null;
  /** What your desktop helper last reported, while it's running. */
  helper: { app: string | null; platform: AppPlatform; unsupported: boolean } | null;
}

/** A paired desktop helper (GET /api/me/devices). */
export interface HelperDevice {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Reported in the last minute. */
  active: boolean;
  platform: AppPlatform | null;
}

/** What the helper sends to PUT /api/me/app-presence. */
export interface HelperReport {
  app: string | null;
  platform: AppPlatform;
  v: 1;
  /** This computer can't tell which app is in front (e.g. a Wayland desktop without support). */
  unsupported?: boolean;
}

declare module './types' {
  interface ClientToServerEvents {
    'presence:set': (update: PresenceUpdate) => void;
  }
  interface ServerToClientEvents {
    'presence:state': (state: PresenceState) => void;
  }
}

/** Keeps only the valid parts of an update from a client; null if there's nothing usable. */
export function sanitizePresenceUpdate(raw: unknown): PresenceUpdate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: PresenceUpdate = {};
  if (r.manual === null) out.manual = null;
  else if (r.manual && typeof r.manual === 'object') {
    const m = r.manual as Record<string, unknown>;
    const app = sanitizeManualApp(m.app);
    const until = m.until ?? null;
    if (!app || (until !== null && (typeof until !== 'number' || !Number.isFinite(until)))) return null;
    out.manual = { app, until };
  }
  if (typeof r.share === 'boolean') out.share = r.share;
  if (typeof r.others === 'boolean') out.others = r.others;
  if (r.restore === true && out.manual) out.restore = true;
  return Object.keys(out).length ? out : null;
}
