import { isLatitude, isLongitude, roundCoord, sanitizePlaceName, type WeatherPlace } from '../../../shared/weather';

// The visitor's approximate place, from headers a proxy in front of the server adds. Anyone can send
// such headers, so they are read only when GEO_HEADERS names the proxy that sets them (and removes
// visitors' copies), like CLIENT_IP_HEADER.

/**
 * Who sets the location headers: Workchop's Cloudflare Worker (x-workchop-geo-*), or Cloudflare's
 * "Add visitor location headers" Managed Transform (cf-ip*, e.g. behind a Cloudflare Tunnel).
 */
export type GeoHeaders = 'workchop' | 'cloudflare';

const NAMES: Record<GeoHeaders, [lat: string, lon: string, city: string, timezone: string]> = {
  workchop: ['x-workchop-geo-lat', 'x-workchop-geo-lon', 'x-workchop-geo-city', 'x-workchop-geo-tz'],
  cloudflare: ['cf-iplatitude', 'cf-iplongitude', 'cf-ipcity', 'cf-timezone'],
};

/** GEO_HEADERS's value; null (headers ignored) when it is unset or unknown. */
export function geoHeadersFrom(value: string | null | undefined): GeoHeaders | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (v === 'workchop' || v === 'cloudflare') return v;
  console.warn(`[weather] GEO_HEADERS must be workchop or cloudflare (got "${value}"), so location headers are ignored`);
  return null;
}

const TIME_ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;

/** An IANA time zone name like "Europe/Lisbon" from untrusted input, or undefined. */
export function timeZoneName(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length <= 64 && TIME_ZONE.test(raw) ? raw : undefined;
}

/** A header value sent as UTF-8 bytes, which Node reads as latin1 (Cloudflare sends non-ASCII city names so). */
function fromUtf8Bytes(v: string): string {
  if (/[^\x00-\xff]/.test(v)) return v;
  const decoded = Buffer.from(v, 'latin1').toString('utf8');
  return decoded.includes('�') ? v : decoded;
}

function cityName(mode: GeoHeaders, raw: string | undefined): string | null {
  if (!raw) return null;
  if (mode === 'cloudflare') return sanitizePlaceName(fromUtf8Bytes(raw));
  try {
    return sanitizePlaceName(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/** A number from a header or query string; NaN for anything else (an empty string isn't 0). */
export const coordinate = (v: unknown) => (typeof v === 'string' && v.trim() ? Number(v) : NaN);

/** The visitor's place from trusted headers (`header` reads one, like req.get), rounded; null without one. */
export function placeFromHeaders(mode: GeoHeaders | null, header: (name: string) => string | undefined): WeatherPlace | null {
  if (!mode) return null;
  const [lat, lon, city, timezone] = NAMES[mode].map(header);
  const la = coordinate(lat);
  const lo = coordinate(lon);
  if (!isLatitude(la) || !isLongitude(lo)) return null;
  const place: WeatherPlace = { name: cityName(mode, city), lat: roundCoord(la), lon: roundCoord(lo) };
  const zone = timeZoneName(timezone?.trim());
  if (zone) place.timezone = zone;
  return place;
}
