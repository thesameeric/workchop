/**
 * Allows `limit` events per key within a sliding window; forgets keys that went quiet.
 * `wait(key)` says how long (ms) until the key may act again (0: now), without counting anything.
 */
export function windowLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  let lastSweep = now();
  const recentOf = (key: string, t: number) => (hits.get(key) ?? []).filter((hit) => t - hit < windowMs);
  const allow = (key: string): boolean => {
    const t = now();
    if (t - lastSweep > windowMs) {
      lastSweep = t;
      for (const [k, times] of hits) if (t - times[times.length - 1] >= windowMs) hits.delete(k);
    }
    const recent = recentOf(key, t);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
  const wait = (key: string): number => {
    const t = now();
    const recent = recentOf(key, t);
    // Hits leave oldest first: one more is allowed once only limit - 1 are left.
    return recent.length < limit ? 0 : recent[recent.length - limit] + windowMs - t;
  };
  return Object.assign(allow, { wait });
}
