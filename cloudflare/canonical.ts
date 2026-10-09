/**
 * Where to send a request that came in at another of Workchop's addresses (the workers.dev one,
 * www.), so everyone uses PUBLIC_URL: sign-in cookies, OAuth callbacks and realtime connections only
 * work there. Null when the request is already there, when PUBLIC_URL isn't set, or for local
 * addresses (wrangler dev).
 */
export function canonicalRedirect(url: URL, publicUrl: string | undefined): string | null {
  let canonical: URL;
  try {
    canonical = new URL(publicUrl ?? '');
  } catch {
    return null;
  }
  if (url.host === canonical.host) return null;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname.endsWith('.localhost')) return null;
  return canonical.origin + url.pathname + url.search;
}
