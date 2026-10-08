import { create } from 'zustand';
import type { WeatherPlace, WeatherReport, WeatherSource } from '../../../../shared/weather';
import { resolvePlace } from './places';
import { loadPrefs } from './prefs';

/** Your weather preferences: kept in this browser, and the shareable parts with your account. */
export interface WeatherPrefs {
  /** "Show my local weather" (default on). Off: a fixed daytime scene and no weather chip. */
  enabled: boolean;
  units: 'c' | 'f';
  /** Show your weather and local time to others in the office (default off). */
  share: boolean;
  /** A city you chose (Settings > Weather); wins over every other source. */
  city: WeatherPlace | null;
  /** Your device's location, rounded, after you clicked "Use my location". */
  device: WeatherPlace | null;
}

export interface WeatherState {
  prefs: WeatherPrefs;
  /** Whether this server has weather (false when its /api/weather routes are missing); null until known. */
  available: boolean | null;
  /** Your approximate place from your connection (GET /api/weather/here), when the server knows it. */
  here: WeatherPlace | null;
  /** Where `place` came from, and the place whose weather you see (null: none, so a fixed daytime scene). */
  source: WeatherSource;
  place: WeatherPlace | null;
  /** The latest weather for `place`, or null while there is none. */
  report: WeatherReport | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Why the last update failed (the last report stays meanwhile). */
  error: string | null;
  /** Waiting for the browser's location, and why the last try failed. */
  locating: boolean;
  locateError: string | null;
}

const prefs = loadPrefs();

export const useWeather = create<WeatherState>()(() => ({
  prefs,
  available: null,
  here: null,
  ...resolvePlace(prefs, null),
  report: null,
  status: 'idle',
  error: null,
  locating: false,
  locateError: null,
}));
