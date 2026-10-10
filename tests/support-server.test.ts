import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR } from '../shared/avatar';
import { seatsOf } from '../shared/catalog';
import type { UploadedFile } from '../shared/uploads';
import {
  CUSTOMER_SEAT,
  deskLabels,
  MAX_CUSTOMERS_PER_ADDRESS,
  MAX_HELPERS,
  OFFER_MS,
  ticketConv,
  type EnterRequest,
  type MyTicket,
  type OfferKind,
  type TicketOffer,
} from '../shared/support';
import type { JoinRequest, JoinResponse, ServerToClientEvents } from '../shared/types';
import type { MembersAnswer } from '../shared/workspace';
import { isLightOn } from '../shared/world';
import { feature as audio } from '../server/features/audio';
import { chatFeature } from '../server/features/chat';
import { feature as presence } from '../server/features/presence';
import { CUSTOMER_UPLOAD_BYTES, OPEN_TICKETS_PER_ADDRESS, supportFeature, TICKETS_PER_ADDRESS, type SupportOptions } from '../server/features/support';
import { feature as world } from '../server/features/world';
import { startServer, type ServerOptions } from '../server/index';
import { MAX_GUESTS_PER_ROOM } from '../server/realtime';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, json, member, signIn, until, type Client } from './helpers/http';

type Server = Awaited<ReturnType<typeof startServer>>;
interface Running {
  server: Server;
  base: string;
}

let dataDir: string;
let main: Running;
const running = new Set<Server>();
const extra: Client[] = [];

/** A server with chat, world, audio, presence and support (`support` changes its timings). */
async function start(support: SupportOptions = {}, more: Partial<ServerOptions> = {}): Promise<Running> {
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    db: await createTestDb(),
    dataDir,
    quiet: true,
    iceServers: [],
    features: [chatFeature({ retentionDays: 30, sweepEveryMs: 0 }), world, audio, presence, supportFeature(support)],
    uploads: { storage: 'fs', maxBytes: 100_000 },
    auth: { google: null, apple: null, devLogin: true },
    clientIpHeader: 'x-test-ip',
    ...more,
  });
  running.add(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

async function stop({ server }: Running) {
  running.delete(server);
  await server.close();
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-support-'));
  main = await start();
}, 60_000);

afterAll(async () => {
  disconnectAll();
  for (const s of extra) s.disconnect();
  for (const server of running) await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Result = { ok: true } | { ok: false; error: string };
function ok<T extends Result>(res: T): Extract<T, { ok: true }> {
  if (!res.ok) throw new Error((res as { error: string }).error);
  return res as Extract<T, { ok: true }>;
}
function failed(res: Result): string {
  if (res.ok) throw new Error('expected a refusal');
  return res.error;
}

/** Everything a socket hears of one event, from now on. */
function heard<E extends keyof ServerToClientEvents>(socket: Client, event: E): Parameters<ServerToClientEvents[E]>[] {
  const got: Parameters<ServerToClientEvents[E]>[] = [];
  socket.on(event, ((...args: Parameters<ServerToClientEvents[E]>) => got.push(args)) as never);
  return got;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = () => crypto.randomBytes(24).toString('base64url');

interface SupportOffice {
  id: string;
  owner: Jar;
  /** The customer link's token. */
  guest: string;
  /** Help desks' item ids, Desk 1 first. */
  desks: string[];
}

/** A support workspace made as people do, through the API. */
async function supportOffice({ server, base }: Running, owner: Jar | string = 'Olive'): Promise<SupportOffice> {
  const jar = typeof owner === 'string' ? await signIn(base, owner) : owner;
  const made = await jar.fetch(`${base}/api/offices`, json({ name: 'Help Desk', kind: 'support', template: 'support' }));
  expect(made.status).toBe(201);
  const { id } = (await made.json()) as { id: string };
  const { access } = (await (await jar.fetch(`${base}/api/offices/${id}/members`)).json()) as MembersAnswer;
  const link = access!.link!;
  const stored = await server.store.get(id);
  return { id, owner: jar, guest: link.slice(link.indexOf('#guest=') + 7), desks: [...deskLabels(stored!.office.items).keys()] };
}

let addresses = 0;
/** A new visitor's address (a workspace takes only a few customers from each). */
const nextIp = () => `10.${(++addresses >> 8) & 255}.${addresses & 255}.7`;

/** Someone with the customer link, from `ip` (a new address unless given). */
const customer = ({ base }: Running, office: SupportOffice, opts: { ip?: string; jar?: Jar; request?: Partial<JoinRequest> } = {}) =>
  join(base, office.id, 'Whoever', { guest: office.guest, jar: opts.jar, headers: { 'x-test-ip': opts.ip ?? nextIp() }, request: opts.request });

/** A new member of the workspace (staff), in it. */
async function staff(run: Running, office: SupportOffice, name: string) {
  const jar = await member(run.base, run.server.db, office.id, name);
  return { ...(await join(run.base, office.id, name, { jar, guest: '' })), jar };
}

type Joined = Awaited<ReturnType<typeof join>>;
const enter = (c: Joined, req: Partial<EnterRequest> = {}) => c.socket.emitWithAck('support:enter', { name: 'Alice Smith', message: 'My order is late', key: newKey(), ...req });
const state = (c: Joined) => c.socket.emitWithAck('support:state');
const asStaff = async (c: Joined) => {
  const s = await state(c);
  if (s.as !== 'staff') throw new Error(`expected staff, got ${s.as}`);
  return s;
};
const asCustomer = async (c: Joined) => {
  const s = await state(c);
  if (s.as !== 'customer') throw new Error(`expected a customer, got ${s.as}`);
  return s;
};
const nameOf = ({ server }: Running, officeId: string, c: Joined) => server.realtime.players(officeId).find((p) => p.id === c.socket.id)?.name;
const itemOf = ({ server }: Running, officeId: string, id: string) => server.store.peek(officeId)!.office.items.find((i) => i.id === id)!;
const ticketRow = async (id: string, run: Running = main) =>
  (
    await run.server.db.query<{ status: string; assignee_user_id: string | null; assigned_at: Date | null; desk_item_id: string | null }>(
      'SELECT status, assignee_user_id, assigned_at, desk_item_id FROM support_tickets WHERE id = $1',
      [id],
    )
  ).rows[0];
/** A staff member's account id. */
const uid = (p: Joined) => (p.res.ok ? p.res.players.find((x) => x.id === p.socket.id)?.userId : undefined) ?? '';
/** Whether two people are in a call. */
const linkedIn = ({ server }: Running, officeId: string) => (p: Joined, q: Joined) => server.realtime.linkedPeers(officeId, p.socket.id!).includes(q.socket.id!);
const offer = (p: Joined, kind: OfferKind, to: string) => p.socket.emitWithAck('support:offer', { kind, to });
const reply = (p: Joined, o: TicketOffer, accept: boolean) => p.socket.emitWithAck('support:offer:answer', o.id, accept);
/** The last support:queue a staff member heard (heard() from before), without asking support:state over and over. */
const lastQueue = (queues: Parameters<ServerToClientEvents['support:queue']>[]) => queues.at(-1)?.[0];
/** A ticket's history lines as stored. */
const eventRows = async (ticketId: string, run: Running = main) =>
  (await run.server.db.query<{ kind: string; actor_user_id: string | null; other_user_id: string | null }>('SELECT kind, actor_user_id, other_user_id FROM support_ticket_events WHERE ticket_id = $1 ORDER BY id', [ticketId])).rows;

describe('customers', () => {
  it('come in with the customer link, without an account, as visitors', async () => {
    const office = await supportOffice(main);
    const info = await (await fetch(`${main.base}/api/offices/${office.id}`, { headers: { 'X-Workchop-Guest': office.guest } })).json();
    expect(info).toMatchObject({ kind: 'support', role: 'guest' });
    const ana = await customer(main, office);
    expect(ana.res).toMatchObject({ ok: true, role: 'guest', kind: 'support', guests: 'link' });
    // Others see a visitor, whatever name they send.
    expect(nameOf(main, office.id, ana)).toBe('Visitor');
    ana.socket.emit('profile', { name: 'Not a visitor' });
    expect(await asCustomer(ana)).toEqual({ as: 'customer', ticket: null, board: { serving: [], waiting: 0 } });
    expect(nameOf(main, office.id, ana)).toBe('Visitor');
    // Signed in with the customer link: still a visitor, also after a rename in Profile.
    const samJar = await signIn(main.base, 'Sam Signed');
    const sam = await customer(main, office, { jar: samJar });
    expect(sam.res).toMatchObject({ role: 'guest' });
    expect(nameOf(main, office.id, sam)).toBe('Visitor');
    await samJar.fetch(`${main.base}/api/me`, json({ name: 'Sam Renamed' }, 'PATCH'));
    await wait(100);
    expect(nameOf(main, office.id, sam)).toBe('Visitor');

    // Opening a ticket: checked, then numbered, and shown as "Visitor #1".
    expect(failed(await enter(ana, { key: 'short' }))).toBe('Reload the page and try again.');
    expect(failed(await enter(ana, { message: '  ' }))).toBe('How can we help? Write a message first.');
    expect(failed(await enter(ana, { name: '' }))).toBe('Tell us your name.');
    expect(failed(await enter(ana, { email: 'not an email' }))).toBe('Check your email address.');
    // Nothing that would change a mailto: link.
    expect(failed(await enter(ana, { email: 'a?cc=everyone@example.com' }))).toBe('Check your email address.');
    const { ticket } = ok(await enter(ana, { email: ' Alice@Example.com ' }));
    expect(ticket).toEqual({ id: expect.any(String), number: 1, status: 'waiting', ahead: 0, agent: null, rating: null, helpers: [] });
    await until(() => nameOf(main, office.id, ana) === 'Visitor #1');

    // Staff see the real name, the email and the first message, which also starts the ticket's chat.
    const olive = await join(main.base, office.id, 'Olive', { jar: office.owner, guest: '' });
    // Everyone can tell customers apart, signed in or not.
    const players = olive.res.ok ? olive.res.players : [];
    expect(players.map((p) => [p.id, p.customer ?? false])).toEqual([
      [ana.socket.id, true],
      [sam.socket.id, true],
      [olive.socket.id, false],
    ]);
    // Without their account (nor its character, which isn't set from the customer lobby either).
    expect(players.find((p) => p.id === sam.socket.id)?.userId).toBeUndefined();
    expect(((await (await samJar.fetch(`${main.base}/api/me`)).json()) as { user: { profile: { avatar?: unknown } } }).user.profile.avatar).toBeUndefined();
    const { queue, board } = await asStaff(olive);
    expect(board).toEqual({ serving: [], waiting: 1 });
    expect(queue).toEqual({
      waiting: [
        expect.objectContaining({
          id: ticket.id,
          number: 1,
          status: 'waiting',
          customerName: 'Alice Smith',
          customerEmail: 'alice@example.com',
          firstMessage: 'My order is late',
          playerId: ana.socket.id,
          present: true,
          assignee: null,
          helpers: [],
        }),
      ],
      desks: [],
      mine: null,
      helping: null,
      colleagues: [],
      offers: { outgoing: null, incoming: null },
    });
    const history = ok(await olive.socket.emitWithAck('chat:history', { conv: ticketConv(ticket.id) }));
    // In the ticket's chat the customer writes under their own name (only staff and they see it).
    expect(history.messages.map((m) => [m.name, m.text, m.conv, m.userId])).toEqual([['Alice Smith', 'My order is late', ticketConv(ticket.id), null]]);

    // Each side has its own requests.
    expect(failed(await enter(olive))).toBe('Only customers can do that.');
    expect(failed(await ana.socket.emitWithAck('support:next'))).toBe('Only staff can do that.');
    expect(failed(await ana.socket.emitWithAck('support:history', {}))).toBe('Only staff can do that.');
    // Elsewhere there's no support.
    const team = await createOffice(main.base, office.owner);
    expect(await state(await join(main.base, team.id, 'Olive', { jar: office.owner }))).toEqual({ as: 'none' });
  });

  it('see their place in the queue, which they keep while they step away', async () => {
    const office = await supportOffice(main);
    const olive = await join(main.base, office.id, 'Olive', { jar: office.owner, guest: '' });
    const queues = heard(olive.socket, 'support:queue');
    const people = [await customer(main, office), await customer(main, office), await customer(main, office)];
    const tickets: MyTicket[] = [];
    for (const c of people) tickets.push(ok(await enter(c)).ticket);
    expect(tickets.map((t) => [t.number, t.ahead])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    const third = heard(people[2].socket, 'support:ticket');
    const boards = heard(people[2].socket, 'support:board');

    // #2 steps away: still in the queue (shown as away to staff), so #3 doesn't move up.
    people[1].socket.disconnect();
    await until(() => queues.at(-1)?.[0].waiting.find((t) => t.number === 2)?.present === false);
    expect(queues.at(-1)![0].waiting.map((t) => [t.number, t.present])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect((await asCustomer(people[2])).ticket?.ahead).toBe(2);

    // #1 gives up: everyone behind moves up.
    const first = heard(people[0].socket, 'support:ticket');
    ok(await people[0].socket.emitWithAck('support:leave-queue'));
    await until(() => third.at(-1)?.[0]?.ahead === 1 && boards.at(-1)?.[0].waiting === 2 && first.length > 0);
    expect(first.at(-1)![0]).toMatchObject({ number: 1, status: 'abandoned', ahead: null });
    expect(failed(await people[0].socket.emitWithAck('support:leave-queue'))).toBe('You’re not in the queue.');
  });

  it('come only a few from one address, open one ticket per connection, and only so many in all', { timeout: 60_000 }, async () => {
    const office = await supportOffice(main);
    const here = () => main.server.realtime.players(office.id).length;
    const ip = nextIp();
    const three = [];
    for (let i = 0; i < MAX_CUSTOMERS_PER_ADDRESS; i++) three.push(await customer(main, office, { ip }));
    await expect(customer(main, office, { ip })).rejects.toThrow('There are a few visitors from your network here already. Please try again later.');
    // Many requests at once, each with a new key: one ticket per connection.
    const answers = await Promise.all(three.flatMap((c) => Array.from({ length: 8 }, () => enter(c))));
    expect(answers.filter((a) => a.ok)).toHaveLength(3);
    for (const a of answers) if (!a.ok) expect(['One moment…', 'You already have a ticket open.']).toContain(a.error);
    const count = async () => (await main.server.db.query<{ n: number }>('SELECT count(*)::int AS n FROM support_tickets WHERE office_id = $1', [office.id])).rows[0].n;
    expect(await count()).toBe(3);

    // Leaving keeps a ticket open (their place): an address has ten open at most.
    for (const c of three) c.socket.disconnect();
    await until(() => here() === 0);
    for (let i = 3; i < OPEN_TICKETS_PER_ADDRESS; i++) {
      const c = await customer(main, office, { ip });
      ok(await enter(c));
      c.socket.disconnect();
      await until(() => here() === 0);
    }
    const eleventh = await customer(main, office, { ip });
    expect(failed(await enter(eleventh))).toBe('There are a lot of open tickets from your network. Try again later.');

    // And 30 new tickets an hour (customers behind one network's address may share it).
    const shared = nextIp();
    for (let i = 0; i < TICKETS_PER_ADDRESS; i++) {
      const c = await customer(main, office, { ip: shared });
      ok(await enter(c));
      ok(await c.socket.emitWithAck('support:leave-queue'));
      c.socket.disconnect();
      await until(() => !main.server.realtime.players(office.id).some((p) => p.id === c.socket.id));
    }
    expect(failed(await enter(await customer(main, office, { ip: shared })))).toBe('You’ve opened a lot of tickets. Try again later.');
    ok(await enter(await customer(main, office)));
    for (const s of main.server.realtime.players(office.id)) main.server.io.sockets.sockets.get(s.id)?.disconnect();
    await until(() => here() === 0);
  });

  it('fill only the guests’ places', { timeout: 30_000 }, async () => {
    const office = await supportOffice(main);
    // Customers are guests: 90 at most, so staff can always come in.
    const visitor = async () => {
      const socket: Client = connect(main.base, { transports: ['websocket'], forceNew: true, extraHeaders: { 'x-test-ip': nextIp() } });
      extra.push(socket);
      const res = await new Promise<JoinResponse>((resolve) =>
        socket.on('connect', () => socket.emit('join', { officeId: office.id, name: 'Guest', avatar: DEFAULT_AVATAR, guest: office.guest }, resolve)),
      );
      return { socket, res };
    };
    const crowd: Client[] = [];
    for (let i = 0; i < MAX_GUESTS_PER_ROOM / 10; i++) {
      for (const v of await Promise.all(Array.from({ length: 10 }, visitor))) {
        expect(v.res.ok).toBe(true);
        crowd.push(v.socket);
      }
    }
    expect((await visitor()).res).toEqual({ ok: false, error: 'This office is full.' });
    expect((await join(main.base, office.id, 'Olive', { jar: office.owner, guest: '' })).res.ok).toBe(true);
    for (const s of crowd) s.disconnect();
  });
});

describe('agents', () => {
  it('call the next customer here to their desk, one each, even when they press Next at once', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const max = await staff(main, office, 'Max');
    const [desk1, desk2] = office.desks;

    expect(failed(await mia.socket.emitWithAck('support:next'))).toBe('Take a desk first.');
    ok(await mia.socket.emitWithAck('support:desk', desk2));
    // Moving to another desk, then one that's taken, or isn't a desk.
    ok(await mia.socket.emitWithAck('support:desk', desk1));
    expect(failed(await max.socket.emitWithAck('support:desk', desk1))).toBe('Mia is at this desk.');
    expect(failed(await max.socket.emitWithAck('support:desk', 'nope'))).toBe('That desk is gone.');
    ok(await max.socket.emitWithAck('support:desk', desk2));
    expect(failed(await mia.socket.emitWithAck('support:next'))).toBe('Nobody is waiting.');

    // Three customers; the first steps away and is skipped (keeping their place).
    const away = await customer(main, office);
    const awayTicket = ok(await enter(away)).ticket;
    away.socket.disconnect();
    const a = await customer(main, office);
    const b = await customer(main, office);
    ok(await enter(a));
    ok(await enter(b));
    const summons = [heard(a.socket, 'support:summon'), heard(b.socket, 'support:summon')];
    const [x, y] = await Promise.all([mia.socket.emitWithAck('support:next'), max.socket.emitWithAck('support:next')]);
    const called = [ok(x).ticket, ok(y).ticket];
    expect(called.map((t) => t.number).sort()).toEqual([2, 3]);
    expect(called.map((t) => [t.status, t.assignee?.name])).toEqual([
      ['active', 'Mia'],
      ['active', 'Max'],
    ]);
    expect(failed(await mia.socket.emitWithAck('support:next'))).toBe('Resolve your ticket first.');
    expect(failed(await mia.socket.emitWithAck('support:desk', null))).toBe('Resolve your ticket first.');
    expect(failed(await mia.socket.emitWithAck('support:desk', office.desks[2]))).toBe('Resolve your ticket first.');

    // Each customer is called to the customer seat of their agent's desk.
    await until(() => summons.every((s) => s.length === 1));
    for (const [i, c] of [a, b].entries()) {
      const [summon] = summons[i][0];
      const t = called.find((ct) => ct.id === summon.ticketId)!;
      expect(t.playerId).toBe(c.socket.id);
      const desk = t.assignee?.name === 'Mia' ? desk1 : desk2;
      expect(summon).toEqual({ ticketId: t.id, deskItemId: desk, seat: seatsOf(itemOf(main, office.id, desk))[CUSTOMER_SEAT], agentName: t.assignee?.name });
      const mine = (await asCustomer(c)).ticket;
      expect(mine).toEqual({
        id: t.id,
        number: t.number,
        status: 'active',
        ahead: null,
        agent: { name: t.assignee?.name, playerId: desk === desk1 ? mia.socket.id : max.socket.id, deskItemId: desk, desk: desk === desk1 ? 'Desk 1' : 'Desk 2' },
        rating: null,
        helpers: [],
      });
    }

    // The Now serving screen, and what each agent sees.
    const miaState = await asStaff(mia);
    expect(miaState.board.waiting).toBe(1);
    expect(miaState.board.serving.map((s) => s.desk)).toEqual(['Desk 1', 'Desk 2']);
    expect(miaState.queue.mine?.assignee?.name).toBe('Mia');
    expect(miaState.queue.waiting.map((t) => [t.id, t.present])).toEqual([[awayTicket.id, false]]);
    expect(miaState.queue.desks.map((d) => [d.label, d.name, d.playerId, !!d.ticketId])).toEqual([
      ['Desk 1', 'Mia', mia.socket.id, true],
      ['Desk 2', 'Max', max.socket.id, true],
    ]);
    // With only an away customer left, there's nobody to call.
    expect(await mia.socket.emitWithAck('support:resolve')).toEqual({ ok: true });
    expect(failed(await mia.socket.emitWithAck('support:resolve'))).toBe('You’re not serving anyone.');
    expect(failed(await mia.socket.emitWithAck('support:next'))).toBe('Nobody waiting is here right now.');
    ok(await mia.socket.emitWithAck('support:desk', null));
    expect((await asStaff(mia)).queue.desks.map((d) => d.name)).toEqual(['Max']);
  });

  it('are in a call with their customer wherever they are; customers with nobody else', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const max = await staff(main, office, 'Max');
    const a = await customer(main, office);
    const b = await customer(main, office);
    const linked = (p: Joined, q: Joined) => main.server.realtime.linkedPeers(office.id, p.socket.id!).includes(q.socket.id!);
    const calls = heard(a.socket, 'peer:connect');
    // The two agents together in one corner, the customers next to each other in another.
    mia.socket.emit('move', 6, 30, 0, 'idle');
    max.socket.emit('move', 6.5, 30, 0, 'idle');
    a.socket.emit('move', 30, 30, 0, 'idle');
    b.socket.emit('move', 30.5, 30, 0, 'idle');
    await until(() => linked(mia, max));
    // A customer next to an agent who isn't serving them: still no call.
    max.socket.emit('move', 31, 30, 0, 'idle');
    await until(() => !linked(mia, max));
    expect([linked(max, a), linked(max, b), linked(a, b)]).toEqual([false, false, false]);
    max.socket.emit('move', 6.5, 30, 0, 'idle');
    await until(() => linked(mia, max));

    // Called: far apart, but in a call; and the serving agent leaves the other staff's call.
    const ticket = ok(await enter(a)).ticket;
    ok(await enter(b));
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    expect(ok(await mia.socket.emitWithAck('support:next')).ticket.id).toBe(ticket.id);
    await until(() => linked(mia, a) && !linked(mia, max));
    expect(calls.map(([peer]) => peer)).toEqual([mia.socket.id]);
    expect(linked(a, b) || linked(max, a) || linked(max, b) || linked(mia, b)).toBe(false);

    // Resolved: the call ends, and the agent is back with the others.
    ok(await mia.socket.emitWithAck('support:resolve'));
    await until(() => !linked(mia, a) && linked(mia, max));
  });
});

describe('ticket chat', () => {
  it('is read by all staff, written by the customer while it’s open and by the agent serving it', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const max = await staff(main, office, 'Max');
    const a = await customer(main, office);
    const b = await customer(main, office);
    const key = newKey();
    const ticket = ok(await enter(a, { key })).ticket;
    ok(await enter(b));
    const conv = ticketConv(ticket.id);
    const send = (p: Joined, text: string, attachments?: { id: string }[]) => p.socket.emitWithAck('chat:send', { conv, text, attachments });
    const got = new Map([mia, max, a, b].map((p) => [p.socket.id, heard(p.socket, 'chat:message')]));

    // Waiting: the customer writes; staff read but don't write yet; other customers see nothing.
    const hello = ok(await send(a, 'Still there?')).message;
    expect(hello).toMatchObject({ conv, name: 'Alice Smith', userId: null, channelId: null, dm: null });
    expect(failed(await send(mia, 'Hi!'))).toBe('Only the people helping with this ticket can write here.');
    expect(failed(await send(b, 'Let me in'))).toBe('That conversation doesn’t exist.');
    expect(failed(await b.socket.emitWithAck('chat:history', { conv }))).toBe('That conversation doesn’t exist.');
    expect(failed(await b.socket.emitWithAck('chat:react', hello.id, '👍'))).toBe('That message no longer exists.');
    await until(() => [mia, max, a].every((p) => got.get(p.socket.id)!.some(([m]) => m.id === hello.id)));
    await wait(50);
    expect(got.get(b.socket.id)).toEqual([]);

    // Called by Mia: she writes, Max still only reads.
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    const reply = ok(await send(mia, 'Hi, I’m Mia. Let me check.')).message;
    expect(reply).toMatchObject({ conv, name: 'Mia' });
    expect(failed(await send(max, 'Me too'))).toBe('Only the people helping with this ticket can write here.');
    ok(await a.socket.emitWithAck('chat:react', reply.id, '🙏'));
    expect(failed(await max.socket.emitWithAck('chat:react', reply.id, '👍'))).toBe('Only the people helping with this ticket can write here.');

    // Files too.
    const uploadKey = a.res.ok ? a.res.uploadKey : '';
    const file = await fetch(`${main.base}/api/offices/${office.id}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Filename': 'receipt.png', 'X-Workchop-Socket': a.socket.id!, 'X-Workchop-Upload-Key': uploadKey },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(file.status).toBe(201);
    const upload = (await file.json()) as UploadedFile;
    expect(ok(await send(a, 'Here’s the receipt', [{ id: upload.id }])).message.attachments.map((f) => f.name)).toEqual(['receipt.png']);

    // Back after a reload (a new connection): their earlier messages are still theirs.
    a.socket.disconnect();
    const back = await customer(main, office);
    expect(ok(await back.socket.emitWithAck('support:enter', { key, name: '', message: '' })).ticket.id).toBe(ticket.id);
    expect(ok(await back.socket.emitWithAck('chat:edit', hello.id, 'Still there? (edited)')).message.text).toBe('Still there? (edited)');
    expect(failed(await mia.socket.emitWithAck('chat:edit', hello.id, 'nope'))).toBe('You can only edit your own messages.');

    // Resolved: the customer still reads it, but nobody writes any more.
    ok(await mia.socket.emitWithAck('support:resolve'));
    await until(async () => (await asCustomer(back)).ticket?.status === 'resolved');
    const page = ok(await back.socket.emitWithAck('chat:history', { conv }));
    expect(page.messages.map((m) => m.text)).toEqual(['My order is late', 'Still there? (edited)', 'Hi, I’m Mia. Let me check.', 'Here’s the receipt']);
    expect(failed(await send(back, 'One more thing'))).toBe('This ticket is closed.');
    expect(failed(await send(mia, 'Bye'))).toBe('This ticket is closed.');
  });

  it('ends with a rating, and another question starts a new ticket; staff search the history', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const a = await customer(main, office);
    const key = newKey();
    const first = ok(await enter(a, { key, name: 'Bea Searchable', email: 'bea@example.com' })).ticket;
    expect(failed(await a.socket.emitWithAck('support:rate', 5))).toBe('There’s nothing to rate yet.');
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    ok(await mia.socket.emitWithAck('support:resolve'));
    const mine = heard(a.socket, 'support:ticket');
    expect(failed(await a.socket.emitWithAck('support:rate', 6))).toBe('Pick 1 to 5 stars.');
    ok(await a.socket.emitWithAck('support:rate', 4));
    await until(() => mine.at(-1)?.[0]?.rating === 4);
    expect(mine.at(-1)![0]).toMatchObject({ id: first.id, status: 'resolved', rating: 4 });
    expect(failed(await a.socket.emitWithAck('support:rate', 1))).toBe('You’ve rated it already. Thanks!');
    // Another question: a new ticket with the same key.
    const second = ok(await enter(a, { key, message: 'One more question' })).ticket;
    expect(second).toMatchObject({ number: 2, status: 'waiting' });
    await until(() => nameOf(main, office.id, a) === 'Visitor #2');

    // History: closed tickets, newest first, by name, email or number, 30 at a time.
    const history = (req: { query?: string; before?: number }) => mia.socket.emitWithAck('support:history', req);
    expect(ok(await history({ query: 'searchable' })).tickets.map((t) => [t.number, t.customerName, t.rating, t.assignee?.name])).toEqual([[1, 'Bea Searchable', 4, 'Mia']]);
    expect(ok(await history({ query: 'BEA@example' })).tickets.map((t) => t.number)).toEqual([1]);
    expect(ok(await history({ query: '#1' })).tickets.map((t) => t.number)).toEqual([1]);
    expect(ok(await history({ query: '%' })).tickets).toEqual([]);
    for (let n = 3; n <= 37; n++) {
      await main.server.db.query(
        `INSERT INTO support_tickets (id, office_id, number, status, customer_name, customer_key, customer_address, first_message, closed_at)
         VALUES ($1, $2, $3, 'abandoned', 'Someone', $4, 'somewhere', 'Hi', now())`,
        [`old${String(n).padStart(13, '0')}`, office.id, n, `key${n}`],
      );
    }
    const page1 = ok(await history({}));
    expect([page1.tickets.length, page1.tickets[0].number, page1.tickets.at(-1)!.number, page1.more]).toEqual([30, 37, 8, true]);
    const page2 = ok(await history({ before: 8 }));
    expect([page2.tickets.map((t) => t.number), page2.more]).toEqual([[7, 6, 5, 4, 3, 1], false]);
  });
});

describe('customers can’t', () => {
  it('see channels or people, chat outside their ticket, or change the lights, the music, notes and boards', async () => {
    const office = await supportOffice(main);
    const olive = await join(main.base, office.id, 'Olive', { jar: office.owner, guest: '' });
    const mia = await staff(main, office, 'Mia');
    const a = await customer(main, office);
    ok(await enter(a));

    expect(ok(await a.socket.emitWithAck('chat:channels'))).toEqual({ ok: true, channels: [], dms: [], counts: {} });
    expect(ok(await a.socket.emitWithAck('chat:people')).people).toEqual([]);
    const general = ok(await mia.socket.emitWithAck('chat:channels')).channels.find((c) => c.isDefault)!;
    expect(failed(await a.socket.emitWithAck('chat:send', { conv: `c:${general.id}`, text: 'hi' }))).toBe('That conversation doesn’t exist.');
    expect(failed(await a.socket.emitWithAck('chat:history', { conv: `c:${general.id}` }))).toBe('That conversation doesn’t exist.');
    expect(failed(await a.socket.emitWithAck('chat:send', { conv: 'nearby', text: 'hi' }))).toBe('That conversation doesn’t exist.');
    expect(failed(await a.socket.emitWithAck('chat:send', { conv: `p:${mia.socket.id}`, text: 'hi' }))).toBe('That conversation doesn’t exist.');
    expect(failed(await mia.socket.emitWithAck('chat:send', { conv: `p:${a.socket.id}`, text: 'hi' }))).toBe('Visitors chat in their ticket.');
    expect(failed(await a.socket.emitWithAck('channel:create', { name: 'mine' }))).toBe('Only staff can create channels here.');
    expect(failed(await a.socket.emitWithAck('channel:update', { id: general.id, topic: 'x' }))).toBe('That channel doesn’t exist.');
    // Staff's channels stay among staff.
    const toCustomer = heard(a.socket, 'chat:message');
    const toOlive = heard(olive.socket, 'chat:message');
    const created = heard(a.socket, 'channel:created');
    const loud = ok(await mia.socket.emitWithAck('chat:send', { conv: `c:${general.id}`, text: 'Lunch? <!here>' })).message;
    ok(await mia.socket.emitWithAck('channel:create', { name: 'staff-only' }));
    await until(() => toOlive.some(([m]) => m.id === loud.id));
    await wait(50);
    expect([toCustomer, created]).toEqual([[], []]);
    expect(failed(await a.socket.emitWithAck('chat:react', loud.id, '👍'))).toBe('That message no longer exists.');

    // The world: look, don't touch.
    const items = main.server.store.peek(office.id)!.office.items;
    const lamp = items.find((i) => i.type === 'floor-lamp')!;
    const jukebox = items.find((i) => i.type === 'jukebox')!;
    const board = items.find((i) => i.type === 'info-board')!;
    const notices = heard(a.socket, 'notice');
    a.socket.emit('world:light', lamp.id, false);
    a.socket.emit('music', { t: 'station', itemId: jukebox.id, station: null });
    const sessions = heard(olive.socket, 'spotify:session');
    a.socket.emit('spotify:session', jukebox.id, { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', name: 'Song', artists: 'Band', durationMs: 1000, positionMs: 0, paused: false }, true);
    a.socket.emit('office:op', { t: 'remove', id: lamp.id });
    await until(() => notices.length === 2);
    expect(notices.map(([n]) => n)).toEqual(['Only staff can switch the lights here.', 'Only staff can change the music here.']);
    const now = (id: string) => itemOf(main, office.id, id);
    expect([isLightOn(now(lamp.id)), (now(jukebox.id).data as { station: string | null }).station, sessions]).toEqual([true, 'lofi', []]);
    expect(failed(await a.socket.emitWithAck('desk:note', items.find((i) => i.type === 'support-desk')!.id, { text: 'hi', color: '#ffe066' }))).toBe(
      'Only staff can leave notes here.',
    );
    // Boards are for the owner and admins.
    const text = { title: 'Opening hours', text: 'Mon–Fri, 9 to 5' };
    expect(failed(await a.socket.emitWithAck('world:board', board.id, text))).toBe('Only the owner and admins can edit boards.');
    expect(failed(await mia.socket.emitWithAck('world:board', board.id, text))).toBe('Only the owner and admins can edit boards.');
    const ops = heard(a.socket, 'office:op');
    ok(await olive.socket.emitWithAck('world:board', board.id, { title: '  Opening   hours ', text: 'Mon–Fri, 9 to 5\r\n' }));
    expect(now(board.id).data).toEqual(text);
    await until(() => ops.some(([op]) => op.t === 'update' && op.item.id === board.id));
    expect(failed(await olive.socket.emitWithAck('world:board', lamp.id, text))).toBe('That board is gone.');
    // Staff still switch the lights.
    mia.socket.emit('world:light', lamp.id, false);
    await until(() => !isLightOn(now(lamp.id)));
    expect(now(lamp.id)).toBeTruthy();
  });
});

describe('coming back', () => {
  it('gives customers their ticket back by key, and an agent who reloads their desk and customer', async () => {
    const office = await supportOffice(main);
    let mia = await staff(main, office, 'Mia');
    const key = newKey();
    let a = await customer(main, office);
    const ticket = ok(await enter(a, { key })).ticket;
    ok(await enter(await customer(main, office)));

    // A reload: a new connection, nameless until the ticket is back, in the same place.
    a.socket.disconnect();
    a = await customer(main, office);
    expect(nameOf(main, office.id, a)).toBe('Visitor');
    expect((await asCustomer(a)).ticket).toBeNull();
    expect(failed(await a.socket.emitWithAck('support:enter', { key: newKey(), name: '', message: '' }))).toBe('How can we help? Write a message first.');
    const back = ok(await a.socket.emitWithAck('support:enter', { key, name: 'Someone else', message: 'Something else' })).ticket;
    expect(back).toEqual({ ...ticket, ahead: 0 });
    await until(() => nameOf(main, office.id, a) === `Visitor #${ticket.number}`);

    // Called, then the agent reloads: back at the desk, and in the call again.
    ok(await mia.socket.emitWithAck('support:desk', office.desks[3]));
    ok(await mia.socket.emitWithAck('support:next'));
    const calls = heard(a.socket, 'peer:connect');
    mia.socket.disconnect();
    await until(async () => (await asCustomer(a)).ticket?.agent?.playerId === null);
    const olive = await join(main.base, office.id, 'Olive', { jar: office.owner, guest: '' });
    expect((await asStaff(olive)).queue.desks).toEqual([expect.objectContaining({ name: 'Mia', playerId: null, ticketId: ticket.id })]);
    // Nobody else takes the desk meanwhile.
    expect(failed(await olive.socket.emitWithAck('support:desk', office.desks[3]))).toBe('Mia is at this desk.');
    mia = { ...(await join(main.base, office.id, 'Mia', { jar: mia.jar, guest: '' })), jar: mia.jar };
    await until(() => calls.some(([peer]) => peer === mia.socket.id));
    expect((await asStaff(mia)).queue.mine?.id).toBe(ticket.id);
    expect((await asCustomer(a)).ticket?.agent?.playerId).toBe(mia.socket.id);
  });

  it('survives a restart: the customer gets their ticket back, the agent their desk', { timeout: 60_000 }, async () => {
    const first = await start();
    const office = await supportOffice(first);
    const mia = await staff(first, office, 'Mia');
    const key = newKey();
    const a = await customer(first, office);
    const ticket = ok(await enter(a, { key })).ticket;
    ok(await mia.socket.emitWithAck('support:desk', office.desks[1]));
    ok(await mia.socket.emitWithAck('support:next'));
    a.socket.disconnect();
    mia.socket.disconnect();
    await stop(first);

    const second = await start();
    const a2 = await customer(second, office);
    const calls = heard(a2.socket, 'peer:connect');
    const back = ok(await a2.socket.emitWithAck('support:enter', { key, name: '', message: '' })).ticket;
    expect(back).toMatchObject({ id: ticket.id, status: 'active', agent: { name: 'Mia', playerId: null, desk: 'Desk 2' } });
    const mia2 = await join(second.base, office.id, 'Mia', { jar: mia.jar, guest: '' });
    await until(() => calls.some(([peer]) => peer === mia2.socket.id));
    const { queue } = await asStaff(mia2);
    expect([queue.mine?.id, queue.desks]).toEqual([ticket.id, [expect.objectContaining({ itemId: office.desks[1], playerId: mia2.socket.id, ticketId: ticket.id })]]);
    ok(await mia2.socket.emitWithAck('support:resolve'));
    await stop(second);
  });
});

describe('back on a new connection before the old one is gone', () => {
  // A dropped network: the server keeps the old connection until its heartbeat times out. The page,
  // back on a new one, says which was its own (JoinRequest.resume).
  const linked = (officeId: string, p: Joined, q: Joined) => main.server.realtime.linkedPeers(officeId, p.socket.id!).includes(q.socket.id!);

  it('a customer is served (and heard) on the new one at once, and isn’t counted twice against their network', { timeout: 30_000 }, async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const ip = nextIp();
    const resume = newKey();
    const key = newKey();
    const a1 = await customer(main, office, { ip, request: { resume } });
    const ticket = ok(await enter(a1, { key })).ticket;
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    await until(() => linked(office.id, mia, a1));
    // Two more from the same network fill its places.
    for (let i = 1; i < MAX_CUSTOMERS_PER_ADDRESS; i++) await customer(main, office, { ip });
    await expect(customer(main, office, { ip })).rejects.toThrow('There are a few visitors from your network here already. Please try again later.');

    const a2 = await customer(main, office, { ip, request: { resume } });
    await until(() => a1.socket.disconnected);
    expect(ok(await a2.socket.emitWithAck('support:enter', { key, name: '', message: '' })).ticket).toMatchObject({ id: ticket.id, status: 'active' });
    expect((await asStaff(mia)).queue.mine).toMatchObject({ id: ticket.id, playerId: a2.socket.id });
    await until(() => linked(office.id, mia, a2));
    expect(main.server.realtime.linkedPeers(office.id, mia.socket.id!)).toEqual([a2.socket.id]);
    ok(await mia.socket.emitWithAck('support:resolve'));
  });

  it('an agent gets their desk and customer back at once', async () => {
    const office = await supportOffice(main);
    const resume = newKey();
    const jar = await member(main.base, main.server.db, office.id, 'Mia');
    const mia1 = await join(main.base, office.id, 'Mia', { jar, guest: '', request: { resume } });
    const a = await customer(main, office);
    const { ticket } = ok(await enter(a));
    ok(await mia1.socket.emitWithAck('support:desk', office.desks[2]));
    ok(await mia1.socket.emitWithAck('support:next'));
    await until(() => linked(office.id, mia1, a));

    const mia2 = await join(main.base, office.id, 'Mia', { jar, guest: '', request: { resume } });
    await until(() => mia1.socket.disconnected);
    // Without asking for the desk again (support:desk): it moved to the new connection as it came in.
    await until(() => linked(office.id, mia2, a));
    const { queue } = await asStaff(mia2);
    expect(queue.mine?.id).toBe(ticket.id);
    expect(queue.desks).toEqual([expect.objectContaining({ itemId: office.desks[2], playerId: mia2.socket.id, ticketId: ticket.id })]);
    expect((await asCustomer(a)).ticket?.agent?.playerId).toBe(mia2.socket.id);
    ok(await mia2.socket.emitWithAck('support:resolve'));
  });

  it('with two connections on one ticket, the newest is the one the agent hears', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const key = newKey();
    const a1 = await customer(main, office);
    const { ticket } = ok(await enter(a1, { key }));
    ok(await mia.socket.emitWithAck('support:desk', office.desks[1]));
    ok(await mia.socket.emitWithAck('support:next'));
    // Another connection with the same browser key (the page back, the old connection not gone yet).
    const a2 = await customer(main, office);
    ok(await a2.socket.emitWithAck('support:enter', { key, name: '', message: '' }));
    await until(async () => (await asStaff(mia)).queue.mine?.playerId === a2.socket.id);
    expect((await asStaff(mia)).queue.mine?.id).toBe(ticket.id);
    a1.socket.disconnect();
    await until(async () => !main.server.realtime.players(office.id).some((p) => p.id === a1.socket.id));
    expect((await asStaff(mia)).queue.mine?.playerId).toBe(a2.socket.id);
    ok(await mia.socket.emitWithAck('support:resolve'));
  });
});

describe('away too long', () => {
  it('customers lose their place, agents their customer (back to the front of the queue), and old tickets go', { timeout: 30_000 }, async () => {
    const quick = await start({ awayGraceMs: 300, sweepEveryMs: 50, retentionDays: 30 });
    const office = await supportOffice(quick);
    const mia = await staff(quick, office, 'Mia');
    const queues = heard(mia.socket, 'support:queue');
    const a = await customer(quick, office);
    const b = await customer(quick, office);
    const first = ok(await enter(a)).ticket;
    const gone = ok(await enter(b)).ticket;
    const c = await customer(quick, office);
    ok(await enter(c));

    // b left for longer than the grace: abandoned. a and c, still here, stay.
    b.socket.disconnect();
    await until(async () => (await ticketRow(gone.id)).status === 'abandoned');
    await until(() => queues.at(-1)?.[0].waiting.length === 2);
    await wait(400);
    expect((await ticketRow(first.id)).status).toBe('waiting');

    // Mia calls a, then is gone too long: a goes back to the queue, ahead of c.
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    const aHears = heard(a.socket, 'support:ticket');
    mia.socket.disconnect();
    await until(() => aHears.at(-1)?.[0]?.status === 'waiting');
    expect(aHears.at(-1)![0]).toMatchObject({ id: first.id, status: 'waiting', ahead: 0, agent: null });
    expect(await ticketRow(first.id)).toMatchObject({ status: 'waiting', assignee_user_id: null, assigned_at: expect.any(Date) });

    // Closed tickets past CHAT_RETENTION_DAYS go with their chat; open ones (and the chat sweep) leave theirs.
    const { db } = quick.server;
    const messages = async (id: string) => (await db.query('SELECT 1 FROM chat_messages WHERE conv_key = $1', [ticketConv(id)])).rowCount;
    expect(await messages(gone.id)).toBe(1);
    await db.query(`UPDATE chat_messages SET created_at = now() - interval '60 days' WHERE conv_key = ANY($1::text[])`, [[ticketConv(gone.id), ticketConv(first.id)]]);
    await customer(quick, office);
    await wait(200);
    expect([await messages(gone.id), await messages(first.id)]).toEqual([1, 1]);
    await db.query(`UPDATE support_tickets SET closed_at = now() - interval '31 days' WHERE id = $1`, [gone.id]);
    await until(async () => !(await ticketRow(gone.id)));
    expect([await messages(gone.id), await messages(first.id)]).toEqual([0, 1]);

    // After a restart, a ticket being served in a workspace nobody comes back to ends too.
    const elsewhere = await supportOffice(quick);
    const { rows } = await db.query<{ id: string }>('SELECT user_id AS id FROM memberships WHERE office_id = $1', [elsewhere.id]);
    await db.query(
      `INSERT INTO support_tickets (id, office_id, number, status, customer_name, customer_key, customer_address, first_message, assignee_user_id, desk_item_id, assigned_at, last_seen_at)
       VALUES ('stale00000000000', $1, 1, 'active', 'Ann', 'k', 'a', 'Hi', $2, $3, now(), now() - interval '1 hour')`,
      [elsewhere.id, rows[0].id, elsewhere.desks[0]],
    );
    await until(async () => (await ticketRow('stale00000000000')).status === 'abandoned');
    await stop(quick);
  });
});

describe('support workspaces', () => {
  it('are the only ones with help desks and queue screens', async () => {
    const team = await createOffice(main.base, 'Tess');
    const tess = await join(main.base, team.id, 'Tess', { jar: team.owner });
    const synced = heard(tess.socket, 'office:sync');
    tess.socket.emit('office:op', { t: 'add', item: { id: 'hd', type: 'support-desk', x: 5, z: 5, rot: 0 } });
    await until(() => synced.length === 1);
    expect(synced[0][1]).toBe('That doesn’t belong in this kind of workspace.');
    expect(main.server.store.peek(team.id)!.office.items.some((i) => i.id === 'hd')).toBe(false);
  });

  it('start with the customer link on, and only ever let guests in with it', async () => {
    const office = await supportOffice(main);
    const res = await office.owner.fetch(`${main.base}/api/offices/${office.id}/members`);
    const { access } = (await res.json()) as MembersAnswer;
    expect(access).toEqual({ guests: 'link', link: expect.stringContaining(`/o/${office.id}#guest=`) });
    await expect(join(main.base, office.id, 'Nobody', { guest: 'wrong' })).rejects.toThrow('This guest link no longer works.');
    // Off, customers are taken out; on again, it's a new link.
    const a = await customer(main, office);
    const removed = heard(a.socket, 'office:removed');
    expect((await office.owner.fetch(`${main.base}/api/offices/${office.id}/access`, json({ guests: 'off' }, 'PUT'))).status).toBe(200);
    await until(() => removed.length === 1);
    const on = (await (await office.owner.fetch(`${main.base}/api/offices/${office.id}/access`, json({ guests: 'link' }, 'PUT'))).json()) as { link: string };
    expect(on.link).not.toContain(office.guest);
  });
});

describe('staff', () => {
  it('take a visitor out: their ticket ends, and they stay out a while', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const ip = nextIp();
    const a = await customer(main, office, { ip });
    const key = newKey();
    const { ticket } = ok(await enter(a, { key }));
    const removed = heard(a.socket, 'office:removed');
    expect(failed(await a.socket.emitWithAck('support:remove', mia.socket.id!))).toBe('Only staff can do that.');
    expect(failed(await mia.socket.emitWithAck('support:remove', mia.socket.id!))).toBe('They’re not a visitor here.');
    ok(await mia.socket.emitWithAck('support:remove', a.socket.id!));
    await until(() => removed.length === 1);
    expect(removed[0]).toEqual(['removed']);
    expect((await ticketRow(ticket.id)).status).toBe('abandoned');
    // Not from that address for an hour, and not with that browser's key from elsewhere.
    await expect(customer(main, office, { ip })).rejects.toThrow('You can’t come in right now. Please try again later.');
    expect(failed(await enter(await customer(main, office), { key }))).toBe('You can’t open tickets here right now.');
  });

  it('keep their desk a moment when they drop out, and it follows them to their newest tab', async () => {
    const office = await supportOffice(main);
    let mia = await staff(main, office, 'Mia');
    const max = await staff(main, office, 'Max');
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    // A reload: the desk waits (nobody else takes it) and comes back with them.
    mia.socket.disconnect();
    await until(async () => (await asStaff(max)).queue.desks[0]?.playerId === null);
    expect(failed(await max.socket.emitWithAck('support:desk', office.desks[0]))).toBe('Mia is at this desk.');
    mia = { ...(await join(main.base, office.id, 'Mia', { jar: mia.jar, guest: '' })), jar: mia.jar };
    await until(async () => (await asStaff(max)).queue.desks[0]?.playerId === mia.socket.id);

    // Serving someone, she opens another tab: it takes over, with the desk and the call.
    const a = await customer(main, office);
    const { ticket } = ok(await enter(a));
    ok(await mia.socket.emitWithAck('support:next'));
    const linked = (p: Joined, q: Joined) => main.server.realtime.linkedPeers(office.id, p.socket.id!).includes(q.socket.id!);
    await until(() => linked(a, mia));
    const removed = heard(mia.socket, 'office:removed');
    const tab = await join(main.base, office.id, 'Mia', { jar: mia.jar, guest: '' });
    await until(() => removed.length === 1);
    expect(removed[0]).toEqual(['elsewhere']);
    await until(() => linked(a, tab));
    expect(linked(a, mia)).toBe(false);
    expect((await asStaff(max)).queue.desks[0]).toMatchObject({ name: 'Mia', playerId: tab.socket.id, ticketId: ticket.id });
    expect((await asCustomer(a)).ticket?.agent?.playerId).toBe(tab.socket.id);
    expect(failed(await mia.socket.emitWithAck('support:resolve'))).toBe('This isn’t a support workspace.');
    ok(await tab.socket.emitWithAck('support:resolve'));
  });

  it('lose a desk moved or removed in build mode; its customer goes back to the front of the queue', async () => {
    const office = await supportOffice(main);
    const olive = await join(main.base, office.id, 'Olive', { jar: office.owner, guest: '' });
    const mia = await staff(main, office, 'Mia');
    const a = await customer(main, office);
    const { ticket } = ok(await enter(a));
    ok(await enter(await customer(main, office)));
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    const mine = heard(a.socket, 'support:ticket');
    const desk = itemOf(main, office.id, office.desks[0]);
    olive.socket.emit('office:op', { t: 'update', item: { ...desk, x: desk.x + 0.5 } });
    await until(() => mine.at(-1)?.[0]?.status === 'waiting');
    expect(mine.at(-1)![0]).toMatchObject({ id: ticket.id, ahead: 0, agent: null });
    expect((await asStaff(mia)).queue.desks).toEqual([]);
    // Taken again, then removed: free again.
    ok(await mia.socket.emitWithAck('support:desk', office.desks[1]));
    olive.socket.emit('office:op', { t: 'remove', id: office.desks[1] });
    await until(async () => (await asStaff(mia)).queue.desks.length === 0);
  });
});

describe('a customer made a member while inside', () => {
  it('is staff from then on: their ticket ends, and others see them by their name', async () => {
    const office = await supportOffice(main);
    const samJar = await signIn(main.base, 'Sam Member');
    const sam = await customer(main, office, { jar: samJar });
    const { ticket } = ok(await enter(sam));
    const olive = await join(main.base, office.id, 'Olive', { jar: office.owner, guest: '' });
    const updates = heard(olive.socket, 'player:updated');
    await member(main.base, main.server.db, office.id, samJar);
    const { user } = (await (await samJar.fetch(`${main.base}/api/me`)).json()) as { user: { id: string } };
    main.server.realtime.setRole(office.id, user.id, 'member');
    await until(() => updates.some(([id, patch]) => id === sam.socket.id && patch.customer === false));
    expect(updates.find(([id]) => id === sam.socket.id)![1]).toEqual({ customer: false, userId: user.id, name: 'Sam Member' });
    await until(async () => (await ticketRow(ticket.id)).status === 'abandoned');
    expect((await state(sam)).as).toBe('staff');
    expect((await asStaff(olive)).queue.waiting).toEqual([]);
  });
});

describe('customers’ tickets', () => {
  it('only come to connections that asked for them, and the last closed one comes back to an empty enter', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const a = await customer(main, office);
    const key = newKey();
    const nothing = heard(a.socket, 'support:ticket');
    // Others' changes don't send anything (least of all null) to someone without a ticket yet.
    ok(await enter(await customer(main, office)));
    await wait(100);
    expect(nothing).toEqual([]);
    const { ticket } = ok(await enter(a, { key }));
    await until(() => nothing.length > 0);
    expect(nothing.every(([t]) => t !== null)).toBe(true);

    // Resolved (after the one who came first), then a reload: an empty enter gives the resolved
    // ticket back, to rate it.
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    for (let i = 0; i < 2; i++) {
      ok(await mia.socket.emitWithAck('support:next'));
      ok(await mia.socket.emitWithAck('support:resolve'));
    }
    a.socket.disconnect();
    const back = await customer(main, office);
    const resolved = ok(await back.socket.emitWithAck('support:enter', { key, name: '', message: '' })).ticket;
    expect(resolved).toEqual({ id: ticket.id, number: ticket.number, status: 'resolved', ahead: null, agent: null, rating: null, helpers: [] });
    ok(await back.socket.emitWithAck('support:rate', 5));
    // A question given up on comes back as abandoned (their place ran out, or they left).
    const second = ok(await enter(back, { key, message: 'Another thing' })).ticket;
    ok(await back.socket.emitWithAck('support:leave-queue'));
    back.socket.disconnect();
    const again = await customer(main, office);
    expect(ok(await again.socket.emitWithAck('support:enter', { key, name: '', message: '' })).ticket).toMatchObject({ id: second.id, status: 'abandoned' });
  });

  it('can’t be written in once closed, even by a connection that resumed it just before', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const key = newKey();
    const a = await customer(main, office);
    const { ticket } = ok(await enter(a, { key }));
    const tab = await customer(main, office);
    ok(await tab.socket.emitWithAck('support:enter', { key, name: '', message: '' }));
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    // Closed behind the server's back (as by a request that crossed with Resolve).
    await main.server.db.query("UPDATE support_tickets SET status = 'resolved', closed_at = now() WHERE id = $1", [ticket.id]);
    const send = (p: Joined) => p.socket.emitWithAck('chat:send', { conv: ticketConv(ticket.id), text: 'after the end' });
    expect(failed(await send(tab))).toBe('This ticket is closed.');
    // The next update tells them so.
    const told = heard(tab.socket, 'support:ticket');
    ok(await enter(await customer(main, office)));
    await until(() => told.at(-1)?.[0]?.status === 'resolved');
    expect(failed(await send(a))).toBe('This ticket is closed.');
  });

  it('are resumed cheaply on the connection that has them', async () => {
    const office = await supportOffice(main);
    const key = newKey();
    const a = await customer(main, office);
    const { ticket } = ok(await enter(a, { key }));
    const realtime = main.server.realtime as { relink: (officeId: string, ids?: string[]) => void };
    const relink = realtime.relink;
    let relinks = 0;
    realtime.relink = (officeId, ids) => {
      relinks++;
      relink(officeId, ids);
    };
    try {
      for (let i = 0; i < 5; i++) expect(ok(await a.socket.emitWithAck('support:enter', { key, name: '', message: '' })).ticket.id).toBe(ticket.id);
      expect(relinks).toBe(0);
    } finally {
      realtime.relink = relink;
    }
  });

  it('get numbers that never start over, and history pages are checked', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    for (let i = 0; i < 2; i++) ok(await enter(await customer(main, office)));
    // Old tickets deleted (retention): the numbers carry on.
    await main.server.db.query('DELETE FROM support_tickets WHERE office_id = $1', [office.id]);
    expect(ok(await enter(await customer(main, office))).ticket.number).toBe(3);
    for (const before of [2 ** 31, -1, 1.5]) expect(ok(await mia.socket.emitWithAck('support:history', { before }))).toMatchObject({ tickets: [], more: false });
  });
});

describe('customers’ files, taps and apps', () => {
  it('send files only in an open ticket, and not too much', { timeout: 60_000 }, async () => {
    const big = await start({}, { uploads: { storage: 'fs', maxBytes: 8 * 1024 * 1024 } });
    try {
      const office = await supportOffice(big);
      const a = await customer(big, office);
      const send = async (bytes: number) => {
        const res = await fetch(`${big.base}/api/offices/${office.id}/uploads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'doc.pdf', 'X-Workchop-Socket': a.socket.id!, 'X-Workchop-Upload-Key': a.res.ok ? a.res.uploadKey : '' },
          body: new Uint8Array(bytes),
        });
        return { status: res.status, error: ((await res.json()) as { error?: string }).error };
      };
      expect(await send(10)).toEqual({ status: 403, error: 'Open a ticket to send files.' });
      ok(await enter(a));
      // Three files fill the allowance up to a few bytes (a refused big body would be cut off unread).
      for (let i = 0; i < 3; i++) expect((await send(Math.floor(CUSTOMER_UPLOAD_BYTES / 3))).status).toBe(201);
      expect(await send(10)).toEqual({ status: 403, error: 'That’s a lot of files for one question. Send a link instead.' });
      ok(await a.socket.emitWithAck('support:leave-queue'));
      expect((await send(10)).status).toBe(403);
    } finally {
      await stop(big);
    }
  });

  it('tap only the agent serving them, keep their app to themselves, and send nothing to staff channels', async () => {
    const office = await supportOffice(main);
    const mia = await staff(main, office, 'Mia');
    const max = await staff(main, office, 'Max');
    for (const p of [mia, max]) p.socket.emit('profile', { focus: true });
    const samJar = await signIn(main.base, 'Sam Tapper');
    const a = await customer(main, office, { jar: samJar });
    a.socket.emit('presence:set', { manual: { app: 'figma', until: null } });
    ok(await enter(a));
    await until(() => main.server.realtime.players(office.id).filter((p) => p.focus).length === 2);
    expect(await a.socket.emitWithAck('focus:tap', max.socket.id!)).toEqual({ ok: false, error: 'You can’t tap them right now.' });
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    await until(() => main.server.realtime.linkedPeers(office.id, a.socket.id!).includes(mia.socket.id!));
    expect(await a.socket.emitWithAck('focus:tap', mia.socket.id!)).toEqual({ ok: true });
    expect(main.server.realtime.players(office.id).find((p) => p.id === a.socket.id)?.app ?? null).toBeNull();
  });
});

describe('a few minutes on', () => {
  it('customers without an open ticket are taken out; idle desks free up', { timeout: 30_000 }, async () => {
    const quick = await start({ customerIdleMs: 300, idleDeskMs: 200, sweepEveryMs: 50 });
    try {
      const office = await supportOffice(quick);
      const mia = await staff(quick, office, 'Mia');
      const idle = await customer(quick, office);
      const left = heard(idle.socket, 'office:removed');
      const busy = await customer(quick, office);
      ok(await enter(busy));
      await until(() => left.length === 1);
      expect(left[0]).toEqual(['idle']);
      await wait(300);
      expect(quick.server.realtime.players(office.id).some((p) => p.id === busy.socket.id)).toBe(true);
      // Their ticket closed: the clock starts then.
      const done = heard(busy.socket, 'office:removed');
      ok(await busy.socket.emitWithAck('support:leave-queue'));
      await until(() => done.length === 1);

      // A desk whose agent doesn't come back (and serves nobody) is free after a moment.
      const max = await staff(quick, office, 'Max');
      ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
      mia.socket.disconnect();
      await until(async () => (await asStaff(max)).queue.desks.length === 0);
      ok(await max.socket.emitWithAck('support:desk', office.desks[0]));
    } finally {
      await stop(quick);
    }
  });
});

describe('one of you per support workspace', () => {
  // Servers of their own: each address may sign in and make workspaces only so often.
  let run: Running;
  beforeAll(async () => {
    run = await start();
  });
  it('a customer’s newest tab gets their ticket, isn’t turned away for their network, and is the one the agent hears', { timeout: 30_000 }, async () => {
    const office = await supportOffice(run);
    const linked = linkedIn(run, office.id);
    const mia = await staff(run, office, 'Mia');
    const ip = nextIp();
    const browser = newKey();
    const key = newKey();
    const a1 = await customer(run, office, { ip, request: { browser } });
    const removed = heard(a1.socket, 'office:removed');
    const ticket = ok(await enter(a1, { key })).ticket;
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    await until(() => linked(mia, a1));
    for (let i = 1; i < MAX_CUSTOMERS_PER_ADDRESS; i++) await customer(run, office, { ip });

    // Another tab of the same browser: in (the old one steps aside first), summoned again, heard.
    const a2 = await customer(run, office, { ip, request: { browser } });
    await until(() => removed.length === 1);
    expect(removed[0]).toEqual(['elsewhere']);
    const summons = heard(a2.socket, 'support:summon');
    expect(ok(await a2.socket.emitWithAck('support:enter', { key, name: '', message: '' })).ticket).toMatchObject({ id: ticket.id, status: 'active' });
    await until(() => summons.length === 1 && linked(mia, a2));
    expect(summons[0][0]).toMatchObject({ ticketId: ticket.id, deskItemId: office.desks[0] });
    expect(run.server.realtime.linkedPeers(office.id, mia.socket.id!)).toEqual([a2.socket.id]);
    expect((await asStaff(mia)).queue.mine).toMatchObject({ id: ticket.id, playerId: a2.socket.id });
    ok(await mia.socket.emitWithAck('support:resolve'));
  });
});

describe('handing over a visitor', () => {
  let run: Running;
  beforeAll(async () => {
    run = await start();
  });
  it('moves the ticket, the call and the visitor to the colleague who accepts', async () => {
    const office = await supportOffice(run);
    const linked = linkedIn(run, office.id);
    const mia = await staff(run, office, 'Mia');
    const tunde = await staff(run, office, 'Tunde');
    const max = await staff(run, office, 'Max');
    const a = await customer(run, office);
    const { ticket } = ok(await enter(a));
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await tunde.socket.emitWithAck('support:desk', office.desks[2]));
    ok(await mia.socket.emitWithAck('support:next'));
    await until(() => linked(mia, a));
    const assignedAt = (await ticketRow(ticket.id)).assigned_at;

    // Mia sees who could take it: Tunde free at Desk 3, Max here without a desk.
    expect((await asStaff(mia)).queue.colleagues).toEqual([
      { userId: uid(tunde), name: 'Tunde', playerId: tunde.socket.id, desk: 'Desk 3', state: 'free', helping: null },
      { userId: uid(max), name: 'Max', playerId: max.socket.id, desk: null, state: 'no-desk', helping: null },
    ]);
    const tundeQueues = heard(tunde.socket, 'support:queue');
    const miaEnded = heard(mia.socket, 'support:offer:ended');
    const tundeEnded = heard(tunde.socket, 'support:offer:ended');
    const sent = ok(await offer(mia, 'transfer', uid(tunde))).offer;
    expect(sent).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
      kind: 'transfer',
      ticketId: ticket.id,
      number: ticket.number,
      customerName: 'Alice Smith',
      firstMessage: 'My order is late',
      from: { userId: uid(mia), name: 'Mia', desk: 'Desk 1' },
      to: { userId: uid(tunde), name: 'Tunde' },
      expiresAt: expect.any(Number),
    });
    expect(sent.expiresAt - Date.now()).toBeGreaterThan(OFFER_MS - 5_000);
    await until(() => tundeQueues.at(-1)?.[0].offers.incoming?.id === sent.id);
    expect((await asStaff(mia)).queue.offers).toEqual({ outgoing: sent, incoming: null });
    expect((await asStaff(max)).queue.offers).toEqual({ outgoing: null, incoming: null });

    const summons = heard(a.socket, 'support:summon');
    const mine = heard(a.socket, 'support:ticket');
    expect(await reply(tunde, sent, true)).toEqual({ ok: true });
    // One change to the ticket (Tunde at Desk 3, still called when it was), and a history line.
    expect(await ticketRow(ticket.id)).toEqual({ status: 'active', assignee_user_id: uid(tunde), assigned_at: assignedAt, desk_item_id: office.desks[2] });
    expect(await eventRows(ticket.id)).toEqual([{ kind: 'transferred', actor_user_id: uid(mia), other_user_id: uid(tunde) }]);
    // The visitor walks over, sees who'll help them now, and is in a call with Tunde only.
    await until(() => summons.length === 1);
    expect(summons[0][0]).toEqual({ ticketId: ticket.id, deskItemId: office.desks[2], seat: seatsOf(itemOf(run, office.id, office.desks[2]))[CUSTOMER_SEAT], agentName: 'Tunde' });
    await until(() => mine.at(-1)?.[0]?.agent?.deskItemId === office.desks[2]);
    expect(mine.at(-1)![0]).toEqual({
      id: ticket.id,
      number: ticket.number,
      status: 'active',
      ahead: null,
      agent: { name: 'Tunde', playerId: tunde.socket.id, deskItemId: office.desks[2], desk: 'Desk 3' },
      rating: null,
      helpers: [],
    });
    await until(() => linked(tunde, a) && !linked(mia, a));
    // Mia hears it worked; Tunde, who accepted, hears nothing.
    await until(() => miaEnded.length === 1);
    expect(miaEnded[0][0]).toEqual({ offer: sent, why: 'accepted' });
    expect(tundeEnded).toEqual([]);
    const miaQueue = (await asStaff(mia)).queue;
    expect([miaQueue.mine, miaQueue.offers]).toEqual([null, { outgoing: null, incoming: null }]);
    expect((await asStaff(tunde)).queue.mine).toMatchObject({ id: ticket.id, assignee: { userId: uid(tunde), name: 'Tunde' }, deskItemId: office.desks[2] });
    expect(await reply(tunde, sent, true)).toEqual({ ok: false, error: 'That offer is no longer open.' });

    // The chat carries on: Tunde writes now, Mia only reads.
    const conv = ticketConv(ticket.id);
    ok(await tunde.socket.emitWithAck('chat:send', { conv, text: 'Hi, Tunde here.' }));
    expect(failed(await mia.socket.emitWithAck('chat:send', { conv, text: 'Still me?' }))).toBe('Only the people helping with this ticket can write here.');
    // Mia is free for the next visitor; only Tunde resolves this one.
    expect(failed(await mia.socket.emitWithAck('support:resolve'))).toBe('You’re not serving anyone.');
    const b = await customer(run, office);
    ok(await enter(b));
    expect(ok(await mia.socket.emitWithAck('support:next')).ticket.playerId).toBe(b.socket.id);
    ok(await tunde.socket.emitWithAck('support:resolve'));
    ok(await mia.socket.emitWithAck('support:resolve'));
  });

  it('can be declined, taken back or left to run out, one open offer each way', { timeout: 30_000 }, async () => {
    const quick = await start({ offerMs: 300 });
    try {
      const office = await supportOffice(quick);
      const mia = await staff(quick, office, 'Mia');
      const tunde = await staff(quick, office, 'Tunde');
      const max = await staff(quick, office, 'Max');
      const ola = await staff(quick, office, 'Ola');
      const [a, b] = [await customer(quick, office), await customer(quick, office)];
      ok(await enter(a));
      ok(await enter(b));
      for (const [i, p] of [mia, max, tunde, ola].entries()) ok(await p.socket.emitWithAck('support:desk', office.desks[i]));
      ok(await mia.socket.emitWithAck('support:next'));
      ok(await max.socket.emitWithAck('support:next'));
      const miaEnded = heard(mia.socket, 'support:offer:ended');
      const tundeEnded = heard(tunde.socket, 'support:offer:ended');

      // One at a time: from Mia, and to Tunde.
      const first = ok(await offer(mia, 'transfer', uid(tunde))).offer;
      expect(failed(await offer(mia, 'invite', uid(ola)))).toBe('You’re waiting for an answer from Tunde.');
      expect(failed(await offer(max, 'invite', uid(tunde)))).toBe('Tunde has another offer to answer. Try again in a moment.');
      // Only Tunde answers it, only Mia takes it back.
      expect(failed(await reply(ola, first, true))).toBe('That offer is no longer open.');
      expect(failed(await tunde.socket.emitWithAck('support:offer:cancel', first.id))).toBe('That offer is no longer open.');
      expect(failed(await tunde.socket.emitWithAck('support:offer:answer', 'nope', true))).toBe('That offer is no longer open.');

      ok(await reply(tunde, first, false));
      await until(() => miaEnded.length === 1);
      expect(miaEnded[0][0]).toEqual({ offer: first, why: 'declined' });
      expect((await asStaff(tunde)).queue.offers).toEqual({ outgoing: null, incoming: null });

      const second = ok(await offer(mia, 'invite', uid(tunde))).offer;
      ok(await mia.socket.emitWithAck('support:offer:cancel', second.id));
      await until(() => tundeEnded.length === 1);
      expect(tundeEnded[0][0]).toEqual({ offer: second, why: 'cancelled' });
      expect(failed(await reply(tunde, second, true))).toBe('That offer is no longer open.');

      // Nobody answers: both hear it ran out.
      const third = ok(await offer(mia, 'transfer', uid(tunde))).offer;
      await until(() => miaEnded.length === 2 && tundeEnded.length === 2);
      expect([miaEnded[1][0], tundeEnded[1][0]]).toEqual([
        { offer: third, why: 'expired' },
        { offer: third, why: 'expired' },
      ]);
      expect((await asStaff(mia)).queue.offers).toEqual({ outgoing: null, incoming: null });
      expect(failed(await reply(tunde, third, true))).toBe('That offer is no longer open.');
      // Only the sides that didn't end it heard of the others.
      expect([miaEnded.length, tundeEnded.length]).toEqual([2, 2]);
    } finally {
      await stop(quick);
    }
  });

  it('is refused, with the reason, when it can’t work', { timeout: 30_000 }, async () => {
    const office = await supportOffice(run);
    const people = [];
    for (const name of ['Mia', 'Max', 'Tunde', 'Ola', 'Zed', 'Nia', 'Pia', 'Una']) people.push(await staff(run, office, name));
    const [mia, max, tunde, ola, zed, nia, pia, una] = people;
    // Desks 1 to 5 for Mia, Max, Tunde, Ola and Zed; Nia, Pia and Una have none.
    for (const [i, p] of [mia, max, tunde, ola, zed].entries()) ok(await p.socket.emitWithAck('support:desk', office.desks[i]));
    const [a, b] = [await customer(run, office), await customer(run, office)];
    ok(await enter(a));
    ok(await enter(b));
    ok(await mia.socket.emitWithAck('support:next'));
    ok(await max.socket.emitWithAck('support:next'));
    // Zed stepped away from his desk.
    const zedId = uid(zed);
    const queues = heard(mia.socket, 'support:queue');
    zed.socket.disconnect();
    await until(() => lastQueue(queues)?.colleagues.find((c) => c.name === 'Zed')?.state === 'away');

    expect(failed(await offer(a, 'invite', uid(tunde)))).toBe('Only staff can do that.');
    expect(failed(await offer(tunde, 'transfer', uid(ola)))).toBe('You’re not serving anyone.');
    expect(failed(await mia.socket.emitWithAck('support:offer', { kind: 'nope' as OfferKind, to: uid(tunde) }))).toBe('Reload the page and try again.');
    expect(failed(await offer(max, 'transfer', uid(max)))).toBe('That’s you.');
    expect(failed(await offer(max, 'invite', 'nobody'))).toBe('They’re not here.');
    expect(failed(await offer(max, 'transfer', uid(nia)))).toBe('Nia isn’t at a desk.');
    expect(failed(await offer(mia, 'transfer', uid(max)))).toBe('Max is serving someone.');
    expect(failed(await offer(mia, 'invite', uid(max)))).toBe('Max is serving someone.');
    expect(failed(await offer(mia, 'transfer', zedId))).toBe('Zed is away.');
    expect(failed(await offer(mia, 'invite', zedId))).toBe('Zed isn’t here.');

    // Pia (no desk) and Ola (at a desk) help Max.
    for (const p of [pia, ola]) ok(await reply(p, ok(await offer(max, 'invite', uid(p))).offer, true));
    expect(failed(await offer(mia, 'invite', uid(pia)))).toBe('Pia is helping with another ticket.');
    expect(failed(await offer(mia, 'transfer', uid(pia)))).toBe('Pia isn’t at a desk.');
    expect(failed(await offer(mia, 'transfer', uid(ola)))).toBe('Ola is helping with another ticket.');

    // Tunde and Nia help Mia: two is all there's room for. (A pause: requests are limited.)
    await wait(2_000);
    for (const p of [tunde, nia]) ok(await reply(p, ok(await offer(mia, 'invite', uid(p))).offer, true));
    expect(failed(await offer(mia, 'invite', uid(tunde)))).toBe('Tunde is already helping.');
    expect(failed(await offer(mia, 'invite', uid(una)))).toBe('Two colleagues are helping already.');
    expect((await asStaff(mia)).queue.mine?.helpers.map((h) => h.name)).toEqual(['Tunde', 'Nia']);
    expect(MAX_HELPERS).toBe(2);
    for (const p of [mia, max]) ok(await p.socket.emitWithAck('support:resolve'));
  });

  it('stops working when the sender resolves first', async () => {
    const office = await supportOffice(run);
    const mia = await staff(run, office, 'Mia');
    const tunde = await staff(run, office, 'Tunde');
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await tunde.socket.emitWithAck('support:desk', office.desks[2]));
    const miaEnded = heard(mia.socket, 'support:offer:ended');
    const tundeEnded = heard(tunde.socket, 'support:offer:ended');
    const serve = async () => {
      const c = await customer(run, office);
      const { ticket } = ok(await enter(c));
      ok(await mia.socket.emitWithAck('support:next'));
      return ticket;
    };

    // Mia resolves while Tunde thinks it over: the offer is taken back.
    const t1 = await serve();
    const o1 = ok(await offer(mia, 'transfer', uid(tunde))).offer;
    ok(await mia.socket.emitWithAck('support:resolve'));
    await until(() => tundeEnded.length === 1);
    expect(tundeEnded[0][0]).toEqual({ offer: o1, why: 'cancelled' });
    expect(failed(await reply(tunde, o1, true))).toBe('That offer is no longer open.');
    expect((await ticketRow(t1.id)).status).toBe('resolved');

    // Resolve pressed while an Accept is being saved: Tunde has it.
    const db = run.server.db;
    const transaction = db.transaction;
    const t2 = await serve();
    const o2 = ok(await offer(mia, 'transfer', uid(tunde))).offer;
    // Saving the handover takes a while to answer.
    db.transaction = (async (fn: Parameters<typeof transaction>[0]) => {
      const done = await transaction.call(db, fn);
      await wait(200);
      return done;
    }) as typeof transaction;
    try {
      const accepting = reply(tunde, o2, true);
      await wait(50);
      expect(await mia.socket.emitWithAck('support:resolve')).toEqual({ ok: false, error: 'Tunde has this ticket now.' });
      expect(await accepting).toEqual({ ok: true });
    } finally {
      db.transaction = transaction;
    }
    expect(await ticketRow(t2.id)).toMatchObject({ status: 'active', assignee_user_id: uid(tunde) });
    await until(() => miaEnded.length === 1);
    expect(miaEnded[0][0]).toEqual({ offer: o2, why: 'accepted' });
    ok(await tunde.socket.emitWithAck('support:resolve'));

    // Resolved while an Accept waits its turn: it no longer works.
    const t3 = await serve();
    const o3 = ok(await offer(mia, 'transfer', uid(tunde))).offer;
    // Saving it waits a while to start.
    db.transaction = (async (fn: Parameters<typeof transaction>[0]) => {
      await wait(200);
      return transaction.call(db, fn);
    }) as typeof transaction;
    try {
      const accepting = reply(tunde, o3, true);
      await wait(50);
      ok(await mia.socket.emitWithAck('support:resolve'));
      expect(await accepting).toEqual({ ok: false, error: `Mia isn’t serving Visitor #${t3.number} any more.` });
    } finally {
      db.transaction = transaction;
    }
    expect((await ticketRow(t3.id)).status).toBe('resolved');
    await until(() => miaEnded.length === 2);
    expect(miaEnded[1][0]).toEqual({ offer: o3, why: 'gone', note: `Visitor #${t3.number} isn’t at your desk any more.` });
  });

  it('stops working when the colleague calls someone, or the sender’s desk moves', async () => {
    const office = await supportOffice(run);
    const olive = await join(run.base, office.id, 'Olive', { jar: office.owner, guest: '' });
    const mia = await staff(run, office, 'Mia');
    const tunde = await staff(run, office, 'Tunde');
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await tunde.socket.emitWithAck('support:desk', office.desks[2]));
    const miaEnded = heard(mia.socket, 'support:offer:ended');
    const tundeEnded = heard(tunde.socket, 'support:offer:ended');

    // Tunde calls someone himself first: it stops working for both.
    ok(await enter(await customer(run, office)));
    const t4 = ok(await mia.socket.emitWithAck('support:next')).ticket;
    const o4 = ok(await offer(mia, 'transfer', uid(tunde))).offer;
    ok(await enter(await customer(run, office)));
    ok(await tunde.socket.emitWithAck('support:next'));
    await until(() => tundeEnded.some(([e]) => e.offer.id === o4.id) && miaEnded.some(([e]) => e.offer.id === o4.id));
    const gone = { offer: o4, why: 'gone', note: 'Tunde is serving someone.' };
    expect([miaEnded.at(-1)![0], tundeEnded.at(-1)![0]]).toEqual([gone, gone]);
    ok(await tunde.socket.emitWithAck('support:resolve'));

    // The database says Tunde is serving someone (a Next that crossed with the accept): refused there.
    const o5 = ok(await offer(mia, 'transfer', uid(tunde))).offer;
    const other = await customer(run, office);
    const otherTicket = ok(await enter(other)).ticket;
    await run.server.db.query("UPDATE support_tickets SET status = 'active', assignee_user_id = $2, desk_item_id = $3 WHERE id = $1", [otherTicket.id, uid(tunde), office.desks[2]]);
    expect(failed(await reply(tunde, o5, true))).toBe('Resolve your ticket first.');
    await until(() => miaEnded.some(([e]) => e.offer.id === o5.id));
    expect(miaEnded.at(-1)![0]).toEqual({ offer: o5, why: 'gone', note: 'Tunde is serving someone.' });
    expect(await ticketRow(t4.id)).toMatchObject({ status: 'active', assignee_user_id: uid(mia) });
    await run.server.db.query("UPDATE support_tickets SET status = 'abandoned', closed_at = now() WHERE id = $1", [otherTicket.id]);

    // Mia's desk is moved in build mode: the visitor goes back to the queue, and the offer with it.
    const o6 = ok(await offer(mia, 'transfer', uid(tunde))).offer;
    const desk = itemOf(run, office.id, office.desks[0]);
    olive.socket.emit('office:op', { t: 'update', item: { ...desk, x: desk.x + 0.5 } });
    await until(() => tundeEnded.some(([e]) => e.offer.id === o6.id) && miaEnded.some(([e]) => e.offer.id === o6.id));
    const queued = { offer: o6, why: 'gone', note: `Visitor #${t4.number} is back in the queue.` };
    expect([miaEnded.at(-1)![0], tundeEnded.at(-1)![0]]).toEqual([queued, queued]);
    expect(await ticketRow(t4.id)).toMatchObject({ status: 'waiting', assignee_user_id: null });
    expect(failed(await reply(tunde, o6, true))).toBe('That offer is no longer open.');
  });

  it('goes to a colleague helping with it, who becomes its agent; the other one keeps helping', async () => {
    const office = await supportOffice(run);
    const linked = linkedIn(run, office.id);
    const mia = await staff(run, office, 'Mia');
    const tunde = await staff(run, office, 'Tunde');
    const nia = await staff(run, office, 'Nia');
    const a = await customer(run, office);
    const { ticket } = ok(await enter(a));
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await tunde.socket.emitWithAck('support:desk', office.desks[1]));
    ok(await mia.socket.emitWithAck('support:next'));
    for (const p of [tunde, nia]) ok(await reply(p, ok(await offer(mia, 'invite', uid(p))).offer, true));
    await until(() => linked(a, tunde) && linked(a, nia) && linked(mia, tunde));
    expect((await asStaff(mia)).queue.colleagues.find((c) => c.name === 'Tunde')).toMatchObject({ state: 'helping', helping: ticket.id, desk: 'Desk 2' });
    // History lines are saved after the answer.
    await until(async () => (await eventRows(ticket.id)).length === 2);

    ok(await reply(tunde, ok(await offer(mia, 'transfer', uid(tunde))).offer, true));
    const { queue } = await asStaff(tunde);
    expect([queue.mine?.id, queue.helping, queue.mine?.helpers.map((h) => h.name)]).toEqual([ticket.id, null, ['Nia']]);
    expect((await asStaff(nia)).queue.helping?.assignee?.name).toBe('Tunde');
    await until(() => linked(a, tunde) && linked(a, nia) && linked(tunde, nia) && !linked(a, mia) && !linked(mia, nia));
    // Handing it over says it all: no "left" line for Tunde.
    expect((await eventRows(ticket.id)).map((e) => e.kind)).toEqual(['joined', 'joined', 'transferred']);
    ok(await tunde.socket.emitWithAck('support:resolve'));
  });

  it('is accepted once when Accept is pressed twice', async () => {
    const office = await supportOffice(run);
    const mia = await staff(run, office, 'Mia');
    const tunde = await staff(run, office, 'Tunde');
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await tunde.socket.emitWithAck('support:desk', office.desks[1]));
    for (const kind of ['transfer', 'invite'] as const) {
      const a = await customer(run, office);
      const { ticket } = ok(await enter(a));
      ok(await mia.socket.emitWithAck('support:next'));
      const sent = ok(await offer(mia, kind, uid(tunde))).offer;
      const answers = await Promise.all([reply(tunde, sent, true), reply(tunde, sent, true)]);
      expect(answers.filter((r) => r.ok)).toHaveLength(1);
      expect(answers.find((r) => !r.ok)).toEqual({ ok: false, error: 'That offer is no longer open.' });
      await until(async () => (await eventRows(ticket.id)).length > 0);
      expect((await eventRows(ticket.id)).map((e) => e.kind)).toEqual([kind === 'transfer' ? 'transferred' : 'joined']);
      if (kind === 'transfer') ok(await tunde.socket.emitWithAck('support:resolve'));
      else {
        expect((await asStaff(mia)).queue.mine?.helpers).toHaveLength(1);
        ok(await mia.socket.emitWithAck('support:resolve'));
      }
    }
  });

  it('outlasts a reload of either side, and a desk left behind frees up', { timeout: 30_000 }, async () => {
    const quick = await start({ idleDeskMs: 200, offerMs: 1_000 });
    try {
      const office = await supportOffice(quick);
      const linked = linkedIn(quick, office.id);
      let mia = await staff(quick, office, 'Mia');
      let tunde = await staff(quick, office, 'Tunde');
      const a = await customer(quick, office);
      const { ticket } = ok(await enter(a));
      ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
      ok(await tunde.socket.emitWithAck('support:desk', office.desks[1]));
      ok(await mia.socket.emitWithAck('support:next'));
      const sent = ok(await offer(mia, 'transfer', uid(tunde))).offer;

      // Tunde reloads: the offer waits for him.
      tunde.socket.disconnect();
      tunde = { ...(await join(quick.base, office.id, 'Tunde', { jar: tunde.jar, guest: '' })), jar: tunde.jar };
      expect((await asStaff(tunde)).queue.offers.incoming?.id).toBe(sent.id);
      // Mia is gone (a reload she doesn't come back from): Tunde still takes it.
      const queues = heard(tunde.socket, 'support:queue');
      mia.socket.disconnect();
      await until(() => lastQueue(queues)?.desks.find((d) => d.name === 'Mia')?.playerId === null);
      ok(await reply(tunde, sent, true));
      await until(() => linked(a, tunde));
      expect(await ticketRow(ticket.id, quick)).toMatchObject({ status: 'active', assignee_user_id: uid(tunde), desk_item_id: office.desks[1] });
      // Her desk, serving nobody now, frees up as an idle one does.
      await until(() => lastQueue(queues)?.desks.map((d) => d.name).join() === 'Tunde');

      // An offer to someone who left lapses.
      mia = { ...(await join(quick.base, office.id, 'Mia', { jar: mia.jar, guest: '' })), jar: mia.jar };
      const ended = heard(tunde.socket, 'support:offer:ended');
      const invite = ok(await offer(tunde, 'invite', uid(mia))).offer;
      mia.socket.disconnect();
      await wait(500);
      expect((await asStaff(tunde)).queue.offers.outgoing?.id).toBe(invite.id);
      await until(() => ended.length === 1, 3_000);
      expect(ended[0][0]).toEqual({ offer: invite, why: 'expired' });
    } finally {
      await stop(quick);
    }
  });
});

describe('inviting a colleague', () => {
  let run: Running;
  beforeAll(async () => {
    run = await start();
  });
  it('brings them into the call and the chat wherever they are, until they leave or are let go', { timeout: 30_000 }, async () => {
    const office = await supportOffice(run);
    const linked = linkedIn(run, office.id);
    const olive = await join(run.base, office.id, 'Olive', { jar: office.owner, guest: '' });
    const mia = await staff(run, office, 'Mia');
    const max = await staff(run, office, 'Max');
    const a = await customer(run, office);
    const b = await customer(run, office);
    const { ticket } = ok(await enter(a));
    ok(await enter(b));
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    // Olive is across the office, next to Max and the other visitor.
    olive.socket.emit('move', 30, 30, 0, 'idle');
    max.socket.emit('move', 30.5, 30, 0, 'idle');
    b.socket.emit('move', 31, 30, 0, 'idle');
    await until(() => linked(olive, max));

    const mine = heard(a.socket, 'support:ticket');
    const sent = ok(await offer(mia, 'invite', uid(olive))).offer;
    expect(sent).toMatchObject({ kind: 'invite', to: { userId: uid(olive), name: 'Olive' } });
    ok(await reply(olive, sent, true));
    await until(() => linked(olive, a) && linked(olive, mia) && !linked(olive, max));
    expect([linked(olive, b), linked(a, max)]).toEqual([false, false]);
    // Everyone sees her helping.
    await until(() => mine.at(-1)?.[0]?.helpers.length === 1);
    expect(mine.at(-1)![0]!.helpers).toEqual([{ name: 'Olive', playerId: olive.socket.id }]);
    expect((await asStaff(mia)).queue.mine?.helpers).toEqual([{ userId: uid(olive), name: 'Olive', playerId: olive.socket.id }]);
    const oliveQueue = (await asStaff(olive)).queue;
    expect([oliveQueue.helping?.id, oliveQueue.mine]).toEqual([ticket.id, null]);
    expect((await asStaff(max)).queue.colleagues.find((c) => c.name === 'Olive')).toEqual({
      userId: uid(olive),
      name: 'Olive',
      playerId: olive.socket.id,
      desk: null,
      state: 'helping',
      helping: ticket.id,
    });
    await until(async () => (await eventRows(ticket.id)).length === 1);
    expect(await eventRows(ticket.id)).toEqual([{ kind: 'joined', actor_user_id: uid(olive), other_user_id: uid(mia) }]);

    // She writes in the ticket's chat; Max still only reads.
    const conv = ticketConv(ticket.id);
    expect(ok(await olive.socket.emitWithAck('chat:send', { conv, text: 'Olive here, I know this one.' })).message).toMatchObject({ name: 'Olive' });
    expect(failed(await max.socket.emitWithAck('chat:send', { conv, text: 'Me too' }))).toBe('Only the people helping with this ticket can write here.');
    // Mia stays in charge.
    expect(failed(await olive.socket.emitWithAck('support:next'))).toBe('Leave the conversation you’re helping with first.');
    expect(failed(await olive.socket.emitWithAck('support:resolve'))).toBe('You’re not serving anyone.');
    expect(failed(await offer(olive, 'invite', uid(max)))).toBe('You’re not serving anyone.');
    expect(failed(await olive.socket.emitWithAck('support:helper:remove', uid(mia)))).toBe('They’re not helping you.');
    expect(failed(await max.socket.emitWithAck('support:helper:leave'))).toBe('You’re not helping anyone.');

    // She leaves: out of the call, the visitor sees it.
    const oliveEnded = heard(olive.socket, 'support:helping:ended');
    ok(await olive.socket.emitWithAck('support:helper:leave'));
    await until(() => !linked(olive, a) && !linked(olive, mia) && linked(olive, max));
    await until(() => mine.at(-1)?.[0]?.helpers.length === 0);
    expect(failed(await olive.socket.emitWithAck('chat:send', { conv, text: 'One more' }))).toBe('Only the people helping with this ticket can write here.');

    // Invited again, then let go by Mia.
    ok(await reply(olive, ok(await offer(mia, 'invite', uid(olive))).offer, true));
    await until(() => linked(olive, a));
    expect(failed(await mia.socket.emitWithAck('support:helper:remove', uid(max)))).toBe('They’re not helping you.');
    ok(await mia.socket.emitWithAck('support:helper:remove', uid(olive)));
    await until(() => oliveEnded.length === 1 && !linked(olive, a));
    expect(oliveEnded[0][0]).toEqual({ ticketId: ticket.id, number: ticket.number, why: 'removed', agent: 'Mia' });
    expect((await asStaff(olive)).queue.helping).toBeNull();
    await until(async () => (await eventRows(ticket.id)).length === 4);
    expect(await eventRows(ticket.id)).toEqual([
      { kind: 'joined', actor_user_id: uid(olive), other_user_id: uid(mia) },
      { kind: 'left', actor_user_id: uid(olive), other_user_id: null },
      { kind: 'joined', actor_user_id: uid(olive), other_user_id: uid(mia) },
      { kind: 'left', actor_user_id: uid(olive), other_user_id: uid(mia) },
    ]);
    ok(await mia.socket.emitWithAck('support:resolve'));
  });

  it('ends with the ticket, survives a helper’s reload but not a long absence, and shows in the history', { timeout: 30_000 }, async () => {
    const quick = await start({ helperAwayMs: 300 });
    try {
      const office = await supportOffice(quick);
      const linked = linkedIn(quick, office.id);
      const olive = await join(quick.base, office.id, 'Olive', { jar: office.owner, guest: '' });
      const mia = await staff(quick, office, 'Mia');
      let nia = await staff(quick, office, 'Nia');
      const tunde = await staff(quick, office, 'Tunde');
      const a = await customer(quick, office);
      const { ticket } = ok(await enter(a, { name: 'Ada Lovelace' }));
      ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
      ok(await tunde.socket.emitWithAck('support:desk', office.desks[1]));
      ok(await mia.socket.emitWithAck('support:next'));
      ok(await reply(nia, ok(await offer(mia, 'invite', uid(nia))).offer, true));
      await until(() => linked(nia, a));

      // A reload: her part waits for her, and she's back in the call.
      const queues = heard(mia.socket, 'support:queue');
      nia.socket.disconnect();
      await until(() => lastQueue(queues)?.mine?.helpers[0]?.playerId === null);
      nia = { ...(await join(quick.base, office.id, 'Nia', { jar: nia.jar, guest: '' })), jar: nia.jar };
      await until(() => linked(nia, a));
      expect((await asStaff(nia)).queue.helping?.id).toBe(ticket.id);
      await wait(400);
      expect((await asStaff(mia)).queue.mine?.helpers).toEqual([{ userId: uid(nia), name: 'Nia', playerId: nia.socket.id }]);
      // Gone longer: her part ends.
      nia.socket.disconnect();
      await until(() => lastQueue(queues)?.mine?.helpers.length === 0);

      // Handed to Tunde with Olive helping, then resolved: Olive is told.
      ok(await reply(olive, ok(await offer(mia, 'invite', uid(olive))).offer, true));
      ok(await reply(tunde, ok(await offer(mia, 'transfer', uid(tunde))).offer, true));
      const oliveEnded = heard(olive.socket, 'support:helping:ended');
      ok(await tunde.socket.emitWithAck('support:resolve'));
      await until(() => oliveEnded.length === 1);
      expect(oliveEnded[0][0]).toEqual({ ticketId: ticket.id, number: ticket.number, why: 'resolved', agent: 'Tunde' });
      expect((await asStaff(olive)).queue.helping).toBeNull();
      await until(() => !linked(olive, a));

      // Back in the queue (the agent's desk moved): the helpers are told, and it shows.
      const b = await customer(quick, office);
      const second = ok(await enter(b)).ticket;
      ok(await mia.socket.emitWithAck('support:next'));
      ok(await reply(olive, ok(await offer(mia, 'invite', uid(olive))).offer, true));
      const desk = itemOf(quick, office.id, office.desks[0]);
      olive.socket.emit('office:op', { t: 'update', item: { ...desk, x: desk.x + 0.5 } });
      await until(() => oliveEnded.length === 2);
      expect(oliveEnded[1][0]).toEqual({ ticketId: second.id, number: second.number, why: 'ended', agent: 'Mia' });
      await until(async () => (await eventRows(second.id, quick)).length === 2);
      expect((await eventRows(second.id, quick)).map((e) => [e.kind, e.other_user_id])).toEqual([
        ['joined', uid(mia)],
        ['left', null],
      ]);

      // The history: what happened, in order, with names.
      const page = ok(await olive.socket.emitWithAck('support:history', { query: 'Ada' }));
      expect(page.tickets.map((t) => t.id)).toEqual([ticket.id]);
      expect(page.tickets[0].events).toEqual([
        { kind: 'joined', at: expect.any(Number), helper: 'Nia', by: 'Mia' },
        { kind: 'left', at: expect.any(Number), helper: 'Nia', by: null },
        { kind: 'joined', at: expect.any(Number), helper: 'Olive', by: 'Mia' },
        { kind: 'transferred', at: expect.any(Number), from: 'Mia', to: 'Tunde' },
      ]);
      const at = page.tickets[0].events!.map((e) => e.at);
      expect([...at].sort((x, y) => x - y)).toEqual(at);
      expect(page.tickets[0].helpers).toEqual([]);
    } finally {
      await stop(quick);
    }
  });

  it('keeps its history in a table of its own, which goes with the ticket', async () => {
    const office = await supportOffice(run);
    const mia = await staff(run, office, 'Mia');
    const tunde = await staff(run, office, 'Tunde');
    const { ticket } = ok(await enter(await customer(run, office)));
    ok(await mia.socket.emitWithAck('support:desk', office.desks[0]));
    ok(await mia.socket.emitWithAck('support:next'));
    ok(await reply(tunde, ok(await offer(mia, 'invite', uid(tunde))).offer, true));
    ok(await tunde.socket.emitWithAck('support:helper:leave'));
    await until(async () => (await eventRows(ticket.id)).length === 2);
    const { db } = run.server;
    expect((await db.query<{ id: number }>('SELECT id FROM schema_migrations WHERE id = 701')).rows).toHaveLength(1);
    ok(await mia.socket.emitWithAck('support:resolve'));
    // Retention deletes tickets: their history goes too.
    await db.query('DELETE FROM support_tickets WHERE id = $1', [ticket.id]);
    expect(await eventRows(ticket.id)).toEqual([]);
  });
});
