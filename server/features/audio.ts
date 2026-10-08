import { TAP_INTERVAL_MS, type TapResult } from '../../shared/audio';
import type { Feature } from '../features';

/** Allows `max` actions per key in any `intervalMs`; remembers only recent keys. */
export class WindowLimiter {
  private times = new Map<string, number[]>();

  constructor(
    private readonly intervalMs: number,
    private readonly max = 1,
    private readonly now: () => number = Date.now,
  ) {}

  /** 0 if `key` may act now, otherwise how many ms are left to wait. */
  wait(key: string): number {
    const now = this.now();
    return this.waitFor(this.recent(key, now), now);
  }

  /** Takes `key`'s turn: 0 if it may act now (and it's counted), otherwise how many ms are left to wait. */
  take(key: string): number {
    const now = this.now();
    const recent = this.recent(key, now);
    const wait = this.waitFor(recent, now);
    if (wait > 0) return wait;
    if (!this.times.has(key) && this.times.size >= 1000) this.sweep(now);
    this.times.set(key, [...recent, now]);
    return 0;
  }

  get size(): number {
    return this.times.size;
  }

  private recent(key: string, now: number): number[] {
    return (this.times.get(key) ?? []).filter((at) => now - at < this.intervalMs);
  }

  private waitFor(recent: number[], now: number): number {
    return recent.length < this.max ? 0 : recent[recent.length - this.max] + this.intervalMs - now;
  }

  private sweep(now: number): void {
    for (const [key, times] of this.times) if (now - times[times.length - 1] >= this.intervalMs) this.times.delete(key);
  }
}

/** How many taps one person can get in TAP_INTERVAL_MS, from everyone together. */
export const TAPS_PER_PERSON = 3;

const seconds = (ms: number) => Math.ceil(ms / 1000);

/** Headphones: tapping someone who wears them on the shoulder. */
export const feature: Feature = {
  name: 'audio',
  register(ctx) {
    const pairs = new WindowLimiter(TAP_INTERVAL_MS);
    // Guests are a new person on every connection: this also caps taps from reconnecting guests.
    const perPerson = new WindowLimiter(TAP_INTERVAL_MS, TAPS_PER_PERSON);
    ctx.realtime.onSocket((s) => {
      const canTap = s.limiter(1, 3);
      s.socket.on('focus:tap', (to, ack) => {
        const reply = (res: TapResult) => typeof ack === 'function' && ack(res);
        try {
          const me = s.me();
          const room = s.room();
          if (!me || !room || typeof to !== 'string' || to === me.id) return reply({ ok: false, error: 'You can’t tap them right now.' });
          const them = room.players.get(to);
          if (!them) return reply({ ok: false, error: 'They’re no longer here.' });
          if (!them.focus) return reply({ ok: false, error: `${them.name} took their headphones off. Just say hi!` });
          if (!canTap()) return reply({ ok: false, error: 'Slow down a little.' });
          // Signed-in people are the same person in every tab; guests are their connection.
          const target = them.userId ?? them.id;
          const pair = `${s.user?.id ?? me.id}\n${target}`;
          const wait = pairs.wait(pair);
          if (wait > 0) return reply({ ok: false, error: `You tapped ${them.name} a moment ago. Try again in ${seconds(wait)} s.` });
          const busy = perPerson.take(target);
          if (busy > 0) return reply({ ok: false, error: `${them.name} was tapped a few times just now. Try again in ${seconds(busy)} s.` });
          pairs.take(pair);
          ctx.io.to(them.id).emit('focus:tapped', me.id, me.name);
          reply({ ok: true });
        } catch (err) {
          console.error('[audio] tap failed:', err);
          reply({ ok: false, error: 'Something went wrong. Please try again.' });
        }
      });
    });
  },
};
