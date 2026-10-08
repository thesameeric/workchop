import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect } from 'socket.io-client';
import { refreshDelay } from '../client/src/features/weather/api';
import { weatherFeature } from '../server/features/weather';
import { DEFAULT_AVATAR } from '../shared/avatar';
import { startServer } from '../server/index';
import type { PlayerPatch } from '../shared/types';
import type { SharedWeather, WeatherPlace, WeatherReport } from '../shared/weather';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, join, until, type Client } from './helpers/http';

/** A fake Open-Meteo (tests never reach the network): Sydney's cell is down, the rest answer. */
const calls: URL[] = [];
const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  calls.push(url);
  if (url.pathname === '/v1/search') {
    return Response.json({
      results: [
        { id: 2950159, name: 'Berlin', latitude: 52.52437, longitude: 13.41053, country: 'Germany', admin1: 'Land Berlin', timezone: 'Europe/Berlin' },
        { id: 5083330, name: 'Berlin', latitude: 44.46867, longitude: -71.18508, country: 'United States', admin1: 'New Hampshire', timezone: 'America/New_York' },
      ],
    });
  }
  if (url.searchParams.get('latitude') === '-33.9') return Response.json({ error: true, reason: 'Internal error' }, { status: 500 });
  return Response.json({
    utc_offset_seconds: 7200,
    timezone: 'Europe/Berlin',
    current: {
      time: 1759924800,
      interval: 900,
      temperature_2m: 18.5,
      weather_code: 61,
      is_day: 1,
      cloud_cover: 90,
      precipitation: 0.4,
      rain: 0.4,
      snowfall: 0,
      wind_speed_10m: 12,
      wind_direction_10m: 200,
      visibility: null,
    },
  });
}) as typeof fetch;

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server;
let plain: Server;
let off: Server;
let base: string;
const opened: Client[] = [];

beforeAll(async () => {
  const db = await createTestDb();
  const start = (feature: ReturnType<typeof weatherFeature>) =>
    startServer({
      port: 0,
      host: '127.0.0.1',
      db,
      quiet: true,
      iceServers: [],
      features: [feature],
      auth: { google: null, apple: null, devLogin: true },
      // So tests can come from different addresses.
      clientIpHeader: 'x-test-ip',
    });
  server = await start(weatherFeature({ enabled: true, fetch: fakeFetch, apiKey: null, geoHeaders: 'cloudflare' }));
  plain = await start(weatherFeature({ enabled: true, fetch: fakeFetch, apiKey: null, geoHeaders: null }));
  off = await start(weatherFeature({ enabled: false, fetch: fakeFetch }));
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  for (const s of opened) s.disconnect();
  await Promise.all([server, plain, off].map((s) => s?.close()));
});

const get = (path: string, headers: Record<string, string> = {}, at = base) => fetch(`${at}/api${path}`, { headers });
const as = (socket: Client) => ({ 'X-Workchop-Socket': socket.id! });

/** Someone in a new office on the main server. */
async function inOffice(name = 'Ana') {
  const { id, guest } = await createOffice(base);
  return { officeId: id, guest, ...(await join(base, id, name)) };
}

/** A connection that hasn't joined an office. */
async function connected(): Promise<Client> {
  const socket: Client = connect(base, { transports: ['websocket'], forceNew: true });
  opened.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
  });
  return socket;
}

describe('GET /api/weather', () => {
  it('answers only connections that are in an office', async () => {
    const { socket } = await inOffice();
    const lobby = await connected();
    expect((await get('/weather?lat=1&lon=1')).status).toBe(403);
    expect((await get('/weather?lat=1&lon=1', { 'X-Workchop-Socket': 'no-such-socket' })).status).toBe(403);
    const res = await get('/weather?lat=1&lon=1', as(lobby));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect((await get('/weather?lat=1&lon=1', as(socket))).status).toBe(200);
  });

  it('refuses bad coordinates', async () => {
    const { socket } = await inOffice();
    for (const query of ['', '?lat=1', '?lon=1', '?lat=&lon=1', '?lat=91&lon=1', '?lat=1&lon=-181', '?lat=abc&lon=1', '?lat=1&lon=1e999', '?lat=1&lat=2&lon=1']) {
      const res = await get(`/weather${query}`, as(socket));
      expect([query, res.status]).toEqual([query, 400]);
    }
  });

  it('answers the weather of the rounded cell, asking Open-Meteo once per cell', async () => {
    const { socket } = await inOffice();
    const before = calls.length;
    const res = await get('/weather?lat=52.5234&lon=13.4119', as(socket));
    expect(res.status).toBe(200);
    // Until the cell's report expires: 15 minutes plus 1–4 of jitter.
    const maxAge = Number(res.headers.get('cache-control')!.match(/^private, max-age=(\d+)$/)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(959);
    expect(maxAge).toBeLessThanOrEqual(1140);
    // The browser reads it the same way: its next refresh comes once the server's copy has expired.
    expect(refreshDelay(res.headers.get('cache-control'), () => 0)).toBe(maxAge * 1000);
    const report = (await res.json()) as WeatherReport;
    expect(report).toEqual({
      lat: 52.5,
      lon: 13.4,
      code: 61,
      isDay: true,
      tempC: 18.5,
      cloudCover: 90,
      precipitation: 0.4,
      rain: 0.4,
      snowfall: 0,
      windKph: 12,
      windDir: 200,
      visibility: null,
      utcOffset: 7200,
      timezone: 'Europe/Berlin',
      fetchedAt: expect.any(Number),
    });
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.searchParams.get('latitude')).toBe('52.5');
    expect(calls.at(-1)!.searchParams.get('longitude')).toBe('13.4');
    // The same cell from someone else: from the cache.
    const other = await inOffice('Ben');
    expect(await (await get('/weather?lat=52.46&lon=13.35', as(other.socket))).json()).toEqual(report);
    expect(calls.length).toBe(before + 1);
  });

  it('answers 503 with Retry-After when Open-Meteo fails and nothing is cached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { socket } = await inOffice();
      const res = await get('/weather?lat=-33.87&lon=151.21', as(socket));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: expect.any(String) });
      const retryAfter = Number(res.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(warn).toHaveBeenCalledWith('[weather] could not get the weather:', 'Open-Meteo answered 500');
    } finally {
      warn.mockRestore();
    }
  });

  it('limits how many lookups one connection may cause from its address', async () => {
    const { socket } = await inOffice();
    const from = (ip: string) => ({ ...as(socket), 'X-Test-IP': ip });
    for (let i = 0; i < 20; i++) expect((await get(`/weather?lat=${60 + i}&lon=100`, from('203.0.113.1'))).status).toBe(200);
    const res = await get('/weather?lat=81&lon=100', from('203.0.113.1'));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many weather requests. Try again later.' });
    // Until the first of the 20 is 10 minutes old.
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(590);
    expect(retryAfter).toBeLessThanOrEqual(600);
    // Cached cells are still answered, and others aren't affected, not even with this connection's id.
    expect((await get('/weather?lat=60&lon=100', from('203.0.113.1'))).status).toBe(200);
    expect((await get('/weather?lat=81&lon=100', from('198.51.100.7'))).status).toBe(200);
    const other = await inOffice('Ben');
    expect((await get('/weather?lat=82&lon=100', { ...as(other.socket), 'X-Test-IP': '203.0.113.1' })).status).toBe(200);
  });
});

describe('GET /api/weather/here', () => {
  const saoPaulo = {
    'cf-iplatitude': '-23.5475',
    'cf-iplongitude': '-46.6361',
    // UTF-8 bytes, as Cloudflare sends them.
    'cf-ipcity': Buffer.from('São Paulo').toString('latin1'),
    'cf-timezone': 'America/Sao_Paulo',
  };

  it('answers the place from trusted location headers, without needing a connection', async () => {
    const res = await get('/weather/here', saoPaulo);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ place: { name: 'São Paulo', lat: -23.5, lon: -46.6, timezone: 'America/Sao_Paulo' } });
    expect(await (await get('/weather/here')).json()).toEqual({ place: null });
    expect(await (await get('/weather/here', { ...saoPaulo, 'cf-iplatitude': 'north' })).json()).toEqual({ place: null });
    // Workchop's own headers aren't what this server was told to trust.
    expect(await (await get('/weather/here', { 'x-workchop-geo-lat': '1', 'x-workchop-geo-lon': '2' })).json()).toEqual({ place: null });
  });

  it('ignores location headers unless GEO_HEADERS is set', async () => {
    const res = await get('/weather/here', saoPaulo, `http://127.0.0.1:${plain.port}`);
    expect(await res.json()).toEqual({ place: null });
  });

  it('says so when weather is off', async () => {
    const at = `http://127.0.0.1:${off.port}`;
    const here = await get('/weather/here', saoPaulo, at);
    expect(here.status).toBe(200);
    expect(await here.json()).toEqual({ place: null, off: true });
    expect((await get('/weather?lat=1&lon=1', {}, at)).status).toBe(404);
  });
});

describe('GET /api/weather/places', () => {
  it('searches Open-Meteo for people in an office, rounding what it answers', async () => {
    const { socket } = await inOffice();
    expect((await get('/weather/places?q=Berlin')).status).toBe(403);
    const res = await get('/weather/places?q=%20Berlin%20&lang=DE', as(socket));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: 'Berlin', region: 'Land Berlin', country: 'Germany', lat: 52.5, lon: 13.4, timezone: 'Europe/Berlin' },
      { name: 'Berlin', region: 'New Hampshire', country: 'United States', lat: 44.5, lon: -71.2, timezone: 'America/New_York' },
    ] satisfies WeatherPlace[]);
    const asked = calls.at(-1)!;
    expect(asked.origin + asked.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
    expect(Object.fromEntries(asked.searchParams)).toEqual({ name: 'Berlin', count: '5', language: 'de', format: 'json' });
    await get('/weather/places?q=New%20%20York&lang=english', as(socket));
    expect(Object.fromEntries(calls.at(-1)!.searchParams)).toMatchObject({ name: 'New York', language: 'en' });
  });

  it('refuses searches that are too short or too long', async () => {
    const { socket } = await inOffice();
    for (const q of ['', 'a', '%20%20b%20', 'x'.repeat(81)]) {
      const res = await get(`/weather/places?q=${q}`, as(socket));
      expect([q, res.status]).toEqual([q, 400]);
    }
    expect((await get('/weather/places', as(socket))).status).toBe(400);
    expect((await get(`/weather/places?q=${'x'.repeat(80)}`, as(socket))).status).toBe(200);
  });
});

describe('weather:share', () => {
  it('shows the sanitized weather on the sharer, until they stop', async () => {
    const { officeId, socket: ana } = await inOffice('Ana');
    const { socket: ben } = await join(base, officeId, 'Ben');
    const updates: [string, PlayerPatch][] = [];
    ben.on('player:updated', (id, patch) => updates.push([id, patch]));

    ana.emit('weather:share', { code: 61, isDay: true, tempC: 12.34, utcOffset: 3600, city: 'Lisbon' } as SharedWeather);
    await until(() => updates.length === 1);
    const shared = { code: 61, isDay: true, tempC: 12.3, utcOffset: 3600 };
    expect(updates[0]).toEqual([ana.id, { weather: shared }]);

    // People who come later see it too.
    const cy = await join(base, officeId, 'Cy');
    expect(cy.res.ok && cy.res.players.find((p) => p.id === ana.id)?.weather).toEqual(shared);

    // Junk and the same weather again change nothing; null stops sharing.
    ana.emit('weather:share', { code: 'rain' } as unknown as SharedWeather);
    ana.emit('weather:share', 'sunny' as unknown as SharedWeather);
    ana.emit('weather:share', shared);
    ana.emit('weather:share', null);
    await until(() => updates.length === 2);
    expect(updates[1]).toEqual([ana.id, { weather: null }]);
  });

  // Waits out the limit in real time (a few seconds).
  it('is limited per connection: the latest weather held back is shared once the limit allows', { timeout: 15_000 }, async () => {
    const { officeId, socket: ana } = await inOffice('Ana');
    const { socket: ben } = await join(base, officeId, 'Ben');
    const temps: (number | null)[] = [];
    ben.on('player:updated', (_id, patch) => {
      if ('weather' in patch) temps.push(patch.weather?.tempC ?? null);
    });
    const share = (tempC: number) => ana.emit('weather:share', { code: 0, isDay: true, tempC, utcOffset: 0 });
    for (let t = 1; t <= 6; t++) share(t);
    await until(() => temps.length === 4);
    expect(temps).toEqual([1, 2, 3, 6]);

    // Stopping is never limited, and drops what was held back.
    share(7);
    share(8);
    ana.emit('weather:share', null);
    await until(() => temps.length === 5);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(temps).toEqual([1, 2, 3, 6, null]);
  });

  it('is ignored outside an office, also from someone who just left one', async () => {
    const { officeId, guest, socket: ana } = await inOffice('Ana');
    const { socket: ben } = await join(base, officeId, 'Ben');
    const shared: [string, number | null][] = [];
    ben.on('player:updated', (id, patch) => {
      if ('weather' in patch) shared.push([id, patch.weather?.tempC ?? null]);
    });
    const weather = (tempC: number): SharedWeather => ({ code: 0, isDay: true, tempC, utcOffset: 0 });
    // Ana leaves the office by asking for one that doesn't exist.
    expect(await ana.emitWithAck('join', { officeId: 'no-such-office', name: 'Ana', avatar: DEFAULT_AVATAR })).toMatchObject({ ok: false });
    ana.emit('weather:share', weather(20));
    const lobby = await connected();
    lobby.emit('weather:share', weather(21));
    // One connection's events are handled in order, so both shares have been once these answer.
    await ana.emitWithAck('time');
    await lobby.emitWithAck('time');

    // Joining later doesn't bring them along either.
    const joined = await lobby.emitWithAck('join', { officeId, name: 'Cy', avatar: DEFAULT_AVATAR, guest });
    expect(joined.ok && joined.players.find((p) => p.id === lobby.id)).toMatchObject({ name: 'Cy' });
    expect(joined.ok && joined.players.find((p) => p.id === lobby.id)?.weather).toBeUndefined();
    // Ben gets updates in order: the first is this one.
    lobby.emit('weather:share', weather(22));
    await until(() => shared.length > 0);
    expect(shared).toEqual([[lobby.id, 22]]);
  });
});
