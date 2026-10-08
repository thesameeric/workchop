import { TAP_INTERVAL_MS, type TapResult } from '../../shared/audio';
import type { Feature } from '../features';

/** Allows one action per `intervalMs` for each (from, to) pair; remembers only recent pairs. */
export class PairLimiter {
  private last = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes the pair's turn: 0 if allowed now, otherwise how many ms are left to wait. */
  take(from: string, to: string): number {
    const now = this.now();
    const key = `${from}\n${to}`;
    const wait = (this.last.get(key) ?? -Infinity) + this.intervalMs - now;
    if (wait > 0) return wait;
    if (this.last.size >= 1000) this.sweep(now);
    this.last.set(key, now);
    return 0;
  }

  get size(): number {
    return this.last.size;
  }

  private sweep(now: number): void {
    for (const [key, at] of this.last) if (now - at >= this.intervalMs) this.last.delete(key);
  }
}

/** Headphones: tapping someone who wears them on the shoulder. */
export const feature: Feature = {
  name: 'audio',
  register(ctx) {
    const taps = new PairLimiter(TAP_INTERVAL_MS);
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
          const wait = taps.take(s.user?.id ?? me.id, them.userId ?? them.id);
          if (wait > 0) return reply({ ok: false, error: `You tapped ${them.name} a moment ago. Try again in ${Math.ceil(wait / 1000)} s.` });
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
