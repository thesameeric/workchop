import { describe, expect, it } from 'vitest';
import { GEO_PATH, withGeo, type VisitorGeo } from '../cloudflare/geo';
import { placeFromHeaders } from '../server/features/weather/geo';

// The Cloudflare Worker's geo headers: on Containers the server trusts x-workchop-geo-* (GEO_HEADERS=workchop),
// so the Worker must drop every copy a visitor sends and only set them from Cloudflare's own lookup.

const ORIGIN = 'https://workchop.example.com';
const LISBON: VisitorGeo = { latitude: '38.71667', longitude: '-9.13333', city: 'Lisbon', timezone: 'Europe/Lisbon' };
const FORGED = {
  'X-Workchop-Geo-Lat': '51.5',
  'x-workchop-geo-lon': '-0.12',
  'X-WORKCHOP-GEO-CITY': 'London',
  'x-workchop-geo-tz': 'Europe/London',
  'x-workchop-geo-extra': 'anything',
};

const request = (path: string, headers: Record<string, string> = {}) => new Request(ORIGIN + path, { headers });
const geoHeaders = (req: Request) => Object.fromEntries([...req.headers].filter(([name]) => name.startsWith('x-workchop-geo-')));

describe('withGeo', () => {
  it('replaces forged headers on the location route with Cloudflare’s', () => {
    const out = withGeo(request(GEO_PATH, { ...FORGED, cookie: 'sid=1' }), LISBON);
    expect(geoHeaders(out)).toEqual({
      'x-workchop-geo-lat': '38.71667',
      'x-workchop-geo-lon': '-9.13333',
      'x-workchop-geo-city': 'Lisbon',
      'x-workchop-geo-tz': 'Europe/Lisbon',
    });
    expect(out.headers.get('cookie')).toBe('sid=1');
  });

  it('drops a forged city or time zone that Cloudflare doesn’t replace', () => {
    const out = withGeo(request(GEO_PATH, FORGED), { latitude: '38.7', longitude: '-9.1' });
    expect(geoHeaders(out)).toEqual({ 'x-workchop-geo-lat': '38.7', 'x-workchop-geo-lon': '-9.1' });
  });

  it('sends no location when cf is missing or has no coordinates', () => {
    for (const cf of [undefined, {}, { city: 'Lisbon', timezone: 'Europe/Lisbon' }, { latitude: '38.7' }]) {
      expect(geoHeaders(withGeo(request(GEO_PATH, FORGED), cf))).toEqual({});
      expect(geoHeaders(withGeo(request(GEO_PATH), cf))).toEqual({});
    }
  });

  it('strips forged headers on every other path without adding a location', () => {
    for (const path of ['/api/weather?lat=1&lon=2', '/api/weather/here/', '/api/weather/HERE', '/socket.io/?EIO=4&transport=websocket', '/']) {
      const out = withGeo(request(path, { ...FORGED, 'x-workchop-socket': 'abc' }), LISBON);
      expect(geoHeaders(out)).toEqual({});
      expect(out.headers.get('x-workchop-socket')).toBe('abc');
      expect(out.url).toBe(ORIGIN + path);
    }
  });

  it('passes other requests on untouched', () => {
    const req = request('/socket.io/?EIO=4&transport=websocket', { upgrade: 'websocket' });
    expect(withGeo(req, LISBON)).toBe(req);
  });

  it('round-trips non-ASCII city names through an ASCII header', () => {
    for (const city of ['São Paulo', 'Zürich', 'Kraków', '東京', 'Ḩalab', 'Saint-Étienne']) {
      const out = withGeo(request(GEO_PATH), { ...LISBON, city });
      const sent = out.headers.get('x-workchop-geo-city')!;
      expect(sent).toMatch(/^[\x21-\x7e]+$/);
      const place = placeFromHeaders('workchop', (name) => out.headers.get(name) ?? undefined);
      expect(place).toEqual({ name: city, lat: 38.7, lon: -9.1, timezone: 'Europe/Lisbon' });
    }
  });
});
