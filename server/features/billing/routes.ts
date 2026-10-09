import type express from 'express';
import type { AccountUser } from '../../../shared/account';
import { FREE_SEATS, GUEST_CAPS, type BillingStatusAnswer, type VerifyAnswer } from '../../../shared/billing';
import { may, type MemberRole } from '../../../shared/workspace';
import { sameSecret } from '../../auth/sessions';
import type { ServerContext } from '../../features';
import { windowLimiter } from '../../limits';
import type { BillingConfig } from './config';
import { HOUR } from './state';
import { BillingError, type Billing } from './service';
import { webhook } from './webhook';

// Billing's routes under /api: the status every page asks for, an office's billing for its owner and
// admins, the owner's changes, the return from Paystack's checkout, Paystack's webhook, and the
// scheduler's tick.

const MINUTE = 60_000;
const DAY = 24 * HOUR;
/** Paystack's references: letters, digits, '-', '.' and '='. */
const REFERENCE = /^[A-Za-z0-9.=-]{1,100}$/;

const bodyOf = (req: express.Request) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

const tooMany = (res: express.Response, ms: number) => {
  res.status(429).set('Retry-After', String(Math.ceil(ms / 1000))).json({ error: 'Too many tries. Try again later.' });
};

export function billingRoutes(ctx: ServerContext, billing: Billing, config: BillingConfig, secretKey: string, now: () => number): void {
  const { app, auth, db } = ctx;
  const checkoutsBy = windowLimiter(10, HOUR);
  const checkoutsFor = windowLimiter(20, DAY);
  const changesFor = windowLimiter(10, HOUR);
  const retriesFor = windowLimiter(3, HOUR);
  const verifiesBy = windowLimiter(30, 10 * MINUTE);

  app.get('/billing/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ available: true, currency: config.currency, prices: config.prices, freeSeats: FREE_SEATS, guestCaps: { ...GUEST_CAPS } } satisfies BillingStatusAnswer);
  });

  const roleIn = async (userId: string, officeId: string) =>
    (await db.query<{ role: MemberRole }>('SELECT role FROM memberships WHERE user_id = $1 AND office_id = $2', [userId, officeId])).rows[0]?.role ?? null;

  /** The office and the person's role, if they may see its billing; null after answering otherwise. */
  const seeing = async (req: express.Request, res: express.Response) => {
    const id = String(req.params.id);
    const stored = await ctx.store.get(id);
    if (!stored) {
      res.status(404).json({ error: 'Office not found' });
      return null;
    }
    const user = res.locals.user as AccountUser;
    const role = await roleIn(user.id, id);
    if (!may(role, 'see-billing')) {
      res.status(403).json({ error: 'Only the owner and admins can see billing.' });
      return null;
    }
    return { id, user, role: role! };
  };

  /** The office, if the person is its owner (with a verified address, when `verified`); null after answering otherwise. */
  const owning = async (req: express.Request, res: express.Response, verified: boolean) => {
    const m = await seeing(req, res);
    if (!m) return null;
    if (!may(m.role, 'billing')) {
      res.status(403).json({ error: 'Only the owner can change billing.' });
      return null;
    }
    // Paystack sends receipts there, and only that address can be charged again.
    if (verified && (!m.user.emailVerified || !m.user.email)) {
      res.status(403).json({ error: 'Confirm your email address first.', code: 'unverified' });
      return null;
    }
    return m;
  };

  const answer = async (res: express.Response, officeId: string, owner: boolean) => {
    res.set('Cache-Control', 'no-store');
    res.json(await billing.view(officeId, owner));
  };

  /** Runs an owner's change, answering with the billing view, or the refusal. */
  const run = async (res: express.Response, officeId: string, change: () => Promise<unknown>) => {
    try {
      await change();
    } catch (err) {
      if (!(err instanceof BillingError)) throw err;
      res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.url ? { url: err.url } : {}) });
      return;
    }
    await answer(res, officeId, true);
  };

  app.get('/offices/:id/billing', auth.requireUser, async (req, res) => {
    const m = await seeing(req, res);
    if (!m) return;
    // Stores what the dates say first (free, past due, locked).
    await billing.advance(m.id, { charge: false });
    await answer(res, m.id, m.role === 'owner');
  });

  app.post('/offices/:id/billing/checkout', auth.requireUser, async (req, res) => {
    const m = await owning(req, res, true);
    if (!m) return;
    const wait = Math.max(checkoutsBy.wait(m.user.id), checkoutsFor.wait(m.id));
    if (wait) return tooMany(res, wait);
    checkoutsBy(m.user.id);
    checkoutsFor(m.id);
    try {
      res.json(await billing.checkout(m.id, m.user, bodyOf(req).seats));
    } catch (err) {
      if (!(err instanceof BillingError)) throw err;
      res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  });

  app.post('/offices/:id/billing/seats', auth.requireUser, async (req, res) => {
    const m = await owning(req, res, true);
    if (!m) return;
    const wait = changesFor.wait(m.id);
    if (wait) return tooMany(res, wait);
    changesFor(m.id);
    await run(res, m.id, () => billing.setSeats(m.id, m.user, bodyOf(req).seats));
  });

  app.post('/offices/:id/billing/cancel', auth.requireUser, async (req, res) => {
    const m = await owning(req, res, false);
    if (!m) return;
    const wait = changesFor.wait(m.id);
    if (wait) return tooMany(res, wait);
    changesFor(m.id);
    await run(res, m.id, () => billing.cancel(m.id, m.user));
  });

  app.post('/offices/:id/billing/resume', auth.requireUser, async (req, res) => {
    const m = await owning(req, res, false);
    if (!m) return;
    const wait = changesFor.wait(m.id);
    if (wait) return tooMany(res, wait);
    changesFor(m.id);
    await run(res, m.id, () => billing.resume(m.id, m.user));
  });

  app.post('/offices/:id/billing/retry', auth.requireUser, async (req, res) => {
    const m = await owning(req, res, false);
    if (!m) return;
    const wait = retriesFor.wait(m.id);
    if (wait) return tooMany(res, wait);
    retriesFor(m.id);
    await run(res, m.id, () => billing.retry(m.id));
  });

  // Paystack's checkout sends people back to /billing/return?reference=…, whose page asks here.
  app.post('/billing/verify', auth.requireUser, async (req, res) => {
    const user = res.locals.user as AccountUser;
    const reference = bodyOf(req).reference;
    if (typeof reference !== 'string' || !REFERENCE.test(reference)) {
      res.status(400).json({ error: 'That isn’t a payment reference.' });
      return;
    }
    const wait = verifiesBy.wait(user.id);
    if (wait) return tooMany(res, wait);
    verifiesBy(user.id);
    const charge = await billing.settle(reference);
    if (!charge) {
      res.status(404).json({ error: 'We don’t know that payment.' });
      return;
    }
    const s = charge.status;
    const status: VerifyAnswer['status'] =
      s === 'succeeded' || s === 'superseded' || s === 'refunded' ? 'succeeded' : s === 'pending' || s === 'action_needed' ? 'pending' : s === 'abandoned' ? 'abandoned' : 'failed';
    // Which workspace, only to its owner and admins or whoever paid.
    const told = charge.actorUserId === user.id || may(await roleIn(user.id, charge.officeId), 'see-billing');
    res.set('Cache-Control', 'no-store');
    res.json({ status, ...(told ? { officeId: charge.officeId, officeName: ctx.store.peek(charge.officeId)?.office.settings.name ?? charge.officeName } : {}) } satisfies VerifyAnswer);
  });

  ctx.keepRawBody('/billing/paystack/webhook');
  app.post('/billing/paystack/webhook', webhook(ctx, billing, secretKey, now));

  // The Worker's daily cron (through its Durable Object) or any scheduler with the secret; 404 to anyone else.
  app.post('/internal/billing/tick', async (req, res) => {
    if (!config.internalToken || !sameSecret(req.get('x-workchop-internal'), config.internalToken)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(await billing.runDue());
  });
}
