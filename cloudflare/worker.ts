import { DurableObject } from 'cloudflare:workers';

/*
 * Runs Workchop's Docker image (the Node server: API, Socket.IO realtime, calls signalling) on
 * Cloudflare Containers. Every API and realtime request goes to ONE Durable Object, which keeps one
 * container running and hands requests and WebSocket upgrades straight to it. The app's pages and
 * scripts are served by Workers Static Assets (see wrangler.jsonc), so they never reach the container.
 */

interface Env {
  WORKCHOP: DurableObjectNamespace<WorkchopServer>;
  /** Where to create the Durable Object on first use ("weur", "enam", "apac"…); empty means near the first visitor. */
  LOCATION_HINT?: string;
  /** "true" to run without a database, for trying things out: offices vanish whenever the container stops. */
  EPHEMERAL_STORAGE?: string;
  // Secrets (`wrangler secret put NAME`), passed on to the server.
  DATABASE_URL?: string;
  DATABASE_SSL?: string;
  SPOTIFY_CLIENT_ID?: string;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_KEY_API_TOKEN?: string;
  CLOUDFLARE_TURN_TTL?: string;
  ICE_SERVERS?: string;
  TURN_URL?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
}

const PASSED_TO_SERVER = [
  'DATABASE_URL',
  'DATABASE_SSL',
  'SPOTIFY_CLIENT_ID',
  'CLOUDFLARE_TURN_KEY_ID',
  'CLOUDFLARE_TURN_KEY_API_TOKEN',
  'CLOUDFLARE_TURN_TTL',
  'ICE_SERVERS',
  'TURN_URL',
  'TURN_USERNAME',
  'TURN_CREDENTIAL',
] as const;

/** The port the server listens on inside the container (the Dockerfile's PORT). */
const PORT = 3001;
/**
 * How long the container keeps running after the last ordinary request. Realtime (WebSocket)
 * traffic doesn't count, so open Workchop tabs check in every few minutes to keep it running.
 */
const IDLE_MS = 15 * 60 * 1000;
/** The server only starts listening once it reaches the database, which it retries for about 30 s. */
const STARTUP_MS = 90 * 1000;

/** A short fingerprint of the server's settings, to notice when secrets change. */
async function fingerprint(env: Record<string, string>): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(Object.entries(env).sort()));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unavailable(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'retry-after': '5' },
  });
}

export class WorkchopServer extends DurableObject<Env> {
  /** Resolves once the container answers its health check. */
  private ready: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A deploy restarts this object, but not necessarily the container, and the restarted
    // object starts without an inactivity timeout: set it again.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(IDLE_MS).catch(() => {}));
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return unavailable('No container is configured for Workchop.');
    if (!this.env.DATABASE_URL && this.env.EPHEMERAL_STORAGE !== 'true') {
      return unavailable('Workchop needs a database on Cloudflare: set the DATABASE_URL secret (see the README).');
    }
    // The container stops when idle (or when Cloudflare moves it): start a new one when needed.
    if (!container.running) this.ready = null;
    this.ready ??= this.start().catch((err) => {
      this.ready = null;
      throw err;
    });
    try {
      await this.ready;
    } catch (err) {
      console.error('[workchop] the server did not start:', err);
      return unavailable('Workchop is starting up. Please try again in a moment.');
    }

    const url = new URL(request.url);
    const forwarded = new Request(new URL(url.pathname + url.search, `http://container:${PORT}`), request);
    forwarded.headers.delete('host');
    try {
      // Returned as is, so WebSocket upgrades pass straight through to the server.
      return await container.getTcpPort(PORT).fetch(forwarded);
    } catch (err) {
      this.ready = null;
      console.error('[workchop] request to the server failed:', err);
      return unavailable('Workchop is restarting. Please try again in a moment.');
    }
  }

  private async start(): Promise<void> {
    const container = this.ctx.container!;
    // Every request arrives through Cloudflare, which sets CF-Connecting-IP to the visitor's address.
    const env: Record<string, string> = { CLIENT_IP_HEADER: 'cf-connecting-ip' };
    for (const key of PASSED_TO_SERVER) {
      const value = this.env[key];
      if (value) env[key] = value;
    }
    const config = await fingerprint(env);

    // A running server keeps the settings it started with. Changing a secret restarts this object
    // but not the container, so restart the server when its settings are out of date.
    if (container.running) {
      const info = await container.inspect().catch(() => null);
      if (info && info.labels.config !== config) {
        console.log('[workchop] settings changed: restarting the server');
        await this.stopGracefully();
      }
    }
    if (!container.running) {
      // Right after a stop, a new container can take a moment to become available.
      for (let attempt = 0; ; attempt++) {
        try {
          container.start({ env, enableInternet: true, labels: { config } });
          break;
        } catch (err) {
          if (attempt >= 20) throw err;
          await scheduler.wait(500);
        }
      }
    }
    await container.setInactivityTimeout(IDLE_MS);

    const port = container.getTcpPort(PORT);
    const deadline = Date.now() + STARTUP_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await port.fetch('http://container/api/health', { signal: AbortSignal.timeout(2000) });
        await res.body?.cancel();
        if (res.ok) return;
        lastError = new Error(`health check answered ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      if (!container.running) throw new Error('the container stopped while starting', { cause: lastError });
      await scheduler.wait(500);
    }
    throw new Error('the server did not answer its health check in time', { cause: lastError });
  }

  /** SIGTERM, so the server saves pending office edits before it exits. */
  private async stopGracefully(): Promise<void> {
    const container = this.ctx.container!;
    container.signal(15);
    await Promise.race([container.monitor().catch(() => {}), scheduler.wait(20_000)]);
    if (container.running) await container.destroy('settings changed');
  }
}

export default {
  fetch(request, env): Promise<Response> {
    // Workchop keeps live rooms in memory, so everyone must reach the same server.
    const hint = env.LOCATION_HINT?.trim() as DurableObjectLocationHint | undefined;
    return env.WORKCHOP.getByName('workchop', hint ? { locationHint: hint } : undefined).fetch(request);
  },
} satisfies ExportedHandler<Env>;
