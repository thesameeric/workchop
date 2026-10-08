import { isLatitude, isLongitude, roundCoord, sanitizePlaceName, type WeatherPlace, type WeatherReport } from '../../../shared/weather';
import { timeZoneName } from './geo';

// Open-Meteo (https://open-meteo.com) behind a cache. The free API allows each IP one request at a
// time and 600 calls a minute, 5,000 an hour and 10,000 a day (counters reset on UTC boundaries,
// failed calls count too), and the whole server shares one IP, so: one cache entry per 0.1° cell, one
// request at a time, a daily budget (an eighth of it at most in any UTC hour), and a pause until the
// boundary a 429 names. Counts and pauses are kept in memory: a restart starts them again.

/** Exactly 10 variables: an 11th would make each request count as 1.1 calls. */
const CURRENT = 'temperature_2m,weather_code,is_day,cloud_cover,precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m,visibility';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Open-Meteo updates current conditions every 15 minutes; 1–4 random minutes more spread the refreshes. */
const TTL = 15 * MINUTE;
/** While Open-Meteo can't be asked, a report up to this old is still served. */
const STALE = 3 * HOUR;
/** After a failed request for a cell (or a search), the next try waits this long; for a cell, twice as long after each further failure, up to MAX_COOLDOWN. */
const COOLDOWN = MINUTE;
const MAX_COOLDOWN = 15 * MINUTE;
/** Open-Meteo resets its counters a few seconds after each UTC boundary. */
const GRACE = 5000;
/** After a 429 that names no minutely, hourly or daily limit (say, too many concurrent requests). */
const SHORT_PAUSE = MINUTE;
const TIMEOUT = 5000;
const PLACES_TTL = DAY;
const MAX_SEARCHES = 500;
/** Requests waiting for their turn; past that, askers are told to come back shortly. */
const MAX_WAITING = 50;

export interface OpenMeteoOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** For the cache's jitter: 0 ≤ x < 1. */
  random?: () => number;
  /** A paid plan's key (OPEN_METEO_API_KEY): uses the customer hosts. */
  apiKey?: string | null;
  /**
   * Calls a UTC day the server allows itself, failed ones and place searches included; an eighth of them
   * at most in a UTC hour. 8,000 by default, 30,000 with an API key.
   */
  dailyBudget?: number;
  /** Cells kept in memory (the ones updated longest ago go first). */
  maxCells?: number;
}

/** Open-Meteo can't be asked right now; try again at `retryAt` (ms since 1970). */
export class WeatherUnavailable extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message);
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integerIn = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
/** A measurement that may be missing (then 0), kept within 0…max. */
const amount = (v: unknown, max = Infinity) => (isNum(v) ? Math.min(Math.max(v, 0), max) : 0);

/** Open-Meteo's forecast answer as a WeatherReport; throws when it isn't what was asked for. */
function toReport(body: unknown, lat: number, lon: number, fetchedAt: number): WeatherReport {
  const { current, utc_offset_seconds: utcOffset, timezone } = (body ?? {}) as Record<string, unknown>;
  if (!current || typeof current !== 'object') throw new Error('Open-Meteo sent no current weather');
  const v = current as Record<string, unknown>;
  const { temperature_2m: tempC, weather_code: code, is_day: isDay, visibility } = v;
  if (!isNum(tempC) || !integerIn(code, 0, 99) || !integerIn(isDay, 0, 1) || !integerIn(utcOffset, -14 * 3600, 14 * 3600)) {
    throw new Error('Open-Meteo sent unexpected weather');
  }
  return {
    lat,
    lon,
    code,
    isDay: isDay === 1,
    tempC,
    cloudCover: amount(v.cloud_cover, 100),
    precipitation: amount(v.precipitation),
    rain: amount(v.rain),
    snowfall: amount(v.snowfall),
    windKph: amount(v.wind_speed_10m),
    windDir: amount(v.wind_direction_10m, 360),
    visibility: isNum(visibility) && visibility >= 0 ? visibility : null,
    utcOffset,
    timezone: timeZoneName(timezone) ?? 'GMT',
    fetchedAt,
  };
}

/** Open-Meteo's geocoding answer as up to 5 places, rounded; entries that don't make sense are skipped. */
function toPlaces(body: unknown): WeatherPlace[] {
  const results = (body as { results?: unknown } | null)?.results;
  // No matches: no `results` at all.
  if (results === undefined) return [];
  if (!Array.isArray(results)) throw new Error('Open-Meteo sent unexpected places');
  const places: WeatherPlace[] = [];
  for (const r of results as Record<string, unknown>[]) {
    const name = sanitizePlaceName(r?.name);
    if (!name || !isLatitude(r.latitude) || !isLongitude(r.longitude)) continue;
    const place: WeatherPlace = { name, lat: roundCoord(r.latitude), lon: roundCoord(r.longitude) };
    const region = sanitizePlaceName(r.admin1);
    const country = sanitizePlaceName(r.country);
    const timezone = timeZoneName(r.timezone);
    if (region) place.region = region;
    if (country) place.country = country;
    if (timezone) place.timezone = timezone;
    if (places.push(place) === 5) break;
  }
  return places;
}

/**
 * When to ask again after a 429 at `t`: just after the end of the UTC minute, hour or day whose limit
 * it names (one that came within GRACE after a boundary still belongs to the period before), or
 * shortly when it names none.
 */
function pauseEnd(reason: unknown, t: number): number {
  const text = typeof reason === 'string' ? reason : '';
  const unit = /^minutely/i.test(text) ? MINUTE : /^hourly/i.test(text) ? HOUR : /^daily/i.test(text) ? DAY : 0;
  if (!unit) return t + SHORT_PAUSE;
  return (Math.floor((t - GRACE) / unit) + 1) * unit + GRACE;
}

/** Sets `key` as the map's newest entry, dropping the oldest past `max` (Maps keep insertion order). */
function setNewest<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as string);
}

/** Runs `task` once per key at a time: whoever asks meanwhile shares its answer. */
function once<T>(pending: Map<string, Promise<T>>, key: string, task: () => Promise<T>): Promise<T> {
  let p = pending.get(key);
  if (!p) {
    p = task().finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

interface Cell {
  report: WeatherReport | null;
  /** Until when `report` is served without asking Open-Meteo. */
  freshUntil: number;
  /** After a failed request: no new one before this. */
  retryAt: number;
  /** Failed requests in a row. */
  failures: number;
}

export function createOpenMeteo(options: OpenMeteoOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const apiKey = options.apiKey || null;
  // The free API allows fewer than 10,000 calls a day; the smallest paid plan 1M a month and two at once.
  const budget = options.dailyBudget ?? (apiKey ? 30_000 : 8000);
  const hourlyBudget = Math.ceil(budget / 8);
  const atOnce = apiKey ? 2 : 1;
  const maxCells = options.maxCells ?? 5000;
  const forecastHost = apiKey ? 'https://customer-api.open-meteo.com' : 'https://api.open-meteo.com';
  const geocodingHost = apiKey ? 'https://customer-geocoding-api.open-meteo.com' : 'https://geocoding-api.open-meteo.com';
  // The key goes in a header, never in URLs (or logs).
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  /** No calls before this (after a 429). */
  let pausedUntil = 0;
  /** Calls made on `day` and in `hour` (days and hours since 1970, UTC). */
  let day = -1;
  let spent = 0;
  let hour = -1;
  let spentThisHour = 0;
  let running = 0;
  const waiting: (() => void)[] = [];

  /** Until when Open-Meteo may not be asked at `t` (after a 429, or with this hour's or today's calls spent); earlier: it may. */
  const blockedUntil = (t: number): number => {
    const today = Math.floor(t / DAY);
    if (today !== day) {
      day = today;
      spent = 0;
    }
    const thisHour = Math.floor(t / HOUR);
    if (thisHour !== hour) {
      hour = thisHour;
      spentThisHour = 0;
    }
    return Math.max(pausedUntil, spent >= budget ? (today + 1) * DAY : 0, spentThisHour >= hourlyBudget ? (thisHour + 1) * HOUR : 0);
  };

  /** Throws while Open-Meteo may not be asked. */
  const checkAllowed = () => {
    const t = now();
    const until = blockedUntil(t);
    if (until > t) throw new WeatherUnavailable('Not asking Open-Meteo for a while', until);
  };

  const myTurn = async () => {
    if (running < atOnce) {
      running++;
      return;
    }
    if (waiting.length >= MAX_WAITING) throw new WeatherUnavailable('Too many weather requests waiting', now() + 10_000);
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const nextTurn = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  /** One request to Open-Meteo, in turn (one at a time, or two with an API key). */
  const call = async (url: string): Promise<unknown> => {
    checkAllowed();
    await myTurn();
    try {
      // A pause may have begun while this request waited.
      checkAllowed();
      spentThisHour++;
      if (++spent === budget) console.warn(`[weather] made all ${budget} Open-Meteo calls allowed today; the next ones after 00:00 UTC`);
      else if (spentThisHour === hourlyBudget) {
        console.warn(`[weather] made all ${hourlyBudget} Open-Meteo calls allowed this hour; the next ones after ${String((hour + 1) % 24).padStart(2, '0')}:00 UTC`);
      }
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
      if (res.status === 429) {
        const reason = await res.json().then((b: { reason?: unknown } | null) => b?.reason, () => undefined);
        pausedUntil = Math.max(pausedUntil, pauseEnd(reason, now()));
        console.warn(`[weather] Open-Meteo refused a call (${String(reason ?? 'no reason given').slice(0, 120)}); pausing until ${new Date(pausedUntil).toISOString()}`);
        throw new WeatherUnavailable('Open-Meteo refused a call', pausedUntil);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`Open-Meteo answered ${res.status}`);
      }
      return await res.json();
    } finally {
      nextTurn();
    }
  };

  const cells = new Map<string, Cell>();
  const fetching = new Map<string, Promise<WeatherReport>>();
  const cellKey = (lat: number, lon: number) => `${roundCoord(lat)},${roundCoord(lon)}`;

  const refresh = async (key: string, lat: number, lon: number): Promise<WeatherReport> => {
    const cell = cells.get(key);
    try {
      if (cell && now() < cell.retryAt) throw new WeatherUnavailable('Waiting after a failed request', cell.retryAt);
      const body = await call(`${forecastHost}/v1/forecast?latitude=${lat}&longitude=${lon}&current=${CURRENT}&timezone=auto&timeformat=unixtime`);
      const t = now();
      const report = toReport(body, lat, lon, t);
      setNewest(cells, key, { report, freshUntil: t + TTL + MINUTE + random() * 3 * MINUTE, retryAt: 0, failures: 0 }, maxCells);
      return report;
    } catch (err) {
      let failure = err;
      if (!(err instanceof WeatherUnavailable)) {
        console.warn('[weather] could not get the weather:', (err as Error).message);
        const failures = (cell?.failures ?? 0) + 1;
        const retryAt = now() + Math.min(COOLDOWN * 2 ** (failures - 1), MAX_COOLDOWN);
        failure = new WeatherUnavailable('Open-Meteo failed', retryAt);
        setNewest(cells, key, { report: cell?.report ?? null, freshUntil: 0, retryAt, failures }, maxCells);
      }
      const stale = cells.get(key)?.report;
      if (stale && now() - stale.fetchedAt <= STALE) return stale;
      throw failure;
    }
  };

  /** Results kept until `until`; null after a failed search, which isn't tried again before then. */
  const searches = new Map<string, { places: WeatherPlace[] | null; until: number }>();
  const searching = new Map<string, Promise<WeatherPlace[]>>();
  const searchKey = (q: string, lang: string) => `${lang}:${q.toLowerCase()}`;

  /** The cell's report if it is fresh, without asking Open-Meteo. */
  const cached = (lat: number, lon: number): WeatherReport | null => {
    const cell = cells.get(cellKey(lat, lon));
    return cell?.report && now() < cell.freshUntil ? cell.report : null;
  };

  /**
   * Earlier results of this search (kept a day), without asking Open-Meteo. Throws WeatherUnavailable
   * while waiting after it failed.
   */
  const cachedPlaces = (q: string, lang: string): WeatherPlace[] | null => {
    const key = searchKey(q, lang);
    const hit = searches.get(key);
    if (!hit || now() >= hit.until) return null;
    if (!hit.places) throw new WeatherUnavailable('Waiting after a failed search', hit.until);
    setNewest(searches, key, hit, MAX_SEARCHES);
    return hit.places;
  };

  return {
    cached,
    cachedPlaces,

    /** The cell's last report if it is at most 3 hours old, without asking Open-Meteo. */
    recent(lat: number, lon: number): WeatherReport | null {
      const report = cells.get(cellKey(lat, lon))?.report;
      return report && now() - report.fetchedAt <= STALE ? report : null;
    },

    /**
     * When asking about the cell again may bring new weather: when its report expires, or else when
     * Open-Meteo may be asked about it again (after a failure or a 429, or with the calls spent).
     */
    askAgainAt(lat: number, lon: number): number {
      const t = now();
      const cell = cells.get(cellKey(lat, lon));
      if (cell?.report && t < cell.freshUntil) return cell.freshUntil;
      return Math.max(cell?.retryAt ?? 0, blockedUntil(t));
    },

    /** Whether a lookup for the cell would ask Open-Meteo now; only those count towards a visitor's limits. */
    wouldAsk(lat: number, lon: number): boolean {
      const key = cellKey(lat, lon);
      const t = now();
      return !cached(lat, lon) && !fetching.has(key) && t >= (cells.get(key)?.retryAt ?? 0) && blockedUntil(t) <= t;
    },

    /** Whether this search would ask Open-Meteo now (it isn't cached or waiting after a failure: see cachedPlaces). */
    wouldSearch(q: string, lang: string): boolean {
      const t = now();
      return !searching.has(searchKey(q, lang)) && blockedUntil(t) <= t;
    },

    /**
     * The weather in the 0.1° cell around lat/lon: cached, asked for, or, while Open-Meteo can't be
     * asked, up to 3 hours old. Throws WeatherUnavailable otherwise.
     */
    report(lat: number, lon: number): Promise<WeatherReport> {
      const fresh = cached(lat, lon);
      if (fresh) return Promise.resolve(fresh);
      const key = cellKey(lat, lon);
      return once(fetching, key, () => refresh(key, roundCoord(lat), roundCoord(lon)));
    },

    /** Up to 5 places matching `q` (Open-Meteo geocoding, in `lang`). Throws WeatherUnavailable when it can't be asked. */
    async places(q: string, lang: string): Promise<WeatherPlace[]> {
      const hit = cachedPlaces(q, lang);
      if (hit) return hit;
      const key = searchKey(q, lang);
      return once(searching, key, async () => {
        let places: WeatherPlace[];
        try {
          places = toPlaces(
            await call(`${geocodingHost}/v1/search?name=${encodeURIComponent(q)}&count=5&language=${encodeURIComponent(lang)}&format=json`),
          );
        } catch (err) {
          if (err instanceof WeatherUnavailable) throw err;
          console.warn('[weather] could not search places:', (err as Error).message);
          const retryAt = now() + COOLDOWN;
          setNewest(searches, key, { places: null, until: retryAt }, MAX_SEARCHES);
          throw new WeatherUnavailable('Open-Meteo failed', retryAt);
        }
        setNewest(searches, key, { places, until: now() + PLACES_TTL }, MAX_SEARCHES);
        return places;
      });
    },
  };
}
