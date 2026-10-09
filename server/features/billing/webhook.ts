import crypto from 'node:crypto';
import type express from 'express';
import { sameSecret } from '../../auth/sessions';
import type { ServerContext, WithRawBody } from '../../features';
import { addressKey, windowLimiter } from '../../limits';
import { metadataOf, type PaystackTx } from './paystack';
import type { Billing } from './service';

// Paystack's webhooks (POST /api/billing/paystack/webhook): signed with the secret key over the exact
// bytes sent (HMAC-SHA512, hex). Each is stored once and answered at once, then handled: a payment is
// settled by asking Paystack (never from the webhook's word), refunds and disputes are noted. Events
// that aren't about Workchop's own charges (the Paystack account may serve other apps) are ignored.

/** The charge an event is about, if it's one billing handles. */
function referenceOf(event: string, data: Record<string, unknown>): string | null {
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  if (event === 'charge.success') return metadataOf(data as PaystackTx).app === 'workchop' ? text(data.reference) : null;
  if (event.startsWith('refund.')) return text(data.transaction_reference);
  if (event.startsWith('charge.dispute.')) {
    const tx = data.transaction;
    return tx && typeof tx === 'object' ? text((tx as Record<string, unknown>).reference) : null;
  }
  return null;
}

/** The payload as stored: without the card's authorization code. */
function withoutCard(body: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(body)) as { data?: { authorization?: { authorization_code?: unknown } } };
  if (copy.data?.authorization) delete copy.data.authorization.authorization_code;
  return copy;
}

export function webhook(ctx: ServerContext, billing: Billing, secretKey: string, now: () => number): express.RequestHandler {
  const fromAddress = windowLimiter(600, 10 * 60_000);
  return async (req, res) => {
    if (!fromAddress(addressKey(ctx.clientIp(req)))) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    const raw = (req as WithRawBody).rawBody;
    if (!raw) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const expected = crypto.createHmac('sha512', secretKey).update(raw).digest('hex');
    if (!sameSecret(req.get('x-paystack-signature'), expected)) {
      res.status(401).json({ error: 'Bad signature' });
      return;
    }
    const body = req.body as { event?: unknown; data?: unknown };
    const event = typeof body.event === 'string' ? body.event : '';
    const data = body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : null;
    if (!event || !data) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const reference = referenceOf(event, data);
    const charge = reference ? await billing.store.charge(ctx.db, reference) : null;
    if (!reference || !charge) {
      res.json({ ok: true });
      return;
    }
    const id = await billing.store.event(event, String(data.id ?? reference), reference, withoutCard(body), now());
    res.json({ ok: true });
    // Seen before: Paystack sends again until it gets an answer, and may resend on request.
    if (id === null) return;
    billing.track(
      (async () => {
        if (event === 'charge.success') await billing.settle(reference);
        else if (event.startsWith('refund.')) {
          if (event === 'refund.processed' || data.status === 'processed') await billing.store.markCharge(ctx.db, reference, 'refunded', ['succeeded', 'superseded']);
        } else if (event === 'charge.dispute.create') await billing.disputed(reference);
        await billing.store.handled(id, now());
      })(),
    );
  };
}
