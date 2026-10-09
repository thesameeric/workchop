import crypto from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

// A stand-in for Paystack's API and its checkout page, for tests and for trying billing in a browser
// without Paystack keys:
//
//   npx tsx tests/helpers/paystack.ts        (PORT=3998 by default; it prints the settings to use)
//
// The checkout page has Pay and Decline buttons that send the browser back to callback_url, like
// Paystack's does. With WEBHOOK_URL set, paying also sends a signed charge.success there.

/**
 * What the next charge of a saved card does: 'failed' is a decline that may work later (insufficient
 * funds), 'expired' one that won't; 'hang' goes through, but the answer never arrives.
 */
export type ChargeOutcome = 'success' | 'failed' | 'expired' | 'paused' | 'hang' | 500;

export interface MockAuthorization {
  authorization_code: string;
  signature: string;
  reusable: boolean;
  channel: 'card';
  brand: string;
  card_type: string;
  last4: string;
  exp_month: string;
  exp_year: string;
  bank: string;
  bin: string;
  country_code: 'NG';
}

export interface MockTransaction {
  id: number;
  reference: string;
  amount: number;
  currency: string;
  email: string;
  metadata: unknown;
  callbackUrl: string | null;
  accessCode: string;
  /** Paystack's statuses: 'abandoned' until paid, 'ongoing' while the bank waits for the payer. */
  status: 'abandoned' | 'ongoing' | 'success' | 'failed';
  gatewayResponse: string;
  paidAt: string | null;
  authorization: MockAuthorization | null;
  /** A transaction made by charging a saved card. */
  recurring: boolean;
  /** Fields to answer differently (e.g. gateway_response_code). */
  extra?: Record<string, unknown>;
}

interface Card {
  email: string;
  usable: boolean;
  authorization: MockAuthorization;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const random = (prefix: string, bytes = 10) => `${prefix}${crypto.randomBytes(bytes).toString('hex')}`;
const REFERENCE = /^[A-Za-z0-9.=-]+$/;

export class MockPaystack {
  readonly secretKey = 'sk_test_mock';
  base = '';
  /** What PAYSTACK_API_BASE is set to. */
  apiBase = '';
  /** The time paid_at is taken from (tests give it billing's clock). */
  now: () => number = Date.now;
  /** Where to send a signed charge.success after paying on the checkout page (interactive use). */
  webhookUrl: string | null = null;
  /** Every API request: method, path, and the JSON body. */
  readonly requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  readonly transactions = new Map<string, MockTransaction>();
  readonly cards = new Map<string, Card>();
  /** Outcomes for the next charges of saved cards, in order (then 'success'); by payer email first. */
  readonly nextCharges: ChargeOutcome[] = [];
  readonly nextChargesFor = new Map<string, ChargeOutcome[]>();
  /** Fields to answer differently on the next charge of a payer's saved card (once). */
  readonly nextChargeExtraFor = new Map<string, Record<string, unknown>>();
  /** References refunds were asked for. */
  readonly refunds: string[] = [];
  /** Answers to the next refund requests, in order (then a refund): 503, Paystack down; 400, refused. */
  readonly refundAnswers: (503 | 400)[] = [];
  /** Authorization codes removed. */
  readonly deactivated: string[] = [];
  private nextId = 4_099_260_516;
  private server = createServer((req, res) => {
    this.handle(req, res).catch((err) => {
      console.error('[mock paystack]', err);
      if (!res.headersSent) json(res, 500, { status: false, message: 'Mock failure' });
    });
  });

  async start(port = 0, host = '127.0.0.1'): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(port, host, resolve));
    const { port: actual } = this.server.address() as AddressInfo;
    this.base = `http://${host === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:${actual}`;
    this.apiBase = this.base;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The requests to a path (e.g. '/transaction/initialize'). */
  calls(path: string) {
    return this.requests.filter((r) => r.path === path || r.path.startsWith(`${path}/`));
  }

  /** A card as Paystack saves it after a payment (4084 0840 8408 4081 by default). */
  private newCard(email: string, reusable: boolean, last4 = '4081'): MockAuthorization {
    const authorization: MockAuthorization = {
      authorization_code: random('AUTH_'),
      signature: `SIG_${last4}${email.length}`,
      reusable,
      channel: 'card',
      brand: 'visa',
      card_type: 'visa ',
      last4,
      exp_month: '12',
      exp_year: '2030',
      bank: 'TEST BANK',
      bin: '408408',
      country_code: 'NG',
    };
    this.cards.set(authorization.authorization_code, { email, usable: true, authorization });
    return authorization;
  }

  /** Pays a checkout (or confirms a paused charge), as the payer would on the checkout page. */
  pay(reference: string, opts: { reusable?: boolean; email?: string; amount?: number; currency?: string; last4?: string } = {}): MockTransaction {
    const tx = this.transactions.get(reference);
    if (!tx) throw new Error(`no transaction ${reference}`);
    if (opts.email) tx.email = opts.email;
    if (opts.amount !== undefined) tx.amount = opts.amount;
    if (opts.currency) tx.currency = opts.currency;
    tx.status = 'success';
    tx.gatewayResponse = 'Successful';
    tx.paidAt = new Date(this.now()).toISOString();
    tx.authorization ??= this.newCard(tx.email, opts.reusable ?? true, opts.last4);
    return tx;
  }

  /** The payer's card is declined on the checkout page. */
  decline(reference: string): MockTransaction {
    const tx = this.transactions.get(reference);
    if (!tx) throw new Error(`no transaction ${reference}`);
    tx.status = 'failed';
    tx.gatewayResponse = 'Declined';
    return tx;
  }

  /** A transaction as verify, charges and webhooks give it. */
  data(tx: MockTransaction) {
    return {
      id: tx.id,
      domain: 'test',
      status: tx.status,
      reference: tx.reference,
      amount: tx.amount,
      requested_amount: tx.amount,
      currency: tx.currency,
      gateway_response: tx.gatewayResponse,
      // Like Paystack: checkout payments say 'approved'; charges of a saved card have no code (null).
      ...(tx.status === 'success' ? { gateway_response_code: tx.recurring ? null : 'approved' } : {}),
      paid_at: tx.paidAt,
      channel: 'card',
      metadata: tx.metadata,
      fees: Math.min(200_000, Math.round(tx.amount * 0.015) + (tx.amount >= 250_000 ? 10_000 : 0)),
      authorization: tx.authorization,
      customer: { id: 181_873_746, email: tx.email, customer_code: `CUS_${crypto.createHash('sha256').update(tx.email).digest('hex').slice(0, 15)}` },
      plan: null,
      ...tx.extra,
    };
  }

  /** A webhook as Paystack sends it: the body and its x-paystack-signature (HMAC-SHA512 with `key`). */
  signedWebhook(event: string, data: unknown, key: string = this.secretKey): { body: string; signature: string } {
    const body = JSON.stringify({ event, data });
    return { body, signature: crypto.createHmac('sha512', key).update(body).digest('hex') };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.base);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();

    // The checkout page (a browser, not the API).
    const page = /^\/checkout\/([a-z0-9]+)(?:\/(pay|decline|cancel))?$/.exec(url.pathname);
    if (page) return this.checkout(req, res, page[1], page[2]);

    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { status: false, message: 'Invalid JSON' });
      }
    }
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, body });
    if (req.headers.authorization !== `Bearer ${this.secretKey}`) return json(res, 401, { status: false, message: 'Invalid key' });

    if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
      const reference = String(body.reference ?? '');
      if (!REFERENCE.test(reference)) return json(res, 400, { status: false, message: 'Invalid transaction reference', type: 'validation_error' });
      if (this.transactions.has(reference)) return this.duplicate(res);
      const tx = this.record(reference, body, false);
      return json(res, 200, { status: true, message: 'Authorization URL created', data: { authorization_url: `${this.base}/checkout/${tx.accessCode}`, access_code: tx.accessCode, reference } });
    }

    const verify = /^\/transaction\/verify\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && verify) {
      const tx = this.transactions.get(decodeURIComponent(verify[1]));
      if (!tx) return json(res, 400, { status: false, message: 'Transaction reference not found', code: 'transaction_not_found' });
      return json(res, 200, { status: true, message: 'Verification successful', data: this.data(tx) });
    }

    if (req.method === 'POST' && url.pathname === '/transaction/charge_authorization') {
      const reference = String(body.reference ?? '');
      if (this.transactions.has(reference)) return this.duplicate(res);
      const card = this.cards.get(String(body.authorization_code));
      if (!card || !card.usable || card.email !== String(body.email).toLowerCase()) return json(res, 400, { status: false, message: 'Invalid authorization code' });
      const outcome = this.nextChargesFor.get(card.email)?.shift() ?? this.nextCharges.shift() ?? 'success';
      if (outcome === 500) return json(res, 500, { status: false, message: 'Mock failure' });
      const tx = this.record(reference, body, true);
      tx.authorization = card.authorization;
      tx.extra = this.nextChargeExtraFor.get(card.email);
      this.nextChargeExtraFor.delete(card.email);
      if (outcome === 'paused') {
        tx.status = 'ongoing';
        tx.gatewayResponse = 'Pending bank confirmation';
        return json(res, 200, {
          status: true,
          message: 'Please, redirect your customer to the authorization url provided',
          data: { authorization_url: `${this.base}/checkout/${tx.accessCode}`, reference, access_code: tx.accessCode, paused: true },
        });
      }
      if (outcome === 'failed' || outcome === 'expired') {
        tx.status = 'failed';
        tx.gatewayResponse = outcome === 'failed' ? 'Insufficient Funds' : 'Expired Card';
      } else {
        tx.status = 'success';
        tx.gatewayResponse = 'Approved';
        tx.paidAt = new Date(this.now()).toISOString();
      }
      // The charge happened, but the answer is lost on the way.
      if (outcome === 'hang') {
        req.socket.destroy();
        return;
      }
      return json(res, 200, { status: true, message: 'Charge attempted', data: this.data(tx) });
    }

    if (req.method === 'POST' && url.pathname === '/customer/authorization/deactivate') {
      const card = this.cards.get(String(body.authorization_code));
      if (!card) return json(res, 400, { status: false, message: 'Authorization code not found' });
      card.usable = false;
      this.deactivated.push(card.authorization.authorization_code);
      return json(res, 200, { status: true, message: 'Authorization has been deactivated' });
    }

    if (req.method === 'POST' && url.pathname === '/refund') {
      const answer = this.refundAnswers.shift();
      if (answer === 503) return json(res, 503, { status: false, message: 'Service unavailable' });
      if (answer === 400) return json(res, 400, { status: false, message: 'Transaction has been fully reversed' });
      const tx = this.transactions.get(String(body.transaction));
      if (!tx || tx.status !== 'success') return json(res, 400, { status: false, message: 'Transaction not found' });
      this.refunds.push(tx.reference);
      return json(res, 200, { status: true, message: 'Refund has been queued for processing', data: { transaction: { reference: tx.reference }, status: 'pending' } });
    }

    json(res, 404, { status: false, message: 'Not found' });
  }

  private duplicate(res: ServerResponse) {
    json(res, 400, {
      status: false,
      message: 'Duplicate Transaction Reference',
      meta: { nextStep: 'Try and create the Transaction or Charge with a new reference' },
      type: 'validation_error',
      code: 'duplicate_reference',
    });
  }

  private record(reference: string, body: Record<string, unknown>, recurring: boolean): MockTransaction {
    const tx: MockTransaction = {
      id: this.nextId++,
      reference,
      amount: Number(body.amount),
      currency: String(body.currency ?? 'NGN'),
      email: String(body.email).toLowerCase(),
      metadata: body.metadata ?? '',
      callbackUrl: typeof body.callback_url === 'string' ? body.callback_url : null,
      accessCode: random('', 8),
      status: 'abandoned',
      gatewayResponse: 'The transaction was not completed',
      paidAt: null,
      authorization: null,
      recurring,
    };
    this.transactions.set(reference, tx);
    return tx;
  }

  /** Paystack's checkout page, with Pay, Decline and Cancel. */
  private async checkout(req: IncomingMessage, res: ServerResponse, code: string, action: string | undefined) {
    const tx = [...this.transactions.values()].find((t) => t.accessCode === code);
    if (!tx) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No such checkout');
      return;
    }
    if (req.method === 'POST' && action) {
      let to = tx.callbackUrl ? `${tx.callbackUrl}${tx.callbackUrl.includes('?') ? '&' : '?'}trxref=${tx.reference}&reference=${tx.reference}` : '/';
      if (action === 'pay') {
        this.pay(tx.reference);
        if (this.webhookUrl) {
          const { body, signature } = this.signedWebhook('charge.success', this.data(tx));
          await fetch(this.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature }, body }).catch(() => {});
        }
      } else if (action === 'decline') this.decline(tx.reference);
      else {
        const cancel = tx.metadata && typeof tx.metadata === 'object' ? (tx.metadata as { cancel_action?: unknown }).cancel_action : null;
        to = typeof cancel === 'string' ? cancel : to;
      }
      res.writeHead(303, { Location: to });
      res.end();
      return;
    }
    const naira = (tx.amount / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock Paystack</title>
<body style="font:16px system-ui;margin:2rem auto;max-width:24rem;padding:0 16px">
<h1 style="font-size:20px">Mock Paystack</h1>
<p>${esc(tx.email)} pays <strong>${esc(tx.currency)} ${esc(naira)}</strong>${tx.recurring ? ' (confirming with the bank)' : ''}.</p>
<p style="color:#666">Card 4084 0840 8408 4081 (test)</p>
<form method="post" action="/checkout/${code}/pay"><button style="font:inherit;padding:10px 18px">Pay</button></form><br>
<form method="post" action="/checkout/${code}/decline"><button style="font:inherit;padding:10px 18px">Decline</button></form><br>
<form method="post" action="/checkout/${code}/cancel"><button style="font:inherit;padding:10px 18px">Cancel</button></form>`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mock = new MockPaystack();
  mock.webhookUrl = process.env.WEBHOOK_URL || null;
  await mock.start(Number(process.env.PORT ?? 3998), 'localhost');
  console.log(`Mock Paystack at ${mock.base}. Start Workchop with:

  PAYSTACK_SECRET_KEY=${mock.secretKey} PAYSTACK_API_BASE=${mock.apiBase} BILLING_INTERNAL_TOKEN=${'x'.repeat(32)}

Optional: WEBHOOK_URL=http://localhost:3001/api/billing/paystack/webhook here sends a signed
charge.success after each payment on the checkout page. Press Ctrl+C to stop.`);
}
