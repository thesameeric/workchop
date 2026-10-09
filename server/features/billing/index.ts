import { formatMoney, type BillingStatusAnswer } from '../../../shared/billing';
import type { Feature } from '../../features';
import { billingConfig } from './config';
import { migrations } from './migrations';
import { createPaystack } from './paystack';
import { billingRoutes } from './routes';
import { Billing } from './service';
import { HOUR } from './state';

// Paid plans, collected with Paystack (docs/specs/README.md, "Billing" in the README). Off, and every
// workspace free and unlimited as before, without PAYSTACK_SECRET_KEY: then only its status route
// answers, and no policy is set.

export interface BillingOptions {
  /** Default: PAYSTACK_SECRET_KEY; without one, billing is off. */
  secretKey?: string | null;
  /** Default: PAYSTACK_API_BASE, or https://api.paystack.co (a stand-in for tests: tests/helpers/paystack.ts). */
  apiBase?: string | null;
  fetch?: typeof fetch;
  /** Billing's clock (tests move it). */
  now?: () => number;
  /** Runs `run` regularly; returns a stop function. Default: a minute after starting, then hourly. */
  schedule?: (run: () => void, everyMs: number) => () => void;
  /** Kobo per seat: Team a month (default BILLING_TEAM_SEAT_PRICE), Support a year (BILLING_SUPPORT_SEAT_PRICE). */
  teamPrice?: string | number;
  supportPrice?: string | number;
  /** The tick route's secret (default BILLING_INTERNAL_TOKEN); without one, the route answers 404. */
  internalToken?: string | null;
}

const defaultSchedule = (run: () => void, everyMs: number) => {
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, everyMs);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
};

/** The billing feature; options default to the PAYSTACK_* and BILLING_* variables, read when it registers. */
export function billingFeature(options: BillingOptions = {}): Feature {
  return {
    name: 'billing',
    migrations,
    async register(ctx) {
      const env = process.env;
      const setting = (option: string | null | undefined, name: string) => (option !== undefined ? option : env[name])?.trim() || null;
      const secretKey = setting(options.secretKey, 'PAYSTACK_SECRET_KEY');
      const off = () => {
        ctx.app.get('/billing/status', (_req, res) => {
          res.set('Cache-Control', 'no-store');
          res.json({ available: false } satisfies BillingStatusAnswer);
        });
      };
      if (!secretKey) {
        off();
        return;
      }
      if (!ctx.publicOrigin) {
        console.warn('[billing] billing needs PUBLIC_URL (Paystack sends people back there); it is off');
        off();
        return;
      }
      // A wrong price stops the server: better than charging the wrong amount.
      const config = billingConfig({
        teamPrice: options.teamPrice ?? env.BILLING_TEAM_SEAT_PRICE,
        supportPrice: options.supportPrice ?? env.BILLING_SUPPORT_SEAT_PRICE,
        internalToken: setting(options.internalToken, 'BILLING_INTERNAL_TOKEN'),
      });
      const now = options.now ?? Date.now;
      const paystack = createPaystack({ secretKey, apiBase: setting(options.apiBase, 'PAYSTACK_API_BASE') ?? 'https://api.paystack.co', fetch: options.fetch });
      const billing = new Billing({
        db: ctx.db,
        offices: ctx.store,
        realtime: ctx.realtime,
        io: ctx.io,
        mailer: ctx.mailer,
        publicOrigin: ctx.publicOrigin,
        config,
        paystack,
        now,
      });
      await billing.start();
      ctx.workspaces.setPolicy(billing.policy);
      billingRoutes(ctx, billing, config, secretKey, now);
      // runDue() keeps track of its own run (failures are logged, and closing waits for it).
      const stop = (options.schedule ?? defaultSchedule)(() => void billing.runDue(), HOUR);
      ctx.onClose(async () => {
        stop();
        billing.close();
        await billing.idle();
      });
      if (!ctx.quiet) {
        console.log(
          `[billing] on (${secretKey.startsWith('sk_live_') ? 'live' : 'test'} key): Team ${formatMoney(config.prices.team)} per seat a month, Support ${formatMoney(config.prices.support)} per seat a year`,
        );
      }
    },
  };
}

export const feature = billingFeature();
