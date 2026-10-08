import type { WeatherPlace, WeatherReport } from '../../../../shared/weather';
import { toPlace } from './places';

// The server's weather routes. /api/weather and /api/weather/places only answer someone in an
// office: they take the connection's id in X-Workchop-Socket.

/** A request the server answered with an error: its status, and how long it asked us to wait. */
export class WeatherError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

async function failed(res: Response): Promise<WeatherError> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  const seconds = Number(res.headers.get('Retry-After'));
  return new WeatherError(typeof body.error === 'string' ? body.error : `Request failed (${res.status})`, res.status, seconds > 0 ? seconds : null);
}

/**
 * Runs a request with a signal that aborts with `signal` or after `ms`, until it has read the answer
 * (by hand: AbortSignal.any is newer than some browsers the app runs in).
 */
async function withTimeout<T>(ms: number, signal: AbortSignal, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ms);
  try {
    return await request(ctrl.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** Your approximate place from your connection, null when the server doesn't know it, 'off' when it has no weather. */
export async function fetchHere(): Promise<WeatherPlace | null | 'off'> {
  const res = await fetch('/api/weather/here', { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (res.status === 404) return 'off';
  if (!res.ok) throw await failed(res);
  return toPlace(((await res.json()) as { place?: unknown }).place);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isReport(r: Partial<WeatherReport> | null): r is WeatherReport {
  return (
    !!r &&
    [r.lat, r.lon, r.code, r.tempC, r.cloudCover, r.precipitation, r.rain, r.snowfall, r.windKph, r.windDir, r.utcOffset, r.fetchedAt].every(finite) &&
    typeof r.isDay === 'boolean' &&
    typeof r.timezone === 'string' &&
    (r.visibility == null || finite(r.visibility))
  );
}

const MINUTE = 60_000;
/** How often the weather is fetched again when the server doesn't say: Open-Meteo updates it every 15 minutes. */
export const REFRESH_MS = 15 * MINUTE;

/**
 * When to fetch the weather again (ms) after an answer with this Cache-Control: once the server's copy
 * has expired (its max-age, up to 20 % later so a cell's viewers don't all ask at once), within 1–30 minutes.
 */
export function refreshDelay(cacheControl: string | null, random = Math.random): number {
  const maxAge = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(cacheControl ?? '')?.[1];
  if (maxAge === undefined) return REFRESH_MS;
  return Math.min(Math.max(Number(maxAge) * 1000 * (1 + random() * 0.2), MINUTE), 30 * MINUTE);
}

/**
 * The weather now in the place's cell, and when to fetch it again (ms, see refreshDelay). Throws a
 * WeatherError (or a network error).
 */
export function fetchReport(place: WeatherPlace, selfId: string, signal: AbortSignal): Promise<{ report: WeatherReport; refreshIn: number }> {
  return withTimeout(15_000, signal, async (signal) => {
    const res = await fetch(`/api/weather?lat=${place.lat}&lon=${place.lon}`, { headers: { 'X-Workchop-Socket': selfId }, signal, cache: 'no-store' });
    if (!res.ok) throw await failed(res);
    const report = (await res.json()) as Partial<WeatherReport> | null;
    if (!isReport(report)) throw new WeatherError('Unexpected answer', res.status, null);
    return { report: { ...report, visibility: report.visibility ?? null }, refreshIn: refreshDelay(res.headers.get('Cache-Control')) };
  });
}

/** The language to name places in: a browser language with a two-letter code (Open-Meteo's), else English. */
export function searchLanguage(tag: string): string {
  try {
    const { language } = new Intl.Locale(tag);
    return /^[a-z]{2}$/.test(language) ? language : 'en';
  } catch {
    return 'en';
  }
}

/** Places matching `q` (at most 5), named in the browser's language when possible. */
export function searchPlaces(q: string, selfId: string, signal: AbortSignal): Promise<WeatherPlace[]> {
  const params = new URLSearchParams({ q, lang: searchLanguage(navigator.language) });
  return withTimeout(10_000, signal, async (signal) => {
    const res = await fetch(`/api/weather/places?${params}`, { headers: { 'X-Workchop-Socket': selfId }, signal, cache: 'no-store' });
    if (!res.ok) throw await failed(res);
    const list: unknown = await res.json();
    return Array.isArray(list) ? list.map(toPlace).filter((p): p is WeatherPlace => !!p).slice(0, 5) : [];
  });
}
