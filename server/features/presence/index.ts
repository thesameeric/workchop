import type express from 'express';
import type { AccountUser } from '../../../shared/account';
import { appMatchers, isAppPlatform, OTHER_APP, sanitizeHelperApp, type AppPlatform } from '../../../shared/apps';
import { sanitizePresenceUpdate } from '../../../shared/presence';
import type { HelperDevice } from '../../../shared/presence';
import type { Feature, ServerContext, SocketContext } from '../../features';
import { windowLimiter } from '../../limits';
import { PresenceMap } from './presence';
import { HelperTokens, isTokenFormat, hashToken, TooManyDevices } from './tokens';

// The current-app indicator: a status picked by hand ("Working in Figma") and, for signed-in people,
// what an optional desktop helper (helper/workchop-presence.cjs) reports. See README "Current app".

/** How often expiries are checked while anyone has a presence. */
const SWEEP_MS = 5_000;
/** Without anyone of theirs online, the helper is asked to check back this much later (seconds). */
const IDLE_RETRY_S = 300;

const userKey = (id: string) => `u:${id}`;
const guestKey = (socketId: string) => `s:${socketId}`;

function createPresence(ctx: ServerContext): void {
  const map = new PresenceMap();
  const tokens = new HelperTokens(ctx.db);
  /** The presence each socket was last told, to send only changes. */
  const told = new Map<string, string>();
  /** When each helper last reported, and from what kind of computer. */
  const seen = new Map<string, { platform: AppPlatform; at: number }>();

  const keyOf = (s: SocketContext) => (s.user ? userKey(s.user.id) : guestKey(s.socket.id));

  const playersOf = (key: string) => {
    if (key.startsWith('u:')) return ctx.realtime.playersOfUser(key.slice(2));
    const s = ctx.realtime.contextOf(key.slice(2));
    const room = s?.room();
    const player = s?.me();
    return room && player ? [{ officeId: room.officeId, player }] : [];
  };

  /** Shows the person's current app to their offices, and tells their own tabs. */
  const refresh = (key: string) => {
    const e = map.get(key);
    for (const { officeId, player } of playersOf(key)) {
      // Customers' apps stay private (even signed in with the helper running).
      const app = player.customer ? null : map.effective(e, player);
      if ((player.app ?? null) !== app) ctx.realtime.updatePlayer(officeId, player.id, { app });
      const state = map.state(e, player);
      const json = JSON.stringify(state);
      if (told.get(player.id) === json) continue;
      told.set(player.id, json);
      ctx.io.to(player.id).emit('presence:state', state);
    }
  };

  let sweeper: ReturnType<typeof setInterval> | null = null;
  const sweep = () => {
    try {
      for (const key of map.sweep((k) => playersOf(k).length > 0)) refresh(key);
    } catch (err) {
      console.error('[presence] could not expire statuses:', err);
    }
    if (!map.size && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  };
  const startSweeping = () => {
    if (sweeper || !map.size) return;
    sweeper = setInterval(sweep, SWEEP_MS);
    sweeper.unref();
  };
  ctx.onClose(() => {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
  });

  ctx.realtime.onSocket((s) => {
    const canSet = s.limiter(2, 8);
    s.socket.on('presence:set', (raw) => {
      try {
        if (!s.room() || !canSet()) return;
        const update = sanitizePresenceUpdate(raw);
        if (!update) return;
        const key = keyOf(s);
        // After a reconnect, a status is only restored if the server has forgotten it (a restart),
        // even if a desktop helper has reported since.
        if (update.restore && map.get(key)?.fromClient) delete update.manual;
        map.update(key, update);
        refresh(key);
        startSweeping();
      } catch (err) {
        console.error('[presence] could not set a status:', err);
      }
    });
    // Do not disturb, away and headphones focus change what others see.
    s.socket.on('profile', (patch) => {
      try {
        if (patch && typeof patch === 'object' && ('status' in patch || 'focus' in patch)) refresh(keyOf(s));
      } catch (err) {
        console.error('[presence] could not update after a profile change:', err);
      }
    });
  });
  ctx.realtime.onJoin((s) => refresh(keyOf(s)));
  ctx.realtime.onLeave((s) => {
    told.delete(s.socket.id);
    // A guest's status lives as long as their connection's visit.
    if (!s.user) map.delete(guestKey(s.socket.id));
  });

  // Pairing computers (signed-in people only).
  const mayPair = windowLimiter(20, 60 * 60 * 1000);
  const { app } = ctx;

  app.get('/me/devices', ctx.auth.requireUser, async (_req, res) => {
    const user = res.locals.user as AccountUser;
    const now = Date.now();
    const devices: HelperDevice[] = (await tokens.list(user.id)).map((d) => {
      const s = seen.get(d.id);
      return { ...d, active: !!s && now - s.at < 60_000, platform: s?.platform ?? null, lastUsedAt: s ? Math.max(s.at, d.lastUsedAt ?? 0) : d.lastUsedAt };
    });
    res.set('Cache-Control', 'no-store');
    res.json(devices);
  });

  app.post('/me/devices', ctx.auth.requireUser, async (req, res) => {
    const user = res.locals.user as AccountUser;
    if (!mayPair(user.id)) {
      res.status(429).json({ error: 'Too many computers paired, try again later.' });
      return;
    }
    try {
      const { device, token } = await tokens.create(user.id, req.body?.label);
      res.set('Cache-Control', 'no-store');
      res.status(201).json({ device, token });
    } catch (err) {
      if (!(err instanceof TooManyDevices)) throw err;
      res.status(400).json({ error: 'You have paired the most computers you can. Remove one first.' });
    }
  });

  app.delete('/me/devices/:id', ctx.auth.requireUser, async (req, res) => {
    const user = res.locals.user as AccountUser;
    const id = String(req.params.id);
    if (!(await tokens.revoke(user.id, id))) {
      res.status(404).json({ error: 'No such computer.' });
      return;
    }
    seen.delete(id);
    if (map.dropHelper(userKey(user.id), id)) refresh(userKey(user.id));
    res.status(204).end();
  });

  // What the helper matches apps against, so it doesn't need updating when the list grows.
  app.get('/app-presence/apps', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(appMatchers());
  });

  // About one report per 2 s per token (the helper sends on change and every 15 s).
  const mayReport = windowLimiter(5, 10_000);
  // Tokens not in memory cost a query each: limit those per address, and overall.
  const mayLookUpFrom = windowLimiter(10, 1000);
  const mayLookUp = windowLimiter(50, 1000);
  const report: express.RequestHandler = async (req, res) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!isTokenFormat(token)) {
      res.status(401).json({ error: 'Pair this computer again in Workchop: Settings > Desktop helper.' });
      return;
    }
    const hash = hashToken(token);
    if (!mayReport(hash)) {
      res.set('Retry-After', '2').status(429).json({ error: 'Too many reports.' });
      return;
    }
    if (!tokens.cached(hash) && !(mayLookUpFrom(ctx.clientIp(req)) && mayLookUp('all'))) {
      res.set('Retry-After', '5').status(503).json({ error: 'Busy, try again shortly.' });
      return;
    }
    const owner = await tokens.verify(token, hash);
    if (!owner) {
      res.status(401).json({ error: 'This computer was removed. Pair it again in Workchop: Settings > Desktop helper.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.v !== 1 || !isAppPlatform(body.platform) || (body.app !== null && typeof body.app !== 'string')) {
      res.status(400).json({ error: 'Expected {"app": "<id>" | null, "platform": "macos" | "windows" | "linux", "v": 1}.' });
      return;
    }
    const unsupported = body.unsupported === true;
    // An id this server doesn't know (from a newer list) shows as "Working".
    const reported = unsupported || body.app === null ? null : (sanitizeHelperApp(body.app) ?? OTHER_APP);
    const key = userKey(owner.userId);
    map.report(key, owner.id, { app: reported, platform: body.platform, unsupported });
    seen.set(owner.id, { platform: body.platform, at: Date.now() });
    refresh(key);
    startSweeping();
    if (playersOf(key).length) {
      // Not while they're offline, so the database can sleep (e.g. a serverless one).
      tokens.touch(owner.id).catch((err) => console.error('[presence] could not note a token was used:', err));
    } else {
      res.set('Retry-After', String(IDLE_RETRY_S));
    }
    res.status(204).end();
  };
  app.put('/me/app-presence', report);
}

export const feature: Feature = {
  name: 'presence',
  migrations: [
    {
      id: 300,
      name: 'api_tokens',
      // Desktop helper tokens: only a SHA-256 of each is stored. Revoked ones are kept, marked.
      sql: `
        CREATE TABLE api_tokens (
          id           text PRIMARY KEY,
          user_id      text NOT NULL REFERENCES users ON DELETE CASCADE,
          token_hash   text NOT NULL UNIQUE,
          scope        text NOT NULL,
          label        text NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now(),
          last_used_at timestamptz,
          revoked_at   timestamptz
        );
        CREATE INDEX api_tokens_user_idx ON api_tokens (user_id)`,
    },
  ],
  register(ctx) {
    createPresence(ctx);
  },
};
