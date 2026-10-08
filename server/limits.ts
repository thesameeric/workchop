/** Allows `limit` events per key within a sliding window; forgets keys that went quiet. */
export function windowLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();
  return (key: string): boolean => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      lastSweep = now;
      for (const [k, times] of hits) if (now - times[times.length - 1] >= windowMs) hits.delete(k);
    }
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}
