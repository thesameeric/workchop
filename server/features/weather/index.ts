import type express from 'express';
import { wellFormed } from '../../../shared/text';
import { isLatitude, isLongitude, roundCoord, sanitizeSharedWeather, type SharedWeather, type WeatherHere, type WeatherReport } from '../../../shared/weather';
import type { Feature } from '../../features';
import { windowLimiter } from '../../limits';
import { coordinate, geoHeadersFrom, placeFromHeaders } from './geo';
import { createOpenMeteo, WeatherUnavailable, type OpenMeteoOptions } from './openMeteo';

// Each person's local weather from Open-Meteo, through the server's cache (GET /api/weather), their
// approximate place from trusted proxy headers (GET /api/weather/here), city search (GET
// /api/weather/places), and the weather people choose to show their office ('weather:share').

export interface WeatherOptions extends OpenMeteoOptions {
  /** False registers nothing, so the routes answer 404; default: unless WEATHER=off. */
  enabled?: boolean;
  /** Which proxy sets visitor location headers, workchop or cloudflare; default: GEO_HEADERS. */
  geoHeaders?: string | null;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Lookups and searches that ask Open-Meteo, per visitor: per connection and address together in 10
 * minutes, so someone using your connection id from elsewhere can't spend yours; and per address
 * (addressKey) in 10 minutes and in a day, so opening more connections doesn't help.
 */
const LOOKUPS = { connection: 20, address: 60, daily: 1000 };
const SEARCHES = { connection: 30, address: 60, daily: 300 };

/** Counts a miss from this address and connection and answers 0, or answers how long (ms) until one is allowed. */
function missLimit(limits: typeof LOOKUPS, now: () => number) {
  const connection = windowLimiter(limits.connection, 10 * MINUTE, now);
  const address = windowLimiter(limits.address, 10 * MINUTE, now);
  const daily = windowLimiter(limits.daily, DAY, now);
  return (ip: string, socketId: string): number => {
    const pair = `${ip} ${socketId}`;
    const wait = Math.max(connection.wait(pair), address.wait(ip), daily.wait(ip));
    if (wait === 0) {
      connection(pair);
      address(ip);
      daily(ip);
    }
    return wait;
  };
}

/**
 * The address the limits count by: an IPv4 address, or the /64 an IPv6 address is in (one household
 * or server usually has a whole /64, so counting single addresses would let one visitor count as many).
 */
export function addressKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('%')[0].toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** OPEN_METEO_API_KEY, or null (with a warning that doesn't show it) when it can't be a key. */
function apiKeyFrom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^[\x21-\x7e]{1,200}$/.test(raw)) return raw;
  console.warn('[weather] OPEN_METEO_API_KEY must be up to 200 printable characters without spaces; using the free API without it');
  return null;
}

/** The weather feature; options default to WEATHER, GEO_HEADERS and OPEN_METEO_API_KEY, read when it registers. */
export function weatherFeature(options: WeatherOptions = {}): Feature {
  return {
    name: 'weather',
    register(ctx) {
      const { enabled, geoHeaders, ...upstream } = options;
      const env = process.env;
      if (!(enabled ?? env.WEATHER?.trim().toLowerCase() !== 'off')) return;
      const now = upstream.now ?? Date.now;
      const geo = geoHeadersFrom(geoHeaders !== undefined ? geoHeaders : env.GEO_HEADERS);
      const openMeteo = createOpenMeteo({
        ...upstream,
        now,
        apiKey: apiKeyFrom(upstream.apiKey !== undefined ? upstream.apiKey : env.OPEN_METEO_API_KEY?.trim()),
      });
      const mayLookUp = missLimit(LOOKUPS, now);
      const maySearch = missLimit(SEARCHES, now);

      /**
       * The asker's socket (X-Workchop-Socket) if it is connected and in an office: weather is only
       * fetched for people online. Everyone in an office sees its socket id, hence the per-address limits.
       */
      const askerOf = (req: express.Request): string | null => {
        const id = req.get('x-workchop-socket');
        const s = id ? ctx.realtime.contextOf(id) : undefined;
        return id && s?.socket.connected && s.room() ? id : null;
      };
      const notInOffice = (res: express.Response) => {
        res.status(403).json({ error: 'Join an office to see the weather.' });
      };
      const tooMany = (res: express.Response, wait: number) => {
        res.set('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
        res.status(429).json({ error: 'Too many weather requests. Try again later.' });
      };
      const unavailable = (res: express.Response, err: unknown) => {
        if (!(err instanceof WeatherUnavailable)) console.error('[weather] a lookup failed:', err);
        const retryAt = err instanceof WeatherUnavailable ? err.retryAt : now() + 60_000;
        res.set('Retry-After', String(Math.max(1, Math.ceil((retryAt - now()) / 1000))));
        res.status(503).json({ error: 'The weather is unavailable right now.' });
      };

      ctx.app.get('/weather', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const asker = askerOf(req);
        if (!asker) return notInOffice(res);
        const lat = coordinate(req.query.lat);
        const lon = coordinate(req.query.lon);
        if (!isLatitude(lat) || !isLongitude(lon)) {
          res.status(400).json({ error: 'Give a latitude and longitude.' });
          return;
        }
        // Rounded again: the cache has one entry per 0.1° cell, and nothing more precise goes upstream.
        const cellLat = roundCoord(lat);
        const cellLon = roundCoord(lon);
        // The client asks again after max-age: when that may bring new weather (the cell's report expires,
        // or Open-Meteo may be asked about it again), at least a minute and at most half an hour from now.
        const send = (report: WeatherReport, askAgainAt = openMeteo.askAgainAt(cellLat, cellLon)) => {
          const maxAge = Math.min(30 * 60, Math.max(60, Math.ceil((askAgainAt - now()) / 1000)));
          res.set('Cache-Control', `private, max-age=${maxAge}`);
          res.json(report);
        };
        const cached = openMeteo.cached(cellLat, cellLon);
        if (cached) return send(cached);
        // Only lookups that would ask Open-Meteo count: one on its way, or a wait after a failure or a 429, costs nothing.
        if (openMeteo.wouldAsk(cellLat, cellLon)) {
          const wait = mayLookUp(addressKey(ctx.clientIp(req)), asker);
          if (wait) {
            // Over the limit, the last report (up to 3 hours old) still beats none.
            const recent = openMeteo.recent(cellLat, cellLon);
            return recent ? send(recent, now() + wait) : tooMany(res, wait);
          }
        }
        try {
          send(await openMeteo.report(cellLat, cellLon));
        } catch (err) {
          unavailable(res, err);
        }
      });

      ctx.app.get('/weather/here', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const here: WeatherHere = { place: placeFromHeaders(geo, (name) => req.get(name)) };
        res.json(here);
      });

      ctx.app.get('/weather/places', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const asker = askerOf(req);
        if (!asker) return notInOffice(res);
        const raw = typeof req.query.q === 'string' ? req.query.q : '';
        const q = wellFormed(raw.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim());
        if (q.length < 2 || q.length > 80) {
          res.status(400).json({ error: 'Search for 2 to 80 characters.' });
          return;
        }
        const lang = typeof req.query.lang === 'string' && /^[a-z]{2}$/i.test(req.query.lang) ? req.query.lang.toLowerCase() : 'en';
        try {
          const cached = openMeteo.cachedPlaces(q, lang);
          if (cached) {
            res.json(cached);
            return;
          }
          const wait = openMeteo.wouldSearch(q, lang) ? maySearch(addressKey(ctx.clientIp(req)), asker) : 0;
          if (wait) return tooMany(res, wait);
          res.json(await openMeteo.places(q, lang));
        } catch (err) {
          unavailable(res, err);
        }
      });

      ctx.realtime.onSocket((s) => {
        const mayShare = s.limiter(1, 3);
        /** New weather the limit held back; the latest is shared once it allows. */
        let held: SharedWeather | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const share = (weather: SharedWeather | null) => {
          const room = s.room();
          const me = s.me();
          if (room && me && JSON.stringify(me.weather ?? null) !== JSON.stringify(weather)) ctx.realtime.updatePlayer(room.officeId, me.id, { weather });
        };
        const shareHeldLater = () => {
          // The limit gives a token a second.
          timer = setTimeout(() => {
            try {
              if (!mayShare()) return shareHeldLater();
              timer = undefined;
              share(held);
            } catch (err) {
              console.error('[weather] could not share the weather:', err);
            }
          }, 1000);
        };
        s.socket.on('weather:share', (raw) => {
          try {
            // null stops sharing; anything else that isn't a SharedWeather is ignored.
            const weather = raw === null ? null : sanitizeSharedWeather(raw);
            const me = s.me();
            if (!s.room() || !me || (raw !== null && !weather)) return;
            if (!weather) {
              // Stopping always works, and drops weather held back.
              clearTimeout(timer);
              timer = undefined;
              return share(null);
            }
            if (timer) {
              held = weather;
              return;
            }
            // Only new weather counts towards the limit.
            if (JSON.stringify(me.weather ?? null) === JSON.stringify(weather)) return;
            if (mayShare()) return share(weather);
            held = weather;
            shareHeldLater();
          } catch (err) {
            console.error('[weather] could not share the weather:', err);
          }
        });
        s.socket.on('disconnect', () => clearTimeout(timer));
      });
    },
  };
}

export const feature = weatherFeature();
