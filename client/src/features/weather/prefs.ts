import { toPlace } from './places';
import type { WeatherPrefs } from './state';

// Weather preferences in this browser (localStorage) and, for signed-in people, with the account:
// one settings key holding a short JSON string. Only rounded cells and place names are kept.

export const PREFS_KEY = 'workchop:weather';
/** A change this browser couldn't save to the account (see Unsynced). */
const UNSYNCED_KEY = 'workchop:weather-unsynced';
/** The account setting, and the most the server keeps of a setting's text. */
export const SETTING = 'weather';
const SETTING_MAX = 200;

/**
 * Where °F is the usual unit: CLDR's list (the US, Puerto Rico, the Bahamas, Belize, the Cayman Islands
 * and Palau) and the other places the US weather service covers.
 */
const FAHRENHEIT = new Set(['US', 'PR', 'BS', 'BZ', 'KY', 'PW', 'AS', 'GU', 'MP', 'UM', 'VI', 'FM', 'MH']);

/** °C or °F, by the region of a browser language ("en" counts as "en-US"). */
export function unitsFor(language: string): 'c' | 'f' {
  try {
    const region = new Intl.Locale(language).maximize().region;
    return region && FAHRENHEIT.has(region) ? 'f' : 'c';
  } catch {
    return 'c';
  }
}

const defaultUnits = () => unitsFor(navigator.language);

const isUnits = (v: unknown): v is 'c' | 'f' => v === 'c' || v === 'f';

export function loadPrefs(): WeatherPrefs {
  let saved: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    if (raw && typeof raw === 'object') saved = raw as Record<string, unknown>;
  } catch {
    // Unreadable or unavailable: the defaults.
  }
  return {
    enabled: saved.enabled !== false,
    units: isUnits(saved.units) ? saved.units : defaultUnits(),
    share: saved.share === true,
    city: toPlace(saved.city),
    device: toPlace(saved.device),
  };
}

export function savePrefs(prefs: WeatherPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not saved; they still apply until the page is reloaded.
  }
}

/** The preferences that follow a signed-in person to other devices (not the device's own location). */
export type SyncedPrefs = Pick<WeatherPrefs, 'enabled' | 'units' | 'share' | 'city'>;

/** The account setting's text: short enough for the server to keep whole (region and country go first). */
export function encodeSynced({ enabled, units, share, city }: SyncedPrefs): string {
  const { name, lat, lon, region, country } = city ?? {};
  const cities = city
    ? [{ name, lat, lon, region, country }, { name, lat, lon, country }, { name, lat, lon }, { name: null, lat, lon }]
    : [null];
  let text = '';
  for (const c of cities) {
    text = JSON.stringify({ enabled, units, share, city: c });
    if (text.length <= SETTING_MAX) break;
  }
  return text;
}

/** The preferences in an account setting, or null when it isn't one. */
export function decodeSynced(raw: unknown): SyncedPrefs | null {
  if (typeof raw !== 'string') return null;
  try {
    const r: unknown = JSON.parse(raw);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const { enabled, units, share, city } = r as Record<string, unknown>;
    return { enabled: enabled !== false, units: isUnits(units) ? units : defaultUnits(), share: share === true, city: toPlace(city) };
  } catch {
    return null;
  }
}

/**
 * A change this browser couldn't save to someone's account, and the account's setting at the time
 * (null: none). While the account still has that, the change is saved later instead of undone.
 */
export interface Unsynced {
  user: string;
  base: string | null;
}

export function loadUnsynced(): Unsynced | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(UNSYNCED_KEY) ?? 'null');
    const { user, base } = (raw ?? {}) as Record<string, unknown>;
    return typeof user === 'string' && (base === null || typeof base === 'string') ? { user, base } : null;
  } catch {
    return null;
  }
}

export function saveUnsynced(unsynced: Unsynced | null): void {
  try {
    if (unsynced) localStorage.setItem(UNSYNCED_KEY, JSON.stringify(unsynced));
    else localStorage.removeItem(UNSYNCED_KEY);
  } catch {
    // Not kept: the account's setting wins on the next page load.
  }
}
