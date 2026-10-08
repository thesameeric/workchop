import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import type { AccountUser, Space } from '../shared/account';
import { sanitizeName } from '../shared/avatar';
import type { TemplateId } from '../shared/templates';
import { Accounts } from './accounts';
import { authOptionsFromEnv, createAuth, type AuthOptions } from './auth';
import { openDb, type DatabaseSsl, type Db } from './db';
import { importLegacyOffices } from './db/legacy';
import { collectMigrations, migrate } from './db/migrations';
import { registerFeatures, type Feature, type ServerContext } from './features';
import { serverFeatures } from './features/index';
import { windowLimiter } from './limits';
import { OfficeStore } from './officeStore';
import { attachRealtime, sessionRoom, userRoom, type IO } from './realtime';
import { SqlOfficeRepo } from './repos';
import { cloudflareTurnFromEnv, mintCloudflareIceServers, type CloudflareTurn, type RTCIceServerLike } from './turn';
import { createUploads, S3_MISSING, uploadOptionsFromEnv, type UploadOptions } from './uploads';

export interface ServerOptions {
  port?: number;
  host?: string;
  /**
   * Base data directory (default ./data): the PGlite database in <dataDir>/db when there's no
   * DATABASE_URL, uploaded files in <dataDir>/uploads, and old office JSON files to import once.
   */
  dataDir?: string;
  /** Postgres connection string; without one, data is kept in PGlite (embedded Postgres). */
  databaseUrl?: string;
  databaseSsl?: DatabaseSsl;
  /** An open database to use instead (tests). It is migrated, but close() leaves it open. */
  db?: Db;
  /** The address people open Workchop at; defaults to PUBLIC_URL, or http://localhost:5173 outside production. */
  publicUrl?: string | null;
  /** Sign-in providers; defaults to the GOOGLE_*, APPLE_*, GITHUB_* and DEV_LOGIN variables. */
  auth?: AuthOptions;
  /** Upload settings; unset ones come from UPLOADS_STORAGE, UPLOAD_MAX_BYTES, UPLOADS_QUOTA_MB and S3_*. */
  uploads?: Partial<UploadOptions>;
  /** Server features to load; defaults to serverFeatures() in server/features/index.ts (which reads COINS). */
  features?: Feature[];
  /** Directory with the built client to serve; omit in development (Vite serves it). */
  clientDir?: string | null;
  iceServers?: RTCIceServerLike[];
  /** Spotify app client id for listen-along; defaults to SPOTIFY_CLIENT_ID. */
  spotifyClientId?: string | null;
  /** Cloudflare Realtime TURN key for per-visitor TURN credentials; defaults to CLOUDFLARE_TURN_*. */
  cloudflareTurn?: CloudflareTurn | null;
  /**
   * Request header with the visitor's IP when running behind a proxy (e.g. cf-connecting-ip, or
   * x-forwarded-for behind Caddy); defaults to CLIENT_IP_HEADER. Only set it when every request
   * comes through that proxy, since visitors could otherwise fake the header.
   */
  clientIpHeader?: string | null;
  quiet?: boolean;
}

export function iceServersFromEnv(env: NodeJS.ProcessEnv = process.env): RTCIceServerLike[] {
  if (env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      console.warn('[config] ICE_SERVERS is not valid JSON, ignoring it');
    }
  }
  const servers: RTCIceServerLike[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (env.TURN_URL) {
    servers.push({ urls: env.TURN_URL.split(','), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  return servers;
}

/** Compares secrets in constant time. */
function sameSecret(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** PUBLIC_URL's origin, or null when unknown. */
function originOf(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
  } catch {
    // Reported below.
  }
  throw new Error(`PUBLIC_URL must be the address people open Workchop at, like https://office.example.com (got "${publicUrl}")`);
}

export async function startServer(opts: ServerOptions = {}) {
  const dataDir = path.resolve(opts.dataDir ?? 'data');
  const features = opts.features ?? serverFeatures();
  // Settings are checked before the database is opened, so a mistake there doesn't leave it locked.
  const publicUrl = opts.publicUrl !== undefined ? opts.publicUrl : process.env.PUBLIC_URL || (process.env.NODE_ENV === 'production' ? null : 'http://localhost:5173');
  const publicOrigin = originOf(publicUrl);
  const uploadOptions = { ...uploadOptionsFromEnv(dataDir), ...opts.uploads };
  if (uploadOptions.storage === 's3' && !uploadOptions.s3) throw new Error(S3_MISSING);
  const db = opts.db ?? (await openDb({ databaseUrl: opts.databaseUrl, databaseSsl: opts.databaseSsl, dataDir }));
  try {
    const applied = await migrate(db, collectMigrations(features));
    if (applied.length && !opts.quiet) console.log(`[db] applied migrations: ${applied.join(', ')}`);
    // A database handed in by a test has no data directory of its own unless one is given.
    if (!opts.db || opts.dataDir) await importLegacyOffices(db, dataDir);
  } catch (err) {
    if (!opts.db) await db.close();
    throw err;
  }
  const store = new OfficeStore(new SqlOfficeRepo(db));
  await store.init();
  if (!opts.quiet) console.log(`[workchop] storing data in ${db.description}`);

  const accounts = new Accounts(db);

  const app = express();
  app.disable('x-powered-by');

  const httpServer = createServer(app);
  const io: IO = new Server(httpServer, {
    maxHttpBufferSize: 256 * 1024,
    // Browsers send Origin on WebSocket handshakes from other sites, and not on same-origin polling.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || !publicOrigin || origin === publicOrigin);
    },
  });
  const auth = createAuth({
    db,
    accounts,
    publicOrigin,
    options: opts.auth ?? authOptionsFromEnv(),
    onLogout: (tokenHash) => io.in(sessionRoom(tokenHash)).disconnectSockets(true),
    onUserUpdated: (user) => io.to(userRoom(user.id)).emit('account:updated', user),
    quiet: opts.quiet,
  });
  io.use(auth.socketMiddleware);
  const realtime = attachRealtime(io, store, { accounts });

  const ipHeader = (opts.clientIpHeader !== undefined ? opts.clientIpHeader : process.env.CLIENT_IP_HEADER)?.trim().toLowerCase() || null;
  const clientIp = (req: express.Request): string => {
    const forwarded = ipHeader ? req.get(ipHeader)?.split(',')[0]?.trim() : undefined;
    return forwarded || req.ip || 'unknown';
  };

  const uploads = createUploads({
    db,
    options: uploadOptions,
    clientIp,
    // Anyone in the office right now may upload, guests included, with the key only their socket got.
    uploaderOf(socketId, uploadKey, officeId) {
      const ctx = realtime.contextOf(socketId);
      const player = ctx?.me();
      if (!ctx?.socket.connected || ctx.room()?.officeId !== officeId || !player || !sameSecret(uploadKey, ctx.socket.data.uploadKey)) return null;
      return { userId: ctx.user?.id ?? null, name: player.name };
    },
  });
  if (!opts.quiet) console.log(`[workchop] storing uploaded files in ${uploads.description}`);

  const iceServers = opts.iceServers ?? iceServersFromEnv();
  const turn = opts.cloudflareTurn !== undefined ? opts.cloudflareTurn : cloudflareTurnFromEnv();

  // Changes may only be asked for by this app's own pages (or by non-browser clients), not by other
  // sites, not even ones on the same domain, whose requests carry the session cookie. Apple's
  // sign-in answer is the one cross-site form post.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.path === '/auth/apple/callback') return next();
    // Browsers say where a request comes from in Sec-Fetch-Site; older ones only in Origin.
    const site = req.get('sec-fetch-site');
    const origin = req.get('origin');
    if (site ? site === 'same-origin' || site === 'none' : !origin || !publicOrigin || origin === publicOrigin) return next();
    res.status(403).json({ error: 'Requests from other sites are not allowed.' });
  });

  // Before express.json, which would otherwise swallow uploads sent as application/json.
  app.post('/api/offices/:id/uploads', uploads.upload);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Spotify listen-along is switched on by setting SPOTIFY_CLIENT_ID (a public PKCE client id).
  const spotifyClientId = opts.spotifyClientId ?? process.env.SPOTIFY_CLIENT_ID ?? null;
  // TURN credentials cost relay bandwidth, so each address gets a generous but finite number; past
  // that (or if Cloudflare is unreachable) calls still work for most people over STUN alone.
  const mayMintTurn = windowLimiter(120, 60 * 60 * 1000);
  // After a failure, don't make every visitor wait on Cloudflare again for a while.
  let turnFailedAt = 0;
  app.get('/api/config', async (req, res) => {
    let servers = iceServers;
    let iceTtl: number | undefined;
    if (turn && Date.now() - turnFailedAt > 30_000 && mayMintTurn(clientIp(req))) {
      try {
        servers = await mintCloudflareIceServers(turn);
        iceTtl = turn.ttl;
      } catch (err) {
        turnFailedAt = Date.now();
        console.warn('[turn] could not get Cloudflare TURN credentials:', (err as Error).message);
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json({ iceServers: servers, iceTtl, turn: !!turn, spotifyClientId: spotifyClientId || null, uploadMaxBytes: uploadOptions.maxBytes });
  });

  // Very small per-IP limit on creating offices.
  const mayCreate = windowLimiter(30, 60 * 60 * 1000);
  app.post('/api/offices', async (req, res) => {
    if (!mayCreate(clientIp(req))) {
      res.status(429).json({ error: 'Too many offices created, try again later.' });
      return;
    }
    const name = sanitizeName(req.body?.name, 48) || 'My Office';
    const template: TemplateId = req.body?.template === 'blank' ? 'blank' : 'startup';
    let stored;
    try {
      stored = await store.create(name, template);
    } catch (err) {
      console.error('[store] could not create office:', err);
      res.status(503).json({ error: 'Could not save the new office. Please try again.' });
      return;
    }
    // Signed in: the office is listed among their spaces, with them as its owner.
    const user = await auth.userFromRequest(req);
    if (user) await accounts.visit(user.id, stored.office.id, true).catch((err) => console.error('[accounts] could not add the owner:', err));
    res.status(201).json({ id: stored.office.id, ownerKey: stored.ownerKey });
  });

  app.get('/api/offices/:id', async (req, res) => {
    let stored;
    try {
      stored = await store.get(req.params.id);
    } catch (err) {
      console.error('[store] could not load office:', err);
      res.status(503).json({ error: 'Storage is unavailable right now.' });
      return;
    }
    if (!stored) {
      res.status(404).json({ error: 'Office not found' });
      return;
    }
    res.json({
      id: stored.office.id,
      name: stored.office.settings.name,
      online: realtime.onlineCount(stored.office.id),
    });
  });

  app.get('/api/uploads/:id{/:name}', uploads.download);

  // Each sign-in attempt stores a little state, so limit them like office creation.
  const maySignIn = windowLimiter(60, 15 * 60 * 1000);
  app.use(['/api/auth/dev', '/api/auth/:provider/start'], (req, res, next) => {
    if (maySignIn(clientIp(req))) return next();
    res.status(429).json({ error: 'Too many sign-in attempts, try again later.' });
  });
  app.use('/api', auth.router);
  app.get('/api/me/spaces', auth.requireUser, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = res.locals.user as AccountUser;
    const spaces: Space[] = (await accounts.spaces(user.id)).map((s) => ({
      ...s,
      // Offices open right now may have been renamed moments ago.
      name: store.peek(s.id)?.office.settings.name ?? s.name,
      online: realtime.onlineCount(s.id),
    }));
    res.json(spaces);
  });

  const featureRoutes = express.Router();
  app.use('/api', featureRoutes);
  const closers: (() => void | Promise<void>)[] = [];
  /** Runs what features asked to run on closing, newest first; one failing doesn't stop the rest. */
  const closeFeatures = async () => {
    for (const close of closers.splice(0).reverse()) {
      try {
        await close();
      } catch (err) {
        console.error('[workchop] a feature failed to close:', err);
      }
    }
  };
  const ctx: ServerContext = {
    app: featureRoutes,
    io,
    db,
    store,
    auth: { userFromRequest: auth.userFromRequest, requireUser: auth.requireUser },
    realtime,
    uploads,
    publicOrigin,
    clientIp,
    quiet: !!opts.quiet,
    onClose: (fn) => void closers.push(fn),
  };
  try {
    await registerFeatures(features, ctx);
  } catch (err) {
    await closeFeatures();
    await auth.close();
    if (!opts.db) await db.close();
    throw err;
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const servesClient = !!opts.clientDir && existsSync(opts.clientDir);
  if (servesClient) {
    const clientDir = opts.clientDir!;
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => {
      // With `root`, a hidden folder in the install path (like ~/.local) isn't refused as a dotfile.
      res.sendFile('index.html', { root: clientDir });
    });
  } else {
    // In development the page is served by Vite; point lost visitors there.
    app.get(/.*/, (_req, res) => {
      res.type('text').send('This is the Workchop API server. Open the app at the "Local:" address that npm run dev printed (usually http://localhost:5173).');
    });
  }

  // Errors from route handlers (e.g. the database going away) and bad request bodies.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { status?: number; expose?: boolean; message?: string };
    if (e.status && e.status >= 400 && e.status < 500) {
      res.status(e.status).json({ error: e.expose && e.message ? e.message : 'Bad request' });
      return;
    }
    console.error(`[workchop] ${req.method} ${req.path} failed:`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  }).catch(async (err) => {
    await closeFeatures();
    await auth.close();
    if (!opts.db) await db.close();
    throw err;
  });
  const port = (httpServer.address() as AddressInfo).port;
  if (!opts.quiet) {
    console.log(
      servesClient
        ? `[workchop] open http://localhost:${port}`
        : `[workchop] API server listening on port ${port} (open the app at the "Local:" address above)`,
    );
  }

  return {
    port,
    io,
    store,
    db,
    realtime,
    async close() {
      // Save pending office edits first, so nothing is lost even if shutdown gets cut short.
      await store.flush();
      io.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await store.close();
      await closeFeatures();
      await auth.close();
      if (!opts.db) await db.close();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const production = process.env.NODE_ENV === 'production' || here.endsWith(path.join('dist', 'server'));
  const port = Number(process.env.PORT ?? 3001);
  const server = await startServer({
    port,
    host: process.env.HOST,
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
    databaseUrl: process.env.DATABASE_URL || undefined,
    databaseSsl: process.env.DATABASE_SSL === 'require' || process.env.DATABASE_SSL === 'no-verify' ? process.env.DATABASE_SSL : undefined,
    // The built app is served on its own port, not Vite's: there's no sensible default address.
    publicUrl: process.env.PUBLIC_URL || (production ? null : undefined),
    auth: authOptionsFromEnv(process.env, production),
    clientDir: production ? (process.env.CLIENT_DIR ?? path.resolve(here, '../client')) : null,
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`[workchop] port ${port} is already in use. Stop the other process or choose another one, e.g. PORT=${port + 1}.`);
    process.exit(1);
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}
