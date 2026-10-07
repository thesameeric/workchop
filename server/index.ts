import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { sanitizeName } from '../shared/avatar';
import type { TemplateId } from '../shared/templates';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/types';
import { OfficeStore } from './officeStore';
import { attachRealtime } from './realtime';
import { FileRepo, PostgresRepo, type DatabaseSsl } from './repos';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Directory for office JSON files (used when no database is configured). */
  dataDir?: string;
  /** Postgres connection string; when set, offices are stored in Postgres instead of files. */
  databaseUrl?: string;
  databaseSsl?: DatabaseSsl;
  /** Directory with the built client to serve; omit in development (Vite serves it). */
  clientDir?: string | null;
  iceServers?: RTCIceServerLike[];
  quiet?: boolean;
}

interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
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

export async function startServer(opts: ServerOptions = {}) {
  const repo = opts.databaseUrl
    ? new PostgresRepo(opts.databaseUrl, opts.databaseSsl)
    : new FileRepo(opts.dataDir ?? path.resolve('data/offices'));
  const store = new OfficeStore(repo);
  await store.init();
  if (!opts.quiet) console.log(`[workchop] storing offices in ${store.description}`);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    maxHttpBufferSize: 256 * 1024,
  });
  const realtime = attachRealtime(io, store);
  const iceServers = opts.iceServers ?? iceServersFromEnv();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ iceServers });
  });

  // Very small per-IP limit on creating offices.
  const creations = new Map<string, number[]>();
  app.post('/api/offices', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const recent = (creations.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= 30) {
      res.status(429).json({ error: 'Too many offices created, try again later.' });
      return;
    }
    creations.set(ip, [...recent, now]);
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

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const servesClient = !!opts.clientDir && existsSync(opts.clientDir);
  if (servesClient) {
    const clientDir = opts.clientDir!;
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  } else {
    // In development the page is served by Vite; point lost visitors there.
    app.get(/.*/, (_req, res) => {
      res.type('text').send('This is the Workchop API server. Open the app at the "Local:" address that npm run dev printed (usually http://localhost:5173).');
    });
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
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
    async close() {
      // Save pending office edits first, so nothing is lost even if shutdown gets cut short.
      await store.flush();
      io.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await store.close();
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
