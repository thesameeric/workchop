/** A surrogate pair (one character, e.g. an emoji), or half of one. */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * `s` without lone surrogates (half an emoji). Postgres refuses them in jsonb and
 * encodeURIComponent throws on them, so text that is stored or put into URLs must be well-formed.
 */
export function wellFormed(s: string): string {
  return s.replace(SURROGATES, (m) => (m.length === 2 ? m : ''));
}

/** At most `max` UTF-16 units of `s`, without cutting an emoji (or any other character) in half. */
export function clip(s: string, max: number): string {
  return wellFormed(s.slice(0, max));
}
