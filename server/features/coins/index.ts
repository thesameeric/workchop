import type { AccountUser } from '../../../shared/account';
import { parseTip, PRESENCE_MINUTES, TIPS_PER_MINUTE, type TipAnswer, type TipParty } from '../../../shared/coins';
import type { PlayerState } from '../../../shared/types';
import type { Feature, SocketContext } from '../../features';
import { CoinsError, migrations, Wallets, type Award } from './wallets';

export interface CoinsOptions {
  now?: () => number;
  /** How often presence is checked (ms). */
  tickMs?: number;
  /** Active presence that earns presence coins (ms). */
  presenceMs?: number;
  /** Without moving, chatting or reacting (and with mic, camera and screen off) for this long, someone is idle. */
  idleMs?: number;
}

const HISTORY_PAGE = 20;
/** Presence time not yet paid out is kept this long after someone leaves (a reload, a short drop). */
const PRESENCE_GRACE_MS = 5 * 60_000;

/** The coins wallet: welcome bonus, daily check-in, presence coins and tips between members. */
export function createCoins(opts: CoinsOptions = {}): Feature {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 60_000;
  const presenceMs = opts.presenceMs ?? PRESENCE_MINUTES * 60_000;
  const idleMs = opts.idleMs ?? 10 * 60_000;

  return {
    name: 'coins',
    migrations,
    register(ctx) {
      const wallets = new Wallets(ctx.db, now);
      const { realtime } = ctx;

      // Office on/off, cached while the office is in use.
      const enabled = new Map<string, boolean>();
      const officeEnabled = async (officeId: string) => {
        const cached = enabled.get(officeId);
        if (cached !== undefined) return cached;
        const on = await wallets.officeEnabled(officeId);
        // Cached only while someone is there (the cache is dropped when the office empties).
        if (realtime.onlineCount(officeId)) enabled.set(officeId, on);
        return on;
      };

      const push = (userId: string, award: Award | null) => {
        if (award) realtime.emitToUser(userId, 'coins:balance', award);
      };

      ctx.app.get('/me/wallet', ctx.auth.requireUser, async (_req, res) => {
        const user = res.locals.user as AccountUser;
        try {
          push(user.id, await wallets.ensure(user.id));
          const [balance, recent] = await Promise.all([wallets.balance(user.id), wallets.history(user.id, HISTORY_PAGE)]);
          res.set('Cache-Control', 'no-store').json({ balance, recent });
        } catch (err) {
          console.error('[coins] could not load a wallet:', err);
          res.status(500).json({ error: 'Could not load your wallet' });
        }
      });

      ctx.app.get('/me/wallet/history', ctx.auth.requireUser, async (req, res) => {
        const user = res.locals.user as AccountUser;
        const raw = typeof req.query.before === 'string' ? Number(req.query.before) : undefined;
        if (raw !== undefined && !(Number.isSafeInteger(raw) && raw > 0)) return void res.status(400).json({ error: 'Bad cursor' });
        try {
          const rows = await wallets.history(user.id, HISTORY_PAGE + 1, raw);
          res.set('Cache-Control', 'no-store').json({ entries: rows.slice(0, HISTORY_PAGE), more: rows.length > HISTORY_PAGE });
        } catch (err) {
          console.error('[coins] could not load wallet history:', err);
          res.status(500).json({ error: 'Could not load your history' });
        }
      });

      // Signed-in people in offices, by socket id, and when each last did something.
      const present = new Map<string, SocketContext>();
      const lastActive = new Map<string, number>();
      // Active time not yet paid out, per account (several tabs count once), and when it last grew.
      const earned = new Map<string, { ms: number; at: number }>();
      const paying = new Set<string>();
      // Per account, kept for a minute after the last tip so leaving and coming back doesn't reset it.
      const tipLimits = new Map<string, { take: () => boolean; at: number }>();

      // The account name, which people can't change from inside an office.
      const party = (p: PlayerState, userId: string, name: string): TipParty => ({ userId, name: name || p.name, playerId: p.id });

      realtime.onSocket((s) => {
        const touch = () => {
          if (present.has(s.socket.id)) lastActive.set(s.socket.id, now());
        };
        for (const event of ['move', 'chat', 'emote'] as const) s.socket.on(event, touch);

        s.socket.on('coins:tip', async (raw, ack) => {
          if (typeof ack !== 'function') return;
          const answer = (res: TipAnswer) => ack(res);
          try {
            if (!s.user) return answer({ ok: false, error: 'Sign in to send coins' });
            const room = s.room();
            const me = s.me();
            if (!room || !me) return answer({ ok: false, error: 'Join an office first' });
            const parsed = parseTip(raw);
            if (!parsed.ok) return answer(parsed);
            const { tip } = parsed;
            if (!(await officeEnabled(room.officeId))) return answer({ ok: false, error: 'Coins are off in this office' });
            // The sender may have moved to another office meanwhile.
            if (s.room() !== room || s.me() !== me) return answer({ ok: false, error: 'Join an office first' });
            const players = [...room.players.values()];
            const target = tip.toPlayerId ? room.players.get(tip.toPlayerId) : players.find((p) => p.userId === tip.toUserId);
            if (!target) return answer({ ok: false, error: 'They’re not in this office' });
            if (!target.userId) return answer({ ok: false, error: 'They need to sign in to get coins' });
            if (target.userId === s.user.id) return answer({ ok: false, error: 'You can’t send coins to yourself' });
            let limit = tipLimits.get(s.user.id);
            if (!limit) tipLimits.set(s.user.id, (limit = { take: s.limiter(TIPS_PER_MINUTE / 60, TIPS_PER_MINUTE), at: 0 }));
            limit.at = now();
            if (!limit.take()) return answer({ ok: false, error: 'That’s a lot of tips. Try again in a minute.' });

            const result = await wallets.tip({ from: s.user.id, to: target.userId, amount: tip.amount, note: tip.note, key: tip.key, officeId: room.officeId });
            answer({ ok: true, balance: result.fromBalance });
            if (result.duplicate) return;
            realtime.emitToUser(s.user.id, 'coins:balance', { balance: result.fromBalance, delta: -tip.amount, kind: 'tip_out' });
            realtime.emitToUser(target.userId, 'coins:balance', { balance: result.toBalance, delta: tip.amount, kind: 'tip_in' });
            realtime.emitToOffice(room.officeId, 'coins:tipped', {
              from: party(me, s.user.id, result.fromName),
              to: party(target, target.userId, result.toName),
              amount: tip.amount,
              note: tip.note,
            });
          } catch (err) {
            if (err instanceof CoinsError) return answer({ ok: false, error: err.message });
            console.error('[coins] a tip failed:', err);
            answer({ ok: false, error: 'Could not send coins. Please try again.' });
          }
        });

        const canSwitch = s.limiter(1, 3);
        s.socket.on('coins:office', async (on, ack) => {
          if (typeof ack !== 'function') return;
          try {
            const room = s.room();
            if (!room) return ack({ ok: false, error: 'Join an office first' });
            if (!s.isOwner()) return ack({ ok: false, error: 'Only the owner can change this' });
            if (typeof on !== 'boolean' || !canSwitch()) return ack({ ok: false, error: 'Please try again' });
            await wallets.setOfficeEnabled(room.officeId, on);
            enabled.set(room.officeId, on);
            ack({ ok: true });
            realtime.emitToOffice(room.officeId, 'coins:office', { enabled: on });
          } catch (err) {
            console.error('[coins] could not change the office setting:', err);
            ack({ ok: false, error: 'Could not save that. Please try again.' });
          }
        });
      });

      realtime.onJoin(async (s) => {
        const room = s.room();
        if (!room) return;
        // Before any await, so that leaving meanwhile (onLeave) removes it again.
        if (s.user) {
          present.set(s.socket.id, s);
          lastActive.set(s.socket.id, now());
        }
        const on = await officeEnabled(room.officeId);
        if (s.room() !== room) return;
        s.socket.emit('coins:office', { enabled: on });
        if (!s.user) return;
        const userId = s.user.id;
        push(userId, await wallets.ensure(userId));
        // The daily bonus comes with the first visit of the day to an office where coins are on.
        if (on) push(userId, await wallets.daily(userId, room.officeId));
      });

      realtime.onLeave((s, { officeId }) => {
        present.delete(s.socket.id);
        lastActive.delete(s.socket.id);
        if (!realtime.onlineCount(officeId)) enabled.delete(officeId);
      });

      /** Counts active time for everyone present and pays presence coins for each full stretch. */
      const tick = () => {
        const t = now();
        const active = new Map<string, string>();
        for (const [socketId, s] of present) {
          const p = s.me();
          const room = s.room();
          if (!p || !room || !s.user || p.status === 'away' || enabled.get(room.officeId) === false) continue;
          const idle = t - (lastActive.get(socketId) ?? 0) > idleMs && !p.mic && !p.cam && !p.screen;
          if (!idle) active.set(s.user.id, room.officeId);
        }
        for (const [userId, e] of earned) if (!active.has(userId) && t - e.at > PRESENCE_GRACE_MS) earned.delete(userId);
        for (const [userId, l] of tipLimits) if (t - l.at > 60_000) tipLimits.delete(userId);
        for (const [userId, officeId] of active) {
          const total = (earned.get(userId)?.ms ?? 0) + tickMs;
          if (total < presenceMs || paying.has(userId)) {
            earned.set(userId, { ms: Math.min(total, presenceMs), at: t });
            continue;
          }
          earned.set(userId, { ms: total - presenceMs, at: t });
          paying.add(userId);
          wallets
            .presence(userId, officeId)
            .then((award) => push(userId, award))
            .catch((err) => console.error('[coins] could not pay presence coins:', err))
            .finally(() => paying.delete(userId));
        }
      };
      setInterval(() => {
        if (present.size || earned.size || tipLimits.size) tick();
      }, tickMs).unref();
    },
  };
}

export const feature = createCoins();
