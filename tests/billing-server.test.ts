import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Space } from '../shared/account';
import { DEFAULT_AVATAR } from '../shared/avatar';
import { GRACE_DAYS, LAUNCH_DAYS, MIN_CHARGE, type BillingStatusAnswer, type BillingView, type VerifyAnswer } from '../shared/billing';
import type { JoinResponse } from '../shared/types';
import type { MembersAnswer, RemovedReason } from '../shared/workspace';
import { Accounts } from '../server/accounts';
import { Sessions } from '../server/auth/sessions';
import type { Db } from '../server/db';
import { openPGlite } from '../server/db/pglite';
import { billingFeature, type BillingOptions } from '../server/features/billing';
import { formatDate } from '../server/features/billing/mail';
import { addInterval, DAY, HOUR, nextPeriodEnd, prorate } from '../server/features/billing/state';
import { chatFeature } from '../server/features/chat';
import { supportFeature } from '../server/features/support';
import { feature as world } from '../server/features/world';
import { startServer } from '../server/index';
import type { Mailer, MailMessage } from '../server/mail';
import { createTestDb, freshDb } from './helpers/db';
import { Jar, json, until, type Client } from './helpers/http';
import { MockPaystack } from './helpers/paystack';

// Billing against a stand-in for Paystack, with billing's clock moved by hand. Each test makes its
// own workspaces; the clock only moves forward, so a test's periods start wherever it finds it.

type Server = Awaited<ReturnType<typeof startServer>>;
interface Running {
  server: Server;
  base: string;
  db: Db;
  accounts: Accounts;
  sessions: Sessions;
}

const ORIGIN = 'http://localhost:5173';
const TOKEN = 'tick-'.repeat(8);
const MINUTE = 60_000;
const TEAM = 750_000;
const SUPPORT = 18_000_000;
/** Every email sent. */
const sent: MailMessage[] = [];
const recorder: Mailer = { kind: 'outbox', send: (message) => void sent.push(message), close: async () => {} };

let mock: MockPaystack;
let dataDir: string;
/** Billing's clock (and the stand-in's paid_at). It starts an hour back, so every office made here is newer than the launch. */
let clock = Date.now() - HOUR;
let main: Running;
const running = new Set<Server>();
const sockets: Client[] = [];

async function start(db: Db, billing: BillingOptions = {}, features?: 'default'): Promise<Running> {
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    db,
    dataDir,
    quiet: true,
    iceServers: [],
    publicUrl: ORIGIN,
    auth: { google: null, apple: null, devLogin: true },
    mailer: recorder,
    clientIpHeader: 'x-test-ip',
    features:
      features === 'default'
        ? undefined
        : [
            chatFeature({ retentionDays: null }),
            world,
            supportFeature(),
            billingFeature({ secretKey: mock.secretKey, apiBase: mock.apiBase, now: () => clock, schedule: () => () => {}, internalToken: TOKEN, ...billing }),
          ],
  });
  running.add(server);
  return { server, base: `http://127.0.0.1:${server.port}`, db, accounts: new Accounts(db), sessions: new Sessions(db) };
}

async function stop(run: Running) {
  running.delete(run.server);
  await run.server.close();
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-billing-'));
  mock = await new MockPaystack().start();
  mock.now = () => clock;
  main = await start(await createTestDb());
}, 60_000);

afterAll(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const server of running) await server.close();
  await mock?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

let people = 0;

/** Someone signed in, with a verified address unless `verified` is false. */
async function person(run: Running, name: string, verified = true) {
  const email = `${name.toLowerCase()}.${++people}@example.com`;
  const user = await run.accounts.signIn({ provider: 'google', subject: `google-${email}`, email, emailVerified: verified, isPrivateEmail: false, name, avatarUrl: null, label: null });
  const jar = new Jar();
  jar.cookies.set('wc_session', await run.sessions.create(user.id, 'test'));
  // Each their own visitor (workspaces made per visitor are limited).
  return { jar, user, email, ip: `10.30.${(people >> 8) & 255}.${people & 255}` };
}
type Person = Awaited<ReturnType<typeof person>>;

const api = (run: Running, who: Person | Jar | null, path: string, body?: unknown) => {
  const init = body === undefined ? {} : json(body);
  if (!who || who instanceof Jar) return (who ?? new Jar()).fetch(`${run.base}/api${path}`, init);
  return who.jar.fetch(`${run.base}/api${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), 'x-test-ip': who.ip } });
};
const read = async <T,>(res: Response | Promise<Response>) => (await (await res).json()) as T;

async function team(run: Running, owner: Person): Promise<string> {
  const res = await api(run, owner, '/offices', { name: `Team ${people}`, template: 'blank' });
  expect(res.status).toBe(201);
  return (await read<{ id: string }>(res)).id;
}

/** A support workspace and its customer link's token. */
async function support(run: Running, owner: Person): Promise<{ id: string; guest: string }> {
  const res = await api(run, owner, '/offices', { name: `Desk ${people}`, kind: 'support', template: 'support' });
  expect(res.status).toBe(201);
  const { id } = await read<{ id: string }>(res);
  const { access } = await read<MembersAnswer>(api(run, owner, `/offices/${id}/members`));
  return { id, guest: access!.link!.slice(access!.link!.indexOf('#guest=') + 7) };
}

const addPerson = (run: Running, by: Person, officeId: string, email: string, role: 'admin' | 'member' = 'member') => api(run, by, `/offices/${officeId}/members`, { email, role });

/** New people, members (or admins) of the office straight away. */
async function staff(run: Running, owner: Person, officeId: string, n: number, role: 'admin' | 'member' = 'member'): Promise<Person[]> {
  const out: Person[] = [];
  for (let i = 0; i < n; i++) {
    const p = await person(run, role === 'admin' ? 'Ada' : 'Mo');
    expect((await addPerson(run, owner, officeId, p.email, role)).status).toBe(201);
    out.push(p);
  }
  return out;
}

const lastReference = () => String(mock.calls('/transaction/initialize').at(-1)!.body.reference);

async function checkout(run: Running, owner: Person, officeId: string, seats?: number): Promise<string> {
  const res = await api(run, owner, `/offices/${officeId}/billing/checkout`, seats === undefined ? {} : { seats });
  expect(res.status, await res.clone().text()).toBe(200);
  expect((await read<{ url: string }>(res)).url).toMatch(new RegExp(`^${mock.base}/checkout/`));
  return lastReference();
}

const verify = (run: Running, who: Person, reference: string) => read<VerifyAnswer>(api(run, who, '/billing/verify', { reference }));

/** Pays for a plan with the checkout, as the owner would. */
async function subscribe(run: Running, owner: Person, officeId: string, seats?: number): Promise<string> {
  const reference = await checkout(run, owner, officeId, seats);
  mock.pay(reference);
  expect((await verify(run, owner, reference)).status).toBe('succeeded');
  return reference;
}

const view = (run: Running, who: Person, officeId: string) => read<BillingView>(api(run, who, `/offices/${officeId}/billing`));
const tick = (run: Running, token: string | null = TOKEN) =>
  fetch(`${run.base}/api/internal/billing/tick`, { method: 'POST', headers: token === null ? {} : { 'x-workchop-internal': token } });

async function account(run: Running, officeId: string) {
  const res = await run.db.query<{ status: string; seats: number; seats_next: number | null; period_start: Date; period_end: Date; carry_amount: string; grace_reason: string | null; grace_ends_at: Date | null; retry_count: number; next_retry_at: Date | null; auto_renew: boolean; cancel_at_period_end: boolean; authorization_code: string | null; payer_user_id: string | null }>(
    'SELECT * FROM billing_accounts WHERE office_id = $1',
    [officeId],
  );
  return res.rows[0];
}
const ms = (d: Date | null) => (d === null ? null : new Date(d).getTime());
const chargesOf = async (run: Running, officeId: string) =>
  (await run.db.query<{ reference: string; purpose: string; status: string; amount: string; seats: number; refund: string | null; gateway_response: string | null }>('SELECT * FROM billing_charges WHERE office_id = $1 ORDER BY id', [officeId])).rows;

/** Comes into the office (or is refused), like the client's join. */
async function enter(run: Running, officeId: string, opts: { who?: Person; guest?: string; ip?: string } = {}) {
  const cookie = opts.who?.jar.header();
  const socket: Client = connect(run.base, {
    transports: ['websocket'],
    forceNew: true,
    extraHeaders: { 'x-test-ip': opts.ip ?? `10.9.${people % 250}.${sockets.length % 250}`, ...(cookie ? { cookie } : {}) },
  });
  sockets.push(socket);
  const removed: RemovedReason[] = [];
  socket.on('office:removed', (reason) => void removed.push(reason));
  const res = await new Promise<JoinResponse>((resolve, reject) => {
    socket.on('connect_error', reject);
    socket.on('connect', () => socket.emit('join', { officeId, name: 'Someone', avatar: DEFAULT_AVATAR, guest: opts.guest ?? '' }, resolve));
  });
  return { socket, res, removed };
}

let ips = 0;
const nextIp = () => `10.20.${(++ips >> 8) & 255}.${ips & 255}`;

describe('billing off', () => {
  it('is the default: everything stays free and unlimited, and the tick isn’t there', async () => {
    const off = await start(await freshDb(), {}, 'default');
    try {
      expect(await read<BillingStatusAnswer>(fetch(`${off.base}/api/billing/status`))).toEqual({ available: false });
      const owner = await person(off, 'Owen');
      const id = await team(off, owner);
      await staff(off, owner, id, 4);
      expect((await addPerson(off, owner, id, 'someone.new@example.com')).status).toBe(202);
      // An invitation that expired can still be sent again.
      await off.db.query("UPDATE office_invites SET expires_at = now() - interval '1 hour' WHERE office_id = $1", [id]);
      const invite = await off.db.query<{ id: string }>('SELECT id FROM office_invites WHERE office_id = $1', [id]);
      expect((await api(off, owner, `/offices/${id}/invites/${invite.rows[0].id}/resend`, {})).status).toBe(202);
      expect((await tick(off)).status).toBe(404);
      expect((await api(off, owner, `/offices/${id}/billing`)).status).toBe(404);
      expect((await read<Space[]>(api(off, owner, '/me/spaces')))[0]).not.toHaveProperty('billing');
    } finally {
      await stop(off);
    }
  }, 60_000);
});

describe('status', () => {
  it('tells every page the prices', async () => {
    expect(await read<BillingStatusAnswer>(fetch(`${main.base}/api/billing/status`))).toEqual({
      available: true,
      currency: 'NGN',
      prices: { team: TEAM, support: SUPPORT },
      freeSeats: 3,
      guestCaps: { free: 3, team: 25 },
    });
  });
});

describe('the Free plan', () => {
  it('has 3 seats: members and open invitations', async () => {
    const owner = await person(main, 'Olu');
    const id = await team(main, owner);
    const [ada] = await staff(main, owner, id, 1, 'admin');
    // An invitation holds a seat.
    const later = await person(main, 'Late', false);
    expect((await addPerson(main, owner, id, later.email)).status).toBe(202);
    const full = await addPerson(main, owner, id, `fourth.${people}@example.com`);
    expect(full.status).toBe(402);
    expect(await full.json()).toEqual({ error: 'All your seats are taken. Add seats in Billing.', code: 'seats-full' });
    const byAdmin = await addPerson(main, ada, id, `fourth.${people}@example.com`);
    expect(byAdmin.status).toBe(402);
    expect(await byAdmin.json()).toEqual({ error: 'All seats are taken. Ask the owner to add seats.', code: 'seats-full' });
    expect(await view(main, ada, id)).toMatchObject({ plan: 'free', status: 'free', seatsUsed: 3, seats: 3 });
    // An invitation that becomes a membership takes no new seat, even when they're all taken.
    await main.db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [later.user.id]);
    expect((await addPerson(main, owner, id, later.email)).status).toBe(201);
    expect((await view(main, owner, id)).seatsUsed).toBe(3);
    // A seat freed is a seat to fill.
    expect((await owner.jar.fetch(`${main.base}/api/offices/${id}/members/${later.user.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await addPerson(main, ada, id, `fifth.${people}@example.com`)).status).toBe(202);
    // An invitation that expired holds no seat, so it isn't sent again: the address is added again.
    await main.db.query("UPDATE office_invites SET expires_at = now() - interval '1 hour' WHERE office_id = $1", [id]);
    const invite = await main.db.query<{ id: string }>('SELECT id FROM office_invites WHERE office_id = $1', [id]);
    expect((await api(main, owner, `/offices/${id}/invites/${invite.rows[0].id}/resend`, {})).status).toBe(404);
  });

  it('lets one of two admins adding at once take the last seat', async () => {
    const owner = await person(main, 'Ola');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    const [a, b] = await staff(main, owner, id, 2, 'admin');
    const results = await Promise.all([addPerson(main, a, id, `race.a.${people}@example.com`), addPerson(main, b, id, `race.b.${people}@example.com`)]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 402]);
    expect((await view(main, owner, id)).seatsUsed).toBe(4);
  });

  it('lets 3 guests in at once (support customers aren’t capped)', async () => {
    const owner = await person(main, 'Gus');
    const id = await team(main, owner);
    const { link } = await read<{ link: string }>(owner.jar.fetch(`${main.base}/api/offices/${id}/access`, json({ guests: 'link' }, 'PUT')));
    const guest = link.slice(link.indexOf('#guest=') + 7);
    for (let i = 0; i < 3; i++) expect((await enter(main, id, { guest, ip: nextIp() })).res.ok).toBe(true);
    expect(await enter(main, id, { guest, ip: nextIp() }).then((j) => j.res)).toMatchObject({ ok: false, error: 'This office is full.' });
    // Members still come in.
    expect((await enter(main, id, { who: owner })).res.ok).toBe(true);

    const desk = await support(main, owner);
    await subscribe(main, owner, desk.id, 1);
    for (let i = 0; i < 5; i++) expect((await enter(main, desk.id, { guest: desk.guest, ip: nextIp() })).res.ok).toBe(true);
  });
});

describe('checkout', () => {
  it('is for the owner, with a confirmed address, for at least the seats in use', async () => {
    const owner = await person(main, 'Chi');
    const id = await team(main, owner);
    const [ada] = await staff(main, owner, id, 1, 'admin');
    const [mo] = await staff(main, owner, id, 1);
    expect((await api(main, ada, `/offices/${id}/billing/checkout`, { seats: 4 })).status).toBe(403);
    expect((await api(main, mo, `/offices/${id}/billing/checkout`, { seats: 4 })).status).toBe(403);
    expect((await api(main, mo, `/offices/${id}/billing`)).status).toBe(403);
    await main.db.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [owner.user.id]);
    expect(await read(api(main, owner, `/offices/${id}/billing/checkout`, { seats: 4 }))).toMatchObject({ code: 'unverified' });
    await main.db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [owner.user.id]);
    for (const seats of [2, 0, 501, 3.5, '4']) {
      const res = await api(main, owner, `/offices/${id}/billing/checkout`, { seats });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'seats' });
    }

    const reference = await checkout(main, owner, id, 5);
    expect(reference).toMatch(new RegExp(`^wc-${id}-[A-Za-z0-9]+$`));
    const sentToPaystack = mock.calls('/transaction/initialize').at(-1)!.body;
    expect(sentToPaystack).toEqual({
      email: owner.email,
      amount: 5 * TEAM,
      currency: 'NGN',
      reference,
      callback_url: `${ORIGIN}/billing/return`,
      channels: ['card'],
      metadata: { app: 'workchop', office_id: id, purpose: 'subscribe', seats: 5, cancel_action: `${ORIGIN}/o/${id}?billing`, custom_filters: { recurring: true } },
    });
    // Nothing changes until it's paid.
    expect(await view(main, owner, id)).toMatchObject({ plan: 'free', status: 'free' });
  });

  it('is settled once, from the return page or the webhook, whichever comes first', async () => {
    const owner = await person(main, 'Pat');
    const stranger = await person(main, 'Stan');
    const id = await team(main, owner);
    const reference = await checkout(main, owner, id, 4);
    expect(await verify(main, owner, reference)).toEqual({ status: 'pending', officeId: id, officeName: expect.any(String) });
    mock.pay(reference);
    const paidAt = clock;
    expect(await verify(main, owner, reference)).toMatchObject({ status: 'succeeded', officeId: id });
    expect(await verify(main, owner, reference)).toMatchObject({ status: 'succeeded' });
    // Only the people concerned learn which workspace it was.
    expect(await verify(main, stranger, reference)).toEqual({ status: 'succeeded' });
    const { body, signature } = mock.signedWebhook('charge.success', mock.data(mock.transactions.get(reference)!));
    expect((await fetch(`${main.base}/api/billing/paystack/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature }, body })).status).toBe(200);
    await until(async () => (await main.db.query('SELECT 1 FROM billing_events WHERE reference = $1 AND handled_at IS NOT NULL', [reference])).rowCount > 0);
    expect((await chargesOf(main, id)).map((c) => c.status)).toEqual(['succeeded']);
    expect((await main.db.query("SELECT 1 FROM billing_log WHERE office_id = $1 AND action = 'paid:subscribe'", [id])).rowCount).toBe(1);
    const v = await view(main, owner, id);
    expect(v).toMatchObject({ plan: 'team', status: 'active', seats: 4, seatsUsed: 1, interval: 'month', periodEnd: addInterval(paidAt, 1, 'month'), graceReason: null });
    expect(v.details).toMatchObject({ unitAmount: TEAM, currency: 'NGN', nextAmount: 4 * TEAM, carry: 0, autoRenew: true, paystackEmail: owner.email });
    expect(v.details!.card).toEqual({ brand: 'visa', last4: '4081', expMonth: 12, expYear: 2030 });
    expect(v.details!.charges).toEqual([expect.objectContaining({ reference, purpose: 'subscribe', status: 'succeeded', seats: 4, amount: 4 * TEAM, card: { brand: 'visa', last4: '4081' } })]);
    expect(sent.some((m) => m.to === owner.email && m.subject.startsWith('Receipt for'))).toBe(true);
    // Admins see the plan, not the money.
    const [ada] = await staff(main, owner, id, 1, 'admin');
    expect(await view(main, ada, id)).not.toHaveProperty('details');
    expect((await api(main, ada, `/offices/${id}/billing/cancel`, {})).status).toBe(403);
  });

  it('gives the seats in use when the payment arrives, and bills the ones not paid for at the renewal', async () => {
    const owner = await person(main, 'Sha');
    const desk = await support(main, owner);
    const reference = await checkout(main, owner, desk.id, 1);
    // While the owner is on Paystack's page, the unpaid desk's 3 seats are filled.
    await staff(main, owner, desk.id, 2, 'admin');
    mock.pay(reference);
    const paidAt = clock;
    expect((await verify(main, owner, reference)).status).toBe('succeeded');
    const end = addInterval(paidAt, 1, 'year');
    const v = await view(main, owner, desk.id);
    expect(v).toMatchObject({ status: 'active', seats: 3, seatsUsed: 3, periodStart: paidAt, periodEnd: end });
    expect(v.details).toMatchObject({ carry: 2 * SUPPORT, nextAmount: 5 * SUPPORT });
    // The receipt says what was paid, for the period it pays for.
    expect(v.details!.charges[0]).toMatchObject({ reference, seats: 1, amount: SUPPORT, periodStart: paidAt, periodEnd: end });
  });
});

describe('the webhook', () => {
  const hook = (body: string, signature: string) =>
    fetch(`${main.base}/api/billing/paystack/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature }, body });

  it('is checked against the exact bytes signed, and handled once', async () => {
    const owner = await person(main, 'Web');
    const id = await team(main, owner);
    const reference = await checkout(main, owner, id, 2);
    const tx = mock.pay(reference);
    expect((await hook(mock.signedWebhook('charge.success', mock.data(tx), 'sk_test_someone_else').body, 'f'.repeat(128))).status).toBe(401);
    const forged = mock.signedWebhook('charge.success', mock.data(tx), 'sk_test_someone_else');
    expect((await hook(forged.body, forged.signature)).status).toBe(401);
    // Spaces and line breaks as sent: the signature is over the bytes, not the parsed JSON.
    const body = JSON.stringify({ event: 'charge.success', data: mock.data(tx) }, null, 2);
    const signature = (await import('node:crypto')).createHmac('sha512', mock.secretKey).update(body).digest('hex');
    expect((await hook(body, signature)).status).toBe(200);
    await until(async () => (await account(main, id))?.status === 'active');
    expect((await hook(body, signature)).status).toBe(200);
    const events = await main.db.query<{ payload: { data: { authorization: Record<string, unknown> } } }>('SELECT payload FROM billing_events WHERE reference = $1', [reference]);
    expect(events.rowCount).toBe(1);
    // The card's code isn't kept with it.
    expect(events.rows[0].payload.data.authorization).not.toHaveProperty('authorization_code');
    expect((await chargesOf(main, id)).map((c) => c.status)).toEqual(['succeeded']);
  });

  it('ignores other apps’ payments on the same Paystack account', async () => {
    const other = mock.signedWebhook('charge.success', { id: 1, reference: 'shop-order-1', status: 'success', metadata: { app: 'shop' } });
    expect((await hook(other.body, other.signature)).status).toBe(200);
    const unknown = mock.signedWebhook('charge.success', { id: 2, reference: 'wc-nothing-here', status: 'success', metadata: { app: 'workchop' } });
    expect((await hook(unknown.body, unknown.signature)).status).toBe(200);
    expect((await main.db.query("SELECT 1 FROM billing_events WHERE reference IN ('shop-order-1', 'wc-nothing-here')")).rowCount).toBe(0);
  });

  it('notes refunds', async () => {
    const owner = await person(main, 'Ref');
    const id = await team(main, owner);
    const first = await checkout(main, owner, id, 1);
    const second = await checkout(main, owner, id, 1);
    mock.pay(first);
    mock.pay(second);
    expect((await verify(main, owner, first)).status).toBe('succeeded');
    // Paid twice: the second is refunded, by itself.
    expect((await verify(main, owner, second)).status).toBe('succeeded');
    expect(mock.refunds).toContain(second);
    expect((await chargesOf(main, id)).map((c) => c.status)).toEqual(['succeeded', 'superseded']);
    const processed = mock.signedWebhook('refund.processed', { id: 77, transaction_reference: second, status: 'processed', amount: '750000' });
    expect((await hook(processed.body, processed.signature)).status).toBe(200);
    await until(async () => (await chargesOf(main, id))[1].status === 'refunded');
  });
});

describe('refunds', () => {
  /** A team paid for twice: the second payment's reference, after it's settled with Paystack answering its refund with `answer`. */
  async function paidTwice(owner: Person, answer: 503 | 400) {
    const id = await team(main, owner);
    const [first, second] = [await checkout(main, owner, id, 1), await checkout(main, owner, id, 1)];
    mock.pay(first);
    mock.pay(second);
    await verify(main, owner, first);
    mock.refundAnswers.push(answer);
    expect((await verify(main, owner, second)).status).toBe('succeeded');
    const receipt = async () => (await view(main, owner, id)).details!.charges.find((c) => c.reference === second);
    return { second, receipt };
  }

  it('Paystack doesn’t take are asked for again until it does', async () => {
    const owner = await person(main, 'Ret');
    const { second, receipt } = await paidTwice(owner, 503);
    expect(mock.refunds).not.toContain(second);
    expect(await receipt()).toMatchObject({ status: 'superseded', refund: 'due' });
    expect(await read<{ refunded: number }>(tick(main))).toMatchObject({ refunded: 1 });
    expect(mock.refunds).toContain(second);
    expect(await receipt()).toMatchObject({ status: 'superseded', refund: 'requested' });
    const asked = mock.calls('/refund').length;
    await tick(main);
    expect(mock.calls('/refund')).toHaveLength(asked);
  });

  it('Paystack refuses are left to its dashboard', async () => {
    const owner = await person(main, 'Rfu');
    const { second, receipt } = await paidTwice(owner, 400);
    expect(await receipt()).toMatchObject({ status: 'superseded', refund: 'refused' });
    const asked = mock.calls('/refund').length;
    await tick(main);
    expect(mock.calls('/refund')).toHaveLength(asked);
    expect(mock.refunds).not.toContain(second);
  });
});

describe('settling', () => {
  it('refuses a payment that doesn’t match its charge', async () => {
    const owner = await person(main, 'Mis');
    const id = await team(main, owner);
    const tamper: ((reference: string) => void)[] = [
      (r) => mock.pay(r, { amount: TEAM - 100 }),
      (r) => mock.pay(r, { currency: 'USD' }),
      (r) => {
        const tx = mock.pay(r);
        tx.metadata = { ...(tx.metadata as object), office_id: 'someoneelse' };
      },
      (r) => {
        mock.pay(r).extra = { gateway_response_code: 'pending_review' };
      },
      (r) => mock.pay(r, { email: 'thief@example.com' }),
    ];
    for (const change of tamper) {
      const reference = await checkout(main, owner, id, 1);
      change(reference);
      expect((await verify(main, owner, reference)).status).toBe('failed');
    }
    expect(await view(main, owner, id)).toMatchObject({ plan: 'free' });
    const charges = await chargesOf(main, id);
    expect(charges.every((c) => c.status === 'failed')).toBe(true);
    // The money was taken: every one of them is given back.
    for (const c of charges) expect(mock.refunds).toContain(c.reference);
  });
});

describe('an unpaid support workspace', () => {
  it('lets in only a few of its staff, and no customers, until it’s paid', async () => {
    const owner = await person(main, 'Sue');
    const desk = await support(main, owner);
    const [ada, abe] = await staff(main, owner, desk.id, 2, 'admin');
    // Its 3 seats are taken; one more admin comes in another way.
    const amy = await person(main, 'Amy');
    await main.db.query("INSERT INTO memberships (user_id, office_id, role) VALUES ($1, $2, 'admin')", [amy.user.id, desk.id]);
    const mo = await person(main, 'Mo');
    await main.db.query("INSERT INTO memberships (user_id, office_id, role) VALUES ($1, $2, 'member')", [mo.user.id, desk.id]);
    expect(await view(main, owner, desk.id)).toMatchObject({ plan: 'support', status: 'incomplete', seats: 3, seatsUsed: 5 });

    const lookup = (who: Person | null, guest?: string) =>
      (who?.jar ?? new Jar()).fetch(`${main.base}/api/offices/${desk.id}`, { headers: guest ? { 'X-Workchop-Guest': guest } : {} });
    expect((await lookup(mo)).status).toBe(403);
    expect(await read(lookup(mo))).toMatchObject({ reason: 'locked' });
    expect(await read(lookup(null, desk.guest))).toMatchObject({ reason: 'locked' });
    expect((await lookup(ada)).status).toBe(200);
    expect((await enter(main, desk.id, { who: mo })).res).toMatchObject({ ok: false, reason: 'locked' });
    expect((await enter(main, desk.id, { guest: desk.guest, ip: nextIp() })).res).toMatchObject({ ok: false, reason: 'locked' });
    expect((await enter(main, desk.id, { who: ada })).res.ok).toBe(true);
    expect((await enter(main, desk.id, { who: abe })).res.ok).toBe(true);
    expect((await enter(main, desk.id, { who: amy })).res.ok).toBe(true);
    // Three are in: no more admins, but the owner always.
    expect((await enter(main, desk.id, { who: owner })).res.ok).toBe(true);
    const fourth = await enter(main, desk.id, { who: abe });
    expect(fourth.res).toMatchObject({ ok: false, error: expect.stringContaining('paused') });
    // Members see it as paused; owners and admins as unpaid.
    expect((await read<Space[]>(api(main, mo, '/me/spaces'))).find((s) => s.id === desk.id)?.billing).toBe('locked');
    expect((await read<Space[]>(api(main, ada, '/me/spaces'))).find((s) => s.id === desk.id)?.billing).toBe('unpaid');
    // A refused member's visit isn't recorded.
    expect((await read<Space[]>(api(main, mo, '/me/spaces'))).find((s) => s.id === desk.id)?.lastVisitAt).toBeNull();

    expect(await read(api(main, owner, `/offices/${desk.id}/billing/checkout`, { seats: 4 }))).toMatchObject({ code: 'seats' });
    const reference = await checkout(main, owner, desk.id, 5);
    expect(mock.calls('/transaction/initialize').at(-1)!.body).toMatchObject({ amount: 5 * SUPPORT });
    mock.pay(reference);
    expect((await verify(main, ada, reference)).status).toBe('succeeded');
    expect(await view(main, owner, desk.id)).toMatchObject({ plan: 'support', status: 'active', seats: 5, interval: 'year', periodEnd: addInterval(clock, 1, 'year') });
    expect((await enter(main, desk.id, { guest: desk.guest, ip: nextIp() })).res.ok).toBe(true);
    expect((await enter(main, desk.id, { who: mo })).res.ok).toBe(true);
    expect((await read<Space[]>(api(main, mo, '/me/spaces'))).find((s) => s.id === desk.id)).not.toHaveProperty('billing');
  });
});

describe('renewals', () => {
  it('charge the saved card for the next period, from the anchor', async () => {
    const owner = await person(main, 'Ren');
    const id = await team(main, owner);
    await staff(main, owner, id, 2);
    await subscribe(main, owner, id, 4);
    const before = await account(main, id);
    const end = ms(before.period_end)!;
    expect((await tick(main)).status).toBe(200);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(0);
    clock = end + MINUTE;
    const summary = await read<Record<string, number>>(tick(main));
    expect(summary.renewed).toBeGreaterThanOrEqual(1);
    const charge = mock.calls('/transaction/charge_authorization').find((c) => c.body.email === owner.email)!;
    expect(charge.body).toMatchObject({ email: owner.email, amount: 4 * TEAM, authorization_code: before.authorization_code, currency: 'NGN', metadata: { app: 'workchop', office_id: id, purpose: 'renewal', seats: 4 } });
    expect(charge.body).not.toHaveProperty('queue');
    const after = await account(main, id);
    expect(after).toMatchObject({ status: 'active', seats: 4 });
    expect(ms(after.period_start)).toBe(end);
    expect(ms(after.period_end)).toBe(nextPeriodEnd(ms(before.period_start)!, end, 'month'));
    expect(sent.filter((m) => m.to === owner.email && m.subject.startsWith('Receipt for'))).toHaveLength(2);
  });

  it('that took the money but don’t match are refunded, and the card isn’t charged again by itself', async () => {
    const owner = await person(main, 'Mat');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    // More than the Free plan's 3, so it waits for a card instead of going back to Free.
    await staff(main, owner, id, 3);
    const end = ms((await account(main, id)).period_end)!;
    const attempts = () => mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email).length;
    mock.nextChargeExtraFor.set(owner.email, { requested_amount: 1 });
    clock = end + MINUTE;
    await tick(main);
    expect(attempts()).toBe(1);
    const renewal = (await chargesOf(main, id)).find((c) => c.purpose === 'renewal')!;
    expect(renewal).toMatchObject({ status: 'failed', refund: 'requested', gateway_response: 'mismatch: amount' });
    expect(mock.refunds).toContain(renewal.reference);
    expect((await account(main, id)).auto_renew).toBe(false);
    clock += DAY;
    await tick(main);
    expect(attempts()).toBe(1);
    expect(await view(main, owner, id)).toMatchObject({ status: 'past_due', graceReason: 'no_card' });
  });

  it('that fail are tried again after 1, 3 and 6 days, then the workspace locks on day 7', async () => {
    const owner = await person(main, 'Fay');
    const desk = await support(main, owner);
    const [ada] = await staff(main, owner, desk.id, 1, 'admin');
    const [mo] = await staff(main, owner, desk.id, 1);
    await subscribe(main, owner, desk.id, 3);
    const t0 = ms((await account(main, desk.id)).period_end)!;
    mock.nextChargesFor.set(owner.email, ['failed', 'failed', 'failed', 'failed']);
    const attempts = () => mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email).length;

    clock = t0 + MINUTE;
    await tick(main);
    expect(attempts()).toBe(1);
    let a = await account(main, desk.id);
    expect(a).toMatchObject({ status: 'past_due', grace_reason: 'payment_failed', retry_count: 1 });
    expect(ms(a.next_retry_at)).toBe(t0 + DAY);
    expect(ms(a.grace_ends_at)).toBe(t0 + GRACE_DAYS * DAY);
    expect(await view(main, ada, desk.id)).toMatchObject({ status: 'past_due', graceReason: 'payment_failed', graceEndsAt: t0 + GRACE_DAYS * DAY });
    expect(sent.some((m) => m.to === owner.email && m.subject.includes('failed'))).toBe(true);
    expect((await read<Space[]>(api(main, owner, '/me/spaces'))).find((s) => s.id === desk.id)?.billing).toBe('past-due');
    expect((await read<Space[]>(api(main, mo, '/me/spaces'))).find((s) => s.id === desk.id)).not.toHaveProperty('billing');

    for (const [day, n, next] of [
      [0.5, 1, t0 + DAY],
      [1, 2, t0 + 3 * DAY],
      [3, 3, t0 + 6 * DAY],
      [6, 4, null],
    ] as const) {
      clock = t0 + day * DAY + MINUTE;
      await tick(main);
      expect(attempts()).toBe(n);
      a = await account(main, desk.id);
      expect(ms(a.next_retry_at)).toBe(next);
    }

    // People inside when it locks: the owner and admins stay, everyone else is taken out.
    const ownerIn = await enter(main, desk.id, { who: owner });
    const memberIn = await enter(main, desk.id, { who: mo });
    const customerIn = await enter(main, desk.id, { guest: desk.guest, ip: nextIp() });
    expect([ownerIn.res.ok, memberIn.res.ok, customerIn.res.ok]).toEqual([true, true, true]);
    clock = t0 + GRACE_DAYS * DAY + MINUTE;
    await tick(main);
    expect(attempts()).toBe(4);
    expect((await account(main, desk.id)).status).toBe('locked');
    await until(() => memberIn.removed.length > 0 && customerIn.removed.length > 0);
    expect([memberIn.removed, customerIn.removed, ownerIn.removed]).toEqual([['locked'], ['locked'], []]);
    expect(main.server.realtime.players(desk.id).map((p) => p.id)).toEqual([ownerIn.socket.id]);
    expect((await enter(main, desk.id, { who: mo })).res).toMatchObject({ ok: false, reason: 'locked' });
    expect(await read(addPerson(main, owner, desk.id, `late.${people}@example.com`))).toMatchObject({ code: 'locked' });
    expect(sent.filter((m) => m.subject.endsWith('is paused')).map((m) => m.to)).toEqual(expect.arrayContaining([owner.email, ada.email]));
    expect((await read<Space[]>(api(main, mo, '/me/spaces'))).find((s) => s.id === desk.id)?.billing).toBe('locked');

    // Paying again starts a new period from now.
    const reference = await checkout(main, owner, desk.id);
    expect(mock.calls('/transaction/initialize').at(-1)!.body).toMatchObject({ amount: 3 * SUPPORT, metadata: { purpose: 'subscribe' } });
    mock.pay(reference);
    await verify(main, owner, reference);
    expect(await account(main, desk.id)).toMatchObject({ status: 'active' });
    expect(ms((await account(main, desk.id)).period_start)).toBe(clock);
    expect((await enter(main, desk.id, { who: mo })).res.ok).toBe(true);
  });

  it('can be paid while past due, continuing from where the period ended', async () => {
    const owner = await person(main, 'Due');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    await staff(main, owner, id, 3);
    const before = await account(main, id);
    const t0 = ms(before.period_end)!;
    mock.nextChargesFor.set(owner.email, ['failed']);
    clock = t0 + MINUTE;
    await tick(main);
    expect(await account(main, id)).toMatchObject({ status: 'past_due' });
    clock = t0 + 2 * DAY;
    // Trying the card again now.
    mock.nextChargesFor.set(owner.email, ['failed']);
    expect(await read(api(main, owner, `/offices/${id}/billing/retry`, {}))).toMatchObject({ code: 'card-declined' });
    expect(await account(main, id)).toMatchObject({ status: 'past_due', retry_count: 2 });
    const reference = await checkout(main, owner, id);
    expect(mock.calls('/transaction/initialize').at(-1)!.body).toMatchObject({ amount: 4 * TEAM, metadata: { purpose: 'pay_due', seats: 4 } });
    mock.pay(reference);
    expect((await verify(main, owner, reference)).status).toBe('succeeded');
    const after = await account(main, id);
    expect(after).toMatchObject({ status: 'active', grace_reason: null, retry_count: 0 });
    expect(ms(after.period_start)).toBe(t0);
    expect(ms(after.period_end)).toBe(nextPeriodEnd(ms(before.period_start)!, t0, 'month'));
    // Paid: no more retries.
    clock = t0 + 3 * DAY + MINUTE;
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(2);
    expect(await read(api(main, owner, `/offices/${id}/billing/retry`, {}))).toMatchObject({ code: 'pay-first' });
  });

  it('a team that fails and has 3 people or fewer is free', async () => {
    const owner = await person(main, 'Tri');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 5);
    const members = await staff(main, owner, id, 4);
    await main.db.query("UPDATE billing_accounts SET status = 'past_due', grace_reason = 'payment_failed', grace_ends_at = $2 WHERE office_id = $1", [id, new Date(clock - 1)]);
    await tick(main);
    expect((await account(main, id)).status).toBe('locked');
    for (const m of members.slice(0, 2)) expect((await owner.jar.fetch(`${main.base}/api/offices/${id}/members/${m.user.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await view(main, owner, id)).toMatchObject({ plan: 'free', status: 'free' });
    expect((await account(main, id)).status).toBe('free');
  });

  it('wait for the bank when it wants the owner to confirm', async () => {
    const owner = await person(main, 'Ban');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    await staff(main, owner, id, 3);
    const t0 = ms((await account(main, id)).period_end)!;
    mock.nextChargesFor.set(owner.email, ['paused']);
    clock = t0 + MINUTE;
    await tick(main);
    const v = await view(main, owner, id);
    expect(v).toMatchObject({ status: 'past_due', graceReason: 'action_needed', graceEndsAt: t0 + GRACE_DAYS * DAY });
    expect(v.details!.actionUrl).toMatch(new RegExp(`^${mock.base}/checkout/`));
    expect(sent.some((m) => m.to === owner.email && m.subject.startsWith('Confirm the payment'))).toBe(true);
    // No retries meanwhile.
    clock = t0 + 2 * DAY;
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(1);
    // The owner confirms, and comes back through the return page.
    const reference = String(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)[0].body.reference);
    mock.pay(reference);
    expect((await verify(main, owner, reference)).status).toBe('succeeded');
    expect(await view(main, owner, id)).toMatchObject({ status: 'active', graceReason: null });
    expect(ms((await account(main, id)).period_start)).toBe(t0);
  });

  it('of a small team that fail keep the plan while the card is tried again, without the owner’s tries using up a retry', async () => {
    const owner = await person(main, 'Sma');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 1);
    const t0 = ms((await account(main, id)).period_end)!;
    const attempts = () => mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email).length;
    mock.nextChargesFor.set(owner.email, ['failed', 'failed', 'failed']);
    clock = t0 + MINUTE;
    await tick(main);
    expect(await account(main, id)).toMatchObject({ status: 'past_due', grace_reason: 'payment_failed', retry_count: 1 });
    expect(await view(main, owner, id)).toMatchObject({ plan: 'team', status: 'past_due', graceEndsAt: t0 + GRACE_DAYS * DAY });
    expect(sent.find((m) => m.to === owner.email && m.subject.includes('failed'))!.text).toContain('goes on the Free plan');
    // The owner tries now: the retry due tomorrow stays.
    clock = t0 + 2 * HOUR;
    expect(await read(api(main, owner, `/offices/${id}/billing/retry`, {}))).toMatchObject({ code: 'card-declined' });
    let a = await account(main, id);
    expect(a.retry_count).toBe(2);
    expect(ms(a.next_retry_at)).toBe(t0 + DAY);
    clock = t0 + DAY + MINUTE;
    await tick(main);
    expect(attempts()).toBe(3);
    a = await account(main, id);
    expect(ms(a.next_retry_at)).toBe(t0 + 3 * DAY);
    // Not paid by the end of the grace: the Free plan.
    clock = t0 + GRACE_DAYS * DAY + MINUTE;
    await tick(main);
    expect(await view(main, owner, id)).toMatchObject({ plan: 'free', status: 'free' });
    expect((await account(main, id)).status).toBe('free');
  });

  it('that are due while no run happens for days still charge the card, and count the grace from then', async () => {
    const owner = await person(main, 'Lat');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    const [mo] = await staff(main, owner, id, 3);
    const t0 = ms((await account(main, id)).period_end)!;
    clock = t0 + 8 * DAY;
    // Nobody is kept out meanwhile.
    expect(await view(main, owner, id)).toMatchObject({ status: 'active', graceEndsAt: null });
    expect((await enter(main, id, { who: mo })).res.ok).toBe(true);
    mock.nextChargesFor.set(owner.email, ['failed']);
    await tick(main);
    const tried = clock;
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(1);
    const a = await account(main, id);
    expect(a).toMatchObject({ status: 'past_due', grace_reason: 'payment_failed' });
    expect([ms(a.grace_ends_at), ms(a.next_retry_at)]).toEqual([tried + GRACE_DAYS * DAY, tried + DAY]);
    clock = tried + DAY + MINUTE;
    await tick(main);
    expect(await account(main, id)).toMatchObject({ status: 'active', grace_reason: null });
    expect(ms((await account(main, id)).period_start)).toBe(t0);
  });

  it('are made without a charge when credit covers them, the rest carried', async () => {
    const owner = await person(main, 'Cre');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 1);
    const end = ms((await account(main, id)).period_end)!;
    await main.db.query('UPDATE billing_accounts SET carry_amount = $2 WHERE office_id = $1', [id, 3000 - TEAM]);
    clock = end + MINUTE;
    expect((await read<{ renewed: number }>(tick(main))).renewed).toBeGreaterThanOrEqual(1);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(0);
    expect(await account(main, id)).toMatchObject({ status: 'active', carry_amount: '3000' });
    expect(ms((await account(main, id)).period_start)).toBe(end);
  });

  it('aren’t tried again after a decline that won’t change', async () => {
    const owner = await person(main, 'Exp');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    await staff(main, owner, id, 3);
    const t0 = ms((await account(main, id)).period_end)!;
    mock.nextChargesFor.set(owner.email, ['expired']);
    clock = t0 + MINUTE;
    await tick(main);
    expect(await account(main, id)).toMatchObject({ status: 'past_due', grace_reason: 'payment_failed', next_retry_at: null });
    clock = t0 + 3 * DAY + MINUTE;
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(1);
  });

  it('paid after the workspace paused show the period actually paid for', async () => {
    const owner = await person(main, 'Per');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    await staff(main, owner, id, 3);
    const t0 = ms((await account(main, id)).period_end)!;
    mock.nextChargesFor.set(owner.email, ['failed']);
    clock = t0 + MINUTE;
    await tick(main);
    clock = t0 + 2 * DAY;
    const reference = await checkout(main, owner, id);
    expect(mock.calls('/transaction/initialize').at(-1)!.body).toMatchObject({ metadata: { purpose: 'pay_due' } });
    clock = t0 + GRACE_DAYS * DAY + MINUTE;
    await tick(main);
    expect((await account(main, id)).status).toBe('locked');
    mock.pay(reference);
    expect((await verify(main, owner, reference)).status).toBe('succeeded');
    const a = await account(main, id);
    expect(ms(a.period_start)).toBe(clock);
    const receipt = (await view(main, owner, id)).details!.charges.find((c) => c.reference === reference);
    expect(receipt).toMatchObject({ purpose: 'pay_due', status: 'succeeded', periodStart: clock, periodEnd: ms(a.period_end) });
  });
});

describe('the owner’s details', () => {
  it('say what paying now charges while a payment is overdue', async () => {
    const owner = await person(main, 'Owe');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    const [ada] = await staff(main, owner, id, 1, 'admin');
    await staff(main, owner, id, 2);
    const due = async () => (await view(main, owner, id)).details!.due;
    const charged = async () => {
      await checkout(main, owner, id);
      return mock.calls('/transaction/initialize').at(-1)!.body.amount;
    };
    expect(await due()).toBeNull();
    const t0 = ms((await account(main, id)).period_end)!;
    // A renewal that's due isn't overdue.
    clock = t0 + MINUTE;
    expect(await due()).toBeNull();
    await main.db.query('UPDATE billing_accounts SET carry_amount = 2500 WHERE office_id = $1', [id]);
    mock.nextChargesFor.set(owner.email, ['failed']);
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email).at(-1)!.body.amount).toBe(4 * TEAM + 2500);
    // The overdue period with what's carried, at least ₦50.
    expect(await due()).toBe(4 * TEAM + 2500);
    expect(await charged()).toBe(4 * TEAM + 2500);
    await main.db.query('UPDATE billing_accounts SET carry_amount = $2 WHERE office_id = $1', [id, 1000 - 4 * TEAM]);
    expect(await due()).toBe(MIN_CHARGE);
    expect(await charged()).toBe(MIN_CHARGE);
    // Paused: a new period for the seats it had (what's carried waits for its renewal).
    clock = t0 + GRACE_DAYS * DAY + MINUTE;
    await tick(main);
    expect((await account(main, id)).status).toBe('locked');
    expect(await due()).toBe(4 * TEAM);
    expect(await charged()).toBe(4 * TEAM);
    expect(await view(main, ada, id)).not.toHaveProperty('details');
  });

  it('list payments and the saved card’s failed charges, not checkouts that were never paid', async () => {
    const owner = await person(main, 'His');
    const id = await team(main, owner);
    const declined = await checkout(main, owner, id, 4);
    mock.decline(declined);
    expect((await verify(main, owner, declined)).status).toBe('failed');
    const left = await checkout(main, owner, id, 4);
    const paid = await subscribe(main, owner, id, 4);
    await staff(main, owner, id, 3);
    const newCard = await checkout(main, owner, id);
    mock.nextChargesFor.set(owner.email, ['failed', 'failed']);
    expect(await read(api(main, owner, `/offices/${id}/billing/seats`, { seats: 6 }))).toMatchObject({ code: 'card-declined' });
    const lastCharge = () => String(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email).at(-1)!.body.reference);
    const seats = lastCharge();
    clock = ms((await account(main, id)).period_end)! + MINUTE;
    await tick(main);
    const renewal = lastCharge();
    const due = await checkout(main, owner, id);
    const statuses = Object.fromEntries((await chargesOf(main, id)).map((c) => [c.reference, c.status]));
    expect(statuses).toEqual({ [declined]: 'failed', [left]: 'abandoned', [paid]: 'succeeded', [newCard]: 'abandoned', [seats]: 'failed', [renewal]: 'failed', [due]: 'pending' });
    const history = (await view(main, owner, id)).details!.charges;
    expect(history.map((c) => [c.reference, c.purpose, c.status])).toEqual([
      [renewal, 'renewal', 'failed'],
      [seats, 'seats', 'failed'],
      [paid, 'subscribe', 'succeeded'],
    ]);
  });
});

describe('the card', () => {
  it('is changed for ₦50, credited to the next renewal, which charges the new card', async () => {
    const owner = await person(main, 'Car');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    const before = await account(main, id);
    const reference = await checkout(main, owner, id);
    expect(mock.calls('/transaction/initialize').at(-1)!.body).toMatchObject({ amount: MIN_CHARGE, metadata: { purpose: 'card_update' } });
    mock.pay(reference, { last4: '1111' });
    expect((await verify(main, owner, reference)).status).toBe('succeeded');
    const v = await view(main, owner, id);
    expect(v.details).toMatchObject({ card: { last4: '1111' }, carry: -MIN_CHARGE, nextAmount: 4 * TEAM - MIN_CHARGE });
    await until(() => mock.deactivated.includes(before.authorization_code!));
    clock = ms(before.period_end)! + MINUTE;
    await tick(main);
    const renewal = mock.calls('/transaction/charge_authorization').find((c) => c.body.email === owner.email)!.body;
    expect(renewal).toMatchObject({ amount: 4 * TEAM - MIN_CHARGE, authorization_code: (await account(main, id)).authorization_code });
    expect(renewal.authorization_code).not.toBe(before.authorization_code);
    expect(await account(main, id)).toMatchObject({ status: 'active', carry_amount: '0' });
  });
});

describe('seats', () => {
  it('added during a period are charged for the rest of it, once', async () => {
    const owner = await person(main, 'Sam');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    const a = await account(main, id);
    const [start, end] = [ms(a.period_start)!, ms(a.period_end)!];
    const charges = () => mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email);
    const setSeats = (seats: unknown) => api(main, owner, `/offices/${id}/billing/seats`, { seats });
    const seatsCharges = async () => (await chargesOf(main, id)).filter((c) => c.purpose === 'seats').map((c) => c.status);

    clock = start + 10 * DAY;
    const res = await setSeats(6);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seats: 6 });
    expect(charges().at(-1)!.body).toMatchObject({ amount: prorate(2, TEAM, clock, start, end), metadata: { purpose: 'seats', seats: 6 } });

    // Declined: nothing changes.
    clock = start + 11 * DAY;
    mock.nextChargesFor.set(owner.email, ['failed']);
    const declined = await setSeats(9);
    expect(declined.status).toBe(402);
    expect(await declined.json()).toMatchObject({ code: 'card-declined' });
    expect((await account(main, id)).seats).toBe(6);

    // The bank wants to confirm it: adding seats again points there instead of charging again.
    mock.nextChargesFor.set(owner.email, ['paused']);
    const paused = await setSeats(9);
    expect(paused.status).toBe(409);
    const { url } = (await paused.json()) as { url: string };
    expect(url).toMatch(/\/checkout\//);
    expect(await read(setSeats(8))).toMatchObject({ code: 'action-needed', url });
    expect(charges()).toHaveLength(3);
    expect((await account(main, id)).seats).toBe(6);
    // Left for a day, it's given up. Paid late, after seats were added another way: refunded.
    const waiting = String(charges().at(-1)!.body.reference);
    clock += DAY + 16 * MINUTE;
    await tick(main);
    expect(await seatsCharges()).toEqual(['succeeded', 'failed', 'abandoned']);
    expect(await read(setSeats(8))).toMatchObject({ seats: 8 });
    mock.pay(waiting);
    expect((await verify(main, owner, waiting)).status).toBe('succeeded');
    expect(mock.refunds).toContain(waiting);
    expect((await account(main, id)).seats).toBe(8);
    expect((await view(main, owner, id)).details!.charges.find((c) => c.reference === waiting)).toMatchObject({ status: 'superseded', refund: 'requested' });

    // Paystack's answer is lost: the charge waits, and another add waits for it.
    mock.nextChargesFor.set(owner.email, ['hang']);
    const lost = await setSeats(10);
    expect(lost.status).toBe(502);
    expect(await read(setSeats(11))).toMatchObject({ code: 'busy' });
    expect((await account(main, id)).seats).toBe(8);
    // The reconciliation finds it went through.
    clock += 16 * MINUTE;
    await tick(main);
    expect((await account(main, id)).seats).toBe(10);
    expect(await seatsCharges()).toEqual(['succeeded', 'failed', 'superseded', 'succeeded', 'succeeded']);

    // Less than ₦50: given now and added to the next renewal.
    clock = end - 2 * HOUR;
    const small = prorate(1, TEAM, clock, start, end);
    expect(small).toBeLessThan(MIN_CHARGE);
    const count = charges().length;
    expect(await read(setSeats(11))).toMatchObject({ seats: 11, details: { carry: small } });
    // In the last hour: no charge, the renewal bills them.
    clock = end - 30 * MINUTE;
    expect(await read(setSeats(12))).toMatchObject({ seats: 12, details: { carry: small } });
    expect(charges()).toHaveLength(count);
  });

  it('lowered take effect at renewal, never below the seats in use', async () => {
    const owner = await person(main, 'Low');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 6);
    const [ada] = await staff(main, owner, id, 1, 'admin');
    await staff(main, owner, id, 2);
    const seats = (n: number) => api(main, owner, `/offices/${id}/billing/seats`, { seats: n });
    expect(await read(seats(3))).toMatchObject({ code: 'below-used' });
    expect(await read(seats(4))).toMatchObject({ seats: 6, seatsNext: 4 });
    expect(sent.some((m) => m.to === owner.email && m.subject.startsWith('Seats changed'))).toBe(true);
    // Admins can still fill this period's seats.
    expect((await addPerson(main, ada, id, `fifth.${people}@example.com`)).status).toBe(202);
    const end = ms((await account(main, id)).period_end)!;
    clock = end + MINUTE;
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').find((c) => c.body.email === owner.email)!.body).toMatchObject({ amount: 5 * TEAM, metadata: { seats: 5 } });
    expect(await account(main, id)).toMatchObject({ seats: 5, seats_next: null });
  });
});

describe('cancelling', () => {
  it('ends the plan at the end of the period: a small team is free, a bigger one locks a week later', async () => {
    const owner = await person(main, 'Can');
    const small = await team(main, owner);
    await staff(main, owner, small, 1);
    await subscribe(main, owner, small, 2);
    const big = await team(main, owner);
    await subscribe(main, owner, big, 5);
    await staff(main, owner, big, 4);
    const cancel = (id: string) => api(main, owner, `/offices/${id}/billing/cancel`, {});
    expect(await read(cancel(small))).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' });
    expect(await read(api(main, owner, `/offices/${small}/billing/resume`, {}))).toMatchObject({ cancelAtPeriodEnd: false });
    await cancel(small);
    await cancel(big);
    expect(sent.some((m) => m.to === owner.email && m.subject.startsWith('Your plan for'))).toBe(true);
    const end = ms((await account(main, big)).period_end)!;
    clock = end + MINUTE;
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(0);
    expect(await view(main, owner, small)).toMatchObject({ plan: 'free', status: 'free' });
    expect(await read(api(main, owner, `/offices/${small}/billing/resume`, {}))).toMatchObject({ code: 'pay-first' });
    expect(await view(main, owner, big)).toMatchObject({ plan: 'team', status: 'past_due', graceReason: 'cancelled', graceEndsAt: end + GRACE_DAYS * DAY });
    clock = end + GRACE_DAYS * DAY + MINUTE;
    await tick(main);
    expect((await account(main, big)).status).toBe('locked');
    expect(await read(api(main, owner, `/offices/${big}/billing/resume`, {}))).toMatchObject({ code: 'pay-first' });
  });

  it('after the period ended stops the renewal that’s due, and can be undone until it pauses', async () => {
    const owner = await person(main, 'Win');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    await staff(main, owner, id, 3);
    const end = ms((await account(main, id)).period_end)!;
    // Due, and not charged yet (no run since).
    clock = end + HOUR;
    expect(await view(main, owner, id)).toMatchObject({ status: 'active', graceEndsAt: null, periodEnd: end });
    expect(await read(api(main, owner, `/offices/${id}/billing/seats`, { seats: 5 }))).toMatchObject({ code: 'busy' });
    expect(await read(api(main, owner, `/offices/${id}/billing/cancel`, {}))).toMatchObject({ status: 'past_due', graceReason: 'cancelled', graceEndsAt: end + GRACE_DAYS * DAY });
    const mail = sent.filter((m) => m.to === owner.email).at(-1)!;
    expect(mail.subject).toMatch(/won’t renew$/);
    expect(mail.text).toContain(formatDate(end + GRACE_DAYS * DAY));
    expect(mail.text).not.toContain('resume');
    // Stored as it is now, then resumed.
    await view(main, owner, id);
    expect(await read(api(main, owner, `/offices/${id}/billing/resume`, {}))).toMatchObject({ status: 'active', cancelAtPeriodEnd: false, graceEndsAt: null });
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(1);
    expect(await account(main, id)).toMatchObject({ status: 'active', cancel_at_period_end: false });
    expect(ms((await account(main, id)).period_start)).toBe(end);
  });

  it('while a renewal waits for the bank keeps the plan ending, whatever the bank says', async () => {
    const owner = await person(main, 'Wai');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    await staff(main, owner, id, 3);
    const t0 = ms((await account(main, id)).period_end)!;
    const attempts = () => mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email);
    mock.nextChargesFor.set(owner.email, ['paused']);
    clock = t0 + MINUTE;
    await tick(main);
    clock = t0 + 2 * DAY;
    expect(await read(api(main, owner, `/offices/${id}/billing/cancel`, {}))).toMatchObject({ status: 'past_due', graceReason: 'cancelled', cancelAtPeriodEnd: true });
    // Ended already: it pauses at the end of its grace.
    const mail = sent.filter((m) => m.to === owner.email).at(-1)!;
    expect(mail.subject).toMatch(/won’t renew$/);
    expect(mail.text).toContain(formatDate(t0 + GRACE_DAYS * DAY));
    expect(mail.text).not.toContain('resume');
    expect(await read(api(main, owner, `/offices/${id}/billing/resume`, {}))).toMatchObject({ code: 'pay-first' });
    // The bank says no: still cancelled, and the card isn't tried again.
    mock.decline(String(attempts()[0].body.reference));
    clock += 16 * MINUTE;
    await tick(main);
    expect(await account(main, id)).toMatchObject({ status: 'past_due', grace_reason: 'cancelled', next_retry_at: null, cancel_at_period_end: true });
    clock = t0 + 3 * DAY + MINUTE;
    await tick(main);
    expect(attempts()).toHaveLength(1);
    clock = t0 + GRACE_DAYS * DAY + MINUTE;
    await tick(main);
    expect((await account(main, id)).status).toBe('locked');
  });

  it('while a renewal’s answer is lost lets the paid period run, then ends', async () => {
    const owner = await person(main, 'Los');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    await staff(main, owner, id, 3);
    const t0 = ms((await account(main, id)).period_end)!;
    mock.nextChargesFor.set(owner.email, ['hang']);
    clock = t0 + MINUTE;
    await tick(main);
    await api(main, owner, `/offices/${id}/billing/cancel`, {});
    // It went through.
    clock += 16 * MINUTE;
    await tick(main);
    const a = await account(main, id);
    expect(a).toMatchObject({ status: 'active', cancel_at_period_end: true });
    expect(ms(a.period_start)).toBe(t0);
    clock = ms(a.period_end)! + MINUTE;
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(1);
    expect(await view(main, owner, id)).toMatchObject({ status: 'past_due', graceReason: 'cancelled' });
  });
});

describe('telling people', () => {
  it('sends the owner and admins in the office the new state', async () => {
    const owner = await person(main, 'Tel');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 3);
    const [ada] = await staff(main, owner, id, 1, 'admin');
    const [mo] = await staff(main, owner, id, 1);
    const heard = new Map<string, unknown[]>();
    for (const who of [owner, ada, mo]) {
      const { socket } = await enter(main, id, { who });
      const got: unknown[] = [];
      socket.on('billing:state', (summary) => void got.push(summary));
      heard.set(who.email, got);
    }
    await api(main, owner, `/offices/${id}/billing/cancel`, {});
    await until(() => heard.get(ada.email)!.length > 0 && heard.get(owner.email)!.length > 0);
    expect(heard.get(owner.email)).toEqual([expect.objectContaining({ officeId: id, plan: 'team', status: 'active', cancelAtPeriodEnd: true })]);
    expect(heard.get(ada.email)![0]).not.toHaveProperty('details');
    expect(heard.get(mo.email)).toEqual([]);
  });

  it('reminds the owner before a yearly renewal, a card that expires, and a pause', async () => {
    const owner = await person(main, 'Rem');
    const desk = await support(main, owner);
    await subscribe(main, owner, desk.id, 1);
    const end = ms((await account(main, desk.id)).period_end)!;
    const mails = (text: string) => sent.filter((m) => m.to === owner.email && m.subject.includes(text)).length;
    clock = end - 29 * DAY;
    await tick(main);
    expect(mails('renews on')).toBe(1);
    clock = end - 6 * DAY;
    await tick(main);
    await tick(main);
    expect(mails('renews on')).toBe(2);
    const expiry = new Date(end - 60 * DAY);
    await main.db.query('UPDATE billing_accounts SET card_exp_year = $2, card_exp_month = $3 WHERE office_id = $1', [desk.id, expiry.getUTCFullYear(), expiry.getUTCMonth() + 1]);
    await tick(main);
    await tick(main);
    expect(mails('Update your card')).toBe(1);

    mock.nextChargesFor.set(owner.email, ['failed', 'failed', 'failed', 'failed']);
    clock = end + MINUTE;
    await tick(main);
    expect(mails('failed')).toBe(1);
    clock = end + 3 * DAY + MINUTE;
    await tick(main);
    expect(mails('paid yet')).toBe(1);
    clock = end + 6 * DAY + MINUTE;
    await tick(main);
    await tick(main);
    expect(mails('pauses tomorrow')).toBe(1);
    expect(mails('failed')).toBe(1);
  });
});

describe('a new owner', () => {
  it('keeps the paid period, but nothing is charged to the old owner’s card', async () => {
    const owner = await person(main, 'Old');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 4);
    const [next] = await staff(main, owner, id, 1, 'admin');
    await staff(main, owner, id, 2);
    const before = await account(main, id);
    expect((await api(main, owner, `/offices/${id}/owner`, { userId: next.user.id })).status).toBe(200);
    await until(async () => (await account(main, id)).auto_renew === false);
    expect(await account(main, id)).toMatchObject({ status: 'active', authorization_code: null, payer_user_id: null });
    await until(() => mock.deactivated.includes(before.authorization_code!));
    // Codes that can charge the card never go into the log.
    expect(JSON.stringify((await main.db.query('SELECT before, after FROM billing_log WHERE office_id = $1', [id])).rows)).not.toContain(before.authorization_code);
    await until(() => sent.some((m) => m.to === next.email && m.subject.startsWith('Add a card')));
    // The old owner (now an admin) sees no money and can't pay.
    expect(await view(main, owner, id)).not.toHaveProperty('details');
    clock = ms(before.period_end)! + MINUTE;
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.authorization_code === before.authorization_code)).toHaveLength(0);
    expect(await view(main, next, id)).toMatchObject({ status: 'past_due', graceReason: 'no_card' });
    // The new owner pays, and their card renews it from then on.
    const reference = await checkout(main, next, id);
    expect(mock.calls('/transaction/initialize').at(-1)!.body).toMatchObject({ email: next.email, metadata: { purpose: 'pay_due' } });
    mock.pay(reference);
    expect((await verify(main, next, reference)).status).toBe('succeeded');
    const paid = await account(main, id);
    expect(paid).toMatchObject({ status: 'active', payer_user_id: next.user.id, auto_renew: true });
    clock = ms(paid.period_end)! + MINUTE;
    await tick(main);
    expect(mock.calls('/transaction/charge_authorization').find((c) => c.body.email === next.email)!.body).toMatchObject({ authorization_code: paid.authorization_code, metadata: { office_id: id } });
    expect(ms((await account(main, id)).period_start)).toBe(ms(paid.period_end));
  });
});

describe('a paused workspace', () => {
  it('keeps at most 3 people in: the owner and the admins who came first', async () => {
    const owner = await person(main, 'Pau');
    const id = await team(main, owner);
    await subscribe(main, owner, id, 7);
    const admins = await staff(main, owner, id, 5, 'admin');
    const [mo] = await staff(main, owner, id, 1);
    const ownerIn = await enter(main, id, { who: owner });
    const adminsIn: Awaited<ReturnType<typeof enter>>[] = [];
    for (const who of admins) adminsIn.push(await enter(main, id, { who }));
    const moIn = await enter(main, id, { who: mo });
    await main.db.query("UPDATE billing_accounts SET status = 'past_due', grace_reason = 'payment_failed', grace_ends_at = $2 WHERE office_id = $1", [id, new Date(clock - 1)]);
    await tick(main);
    expect((await account(main, id)).status).toBe('locked');
    await until(() => moIn.removed.length > 0 && adminsIn.slice(2).every((a) => a.removed.length > 0));
    expect([ownerIn, ...adminsIn, moIn].map((p) => p.removed)).toEqual([[], [], [], ['locked'], ['locked'], ['locked'], ['locked']]);
    expect(main.server.realtime.players(id).map((p) => p.id)).toEqual([ownerIn, ...adminsIn.slice(0, 2)].map((p) => p.socket.id));

    // An admin made a member is taken out too.
    expect((await owner.jar.fetch(`${main.base}/api/offices/${id}/members/${admins[0].user.id}`, json({ role: 'member' }, 'PATCH'))).status).toBe(200);
    await until(() => adminsIn[0].removed.length > 0);
    expect(adminsIn[0].removed).toEqual(['locked']);
    // Adding people says what to do about it.
    expect(await read(addPerson(main, owner, id, `late.${people}@example.com`))).toEqual({ error: 'This workspace is paused. Pay in Billing to add people.', code: 'locked' });
    expect(await read(addPerson(main, admins[1], id, `late.${people}@example.com`))).toEqual({ error: 'This workspace is paused until its owner pays for it.', code: 'locked' });
  });
});

describe('the launch', () => {
  it('gives the workspaces there were 30 days to choose a plan, once', async () => {
    const db = await freshDb();
    // Before billing: two teams and a support workspace.
    const before = await start(db, { secretKey: null });
    const owner = await person(before, 'Lou');
    const big = await team(before, owner);
    await staff(before, owner, big, 4);
    const smallTeam = await team(before, owner);
    const { link } = await read<{ link: string }>(owner.jar.fetch(`${before.base}/api/offices/${smallTeam}/access`, json({ guests: 'link' }, 'PUT')));
    const guest = link.slice(link.indexOf('#guest=') + 7);
    const desk = await support(before, owner);
    await stop(before);

    const launched = clock;
    let on = await start(db);
    const rows = async () =>
      (await db.query<{ office_id: string; status: string; grace_reason: string; grace_ends_at: Date }>('SELECT office_id, status, grace_reason, grace_ends_at FROM billing_accounts ORDER BY office_id')).rows;
    expect(await rows()).toEqual(
      [big, desk.id].sort().map((id) => ({ office_id: id, status: 'past_due', grace_reason: 'launch', grace_ends_at: new Date(launched + LAUNCH_DAYS * DAY) })),
    );
    expect(await view(on, owner, big)).toMatchObject({ plan: 'team', status: 'past_due', graceReason: 'launch' });
    expect(await view(on, owner, smallTeam)).toMatchObject({ plan: 'free' });
    // The small team keeps its guests while the others choose.
    for (let i = 0; i < 4; i++) expect((await enter(on, smallTeam, { guest, ip: nextIp() })).res.ok).toBe(true);
    // Customers keep coming in meanwhile.
    expect((await enter(on, desk.id, { guest: desk.guest, ip: nextIp() })).res.ok).toBe(true);
    for (const s of sockets.splice(0)) s.disconnect();

    // Starting again changes nothing.
    await stop(on);
    clock += DAY;
    on = await start(db);
    expect((await db.query<{ launched_at: Date }>('SELECT launched_at FROM billing_launch')).rows[0].launched_at).toEqual(new Date(launched));
    expect((await db.query("SELECT 1 FROM billing_log WHERE action = 'launch'")).rowCount).toBe(2);

    await tick(on);
    expect(sent.filter((m) => m.to === owner.email && m.subject.startsWith('Choose a plan'))).toHaveLength(2);
    clock = launched + LAUNCH_DAYS * DAY + MINUTE;
    await tick(on);
    expect((await rows()).map((r) => r.status)).toEqual(['locked', 'locked']);
    for (let i = 0; i < 3; i++) expect((await enter(on, smallTeam, { guest, ip: nextIp() })).res.ok).toBe(true);
    expect((await enter(on, smallTeam, { guest, ip: nextIp() })).res).toMatchObject({ ok: false, error: 'This office is full.' });
    expect((await enter(on, desk.id, { guest: desk.guest, ip: nextIp() })).res).toMatchObject({ ok: false, reason: 'locked' });
    await stop(on);
  }, 60_000);
});

describe('the scheduler’s tick', () => {
  it('needs the secret', async () => {
    expect((await tick(main, null)).status).toBe(404);
    expect((await tick(main, 'x'.repeat(40))).status).toBe(404);
    expect(await read(tick(main))).toEqual({
      reconciled: expect.any(Number),
      renewed: expect.any(Number),
      failed: expect.any(Number),
      locked: expect.any(Number),
      freed: expect.any(Number),
      refunded: expect.any(Number),
      mailed: expect.any(Number),
    });
  });

  it('is off without a secret set', async () => {
    const other = await start(await freshDb(), { internalToken: null });
    try {
      expect((await tick(other)).status).toBe(404);
    } finally {
      await stop(other);
    }
  }, 60_000);

  it('checks saved cards’ charges first, and a checkout left unpaid only twice', async () => {
    const run = await start(await freshDb());
    try {
      const owner = await person(run, 'Rec');
      const id = await team(run, owner);
      await subscribe(run, owner, id, 4);
      // More checkouts left on Paystack's page than one run checks.
      for (let i = 0; i < 6; i++) {
        const spammer = await person(run, 'Spa');
        const office = await team(run, spammer);
        for (let j = 0; j < 10; j++) await checkout(run, spammer, office, 1);
      }
      clock += MINUTE;
      mock.nextChargesFor.set(owner.email, ['hang']);
      expect((await api(run, owner, `/offices/${id}/billing/seats`, { seats: 5 })).status).toBe(502);
      const verifies = () => mock.calls('/transaction/verify').length;
      const before = verifies();
      clock += 16 * MINUTE;
      await tick(run);
      expect((await account(run, id)).seats).toBe(5);
      expect(verifies() - before).toBe(50);
      clock += HOUR;
      await tick(run);
      expect(verifies() - before).toBe(61);
      clock += HOUR;
      await tick(run);
      expect(verifies() - before).toBe(61);
      // A day on, each is checked again and given up.
      clock += DAY;
      await tick(run);
      await tick(run);
      expect(verifies() - before).toBe(121);
      expect((await run.db.query("SELECT status, count(*)::int AS n FROM billing_charges WHERE purpose = 'subscribe' GROUP BY status ORDER BY status")).rows).toEqual([
        { status: 'abandoned', n: 60 },
        { status: 'succeeded', n: 1 },
      ]);
    } finally {
      await stop(run);
    }
  }, 60_000);

  it('runs on its own a minute after the server starts, then hourly', async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const intervals = vi.spyOn(globalThis, 'setInterval');
    let run: Running;
    let calls: { timeouts: unknown[][]; intervals: unknown[][] };
    try {
      run = await start(await freshDb(), { schedule: undefined });
    } finally {
      calls = { timeouts: [...timeouts.mock.calls], intervals: [...intervals.mock.calls] };
      timeouts.mockRestore();
      intervals.mockRestore();
    }
    try {
      // The same run, a minute after starting and every hour.
      const hourly = calls.intervals.filter(([, every]) => every === HOUR).map(([fn]) => fn);
      const scheduled = calls.timeouts.find(([fn, after]) => after === MINUTE && hourly.includes(fn))?.[0];
      expect(scheduled).toBeTypeOf('function');
      const owner = await person(run, 'Hou');
      const id = await team(run, owner);
      await subscribe(run, owner, id, 1);
      clock = ms((await account(run, id)).period_end)! + MINUTE;
      (scheduled as () => void)();
      await until(async () => ms((await account(run, id)).period_start) === clock - MINUTE);
      expect(mock.calls('/transaction/charge_authorization').filter((c) => c.body.email === owner.email)).toHaveLength(1);
    } finally {
      await stop(run);
    }
  }, 60_000);

  it('started by the tick is finished before the server closes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'workchop-billing-close-'));
    // The server opens its own database (PGlite in `dir`), and closes it.
    const slow: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/transaction/charge_authorization')) await new Promise((r) => setTimeout(r, 800));
      return fetch(input, init);
    };
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      quiet: true,
      iceServers: [],
      publicUrl: ORIGIN,
      auth: { google: null, apple: null, devLogin: true },
      mailer: recorder,
      features: [billingFeature({ secretKey: mock.secretKey, apiBase: mock.apiBase, now: () => clock, schedule: () => () => {}, internalToken: TOKEN, fetch: slow })],
    });
    try {
      const run: Running = { server, base: `http://127.0.0.1:${server.port}`, db: server.db, accounts: new Accounts(server.db), sessions: new Sessions(server.db) };
      const owner = await person(run, 'Clo');
      const id = await team(run, owner);
      await subscribe(run, owner, id, 1);
      const end = ms((await account(run, id)).period_end)!;
      clock = end + MINUTE;
      void tick(run).catch(() => {});
      await until(async () => (await run.db.query("SELECT 1 FROM billing_charges WHERE purpose = 'renewal'")).rowCount > 0);
      await server.close();
      const db = await openPGlite(path.join(dir, 'db'));
      try {
        expect((await db.query<{ status: string }>("SELECT status FROM billing_charges WHERE purpose = 'renewal'")).rows).toEqual([{ status: 'succeeded' }]);
        expect((await db.query<{ period_start: Date }>('SELECT period_start FROM billing_accounts')).rows.map((r) => ms(r.period_start))).toEqual([end]);
      } finally {
        await db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('complimentary workspaces', () => {
  it('have no limits and never lock', async () => {
    const owner = await person(main, 'Com');
    const id = await team(main, owner);
    await main.db.query("INSERT INTO billing_accounts (office_id, status, comp) VALUES ($1, 'free', true) ON CONFLICT (office_id) DO UPDATE SET comp = true", [id]);
    await staff(main, owner, id, 5);
    const { link } = await read<{ link: string }>(owner.jar.fetch(`${main.base}/api/offices/${id}/access`, json({ guests: 'link' }, 'PUT')));
    const guest = link.slice(link.indexOf('#guest=') + 7);
    for (let i = 0; i < 5; i++) expect((await enter(main, id, { guest, ip: nextIp() })).res.ok).toBe(true);
    expect(await view(main, owner, id)).toMatchObject({ plan: 'comp', seats: null });
    expect(await read(api(main, owner, `/offices/${id}/billing/checkout`, { seats: 6 }))).toMatchObject({ error: 'This workspace is free of charge.' });
    clock += 400 * DAY;
    await tick(main);
    expect(await account(main, id)).toMatchObject({ status: 'free' });
  });
});

describe('limits', () => {
  it('on checkouts', async () => {
    const owner = await person(main, 'Lim');
    const id = await team(main, owner);
    for (let i = 0; i < 10; i++) await checkout(main, owner, id, 1);
    expect((await api(main, owner, `/offices/${id}/billing/checkout`, { seats: 1 })).status).toBe(429);
  });
});
