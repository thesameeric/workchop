import { clip } from './text';

// Weather by each person's location: what the server's /api/weather answers, how WMO weather codes
// map to what the scene shows, and the little each person may share with others (opt-in).

/** What the scene and the weather chip show, from the WMO weather code. */
export type WeatherCondition = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder';

/**
 * The condition for a WMO weather code (Open-Meteo's `weather_code`). Unknown codes count as cloudy:
 * the code table on Open-Meteo's website and its server don't agree on every code.
 */
export function conditionOf(code: number): WeatherCondition {
  if (!Number.isInteger(code)) return 'cloudy';
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'thunder';
  return 'cloudy';
}

/**
 * A coordinate rounded to 0.1° (about 11 km), which is all that leaves the browser and all the server
 * asks Open-Meteo for: one cache cell per rounded pair, and no precise location in anyone's logs.
 */
export function roundCoord(v: number): number {
  // + 0 turns -0 into 0, so both halves of the equator share a cell.
  return Math.round(v * 10) / 10 + 0;
}

export function isLatitude(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}

export function isLongitude(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

/** A place to show the weather for, with its coordinates rounded (roundCoord). */
export interface WeatherPlace {
  /** "Lisbon", or null when unknown (e.g. the browser's location). */
  name: string | null;
  /** Region and country, for telling places with the same name apart. */
  region?: string;
  country?: string;
  lat: number;
  lon: number;
  /** IANA time zone, e.g. "Europe/Lisbon", when known. */
  timezone?: string;
}

/** Where the place whose weather you see comes from, in order of preference. */
export type WeatherSource = 'city' | 'device' | 'ip' | 'none';

/** GET /api/weather?lat=&lon= (both rounded): the weather right now in that cell. */
export interface WeatherReport {
  lat: number;
  lon: number;
  /** WMO weather code; see conditionOf. */
  code: number;
  isDay: boolean;
  tempC: number;
  /** Cloud cover, 0–100 %. */
  cloudCover: number;
  /** Rain, showers and snow together, in mm over the last 15 minutes. */
  precipitation: number;
  /** Rain and showers in mm, snowfall in cm, over the last 15 minutes. */
  rain: number;
  snowfall: number;
  /** Wind at 10 m in km/h, and the direction it blows from (degrees, 0 = from the north). */
  windKph: number;
  windDir: number;
  /** Visibility in metres, or null when Open-Meteo has none. */
  visibility: number | null;
  /** The place's offset from UTC in seconds right now, and its IANA time zone. */
  utcOffset: number;
  timezone: string;
  /**
   * When Open-Meteo was asked (ms since 1970). The server answers with the same report for 16–19
   * minutes, and for up to 3 hours while it can't ask Open-Meteo again.
   */
  fetchedAt: number;
}

/** GET /api/weather/here: the visitor's approximate place from their connection, when the server knows it. */
export interface WeatherHere {
  place: WeatherPlace | null;
  /** The server has no weather (WEATHER=off). */
  off?: true;
}

/** What someone shares with others in the office about their weather (Settings > Weather, off by default). No place. */
export interface SharedWeather {
  code: number;
  isDay: boolean;
  tempC: number;
  /** Their offset from UTC in seconds, to show their local time. */
  utcOffset: number;
}

/** A SharedWeather built from untrusted input, or null. */
export function sanitizeSharedWeather(raw: unknown): SharedWeather | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const { code, tempC, utcOffset } = r;
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 99) return null;
  if (typeof tempC !== 'number' || !Number.isFinite(tempC) || tempC < -100 || tempC > 70) return null;
  if (typeof utcOffset !== 'number' || !Number.isInteger(utcOffset) || Math.abs(utcOffset) > 14 * 3600) return null;
  return { code, isDay: r.isDay === true, tempC: Math.round(tempC * 10) / 10, utcOffset };
}

/** A place name from untrusted input (a profile setting, a proxy header), or null. */
export function sanitizePlaceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = clip(raw.replace(/[\u0000-\u001f\u007f]/g, '').trim(), 60);
  return name || null;
}

declare module './types' {
  interface PlayerState {
    /** Their local weather, when they chose to share it (Settings > Weather). */
    weather?: SharedWeather | null;
  }
  interface ClientToServerEvents {
    /** Share your local weather with the office (null stops sharing). */
    'weather:share': (weather: SharedWeather | null) => void;
  }
}
