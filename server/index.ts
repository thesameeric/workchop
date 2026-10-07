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

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
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
  const store = new OfficeStore(opts.dataDir ?? path.resolve('data/offices'));
  await store.init();

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
    const stored = await store.create(name, template);
    res.status(201).json({ id: stored.office.id, ownerKey: stored.ownerKey });
  });

  app.get('/api/offices/:id', async (req, res) => {
    const stored = await store.get(req.params.id);
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

  if (opts.clientDir && existsSync(opts.clientDir)) {
    const clientDir = opts.clientDir;
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  if (!opts.quiet) console.log(`[workchop] server listening on http://localhost:${port}`);

  return {
    port,
    io,
    store,
    async close() {
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await store.flush();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const production = process.env.NODE_ENV === 'production' || here.endsWith(path.join('dist', 'server'));
  const server = await startServer({
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST,
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
    clientDir: production ? (process.env.CLIENT_DIR ?? path.resolve(here, '../client')) : null,
  });
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
