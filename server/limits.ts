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
