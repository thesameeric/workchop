import type express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../server/features';
import { addressKey, weatherFeature, type WeatherOptions } from '../server/features/weather';
import { geoHeadersFrom, placeFromHeaders } from '../server/features/weather/geo';
import { createOpenMeteo, WeatherUnavailable, type OpenMeteoOptions } from '../server/features/weather/openMeteo';
import { windowLimiter } from '../server/limits';
import {
  conditionOf,
  isLatitude,
  isLongitude,
  roundCoord,
  sanitizePlaceName,
  sanitizeSharedWeather,
  type WeatherCondition,
} from '../shared/weather';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 2026-10-08 12:00:30.250 UTC. */
const T0 = Date.UTC(2026, 9, 8, 12, 0, 30, 250);
const CURRENT = [
  'temperature_2m',
  'weather_code',
  'is_day',
  'cloud_cover',
  'precipitation',
  'rain',
  'snowfall',
  'wind_speed_10m',
  'wind_direction_10m',
  'visibility',
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('conditionOf', () => {
  // The WMO table from the spec: 0–1 clear, 2 partly cloudy, 3 overcast, 45/48 fog, 51–57 drizzle,
  // 61–67 and 80–82 rain, 71–77 and 85–86 snow, 95–99 thunder; anything else cloudy.
  const TABLE: [number[], WeatherCondition][] = [
    [[0, 1], 'clear'],
    [[2], 'partly-cloudy'],
    [[3], 'cloudy'],
    [[45, 48], 'fog'],
    [range(51, 57), 'drizzle'],
    [range(61, 67), 'rain'],
    [range(80, 82), 'rain'],
    [range(71, 77), 'snow'],
    [[85, 86], 'snow'],
    [range(95, 99), 'thunder'],
  ];

  it('maps every WMO code from 0 to 99', () => {
    for (const code of range(0, 99)) {
      const expected = TABLE.find(([codes]) => codes.includes(code))?.[1] ?? 'cloudy';
      expect([code, conditionOf(code)]).toEqual([code, expected]);
    }
  });

  it('counts unknown codes as cloudy', () => {
    for (const code of [-1, 100, 255, 1.5, 61.2, NaN, Infinity, -Infinity]) expect(conditionOf(code)).toBe('cloudy');
  });
});

describe('roundCoord', () => {
  it('rounds to 0.1°, with no negative zero', () => {
    expect(Object.is(roundCoord(-0.04), 0)).toBe(true);
    expect(Object.is(roundCoord(-0.05), 0)).toBe(true);
    expect(Object.is(roundCoord(-0), 0)).toBe(true);
    expect(roundCoord(0.05)).toBe(0.1);
    expect(roundCoord(12.35)).toBe(12.4);
    expect(roundCoord(-12.35)).toBe(-12.3);
    expect(roundCoord(179.96)).toBe(180);
    expect(roundCoord(-179.96)).toBe(-180);
    expect(roundCoord(52.5234)).toBe(52.5);
    expect(roundCoord(0.3)).toBe(0.3);
  });

  it('is idempotent', () => {
    for (const v of [-89.95, -12.35, -0.04, 0.05, 0.15, 33.333, 179.96]) expect(roundCoord(roundCoord(v))).toBe(roundCoord(v));
  });
});

describe('isLatitude and isLongitude', () => {
  it('accept finite numbers in range only', () => {
    for (const v of [0, 90, -90, 45.5]) expect(isLatitude(v)).toBe(true);
    for (const v of [90.01, -90.01, NaN, Infinity, '45', null, undefined]) expect(isLatitude(v)).toBe(false);
    for (const v of [0, 180, -180, 13.4]) expect(isLongitude(v)).toBe(true);
    for (const v of [180.01, -180.01, NaN, -Infinity, '13', {}]) expect(isLongitude(v)).toBe(false);
  });
});

describe('sanitizeSharedWeather', () => {
  const ok = { code: 61, isDay: true, tempC: 12.34, utcOffset: 3600 };

  it('keeps the four fields, rounding the temperature', () => {
    expect(sanitizeSharedWeather({ ...ok, city: 'Lisbon', lat: 38.7 })).toEqual({ code: 61, isDay: true, tempC: 12.3, utcOffset: 3600 });
    expect(sanitizeSharedWeather({ ...ok, isDay: 'yes' })).toMatchObject({ isDay: false });
    expect(sanitizeSharedWeather({ ...ok, code: 0, tempC: -100, utcOffset: -14 * 3600 })).toEqual({ code: 0, isDay: true, tempC: -100, utcOffset: -14 * 3600 });
  });

  it('refuses anything else', () => {
    for (const raw of [null, undefined, 'sunny', 42, []]) expect(sanitizeSharedWeather(raw)).toBeNull();
    for (const code of [-1, 100, 2.5, '3', null]) expect(sanitizeSharedWeather({ ...ok, code })).toBeNull();
    for (const tempC of [NaN, Infinity, 70.1, -100.1, '20', undefined]) expect(sanitizeSharedWeather({ ...ok, tempC })).toBeNull();
    for (const utcOffset of [1.5, 14 * 3600 + 1, -14 * 3600 - 1, '0', undefined]) expect(sanitizeSharedWeather({ ...ok, utcOffset })).toBeNull();
  });
});

describe('sanitizePlaceName', () => {
  it('trims, drops control characters and keeps at most 60 characters', () => {
    expect(sanitizePlaceName('  Lisbon ')).toBe('Lisbon');
    expect(sanitizePlaceName('Li\u0000sb\u007fon\n')).toBe('Lisbon');
    expect(sanitizePlaceName('São Paulo')).toBe('São Paulo');
    expect(sanitizePlaceName('x'.repeat(80))).toBe('x'.repeat(60));
    // An emoji cut in half at the limit is dropped, not left as a lone surrogate.
    expect(sanitizePlaceName('x'.repeat(59) + '🌧')).toBe('x'.repeat(59));
  });

  it('gives null for nothing', () => {
    for (const raw of ['', '   ', '\u0001\u0002', null, 7, undefined]) expect(sanitizePlaceName(raw)).toBeNull();
  });
});

describe('geo headers', () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name];
  /** The bytes of `s` in UTF-8, read as latin1: how Node sees a UTF-8 header value. */
  const asNodeReadsIt = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
  const workchop = {
    'x-workchop-geo-lat': '47.3769',
    'x-workchop-geo-lon': '8.5417',
    'x-workchop-geo-city': encodeURIComponent('Zürich'),
    'x-workchop-geo-tz': 'Europe/Zurich',
  };
  const cloudflare = {
    'cf-iplatitude': '-23.5475',
    'cf-iplongitude': '-46.6361',
    'cf-ipcity': asNodeReadsIt('São Paulo'),
    'cf-timezone': 'America/Sao_Paulo',
  };

  it('are trusted only when GEO_HEADERS names who sets them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(geoHeadersFrom(undefined)).toBeNull();
    expect(geoHeadersFrom('')).toBeNull();
    expect(geoHeadersFrom('  ')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(geoHeadersFrom('workchop')).toBe('workchop');
    expect(geoHeadersFrom(' Cloudflare ')).toBe('cloudflare');
    expect(geoHeadersFrom('true')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GEO_HEADERS must be workchop or cloudflare (got "true")'));
    expect(placeFromHeaders(null, headers({ ...workchop, ...cloudflare }))).toBeNull();
  });

  it('read the Worker’s x-workchop-geo-* headers', () => {
    expect(placeFromHeaders('workchop', headers(workchop))).toEqual({ name: 'Zürich', lat: 47.4, lon: 8.5, timezone: 'Europe/Zurich' });
    // Only its own headers: Cloudflare's are someone else's.
    expect(placeFromHeaders('workchop', headers(cloudflare))).toBeNull();
    // A broken city name is left out, the place kept.
    expect(placeFromHeaders('workchop', headers({ ...workchop, 'x-workchop-geo-city': '%E0%A4%A' }))).toEqual({ name: null, lat: 47.4, lon: 8.5, timezone: 'Europe/Zurich' });
    const { 'x-workchop-geo-city': _city, 'x-workchop-geo-tz': _tz, ...bare } = workchop;
    expect(placeFromHeaders('workchop', headers(bare))).toEqual({ name: null, lat: 47.4, lon: 8.5 });
  });

  it('read Cloudflare’s cf-ip* headers, re-decoding UTF-8 city names', () => {
    expect(placeFromHeaders('cloudflare', headers(cloudflare))).toEqual({ name: 'São Paulo', lat: -23.5, lon: -46.6, timezone: 'America/Sao_Paulo' });
    expect(placeFromHeaders('cloudflare', headers({ ...cloudflare, 'cf-ipcity': asNodeReadsIt('Zürich') }))).toMatchObject({ name: 'Zürich' });
    expect(placeFromHeaders('cloudflare', headers({ ...cloudflare, 'cf-ipcity': 'Lisbon' }))).toMatchObject({ name: 'Lisbon' });
    // Already text (not bytes), or latin1 that isn't UTF-8: kept as it is.
    expect(placeFromHeaders('cloudflare', headers({ ...cloudflare, 'cf-ipcity': 'Kraków' }))).toMatchObject({ name: 'Kraków' });
    expect(placeFromHeaders('cloudflare', headers({ ...cloudflare, 'cf-ipcity': 'Genève' }))).toMatchObject({ name: 'Genève' });
    expect(placeFromHeaders('cloudflare', headers(workchop))).toBeNull();
  });

  it('drop invalid coordinates, names and time zones', () => {
    for (const [lat, lon] of [
      ['', '8.5'],
      ['abc', '8.5'],
      ['91', '8.5'],
      ['47.3', '181'],
      ['NaN', '8.5'],
      ['Infinity', '8.5'],
      ['47.3', ' '],
    ]) {
      expect(placeFromHeaders('workchop', headers({ ...workchop, 'x-workchop-geo-lat': lat, 'x-workchop-geo-lon': lon }))).toBeNull();
    }
    for (const tz of ['Europe/../etc', '<script>', 'Europe/Zurich; rm', 'A'.repeat(65), '/Europe', '']) {
      expect(placeFromHeaders('cloudflare', headers({ ...cloudflare, 'cf-timezone': tz }))).not.toHaveProperty('timezone');
    }
    expect(placeFromHeaders('cloudflare', headers({ ...cloudflare, 'cf-timezone': 'America/Argentina/Buenos_Aires' }))).toMatchObject({
      timezone: 'America/Argentina/Buenos_Aires',
    });
    expect(placeFromHeaders('cloudflare', headers({ ...cloudflare, 'cf-timezone': 'Etc/GMT+5' }))).toMatchObject({ timezone: 'Etc/GMT+5' });
    expect(placeFromHeaders('workchop', headers({ ...workchop, 'x-workchop-geo-city': encodeURIComponent('Bad\u0000\nCity  ') }))).toMatchObject({
      name: 'BadCity',
    });
    expect(placeFromHeaders('workchop', headers({ ...workchop, 'x-workchop-geo-city': encodeURIComponent(' \u0007 ') }))).toMatchObject({ name: null });
  });
});

/** Open-Meteo's forecast answer (as of 2026), with `current` changed by `over`. */
function forecast(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    latitude: 52.52,
    longitude: 13.419998,
    generationtime_ms: 0.05,
    utc_offset_seconds: 7200,
    timezone: 'Europe/Berlin',
    timezone_abbreviation: 'GMT+2',
    elevation: 38,
    current_units: { time: 'unixtime', interval: 'seconds', temperature_2m: '°C' },
    current: {
      time: 1759924800,
      interval: 900,
      temperature_2m: 14.2,
      weather_code: 3,
      is_day: 1,
      cloud_cover: 100,
      precipitation: 0.1,
      rain: 0.1,
      snowfall: 0,
      wind_speed_10m: 11.2,
      wind_direction_10m: 250,
      visibility: 24140,
      ...over,
    },
    ...top,
  };
}

const GEOCODING = {
  results: [
    { id: 1, name: 'Springfield', latitude: 39.80172, longitude: -89.64371, country: 'United States', admin1: 'Illinois', timezone: 'America/Chicago' },
    { id: 2, name: 'Springfield', latitude: 37.21533, longitude: -93.29824, country: 'United States', admin1: 'Missouri', timezone: 'America/Chicago' },
    { id: 3, name: 'No coordinates' },
    { id: 4, name: 'Off the map', latitude: 91, longitude: 0 },
    { id: 5, latitude: 1, longitude: 1 },
    null,
    { id: 6, name: ' Spring\u0000field ', latitude: -0.04, longitude: 179.96, timezone: 'not a zone!' },
    { id: 7, name: 'Springfield', latitude: 42.1, longitude: -72.59, country: 'United States', admin1: 'Massachusetts', timezone: 'America/New_York' },
    { id: 8, name: 'Springfield', latitude: 44.04, longitude: -123.02, country: 'United States', admin1: 'Oregon', timezone: 'America/Los_Angeles' },
    { id: 9, name: 'Sixth', latitude: 1, longitude: 1 },
  ],
  generationtime_ms: 1.2,
};

interface Call {
  url: string;
  headers: Headers;
  signal: AbortSignal | null | undefined;
}

/** A fake Open-Meteo: `answer` decides each answer (forecasts by default); every call is recorded. */
function fakeUpstream() {
  const calls: Call[] = [];
  const fake = {
    calls,
    answer: (url: URL): Response | Promise<Response> => (url.pathname === '/v1/search' ? Response.json(GEOCODING) : Response.json(forecast())),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), signal: init?.signal });
      return fake.answer(new URL(String(input)));
    }) as typeof fetch,
  };
  return fake;
}

function setup(opts: OpenMeteoOptions = {}) {
  const clock = { t: T0 };
  const upstream = fakeUpstream();
  const om = createOpenMeteo({ fetch: upstream.fetch, now: () => clock.t, random: () => 0, ...opts });
  return { clock, upstream, om };
}

const tooMany = (reason?: string) => (reason ? Response.json({ error: true, reason }, { status: 429 }) : new Response('slow down', { status: 429 }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const quiet = () => ({ warn: vi.spyOn(console, 'warn').mockImplementation(() => {}), error: vi.spyOn(console, 'error').mockImplementation(() => {}) });

describe('Open-Meteo forecasts', () => {
  it('asks for exactly the 10 current variables of the rounded cell, in local time with unix timestamps', async () => {
    const { om, upstream } = setup();
    const report = await om.report(52.5234, 13.4119);
    expect(upstream.calls).toHaveLength(1);
    const { url, headers, signal } = upstream.calls[0];
    expect(url).toBe(`https://api.open-meteo.com/v1/forecast?latitude=52.5&longitude=13.4&current=${CURRENT.join(',')}&timezone=auto&timeformat=unixtime`);
    const params = new URL(url).searchParams;
    expect([...params.keys()]).toEqual(['latitude', 'longitude', 'current', 'timezone', 'timeformat']);
    expect(params.get('current')!.split(',')).toHaveLength(10);
    expect(headers.get('x-api-key')).toBeNull();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    expect(report).toEqual({
      lat: 52.5,
      lon: 13.4,
      code: 3,
      isDay: true,
      tempC: 14.2,
      cloudCover: 100,
      precipitation: 0.1,
      rain: 0.1,
      snowfall: 0,
      windKph: 11.2,
      windDir: 250,
      visibility: 24140,
      utcOffset: 7200,
      timezone: 'Europe/Berlin',
      fetchedAt: T0,
    });
  });

  it('accepts missing or null extras, and refuses weather that makes no sense', async () => {
    quiet();
    const { om, upstream } = setup();
    const answers = new Map<number, unknown>([
      [1, forecast({ visibility: null, is_day: 0 })],
      [2, forecast({ visibility: undefined, cloud_cover: 130, rain: null, snowfall: -1, wind_direction_10m: 400, precipitation: 'lots' }, { timezone: 'Mars/<b>' })],
      [3, forecast({ temperature_2m: null })],
      [4, forecast({ is_day: 2 })],
      [5, forecast({ weather_code: 3.5 })],
      [6, forecast({ weather_code: '3' })],
      [7, forecast({}, { current: undefined })],
      [8, forecast({}, { utc_offset_seconds: undefined })],
      [9, forecast({ weather_code: 100 })],
      [10, 'not an object'],
    ]);
    upstream.answer = (url) => Response.json(answers.get(Number(url.searchParams.get('latitude'))));
    expect(await om.report(1, 0)).toMatchObject({ isDay: false, visibility: null });
    expect(await om.report(2, 0)).toMatchObject({ visibility: null, cloudCover: 100, rain: 0, snowfall: 0, windDir: 360, precipitation: 0, timezone: 'GMT' });
    for (const lat of range(3, 10)) await expect(om.report(lat, 0)).rejects.toBeInstanceOf(WeatherUnavailable);
    upstream.answer = () => new Response('<html>oops</html>', { status: 200 });
    await expect(om.report(11, 0)).rejects.toBeInstanceOf(WeatherUnavailable);
  });

  it.each([0, 0.5, 0.9999])('keeps a report 15 minutes plus 1–4 minutes of jitter (random %s)', async (r) => {
    const { om, upstream, clock } = setup({ random: () => r });
    const ttl = 15 * MINUTE + MINUTE + r * 3 * MINUTE;
    await om.report(10, 10);
    expect(om.askAgainAt(10.04, 10)).toBe(T0 + ttl);
    clock.t = T0 + ttl - 1;
    expect(om.cached(10, 10)).not.toBeNull();
    await om.report(10.04, 9.96);
    expect(upstream.calls).toHaveLength(1);
    clock.t = T0 + ttl;
    expect(om.cached(10, 10)).toBeNull();
    expect((await om.report(10, 10)).fetchedAt).toBe(T0 + ttl);
    expect(upstream.calls).toHaveLength(2);
  });

  it('asks once for a cell, however many ask at the same time', async () => {
    const { om, upstream } = setup();
    const answer = deferred<Response>();
    upstream.answer = () => answer.promise;
    const asks = [om.report(52.52, 13.41), om.report(52.54, 13.38), om.report(52.5, 13.4)];
    await flush();
    expect(upstream.calls).toHaveLength(1);
    answer.resolve(Response.json(forecast()));
    const [a, b, c] = await Promise.all(asks);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(upstream.calls).toHaveLength(1);
  });

  it('asks Open-Meteo one request at a time, in order', async () => {
    quiet();
    const { om, upstream } = setup();
    const answers = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    upstream.answer = () => answers[upstream.calls.length - 1].promise;
    const settled = Promise.allSettled([om.report(1, 1), om.report(2, 2), om.places('Berlin', 'en')]);
    await flush();
    expect(upstream.calls.map((c) => c.url)).toEqual([expect.stringContaining('latitude=1&')]);
    answers[0].resolve(Response.json(forecast()));
    await vi.waitFor(() => expect(upstream.calls).toHaveLength(2));
    expect(upstream.calls[1].url).toContain('latitude=2&');
    answers[1].resolve(new Response('busy', { status: 503 }));
    await vi.waitFor(() => expect(upstream.calls).toHaveLength(3));
    expect(upstream.calls[2].url).toContain('/v1/search?');
    answers[2].resolve(Response.json(GEOCODING));
    const [first, second, third] = await settled;
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(third.status).toBe('fulfilled');
  });

  it('tells askers to come back when too many wait', async () => {
    const { om, upstream } = setup();
    const gate = deferred<void>();
    upstream.answer = () => gate.promise.then(() => Response.json(forecast()));
    const asks = range(0, 50).map((i) => om.report(-60 + i, 0));
    await flush();
    await expect(om.report(80, 0)).rejects.toMatchObject({ retryAt: T0 + 10_000 });
    gate.resolve();
    await Promise.all(asks);
    expect(upstream.calls).toHaveLength(51);
  });

  it('serves a report up to 3 hours old while Open-Meteo fails, without retrying in a loop', async () => {
    const { warn } = quiet();
    const { om, upstream, clock } = setup();
    await om.report(10, 10);
    upstream.answer = () => new Response('{"error":true,"reason":"Internal"}', { status: 503 });
    clock.t = T0 + 20 * MINUTE;
    expect(await om.report(10, 10)).toMatchObject({ fetchedAt: T0 });
    expect(upstream.calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith('[weather] could not get the weather:', 'Open-Meteo answered 503');
    // A minute's rest after a failure, and twice as long after each further one in a row.
    clock.t += 59_999;
    expect(await om.report(10, 10)).toMatchObject({ fetchedAt: T0 });
    expect(upstream.calls).toHaveLength(2);
    clock.t = T0 + 3 * HOUR;
    expect(await om.report(10, 10)).toMatchObject({ fetchedAt: T0 });
    expect(upstream.calls).toHaveLength(3);
    clock.t += 1;
    await expect(om.report(10, 10)).rejects.toMatchObject({ retryAt: T0 + 3 * HOUR + 2 * MINUTE });
    expect(upstream.calls).toHaveLength(3);
    // Timeouts and network errors count as failures too.
    clock.t = T0 + 4 * HOUR;
    upstream.answer = () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await expect(om.report(10, 10)).rejects.toMatchObject({ retryAt: T0 + 4 * HOUR + 4 * MINUTE });
    upstream.answer = () => Promise.reject(new TypeError('fetch failed'));
    await expect(om.report(20, 20)).rejects.toMatchObject({ retryAt: T0 + 4 * HOUR + MINUTE });
    // At most 15 minutes apart, however long it fails.
    upstream.answer = () => new Response('', { status: 502 });
    for (const wait of [8, 15, 15]) {
      clock.t = om.askAgainAt(10, 10);
      await expect(om.report(10, 10)).rejects.toMatchObject({ retryAt: clock.t + wait * MINUTE });
    }
    // And it recovers, starting again from a minute's rest.
    upstream.answer = () => Response.json(forecast());
    clock.t = om.askAgainAt(10, 10);
    expect(await om.report(10, 10)).toMatchObject({ fetchedAt: clock.t });
  });

  it.each([
    ['Minutely API request limit exceeded. Please try again in one minute.', Date.UTC(2026, 9, 8, 12, 1, 5)],
    ['Hourly API request limit exceeded. Please try again in the next hour.', Date.UTC(2026, 9, 8, 13, 0, 5)],
    ['Daily API request limit exceeded. Please try again tomorrow.', Date.UTC(2026, 9, 9, 0, 0, 5)],
    // Limits that don't reset on a boundary, and answers without a reason: a minute.
    ['Too many concurrent requests', T0 + MINUTE],
    ['Something new', T0 + MINUTE],
    [undefined, T0 + MINUTE],
  ])('after a 429 (%s), asks nothing until 5 s after the UTC boundary it names', async (reason, until) => {
    const { warn } = quiet();
    const { om, upstream, clock } = setup();
    upstream.answer = () => tooMany(reason);
    await expect(om.report(1, 1)).rejects.toMatchObject({ retryAt: until });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`pausing until ${new Date(until).toISOString()}`));
    upstream.answer = () => Response.json(forecast());
    clock.t = until - 1;
    expect(om.wouldAsk(-89, 0)).toBe(false);
    await expect(om.report(2, 2)).rejects.toMatchObject({ retryAt: until });
    await expect(om.places('Berlin', 'en')).rejects.toMatchObject({ retryAt: until });
    expect(upstream.calls).toHaveLength(1);
    clock.t = until;
    expect(om.wouldAsk(-89, 0)).toBe(true);
    await om.report(2, 2);
    expect(upstream.calls).toHaveLength(2);
  });

  it.each([
    ['Minutely API request limit exceeded.', Date.UTC(2026, 9, 8, 12, 1, 3), Date.UTC(2026, 9, 8, 12, 1, 5)],
    ['Hourly API request limit exceeded.', Date.UTC(2026, 9, 8, 13, 0, 4, 999), Date.UTC(2026, 9, 8, 13, 0, 5)],
    ['Daily API request limit exceeded.', Date.UTC(2026, 9, 9, 0, 0, 0, 400), Date.UTC(2026, 9, 9, 0, 0, 5)],
    // From 5 s on, a 429 is about the new period.
    ['Daily API request limit exceeded.', Date.UTC(2026, 9, 9, 0, 0, 5), Date.UTC(2026, 9, 10, 0, 0, 5)],
  ])('counts a 429 (%s) that comes within 5 s after a boundary towards the period before', async (reason, at, until) => {
    quiet();
    const { om, upstream, clock } = setup();
    clock.t = at;
    upstream.answer = () => tooMany(reason);
    await expect(om.report(1, 1)).rejects.toMatchObject({ retryAt: until });
    upstream.answer = () => Response.json(forecast());
    clock.t = until;
    await om.report(2, 2);
    expect(upstream.calls).toHaveLength(2);
  });

  it('serves stale reports while paused', async () => {
    quiet();
    const { om, upstream, clock } = setup();
    await om.report(1, 1);
    clock.t = T0 + 30 * MINUTE;
    upstream.answer = () => tooMany('Hourly API request limit exceeded. Please try again in the next hour.');
    expect(await om.report(1, 1)).toMatchObject({ fetchedAt: T0 });
    clock.t = T0 + 40 * MINUTE;
    expect(await om.report(1, 1)).toMatchObject({ fetchedAt: T0 });
    await expect(om.report(3, 3)).rejects.toMatchObject({ retryAt: Date.UTC(2026, 9, 8, 13, 0, 5) });
    expect(upstream.calls).toHaveLength(2);
  });

  it('keeps to a daily budget that counts every call and starts again at 00:00 UTC', async () => {
    const { warn } = quiet();
    // And so one call an hour.
    const { om, upstream, clock } = setup({ dailyBudget: 3 });
    upstream.answer = (url) =>
      url.pathname === '/v1/search' ? Response.json(GEOCODING) : url.searchParams.get('latitude') === '2' ? new Response('', { status: 500 }) : Response.json(forecast());
    await om.report(1, 1);
    clock.t += HOUR;
    await expect(om.report(2, 2)).rejects.toBeInstanceOf(WeatherUnavailable);
    clock.t += HOUR;
    await om.places('Springfield', 'en');
    expect(upstream.calls).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('made all 3 Open-Meteo calls allowed today'));
    const midnight = Date.UTC(2026, 9, 9);
    await expect(om.report(3, 3)).rejects.toMatchObject({ retryAt: midnight });
    await expect(om.places('Shelbyville', 'en')).rejects.toMatchObject({ retryAt: midnight });
    clock.t = midnight - 1;
    await expect(om.report(3, 3)).rejects.toMatchObject({ retryAt: midnight });
    expect(upstream.calls).toHaveLength(3);
    clock.t = midnight;
    await om.report(3, 3);
    expect(upstream.calls).toHaveLength(4);
  });

  it('makes at most an eighth of the daily budget in one UTC hour', async () => {
    const { warn } = quiet();
    const { om, upstream, clock } = setup({ dailyBudget: 17 });
    await om.report(1, 1);
    await om.places('Springfield', 'en');
    expect(warn).not.toHaveBeenCalled();
    await om.report(2, 2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('made all 3 Open-Meteo calls allowed this hour; the next ones after 13:00 UTC'));
    const nextHour = Date.UTC(2026, 9, 8, 13);
    expect(om.wouldAsk(-89, 0)).toBe(false);
    await expect(om.report(3, 3)).rejects.toMatchObject({ retryAt: nextHour });
    clock.t = nextHour - 1;
    await expect(om.places('Shelbyville', 'en')).rejects.toMatchObject({ retryAt: nextHour });
    expect(upstream.calls).toHaveLength(3);
    clock.t = nextHour;
    expect(om.wouldAsk(-89, 0)).toBe(true);
    await om.report(3, 3);
    expect(upstream.calls).toHaveLength(4);
  });

  it('makes 1,000 calls an hour by default', async () => {
    quiet();
    const { om, upstream } = setup();
    for (let i = 0; i < 1000; i++) await om.report(-50 + i / 10, 0);
    await expect(om.report(80, 0)).rejects.toMatchObject({ retryAt: Date.UTC(2026, 9, 8, 13) });
    expect(upstream.calls).toHaveLength(1000);
  });

  it('uses the customer hosts with an API key, sent only in a header and never logged', async () => {
    const { warn, error } = quiet();
    const { om, upstream, clock } = setup({ apiKey: 'sk-secret-123' });
    await om.report(48.85, 2.35);
    await om.places('Paris', 'fr');
    expect(upstream.calls.map((c) => c.url.split('?')[0])).toEqual([
      'https://customer-api.open-meteo.com/v1/forecast',
      'https://customer-geocoding-api.open-meteo.com/v1/search',
    ]);
    for (const call of upstream.calls) {
      expect(call.headers.get('x-api-key')).toBe('sk-secret-123');
      expect(call.url).not.toContain('sk-secret');
      expect(call.url).not.toContain('apikey');
    }
    upstream.answer = () => new Response('', { status: 500 });
    await expect(om.report(1, 1)).rejects.toBeInstanceOf(WeatherUnavailable);
    upstream.answer = () => tooMany('Minutely API request limit exceeded.');
    await expect(om.report(2, 2)).rejects.toBeInstanceOf(WeatherUnavailable);
    clock.t += HOUR;
    upstream.answer = () => Promise.reject(new TypeError('fetch failed'));
    await expect(om.places('Lyon', 'fr')).rejects.toBeInstanceOf(WeatherUnavailable);
    expect(warn.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain('sk-secret');
  });

  it('keeps a limited number of cells, dropping the oldest', async () => {
    const { om, upstream } = setup({ maxCells: 2 });
    await om.report(1, 1);
    await om.report(2, 2);
    await om.report(3, 3);
    expect(om.cached(1, 1)).toBeNull();
    expect(om.cached(2, 2)).not.toBeNull();
    expect(om.cached(3, 3)).not.toBeNull();
    await om.report(1, 1);
    expect(upstream.calls).toHaveLength(4);
    expect(om.cached(2, 2)).toBeNull();
  });
});

describe('Open-Meteo place search', () => {
  it('asks the geocoding API and answers up to 5 sensible places, rounded', async () => {
    const { om, upstream } = setup();
    const places = await om.places('Springfield', 'de');
    expect(upstream.calls[0].url).toBe('https://geocoding-api.open-meteo.com/v1/search?name=Springfield&count=5&language=de&format=json');
    expect(places).toEqual([
      { name: 'Springfield', region: 'Illinois', country: 'United States', lat: 39.8, lon: -89.6, timezone: 'America/Chicago' },
      { name: 'Springfield', region: 'Missouri', country: 'United States', lat: 37.2, lon: -93.3, timezone: 'America/Chicago' },
      { name: 'Springfield', lat: 0, lon: 180 },
      { name: 'Springfield', region: 'Massachusetts', country: 'United States', lat: 42.1, lon: -72.6, timezone: 'America/New_York' },
      { name: 'Springfield', region: 'Oregon', country: 'United States', lat: 44, lon: -123, timezone: 'America/Los_Angeles' },
    ]);
    await om.places('São Paulo', 'pt');
    expect(upstream.calls[1].url).toBe('https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo&count=5&language=pt&format=json');
  });

  it('answers no places when nothing matches, and fails on nonsense', async () => {
    quiet();
    const { om, upstream } = setup();
    upstream.answer = () => Response.json({ generationtime_ms: 0.3 });
    expect(await om.places('Xyzzy', 'en')).toEqual([]);
    upstream.answer = () => Response.json({ results: 'many' });
    await expect(om.places('Plugh', 'en')).rejects.toBeInstanceOf(WeatherUnavailable);
    upstream.answer = () => Response.json({ error: true, reason: 'Parameter count must be between 1 and 100.' }, { status: 400 });
    await expect(om.places('Plover', 'en')).rejects.toMatchObject({ retryAt: T0 + MINUTE });
  });

  it('keeps results for a day and the 500 most recent searches', async () => {
    const { om, upstream, clock } = setup();
    await om.places('Berlin', 'en');
    expect(await om.places('BERLIN', 'en')).toHaveLength(5);
    expect(om.cachedPlaces('berlin', 'en')).toHaveLength(5);
    expect(om.cachedPlaces('berlin', 'de')).toBeNull();
    expect(upstream.calls).toHaveLength(1);
    clock.t = T0 + 24 * HOUR - 1;
    expect(om.cachedPlaces('Berlin', 'en')).not.toBeNull();
    clock.t = T0 + 24 * HOUR;
    expect(om.cachedPlaces('Berlin', 'en')).toBeNull();
    await om.places('Berlin', 'en');
    expect(upstream.calls).toHaveLength(2);

    for (let i = 0; i < 499; i++) await om.places(`town ${i}`, 'en');
    // Using an entry makes it the newest.
    expect(om.cachedPlaces('Berlin', 'en')).not.toBeNull();
    await om.places('one more', 'en');
    expect(om.cachedPlaces('Berlin', 'en')).not.toBeNull();
    expect(om.cachedPlaces('town 0', 'en')).toBeNull();
    expect(om.cachedPlaces('town 1', 'en')).not.toBeNull();
  });

  it('waits a minute after a failed search before trying it again', async () => {
    const { warn } = quiet();
    const { om, upstream, clock } = setup();
    upstream.answer = () => new Response('', { status: 500 });
    await expect(om.places('Berlin', 'en')).rejects.toMatchObject({ retryAt: T0 + MINUTE });
    expect(warn).toHaveBeenCalledWith('[weather] could not search places:', 'Open-Meteo answered 500');
    upstream.answer = () => Response.json(GEOCODING);
    clock.t = T0 + MINUTE - 1;
    await expect(om.places('BERLIN', 'en')).rejects.toMatchObject({ retryAt: T0 + MINUTE });
    expect(() => om.cachedPlaces('berlin', 'en')).toThrow(WeatherUnavailable);
    expect(upstream.calls).toHaveLength(1);
    // Other searches go ahead.
    expect(await om.places('Berlin', 'de')).toHaveLength(5);
    clock.t = T0 + MINUTE;
    expect(om.cachedPlaces('Berlin', 'en')).toBeNull();
    expect(await om.places('Berlin', 'en')).toHaveLength(5);
    expect(upstream.calls).toHaveLength(3);
  });

  it('asks once for a search, however many ask at the same time', async () => {
    const { om, upstream } = setup();
    const [a, b] = await Promise.all([om.places('Lisbon', 'en'), om.places('lisbon', 'en')]);
    expect(a).toBe(b);
    expect(upstream.calls).toHaveLength(1);
  });
});

describe('the weather feature', () => {
  /** A context that records what the feature registers. */
  const fakeContext = () => {
    const routes: string[] = [];
    const onSocket = vi.fn();
    const ctx = { app: { get: (path: string) => routes.push(path) }, realtime: { onSocket } } as unknown as ServerContext;
    return { ctx, routes, onSocket };
  };

  it('registers nothing with WEATHER=off', async () => {
    vi.stubEnv('WEATHER', 'off');
    const { ctx, routes, onSocket } = fakeContext();
    await weatherFeature().register(ctx);
    expect(routes).toEqual([]);
    expect(onSocket).not.toHaveBeenCalled();
  });

  it('registers its routes and socket events otherwise, warning about an unknown GEO_HEADERS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('WEATHER', '');
    vi.stubEnv('GEO_HEADERS', 'yes please');
    const { ctx, routes, onSocket } = fakeContext();
    await weatherFeature().register(ctx);
    expect(routes.sort()).toEqual(['/weather', '/weather/here', '/weather/places']);
    expect(onSocket).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GEO_HEADERS must be workchop or cloudflare (got "yes please")'));
  });
});

describe('the weather routes', () => {
  type Handler = (req: express.Request, res: express.Response) => unknown;

  /** The feature on a fake server where every connection is in an office; `ask` calls a route. */
  function serve(options: WeatherOptions = {}) {
    const clock = { t: T0 };
    const upstream = fakeUpstream();
    const handlers = new Map<string, Handler>();
    const ctx = {
      app: { get: (path: string, handler: Handler) => handlers.set(path, handler) },
      realtime: { onSocket: () => {}, contextOf: () => ({ socket: { connected: true }, room: () => ({ officeId: 'office' }) }) },
      clientIp: (req: express.Request) => req.ip,
    } as unknown as ServerContext;
    void weatherFeature({ enabled: true, geoHeaders: null, apiKey: null, fetch: upstream.fetch, now: () => clock.t, random: () => 0, ...options }).register(ctx);
    const ask = async (path: string, query: Record<string, string>, from: { ip?: string; socket?: string } = {}) => {
      const headers: Record<string, string> = { 'x-workchop-socket': from.socket ?? 'socket-1' };
      const req = { query, ip: from.ip ?? '203.0.113.1', get: (name: string) => headers[name.toLowerCase()] };
      const res = {
        statusCode: 200,
        headers: new Map<string, string>(),
        body: undefined as unknown,
        set: (name: string, value: string) => (res.headers.set(name.toLowerCase(), value), res),
        status: (code: number) => ((res.statusCode = code), res),
        json: (body: unknown) => ((res.body = body), res),
      };
      await handlers.get(path)!(req as unknown as express.Request, res as unknown as express.Response);
      return res;
    };
    /** A lookup of the i-th cell, one no one asked for before. */
    const lookUp = (i: number, from?: { ip?: string; socket?: string }) => ask('/weather', { lat: String(-80 + i / 10), lon: '0' }, from);
    const search = (i: number, from?: { ip?: string; socket?: string }) => ask('/weather/places', { q: `town ${i}` }, from);
    return { clock, upstream, ask, lookUp, search };
  }

  it('limits lookups per connection and address, per address, and per address a day', async () => {
    const { clock, upstream, lookUp } = serve();
    let i = 0;
    for (; i < 20; i++) expect((await lookUp(i)).statusCode).toBe(200);
    clock.t += MINUTE;
    const refused = await lookUp(i);
    expect(refused.statusCode).toBe(429);
    expect(refused.body).toEqual({ error: 'Too many weather requests. Try again later.' });
    // When the connection's first lookup leaves the 10-minute window.
    expect(refused.headers.get('retry-after')).toBe('540');
    // Cached cells don't count.
    expect((await lookUp(0)).statusCode).toBe(200);
    // Someone using this connection's id from elsewhere has their own allowance, not this one's.
    expect((await lookUp(i++, { ip: '198.51.100.7' })).statusCode).toBe(200);
    // Other connections from the same address: 60 lookups in 10 minutes for the address.
    for (let n = 0; n < 40; n++) expect((await lookUp(i++, { socket: `socket-${2 + Math.floor(n / 20)}` })).statusCode).toBe(200);
    const crowded = await lookUp(i, { socket: 'socket-4' });
    expect(crowded.statusCode).toBe(429);
    expect(crowded.headers.get('retry-after')).toBe('540');
    // And 1000 a day: 60 so far, then 60 every 10 minutes.
    let total = 60;
    for (let round = 1; total < 1000; round++) {
      clock.t = T0 + MINUTE + round * 10 * MINUTE;
      for (let n = 0; n < 60 && total < 1000; n++, total++) {
        expect((await lookUp(i++, { socket: `round-${round}-${Math.floor(n / 20)}` })).statusCode).toBe(200);
      }
    }
    clock.t += 10 * MINUTE;
    const daily = await lookUp(i, { socket: 'late' });
    expect(daily.statusCode).toBe(429);
    // When the address's first lookup of the day leaves the 24-hour window.
    expect(daily.headers.get('retry-after')).toBe(String((T0 + DAY - clock.t) / 1000));
    expect(upstream.calls).toHaveLength(1001);
  });

  it('counts an IPv6 address by its /64', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0DB8:0001:0002::abcd')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('unknown')).toBe('unknown');
  });

  it('gives someone over their limit the last report, up to 3 hours old, rather than none', async () => {
    const { clock, upstream, lookUp } = serve();
    await lookUp(0);
    clock.t += 17 * MINUTE;
    for (let i = 1; i <= 20; i++) expect((await lookUp(i)).statusCode).toBe(200);
    // The first cell's report has expired, and this connection may not ask for it again yet.
    const old = await lookUp(0);
    expect(old.statusCode).toBe(200);
    expect(old.body).toMatchObject({ fetchedAt: T0 });
    expect(old.headers.get('cache-control')).toBe('private, max-age=600');
    expect(upstream.calls).toHaveLength(21);
    // A cell it never had still gets a 429.
    expect((await lookUp(21)).statusCode).toBe(429);
  });

  it('doesn’t count lookups that wait for a report on its way or after a failure', async () => {
    quiet();
    const { upstream, ask } = serve();
    upstream.answer = () => new Response('', { status: 502 });
    // The first asks; the rest wait for its answer, then for the cell's cooldown, at no cost.
    const answers = await Promise.all(Array.from({ length: 30 }, () => ask('/weather', { lat: '1', lon: '1' })));
    expect(answers.every((res) => res.statusCode === 503)).toBe(true);
    expect(upstream.calls).toHaveLength(1);
    for (let i = 0; i < 30; i++) expect((await ask('/weather', { lat: '1', lon: '1' })).statusCode).toBe(503);
    expect(upstream.calls).toHaveLength(1);
  });

  it('limits searches per connection and address, and per address', async () => {
    const { clock, upstream, search } = serve();
    let i = 0;
    for (; i < 30; i++) expect((await search(i)).statusCode).toBe(200);
    clock.t += 2 * MINUTE;
    const refused = await search(i);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('480');
    // Earlier searches are answered from the cache.
    expect((await search(0)).statusCode).toBe(200);
    for (; i < 60; i++) expect((await search(i, { socket: 'socket-2' })).statusCode).toBe(200);
    expect((await search(i, { socket: 'socket-3' })).statusCode).toBe(429);
    expect((await search(i, { ip: '198.51.100.7' })).statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(61);
  });

  it('doesn’t count lookups and searches while Open-Meteo can’t be asked anyway', async () => {
    quiet();
    const { clock, upstream, lookUp, ask } = serve();
    upstream.answer = () => tooMany('Hourly API request limit exceeded.');
    for (let i = 0; i < 25; i++) {
      const res = await lookUp(i);
      expect(res.statusCode).toBe(503);
      expect(res.headers.get('retry-after')).toBe(String(Math.ceil((Date.UTC(2026, 9, 8, 13, 0, 5) - T0) / 1000)));
    }
    expect(upstream.calls).toHaveLength(1);
    // A search that failed is retried after a minute, and asking again meanwhile is free.
    clock.t = Date.UTC(2026, 9, 8, 13, 0, 5);
    upstream.answer = () => new Response('', { status: 500 });
    for (let i = 0; i < 35; i++) {
      const res = await ask('/weather/places', { q: 'Berlin' });
      expect(res.statusCode).toBe(503);
      expect(res.headers.get('retry-after')).toBe('60');
    }
    expect(upstream.calls).toHaveLength(2);
  });

  it('says how long a report may be kept: until the cell’s expires, or a minute for old ones', async () => {
    quiet();
    const { clock, upstream, ask } = serve();
    const berlin = { lat: '52.52', lon: '13.41' };
    const first = await ask('/weather', berlin);
    // 15 minutes plus 1–4 minutes of jitter (random 0).
    expect(first.headers.get('cache-control')).toBe('private, max-age=960');
    clock.t += 10 * MINUTE + 500;
    expect((await ask('/weather', berlin)).headers.get('cache-control')).toBe('private, max-age=360');
    clock.t = T0 + 16 * MINUTE - 30_000;
    expect((await ask('/weather', berlin)).headers.get('cache-control')).toBe('private, max-age=60');
    // Open-Meteo fails: the last report, to be asked for again when the cell may be: in a minute, then
    // twice as long after each further failure.
    upstream.answer = () => new Response('', { status: 500 });
    clock.t = T0 + 20 * MINUTE;
    const stale = await ask('/weather', berlin);
    expect(stale.body).toMatchObject({ fetchedAt: T0 });
    expect(stale.headers.get('cache-control')).toBe('private, max-age=60');
    clock.t += MINUTE;
    expect((await ask('/weather', berlin)).headers.get('cache-control')).toBe('private, max-age=120');
    clock.t += 2 * MINUTE;
    expect((await ask('/weather', berlin)).headers.get('cache-control')).toBe('private, max-age=240');
    const failed = await ask('/weather', { lat: '1', lon: '1' });
    expect(failed.statusCode).toBe(503);
    expect(failed.headers.get('cache-control')).toBe('no-store');
  });

  it.each([['sk-secret\nmore'], ['sk-secret more'], [`sk-secret-${'x'.repeat(200)}`], ['sk-secret-é']])(
    'runs without an OPEN_METEO_API_KEY that can’t be one (%#), never logging it',
    async (key) => {
      const { warn, error } = quiet();
      vi.stubEnv('OPEN_METEO_API_KEY', key);
      const { upstream, ask } = serve({ apiKey: undefined });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OPEN_METEO_API_KEY must be'));
      expect((await ask('/weather', { lat: '1', lon: '1' })).statusCode).toBe(200);
      expect(upstream.calls[0].url).toMatch(/^https:\/\/api\.open-meteo\.com\//);
      expect(upstream.calls[0].headers.get('x-api-key')).toBeNull();
      expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain('sk-secret');
    },
  );

  it('uses a valid OPEN_METEO_API_KEY, trimmed', async () => {
    const { warn } = quiet();
    vi.stubEnv('OPEN_METEO_API_KEY', ' sk-secret-123\n');
    const { upstream, ask } = serve({ apiKey: undefined });
    await ask('/weather', { lat: '1', lon: '1' });
    expect(upstream.calls[0].url).toMatch(/^https:\/\/customer-api\.open-meteo\.com\//);
    expect(upstream.calls[0].headers.get('x-api-key')).toBe('sk-secret-123');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('windowLimiter', () => {
  it('says how long until a key may act again, without counting it', () => {
    const clock = { t: T0 };
    const allow = windowLimiter(2, 10_000, () => clock.t);
    expect(allow.wait('a')).toBe(0);
    expect(allow('a')).toBe(true);
    clock.t += 3000;
    expect(allow('a')).toBe(true);
    expect(allow.wait('a')).toBe(7000);
    expect(allow.wait('b')).toBe(0);
    expect(allow('a')).toBe(false);
    clock.t += 6999;
    expect(allow('a')).toBe(false);
    expect(allow.wait('a')).toBe(1);
    clock.t += 1;
    expect(allow.wait('a')).toBe(0);
    expect(allow('a')).toBe(true);
    expect(allow.wait('a')).toBe(3000);
  });
});
