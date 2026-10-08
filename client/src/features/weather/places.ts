import { isLatitude, isLongitude, roundCoord, sanitizePlaceName, type WeatherPlace, type WeatherSource } from '../../../../shared/weather';
import type { WeatherPrefs } from './state';

/**
 * A place from untrusted input (the server, this browser's storage, the account), rounded; or null.
 * Its time zone isn't kept: the local time comes from the report.
 */
export function toPlace(raw: unknown): WeatherPlace | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isLatitude(r.lat) || !isLongitude(r.lon)) return null;
  const place: WeatherPlace = { name: sanitizePlaceName(r.name), lat: roundCoord(r.lat), lon: roundCoord(r.lon) };
  const region = sanitizePlaceName(r.region);
  const country = sanitizePlaceName(r.country);
  if (region) place.region = region;
  if (country) place.country = country;
  return place;
}

/** The place to show the weather for: a chosen city, else your device's location, else your connection's. */
export function resolvePlace(prefs: WeatherPrefs, here: WeatherPlace | null): { source: WeatherSource; place: WeatherPlace | null } {
  if (!prefs.enabled) return { source: 'none', place: null };
  if (prefs.city) return { source: 'city', place: prefs.city };
  if (prefs.device) return { source: 'device', place: prefs.device };
  if (here) return { source: 'ip', place: here };
  return { source: 'none', place: null };
}

/** Whether two places share a weather cell (both null counts too). */
export function sameCell(a: WeatherPlace | null, b: WeatherPlace | null): boolean {
  return a === b || (!!a && !!b && a.lat === b.lat && a.lon === b.lon);
}

/** "Lisbon", or "Your location" for a place without a name. */
export function placeName(place: WeatherPlace): string {
  return place.name ?? 'Your location';
}

/** "Lisbon, Portugal": region and country, to tell places with the same name apart. */
export function placeDetail(place: WeatherPlace): string {
  return [place.region, place.country].filter((v) => v && v !== place.name).join(', ');
}

/** Where the weather you see comes from, for people. */
export function sourceLine(source: WeatherSource, place: WeatherPlace | null): string {
  if (source === 'city' && place) return `Chosen city: ${placeName(place)}`;
  if (source === 'device') return 'Your device’s location';
  if (source === 'ip') return 'Approximate, from your connection';
  return 'No location';
}
