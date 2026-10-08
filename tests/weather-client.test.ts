import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { fetchReport, refreshDelay, searchLanguage } from '../client/src/features/weather/api';
import { clockAt, describe as describeCode, formatPrecipitation, formatTemp, formatVisibility, formatWind } from '../client/src/features/weather/format';
import { placeDetail, resolvePlace, toPlace } from '../client/src/features/weather/places';
import { decodeSynced, encodeSynced, PREFS_KEY, unitsFor } from '../client/src/features/weather/prefs';
import { brightness, computeLook, DAYTIME_BRIGHTNESS, newFx } from '../client/src/features/weather/scene/sky';
import type { WeatherPrefs } from '../client/src/features/weather/state';
import type { AccountUser } from '../shared/account';
import type { WeatherPlace, WeatherReport } from '../shared/weather';

// The weather's client logic: places, preferences, words and numbers, what the scene looks like, and
// (with a little of a browser and stand-ins for the rest of the app) fetching and syncing.

const fake = vi.hoisted(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  /** The app's store: a new one on each page load (see pageLoad). */
  const app = { store: null as StoreApi<{ account: AccountUser | null }> | null };
  return { items, app, saveAccountSettings: vi.fn(async () => {}), onSession: vi.fn(), locateDevice: vi.fn() };
});
vi.mock('../client/src/lib/account', () => ({ saveAccountSettings: fake.saveAccountSettings }));
vi.mock('../client/src/lib/session', () => ({ onSession: fake.onSession }));
vi.mock('../client/src/features/weather/location', () => ({ locateDevice: fake.locateDevice }));
vi.mock('../client/src/state/store', () => {
  const store = () => fake.app.store ?? (fake.app.store = createStore(() => ({ account: null })));
  const useStore: Pick<StoreApi<{ account: AccountUser | null }>, 'getState' | 'setState' | 'subscribe'> = {
    getState: () => store().getState(),
    setState: (patch) => store().setState(patch),
    subscribe: (listener) => store().subscribe(listener),
  };
  return { useStore, getState: useStore.getState };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const lisbon: WeatherPlace = { name: 'Lisbon', lat: 38.7, lon: -9.1, region: 'Lisbon', country: 'Portugal' };
const prefs = (patch: Partial<WeatherPrefs> = {}): WeatherPrefs => ({ enabled: true, units: 'c', share: false, city: null, device: null, ...patch });
/** A clear day in Lisbon. */
const sunny: WeatherReport = {
  lat: 38.7,
  lon: -9.1,
  code: 0,
  isDay: true,
  tempC: 20,
  cloudCover: 0,
  precipitation: 0,
  rain: 0,
  snowfall: 0,
  windKph: 0,
  windDir: 0,
  visibility: 30_000,
  utcOffset: 3600,
  timezone: 'Europe/Lisbon',
  fetchedAt: 0,
};

describe('places', () => {
  it('takes places from untrusted input, rounded, without bad names or time zones', () => {
    expect(toPlace({ name: ' Lisbon ', region: 'Lisbon', country: 'Portugal', lat: 38.7223, lon: -9.1393, timezone: 'Europe/Lisbon' })).toStrictEqual(lisbon);
    expect(toPlace({ name: 7, lat: 1.04, lon: 2, region: '', timezone: 'Not a zone!' })).toStrictEqual({ name: null, lat: 1, lon: 2 });
    for (const raw of [null, 'Lisbon', { lat: 91, lon: 0 }, { lat: 0, lon: '1' }, { lat: Number.NaN, lon: 0 }]) expect(toPlace(raw)).toBeNull();
  });

  it('prefers a chosen city, then the device, then the connection', () => {
    const device: WeatherPlace = { name: null, lat: 51.5, lon: -0.1 };
    const here: WeatherPlace = { name: 'Porto', lat: 41.1, lon: -8.6 };
    expect(resolvePlace(prefs({ city: lisbon, device }), here)).toEqual({ source: 'city', place: lisbon });
    expect(resolvePlace(prefs({ device }), here)).toEqual({ source: 'device', place: device });
    expect(resolvePlace(prefs(), here)).toEqual({ source: 'ip', place: here });
    expect(resolvePlace(prefs(), null)).toEqual({ source: 'none', place: null });
    expect(resolvePlace(prefs({ enabled: false, city: lisbon }), here)).toEqual({ source: 'none', place: null });
  });

  it('tells places apart by region and country', () => {
    expect(placeDetail(lisbon)).toBe('Portugal');
    expect(placeDetail({ name: 'Paris', region: 'Texas', country: 'United States', lat: 33.7, lon: -95.6 })).toBe('Texas, United States');
  });
});

describe('the account setting', () => {
  it('round-trips, without the device location', () => {
    const text = encodeSynced(prefs({ units: 'f', share: true, city: lisbon, device: { name: null, lat: 51.5, lon: -0.1 } }));
    expect(text).not.toContain('51.5');
    expect(decodeSynced(text)).toEqual({ enabled: true, units: 'f', share: true, city: lisbon });
  });

  it('stays short enough for the server to keep whole, dropping the region and country first', () => {
    const long = 'x'.repeat(60);
    const city: WeatherPlace = { name: long, region: long, country: long, lat: -34.6, lon: -58.4, timezone: 'America/Argentina/Buenos_Aires' };
    const text = encodeSynced(prefs({ city }));
    expect(text.length).toBeLessThanOrEqual(200);
    expect(decodeSynced(text)?.city).toStrictEqual({ name: long, lat: -34.6, lon: -58.4 });
    // No time zone: a long name keeps its region and country.
    const buenosAires = { name: 'Ciudad Autónoma de Buenos Aires', region: 'Buenos Aires F.D.', country: 'Argentina', lat: -34.6, lon: -58.4 };
    expect(decodeSynced(encodeSynced(prefs({ city: { ...buenosAires, timezone: 'America/Argentina/Buenos_Aires' } })))?.city).toStrictEqual(buenosAires);
  });

  it('ignores anything else', () => {
    for (const raw of [undefined, 5, 'nope', 'null', '[1]']) expect(decodeSynced(raw)).toBeNull();
    expect(decodeSynced('{"enabled":false,"units":"c","city":{"lat":200,"lon":0}}')).toEqual({ enabled: false, units: 'c', share: false, city: null });
  });
});

describe('the °F default', () => {
  it('follows where the browser’s language is from', () => {
    for (const tag of ['en-US', 'en', 'es-US', 'es-PR', 'en-GU', 'en-BS', 'en-KY']) expect(unitsFor(tag)).toBe('f');
    for (const tag of ['en-GB', 'pt-BR', 'my', 'my-MM', 'en-LR', 'de', '', 'not a language']) expect(unitsFor(tag)).toBe('c');
  });
});

describe('the server', () => {
  it('is asked again once its copy expires, a little later for some', () => {
    expect(refreshDelay('private, max-age=600', () => 0)).toBe(600_000);
    expect(refreshDelay('private, max-age=600', () => 0.999)).toBeCloseTo(720_000, -3);
    // Within 1 to 30 minutes, and every 15 when the server doesn't say.
    expect(refreshDelay('private, max-age=10', () => 0)).toBe(60_000);
    expect(refreshDelay('max-age=7200', () => 0)).toBe(30 * 60_000);
    for (const header of [null, 'no-store', 's-maxage=100', 'max-age=soon']) expect(refreshDelay(header, () => 0)).toBe(15 * 60_000);
  });

  it('is asked for places in the browser’s language when it has a two-letter code', () => {
    expect(searchLanguage('pt-BR')).toBe('pt');
    expect(searchLanguage('EN-gb')).toBe('en');
    // Filipino isn't Finnish, nor Hawaiian Hausa.
    for (const tag of ['fil-PH', 'haw', 'ast', '', 'not a language']) expect(searchLanguage(tag)).toBe('en');
  });

  it('gets 15 seconds or until the caller gives up, also in browsers without AbortSignal.any', async () => {
    const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    try {
      vi.useFakeTimers();
      const hang = (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      vi.stubGlobal('fetch', vi.fn(hang));
      const ctrl = new AbortController();
      const timedOut = fetchReport(lisbon, 'socket-1', ctrl.signal).catch((err: Error) => err.name);
      await vi.advanceTimersByTimeAsync(14_999);
      const stopped = fetchReport(lisbon, 'socket-1', ctrl.signal).catch((err: Error) => err.name);
      ctrl.abort();
      expect(await stopped).toBe('AbortError');
      await vi.advanceTimersByTimeAsync(1);
      expect(await timedOut).toBe('AbortError');

      vi.stubGlobal('fetch', vi.fn(async () => Response.json(sunny, { headers: { 'Cache-Control': 'private, max-age=300' } })));
      vi.spyOn(Math, 'random').mockReturnValue(0);
      await expect(fetchReport(lisbon, 'socket-1', new AbortController().signal)).resolves.toEqual({ report: sunny, refreshIn: 300_000 });
    } finally {
      if (any) Object.defineProperty(AbortSignal, 'any', any);
    }
  });
});

describe('words and numbers', () => {
  it('formats in the chosen units', () => {
    expect(formatTemp(20.4, 'c')).toBe('20°');
    expect(formatTemp(20, 'f', true)).toBe('68°F');
    expect(formatWind(0.4, 90, 'c')).toBe('Calm');
    expect(formatWind(12, 315, 'c')).toBe('12 km/h NW');
    expect(formatWind(16.09344, 92, 'f')).toBe('10 mph E');
    // Per hour, from the last 15 minutes.
    expect(formatPrecipitation(0.44, 'c')).toBe('1.8 mm/h');
    expect(formatPrecipitation(6.35, 'f')).toBe('1 in/h');
    expect(formatVisibility(804, 'c')).toBe('800 m');
    expect(formatVisibility(2500, 'c')).toBe('2.5 km');
    expect(formatVisibility(1609.344, 'f')).toBe('1 mi');
  });

  it('names weather codes and tells the local time', () => {
    expect(describeCode(61)).toBe('Light rain');
    expect(describeCode(2)).toBe('Partly cloudy');
    expect(describeCode(42)).toBe('Cloudy');
    // In this machine's own format ("1:05 PM", "13:05", "1:05 pm"…).
    const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone: 'UTC' });
    expect(clockAt(Date.UTC(2026, 0, 1, 12, 5), 3600)).toBe(clock.format(Date.UTC(2026, 0, 1, 13, 5)));
    expect(clockAt(Date.UTC(2026, 0, 1, 2, 5), -5 * 3600)).toBe(clock.format(Date.UTC(2025, 11, 31, 21, 5)));
  });
});

describe('the scene', () => {
  const report = (patch: Partial<WeatherReport>): WeatherReport => ({ ...sunny, ...patch });
  const look = (date: Date, r: WeatherReport | null) => {
    const { target } = newFx();
    computeLook(target, date, lisbon, r, false);
    return target;
  };
  const noon = new Date(Date.UTC(2026, 5, 21, 12, 40));
  const midnight = new Date(Date.UTC(2026, 5, 21, 0, 40));

  it('is darker at night, but never too dark to see the office', () => {
    const day = brightness(look(noon, report({})));
    const night = brightness(look(midnight, report({ isDay: false })));
    expect(day).toBeGreaterThan(0.9 * DAYTIME_BRIGHTNESS);
    expect(night).toBeLessThan(0.6 * day);
    expect(night).toBeGreaterThanOrEqual(0.45 * DAYTIME_BRIGHTNESS - 1e-9);
    // The sun comes from above in the day, and the light never from below the horizon.
    expect(look(noon, null).sunDir.y).toBeGreaterThan(0.9);
    expect(look(midnight, null).sunDir.y).toBeGreaterThan(0);
  });

  it('shows fog, rain, snow and wind', () => {
    expect(look(noon, report({})).clearAir).toBe(1);
    expect(look(noon, report({ code: 45, visibility: 200 })).clearAir).toBeLessThan(0.1);
    const rain = look(noon, report({ code: 63, precipitation: 1.5, rain: 1.5 }));
    expect(rain.precip).toBeGreaterThan(0.45);
    expect(rain.wetness).toBeGreaterThan(0.5);
    expect(look(noon, report({ code: 73, snowfall: 0.5 })).precip).toBeGreaterThan(0.5);
    expect(look(noon, report({ code: 3 })).precip).toBe(0);
    // A west wind (from 270°) blows things east.
    const wind = look(noon, report({ windKph: 36, windDir: 270 }));
    expect(wind.windX).toBeCloseTo(10);
    expect(wind.windZ).toBeCloseTo(0);
  });
});

describe('your weather in the app', () => {
  type Data = typeof import('../client/src/features/weather/data');
  type Hook = (session: unknown) => () => void;
  const account = (weather?: string): AccountUser => ({
    id: 'u1',
    name: 'Ada',
    email: null,
    avatarUrl: null,
    profile: { settings: weather === undefined ? {} : { weather } },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** The weather's client as on a fresh page load: this browser's storage stays. */
  async function pageLoad() {
    vi.resetModules();
    vi.stubGlobal('window', new EventTarget());
    fake.app.store = null;
    fake.onSession.mockClear();
    const data: Data = await import('../client/src/features/weather/data');
    const { useWeather } = await import('../client/src/features/weather/state');
    const { useStore } = await import('../client/src/state/store');
    const hook = fake.onSession.mock.calls[0][1] as Hook;
    return { ...data, useWeather, useStore, hook };
  }

  it('doesn’t let a late "Use my location" undo a city chosen meanwhile', async () => {
    fake.items.clear();
    const w = await pageLoad();
    let found: (place: WeatherPlace) => void = () => {};
    fake.locateDevice.mockReturnValueOnce(new Promise((resolve) => (found = resolve)));
    const located = w.locateMe();
    expect(w.useWeather.getState().locating).toBe(true);
    w.chooseCity(lisbon);
    expect(w.useWeather.getState().locating).toBe(false);
    found({ name: null, lat: 51.5, lon: -0.1 });
    expect(await located).toBe(false);
    expect(w.useWeather.getState().prefs).toMatchObject({ city: lisbon, device: null });

    // A new choice also clears the last try's error.
    fake.locateDevice.mockRejectedValueOnce(new Error('Location access is blocked. Choose a city instead.'));
    expect(await w.locateMe()).toBe(false);
    expect(w.useWeather.getState().locateError).toMatch(/blocked/);
    w.chooseAutomatic();
    expect(w.useWeather.getState()).toMatchObject({ locateError: null, prefs: { city: null, device: null } });

    // So does closing the picker that showed it.
    fake.locateDevice.mockRejectedValueOnce(new Error('Couldn’t get your location.'));
    expect(await w.locateMe()).toBe(false);
    w.clearLocateError();
    expect(w.useWeather.getState()).toMatchObject({ locateError: null, prefs: { city: null, device: null } });
  });

  it('follows changes made in another tab, so it doesn’t save older ones over them', async () => {
    fake.items.clear();
    const w = await pageLoad();
    w.useStore.setState({ account: account(encodeSynced(prefs({ city: lisbon }))) });
    expect(w.useWeather.getState().prefs.city).toEqual(lisbon);
    // Another tab uses the device's location…
    const device: WeatherPlace = { name: null, lat: 51.5, lon: -0.1 };
    const theirs = prefs({ device });
    localStorage.setItem(PREFS_KEY, JSON.stringify(theirs));
    window.dispatchEvent(Object.assign(new Event('storage'), { key: PREFS_KEY }));
    expect(w.useWeather.getState().prefs).toEqual(theirs);
    // …and saves it to the account, which tells this tab too.
    w.useStore.setState({ account: account(encodeSynced(theirs)) });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '')).toEqual(theirs);
  });

  it('keeps a change the account didn’t take, and saves it on the next page load', async () => {
    fake.items.clear();
    const before = encodeSynced(prefs());
    let w = await pageLoad();
    w.useStore.setState({ account: account(before) });
    fake.saveAccountSettings.mockRejectedValueOnce(new Error('Offline'));
    w.setPrefs({ units: 'f' });
    await settle();

    w = await pageLoad();
    fake.saveAccountSettings.mockClear();
    w.useStore.setState({ account: account(before) });
    expect(w.useWeather.getState().prefs.units).toBe('f');
    expect(fake.saveAccountSettings).toHaveBeenCalledWith({ weather: encodeSynced(prefs({ units: 'f' })) });
  });

  it('takes the account’s setting when it changed elsewhere since the change it didn’t take', async () => {
    fake.items.clear();
    let w = await pageLoad();
    w.useStore.setState({ account: account(encodeSynced(prefs())) });
    fake.saveAccountSettings.mockRejectedValueOnce(new Error('Offline'));
    w.setPrefs({ units: 'f' });
    await settle();

    w = await pageLoad();
    fake.saveAccountSettings.mockClear();
    w.useStore.setState({ account: account(encodeSynced(prefs({ city: lisbon }))) });
    expect(w.useWeather.getState().prefs).toMatchObject({ units: 'c', city: lisbon });
    expect(fake.saveAccountSettings).not.toHaveBeenCalled();
  });

  describe('in an office', () => {
    /** Joins an office whose server has weather (or not), with your connection in Lisbon. */
    async function join(hook: Hook, weather = true) {
      const fetch = vi.fn(async (url: string) => {
        if (!weather) return url === '/api/weather/here' ? Response.json({ place: null, off: true }) : Response.json({ error: 'Not found' }, { status: 404 });
        if (url === '/api/weather/here') return Response.json({ place: lisbon });
        return Response.json(sunny, { headers: { 'Cache-Control': 'private, max-age=240' } });
      });
      vi.stubGlobal('fetch', fetch);
      const emit = vi.fn();
      let joined = (_rejoin: boolean) => {};
      const onJoined = (handler: typeof joined) => {
        joined = handler;
        handler(false);
        return () => {};
      };
      const stop = hook({ selfId: () => 'socket-1', socket: { emit }, onJoined });
      await vi.advanceTimersByTimeAsync(0);
      const reports = () => fetch.mock.calls.filter(([url]) => url.startsWith('/api/weather?')).length;
      return { reports, emit, rejoin: () => joined(true), stop };
    }
    const hide = (hidden: boolean) => {
      Object.assign(document, { hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    it('fetches the weather again when the server’s copy expires, in a hidden tab only while sharing', async () => {
      fake.items.clear();
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const w = await pageLoad();
      const { reports, emit, rejoin, stop } = await join(w.hook);
      expect(reports()).toBe(1);
      await vi.advanceTimersByTimeAsync(239_999);
      expect(reports()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reports()).toBe(2);

      // Hidden, the next one waits for you…
      hide(true);
      await vi.advanceTimersByTimeAsync(240_000);
      expect(reports()).toBe(2);
      hide(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(reports()).toBe(3);

      // …unless others see your weather (sent again after a reconnect: the server forgot it).
      const shared = { code: 0, isDay: true, tempC: 20, utcOffset: 3600 };
      w.setPrefs({ share: true });
      expect(emit).toHaveBeenLastCalledWith('weather:share', shared);
      emit.mockClear();
      rejoin();
      expect(emit).toHaveBeenCalledWith('weather:share', shared);
      hide(true);
      await vi.advanceTimersByTimeAsync(240_000);
      expect(reports()).toBe(4);
      hide(false);
      stop();
    });

    it('finds out whether the server has weather also while yours is off', async () => {
      fake.items.clear();
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs({ enabled: false })));
      vi.useFakeTimers();
      const w = await pageLoad();
      const { reports, stop } = await join(w.hook, false);
      expect(w.useWeather.getState().available).toBe(false);
      expect(reports()).toBe(0);
      stop();
    });
  });
});
