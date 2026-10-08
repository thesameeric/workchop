// The visitor's approximate location for the weather, added by the Worker (worker.ts). Kept apart,
// with no Workers-only imports, so the tests can run it in Node.

/** The server's route that answers with the visitor's approximate place, for the weather. */
export const GEO_PATH = '/api/weather/here';

/** The part of a request's `cf` object used here: Cloudflare's guess from the visitor's IP address. */
export interface VisitorGeo {
  latitude?: string;
  longitude?: string;
  city?: string;
  timezone?: string;
}

/**
 * Passes the visitor's approximate location (`cf`, from `request.cf`) to the server in x-workchop-geo-*
 * headers (GEO_HEADERS=workchop), after removing any the visitor sent. Only GEO_PATH needs them: other
 * requests, WebSocket upgrades included, go on untouched unless they carry such a header.
 */
export function withGeo(request: Request, cf: VisitorGeo | undefined): Request {
  // Header names come back in lower case, so this catches any spelling.
  const sent = [...request.headers.keys()].filter((name) => name.startsWith('x-workchop-geo-'));
  const wanted = new URL(request.url).pathname === GEO_PATH;
  if (!sent.length && !wanted) return request;
  const forwarded = new Request(request);
  for (const name of sent) forwarded.headers.delete(name);
  // cf is missing in the dashboard's preview (and wrangler dev may give a placeholder location).
  if (wanted && cf?.latitude && cf.longitude) {
    forwarded.headers.set('x-workchop-geo-lat', cf.latitude);
    forwarded.headers.set('x-workchop-geo-lon', cf.longitude);
    // Header values must be ASCII, and many city names aren't.
    if (cf.city) forwarded.headers.set('x-workchop-geo-city', encodeURIComponent(cf.city));
    if (cf.timezone) forwarded.headers.set('x-workchop-geo-tz', cf.timezone);
  }
  return forwarded;
}
