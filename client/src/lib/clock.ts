/** Offset between this browser's clock and the server's, so synced music lines up for everyone. */
let offset = 0;

export function serverNow(): number {
  return Date.now() + offset;
}

/** Estimate the offset from a few round trips, keeping the one with the shortest delay. */
export async function syncClock(ask: () => Promise<number>, samples = 5): Promise<void> {
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    let server: number;
    try {
      server = await ask();
    } catch {
      continue;
    }
    const t1 = Date.now();
    const rtt = t1 - t0;
    const est = server - (t0 + t1) / 2;
    if (!best || rtt < best.rtt) best = { rtt, offset: est };
  }
  if (best) offset = best.offset;
}
