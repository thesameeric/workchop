import { canonicalRedirect } from './canonical';
import { DurableObject } from 'cloudflare:workers';
import { withGeo } from './geo';

/*
 * Runs Workchop's Docker image (the Node server: API, Socket.IO realtime, calls signalling) on
 * Cloudflare Containers. Every API and realtime request goes to ONE Durable Object, which keeps one
 * container running and hands requests and WebSocket upgrades straight to it. The app's pages and
 * scripts are served by Workers Static Assets (see wrangler.jsonc), so they never reach the container.
 */

interface Env {
  WORKCHOP: DurableObjectNamespace<WorkchopServer>;
  /** The app's pages and scripts (dist/client). */
  ASSETS: Fetcher;
  /** Where to create the Durable Object on first use ("weur", "enam", "apac"…); empty means near the first visitor. */
  LOCATION_HINT?: string;
  /**
   * "true" to run without a database, for trying things out: the server then keeps its data in an
   * embedded database (PGlite) on the container's disk, so it vanishes whenever the container stops.
   */
  EPHEMERAL_STORAGE?: string;
  // Secrets (`wrangler secret put NAME`), passed on to the server.
  DATABASE_URL?: string;
  DATABASE_SSL?: string;
  SPOTIFY_CLIENT_ID?: string;
  /** Key for Open-Meteo's paid weather API: the free one is for non-commercial use only. */
  OPEN_METEO_API_KEY?: string;
  /** "off" turns the weather off. */
  WEATHER?: string;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_KEY_API_TOKEN?: string;
  CLOUDFLARE_TURN_TTL?: string;
  ICE_SERVERS?: string;
  TURN_URL?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  /** The address people open Homeoffice at, e.g. https://office.example.com (needed for sign-in). */
  PUBLIC_URL?: string;
  /** Resend API key for emailing sign-up links and password resets. */
  RESEND_API_KEY?: string;
  /** The sender, on a domain verified in Resend: "Homeoffice <noreply@mail.example.com>" (required with RESEND_API_KEY). */
  EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  /** The OAuth App for GitHub sign-in and notifications (callbacks: PUBLIC_URL + /api/auth/github/callback and + /api/integrations/github/callback). */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** 32 random bytes in base64 (`openssl rand -base64 32`) that encrypt the saved GitHub tokens. */
  TOKEN_ENCRYPTION_KEY?: string;
  /** Uploaded files: "s3" (an R2 bucket via S3_*) or "db" (the Postgres database). */
  UPLOADS_STORAGE?: string;
  UPLOAD_MAX_BYTES?: string;
  UPLOADS_QUOTA_MB?: string;
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_REGION?: string;
  /** Delete chat conversations quiet for this many days (default: keep them). */
  CHAT_RETENTION_DAYS?: string;
  /** Paystack's secret key: turns billing (paid plans) on. */
  PAYSTACK_SECRET_KEY?: string;
  /** At least 32 random characters: the daily cron shows it to run billing's renewals (BILLING_INTERNAL_TOKEN). */
  BILLING_INTERNAL_TOKEN?: string;
  /** Kobo per seat: Team a month, Support a year (empty: the defaults). */
  BILLING_TEAM_SEAT_PRICE?: string;
  BILLING_SUPPORT_SEAT_PRICE?: string;
}

const PASSED_TO_SERVER = [
  'DATABASE_URL',
  'DATABASE_SSL',
  'SPOTIFY_CLIENT_ID',
  'OPEN_METEO_API_KEY',
  'WEATHER',
  'CLOUDFLARE_TURN_KEY_ID',
  'CLOUDFLARE_TURN_KEY_API_TOKEN',
  'CLOUDFLARE_TURN_TTL',
  'ICE_SERVERS',
  'TURN_URL',
  'TURN_USERNAME',
  'TURN_CREDENTIAL',
  'PUBLIC_URL',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'APPLE_CLIENT_ID',
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
  'APPLE_PRIVATE_KEY',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'UPLOADS_STORAGE',
  'UPLOAD_MAX_BYTES',
  'UPLOADS_QUOTA_MB',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_REGION',
  'CHAT_RETENTION_DAYS',
  'PAYSTACK_SECRET_KEY',
  'BILLING_INTERNAL_TOKEN',
  'BILLING_TEAM_SEAT_PRICE',
  'BILLING_SUPPORT_SEAT_PRICE',
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
/**
 * Desktop helpers (the current-app indicator) report here every 15 s. They must not start a stopped
 * container or keep an idle one running, so they only get through while people use Workchop.
 */
const HELPER_PATH = '/api/me/app-presence';
/** Reports are passed on only this soon after a visit (open tabs check in every 4 minutes). */
const HELPER_FORWARD_MS = 5 * 60 * 1000;
/** How long a helper is asked to wait when its report isn't passed on (seconds). */
const HELPER_RETRY_S = 60;
/**
 * The same while the container is still running without visitors: longer than IDLE_MS, so that even
 * if reaching this object counted as activity, helpers couldn't keep the container running.
 */
const HELPER_RETRY_RUNNING_S = IDLE_MS / 1000 + 60;
/** The header with BILLING_INTERNAL_TOKEN on the cron's tick; never passed on from a visitor. */
const INTERNAL_HEADER = 'x-workchop-internal';
/** How long the tick may take (renewals are charged one after another). */
const TICK_MS = 5 * 60 * 1000;

/** Paths only this Worker may call on the server (billing's tick): 404 to the public (the server's routes ignore case). */
const isInternal = (pathname: string) => /^\/(api\/)?internal\//i.test(pathname);

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
  /** When the last request other than a helper report came in. */
  private lastVisit = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A deploy restarts this object, but not necessarily the container, and the restarted
    // object starts without an inactivity timeout: set it again.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(IDLE_MS).catch(() => {}));
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return unavailable('No container is configured for Homeoffice.');
    if (!this.env.DATABASE_URL && this.env.EPHEMERAL_STORAGE !== 'true') {
      return unavailable('Homeoffice needs a database on Cloudflare: set the DATABASE_URL secret (see the README).');
    }
    const url = new URL(request.url);
    if (url.pathname !== HELPER_PATH) this.lastVisit = Date.now();
    else if (!container.running || Date.now() - this.lastVisit > HELPER_FORWARD_MS) {
      const wait = container.running ? HELPER_RETRY_RUNNING_S : HELPER_RETRY_S;
      return new Response(null, { status: 204, headers: { 'retry-after': String(wait) } });
    }
    try {
      await this.started();
    } catch (err) {
      console.error('[workchop] the server did not start:', err);
      return unavailable('Homeoffice is starting up. Please try again in a moment.');
    }

    const forwarded = new Request(new URL(url.pathname + url.search, `http://container:${PORT}`), request);
    forwarded.headers.delete('host');
    forwarded.headers.delete(INTERNAL_HEADER);
    try {
      // Returned as is, so WebSocket upgrades pass straight through to the server.
      return await container.getTcpPort(PORT).fetch(forwarded);
    } catch (err) {
      this.ready = null;
      console.error('[workchop] request to the server failed:', err);
      return unavailable('Homeoffice is restarting. Please try again in a moment.');
    }
  }

  /** Starts the container when it isn't running (it stops when idle, or when Cloudflare moves it). */
  private started(): Promise<void> {
    if (!this.ctx.container!.running) this.ready = null;
    this.ready ??= this.start().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /**
   * Billing's daily run (renewals, retries, locks, reminders), from the cron: starts the server if
   * it's asleep and calls its internal tick directly, never through the public path. The container
   * then stops by itself once idle.
   */
  async billingTick(): Promise<void> {
    const container = this.ctx.container;
    const token = this.env.BILLING_INTERNAL_TOKEN;
    if (!container || !token || (!this.env.DATABASE_URL && this.env.EPHEMERAL_STORAGE !== 'true')) return;
    await this.started();
    const res = await container.getTcpPort(PORT).fetch('http://container/api/internal/billing/tick', {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: token },
      signal: AbortSignal.timeout(TICK_MS),
    });
    const summary = await res.text();
    if (!res.ok) throw new Error(`the billing tick answered ${res.status}`);
    console.log(`[workchop] billing tick: ${summary}`);
  }

  private async start(): Promise<void> {
    const container = this.ctx.container!;
    // Every request arrives through Cloudflare, which sets CF-Connecting-IP to the visitor's address,
    // and through this Worker, which sets the x-workchop-geo-* headers (withGeo).
    const env: Record<string, string> = { CLIENT_IP_HEADER: 'cf-connecting-ip', GEO_HEADERS: 'workchop' };
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

    // Settles when the server exits; used to report why if it stops while starting.
    const exited = container.monitor().then(
      () => 'it exited normally',
      (err: unknown) => {
        const code = (err as { exitCode?: number })?.exitCode;
        return code !== undefined ? `it exited with code ${code} (see the container's logs for the server's error)` : String(err);
      },
    );
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
      if (!container.running) throw new Error(`the container stopped while starting: ${await exited}`, { cause: lastError });
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

// Workchop keeps live rooms in memory, so everyone must reach the same server.
function server(env: Env) {
  const hint = env.LOCATION_HINT?.trim() as DurableObjectLocationHint | undefined;
  return env.WORKCHOP.getByName('workchop', hint ? { locationHint: hint } : undefined);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // Another of its addresses: to PUBLIC_URL, the same path (308 keeps an API call's method and body).
    const elsewhere = canonicalRedirect(url, env.PUBLIC_URL);
    if (elsewhere) return Response.redirect(elsewhere, request.method === 'GET' || request.method === 'HEAD' ? 301 : 308);
    if (isInternal(url.pathname)) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return server(env).fetch(withGeo(request, request.cf));
    return env.ASSETS.fetch(request);
  },
  // Daily (wrangler.jsonc's triggers.crons), only with billing on.
  async scheduled(_controller, env, ctx) {
    if (env.PAYSTACK_SECRET_KEY && env.BILLING_INTERNAL_TOKEN) ctx.waitUntil(server(env).billingTick());
  },
} satisfies ExportedHandler<Env>;
