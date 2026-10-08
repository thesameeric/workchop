import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountUser, Space } from '../shared/account';
import { DEFAULT_AVATAR } from '../shared/avatar';
import type { JoinResponse, ServerToClientEvents } from '../shared/types';
import { may, type Action, type Invite, type Member, type MembersAnswer, type Role } from '../shared/workspace';
import { Accounts } from '../server/accounts';
import { hashToken, Sessions } from '../server/auth/sessions';
import type { Db, Tx } from '../server/db';
import { startServer } from '../server/index';
import type { Mailer, MailMessage } from '../server/mail';
import { MAX_GUESTS_PER_ROOM } from '../server/realtime';
import { createTestDb, TEST_DATABASE_URL } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, json, member, signIn, until, type Client } from './helpers/http';

let server: Awaited<ReturnType<typeof startServer>>;
let db: Db;
let base: string;
let accounts: Accounts;
let sessions: Sessions;
/** Every email sent. */
const sent: MailMessage[] = [];
const recorder: Mailer = { kind: 'outbox', send: (message) => void sent.push(message), close: async () => {} };
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery';
const extra: Client[] = [];

beforeAll(async () => {
  db = await createTestDb();
  server = await startServer({ port: 0, host: '127.0.0.1', db, quiet: true, iceServers: [], publicUrl: ORIGIN, auth: { google: null, apple: null, devLogin: true }, mailer: recorder });
  base = `http://127.0.0.1:${server.port}`;
  accounts = new Accounts(db);
  sessions = new Sessions(db);
}, 60_000);

afterAll(async () => {
  disconnectAll();
  for (const s of extra) s.disconnect();
  await server?.close();
});

let people = 0;

/** A browser signed in to an account that has verified `email` (as a Google sign-in does). */
async function verified(name: string, email = `${name.toLowerCase()}.${++people}@example.com`) {
  const user = await accounts.signIn({ provider: 'google', subject: `google-${email}`, email, emailVerified: true, isPrivateEmail: false, name, avatarUrl: null, label: null });
  const jar = new Jar();
  jar.cookies.set('wc_session', await sessions.create(user.id, 'test'));
  return { jar, user, email };
}

const call = (jar: Jar | null, path: string, init?: RequestInit) => (jar ?? new Jar()).fetch(`${base}/api${path}`, init);
const post = (jar: Jar | null, path: string, body: unknown = {}) => call(jar, path, json(body));
const put = (jar: Jar | null, path: string, body: unknown) => call(jar, path, json(body, 'PUT'));
const patch = (jar: Jar | null, path: string, body: unknown) => call(jar, path, json(body, 'PATCH'));
const del = (jar: Jar | null, path: string) => call(jar, path, { method: 'DELETE' });
const answer = async <T,>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const status = async (res: Promise<Response>) => (await res).status;

/** A workspace made through the API, members only (no guest link). */
async function workspace(owner: Jar, name = 'Quiet HQ'): Promise<string> {
  const res = await post(owner, '/offices', { name, kind: 'team', template: 'blank' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const members = (jar: Jar, id: string) => answer<MembersAnswer>(call(jar, `/offices/${id}/members`));
const tokenOf = (link: string | null) => link?.slice(link.indexOf('#guest=') + 7) ?? '';
const mailsTo = (to: string) => sent.filter((m) => m.to === to);
const inviteToken = (to: string) => mailsTo(to).at(-1)?.text.match(new RegExp(`${ORIGIN}/invite#t=([\\w-]{43})`))?.[1] ?? '';

/** Tries to join; the answer, refusals included. */
async function attempt(officeId: string, opts: { jar?: Jar; guest?: string; ownerKey?: string } = {}): Promise<JoinResponse> {
  const cookie = opts.jar?.header();
  const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: cookie ? { cookie } : {} });
  extra.push(socket);
  return new Promise((resolve) =>
    socket.on('connect', () => socket.emit('join', { officeId, name: 'Someone', avatar: DEFAULT_AVATAR, guest: opts.guest, ownerKey: opts.ownerKey }, resolve)),
  );
}

function next<E extends keyof ServerToClientEvents>(socket: Client, event: E, ms = 2000): Promise<Parameters<ServerToClientEvents[E]>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, ((...args: Parameters<ServerToClientEvents[E]>) => {
      clearTimeout(timer);
      resolve(args);
    }) as never);
  });
}

const inRoom = (officeId: string, socket: Client) => !!server.realtime.rooms.get(officeId)?.players.has(socket.id!);

describe('roles', () => {
  it('allow what the table says', () => {
    const office = (buildPolicy: 'everyone' | 'owner', guests: 'off' | 'link' | 'open') => ({ buildPolicy, guests });
    const table: [Action, Role[]][] = [
      ['see-members', ['owner', 'admin', 'member']],
      ['add-member', ['owner', 'admin']],
      ['remove-member', ['owner', 'admin']],
      ['guest-link', ['owner', 'admin']],
      ['add-admin', ['owner']],
      ['change-role', ['owner']],
      ['remove-admin', ['owner']],
      ['transfer', ['owner']],
    ];
    const roles: Role[] = ['owner', 'admin', 'member', 'guest'];
    for (const [action, allowed] of table) expect(roles.filter((r) => may(r, action)), action).toEqual(allowed);
    expect(may(null, 'see-members')).toBe(false);
    // Owners and admins always build; members when everyone may; guests only in open offices.
    expect(roles.filter((r) => may(r, 'build', office('owner', 'open')))).toEqual(['owner', 'admin']);
    expect(roles.filter((r) => may(r, 'build', office('everyone', 'link')))).toEqual(['owner', 'admin', 'member']);
    expect(roles.filter((r) => may(r, 'build', office('everyone', 'open')))).toEqual(roles);
    expect(may('member', 'build')).toBe(false);
  });
});

describe('who may come in', () => {
  it('members only in a new workspace; guests with the guest link, until it is reset or turned off', async () => {
    const owner = await signIn(base, 'Olive');
    const id = await workspace(owner);
    const stranger = await signIn(base, 'Stan');

    // Refused, with the reason and without the office's name.
    const refused = async (jar: Jar | null, headers: Record<string, string> = {}) => {
      const res = await call(jar, `/offices/${id}`, { headers });
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).not.toContain('Quiet HQ');
      return (JSON.parse(body) as { reason: string }).reason;
    };
    expect(await refused(null)).toBe('sign-in');
    expect(await refused(stranger)).toBe('members-only');
    expect(await refused(null, { 'X-Workchop-Guest': 'made-up' })).toBe('link');
    expect(await answer(call(owner, `/offices/${id}`))).toEqual({ id, name: 'Quiet HQ', kind: 'team', role: 'owner', online: 0 });
    expect(await attempt(id)).toEqual({ ok: false, error: 'Sign in to come in.', reason: 'sign-in' });
    expect(await attempt(id, { jar: stranger })).toEqual({ ok: false, error: 'Only members can come in.', reason: 'members-only' });
    const asStranger = await call(stranger, `/offices/${id}/members`);
    expect(asStranger.status).toBe(403);
    expect(await asStranger.text()).not.toContain('Quiet HQ');
    // Trying to come in doesn't make anyone a member.
    expect((await db.query('SELECT 1 FROM memberships WHERE office_id = $1', [id])).rowCount).toBe(1);

    // The guest link.
    const on = await answer<{ guests: string; link: string }>(put(owner, `/offices/${id}/access`, { guests: 'link' }));
    expect(on.guests).toBe('link');
    expect(on.link).toMatch(new RegExp(`^${ORIGIN}/o/${id}#guest=[\\w-]{43}$`));
    const first = tokenOf(on.link);
    expect(await answer(call(null, `/offices/${id}`, { headers: { 'X-Workchop-Guest': first } }))).toMatchObject({ role: 'guest' });
    const own = await join(base, id, 'Olive', { jar: owner });
    const guest = await join(base, id, 'Gus', { guest: first });
    expect(guest.res.ok && [guest.res.role, guest.res.kind, guest.res.guests, guest.res.isOwner]).toEqual(['guest', 'team', 'link', false]);
    const signedInGuest = await join(base, id, 'Stan', { jar: stranger, guest: first });
    expect(signedInGuest.res.ok && signedInGuest.res.role).toBe('guest');
    expect((await db.query('SELECT 1 FROM memberships WHERE office_id = $1', [id])).rowCount).toBe(1);

    // A new link: the old one lets nobody else in, and guests already in stay.
    const reset = await answer<{ guests: string; link: string }>(post(owner, `/offices/${id}/access/reset`));
    const second = tokenOf(reset.link);
    expect(second).not.toBe(first);
    expect(await refused(null, { 'X-Workchop-Guest': first })).toBe('link');
    expect(await attempt(id, { guest: first })).toMatchObject({ ok: false, reason: 'link' });
    // Signed in, what matters is that they aren't a member.
    expect(await refused(stranger, { 'X-Workchop-Guest': first })).toBe('members-only');
    expect(await attempt(id, { jar: stranger, guest: first })).toMatchObject({ ok: false, reason: 'members-only' });
    expect(await attempt(id, { guest: second })).toMatchObject({ ok: true, role: 'guest' });
    expect(inRoom(id, guest.socket)).toBe(true);

    // Off: the guests are taken out, and everyone else hears about it.
    const removed = [next(guest.socket, 'office:removed'), next(signedInGuest.socket, 'office:removed')];
    const told = next(own.socket, 'office:role');
    expect(await answer(put(owner, `/offices/${id}/access`, { guests: 'off' }))).toEqual({ guests: 'off', link: null });
    expect(await Promise.all(removed)).toEqual([['guests-off'], ['guests-off']]);
    expect(await told).toEqual(['owner', 'off']);
    await until(() => !inRoom(id, guest.socket) && !inRoom(id, signedInGuest.socket));
    expect(inRoom(id, own.socket)).toBe(true);
    expect(await refused(null, { 'X-Workchop-Guest': second })).toBe('link');

    // On again, it's another new link; 'open' can't be chosen.
    const again = await answer<{ link: string }>(put(owner, `/offices/${id}/access`, { guests: 'link' }));
    expect([first, second]).not.toContain(tokenOf(again.link));
    expect(await status(put(owner, `/offices/${id}/access`, { guests: 'open' }))).toBe(400);
    expect(await status(post(stranger, `/offices/${id}/access/reset`))).toBe(403);
    expect(await status(put(null, `/offices/${id}/access`, { guests: 'off' }))).toBe(401);
  });

  it('keeps offices from before workspaces open, and lets their owner key claim them', async () => {
    const legacy = async (name: string) => {
      const stored = await server.store.create(name, 'blank');
      await server.store.setAccess(stored.office.id, 'open', null);
      return stored;
    };
    const old = await legacy('Old HQ');
    const id = old.office.id;
    expect(await answer(call(null, `/offices/${id}`))).toEqual({ id, name: 'Old HQ', kind: 'team', role: 'guest', online: 0 });

    // Guests come in and build (everyone may, by default); the key still counts while nobody owns it.
    const keyGuest = await join(base, id, 'Kay', { ownerKey: old.ownerKey });
    expect(keyGuest.res.ok && [keyGuest.res.role, keyGuest.res.isOwner, keyGuest.res.guests]).toEqual(['guest', true, 'open']);
    const guest = await join(base, id, 'Gus');
    const built = next(keyGuest.socket, 'office:op');
    guest.socket.emit('office:op', { t: 'add', item: { id: 'sofa1', type: 'sofa', x: 5, z: 5, rot: 0 } });
    expect((await built)[0]).toMatchObject({ t: 'add', item: { id: 'sofa1' } });

    // Signed in with the key: it's theirs, and from then on the key alone does nothing.
    const kay = await verified('Kay');
    const claimed = await join(base, id, 'Kay', { jar: kay.jar, ownerKey: old.ownerKey });
    expect(claimed.res.ok && [claimed.res.role, claimed.res.isOwner]).toEqual(['owner', true]);
    expect((await answer<Space[]>(call(kay.jar, '/me/spaces'))).map((s) => [s.id, s.role, s.kind])).toEqual([[id, 'owner', 'team']]);
    const late = await signIn(base, 'Late');
    expect(await attempt(id, { jar: late, ownerKey: old.ownerKey })).toMatchObject({ ok: true, role: 'guest', isOwner: false });
    expect(await attempt(id, { ownerKey: old.ownerKey })).toMatchObject({ ok: true, role: 'guest', isOwner: false });

    // Tightening it: guests already in stay, but no longer build.
    const tightened = next(guest.socket, 'office:role');
    await put(kay.jar, `/offices/${id}/access`, { guests: 'link' });
    expect(await tightened).toEqual(['guest', 'link']);
    const bounced = next(guest.socket, 'office:sync');
    guest.socket.emit('office:op', { t: 'remove', id: 'sofa1' });
    expect((await bounced)[1]).toMatch(/only members/i);
    expect(await attempt(id)).toMatchObject({ ok: false, reason: 'sign-in' });

    // Claiming from the home page, with the keys this browser kept.
    const other = await legacy('Other HQ');
    const third = await legacy('Third HQ');
    const claim = (jar: Jar, offices: { id: string; ownerKey: string }[]) => answer<{ claimed: string[] }>(post(jar, '/offices/claim', { offices }));
    expect(await status(post(null, '/offices/claim', { offices: [] }))).toBe(401);
    expect(await claim(kay.jar, [{ id: other.office.id, ownerKey: 'wrong' }, { id: 'nonexistent', ownerKey: 'x' }])).toEqual({ claimed: [] });
    expect(await claim(kay.jar, [{ id: other.office.id, ownerKey: other.ownerKey }, { id, ownerKey: old.ownerKey }])).toEqual({ claimed: [other.office.id, id] });
    // Someone else's now, whoever has the key.
    expect(await claim(late, [{ id: other.office.id, ownerKey: other.ownerKey }, { id: third.office.id, ownerKey: third.ownerKey }])).toEqual({ claimed: [third.office.id] });
    expect((await db.query("SELECT office_id FROM memberships WHERE role = 'owner' AND office_id = ANY($1::text[]) ORDER BY office_id", [[id, other.office.id, third.office.id]])).rowCount).toBe(3);
  });

  // PGlite runs one statement at a time, so the claims can't race there.
  it.skipIf(!TEST_DATABASE_URL)('gives an office nobody owns one owner when two claim it at once', async () => {
    const stored = await server.store.create('Race HQ', 'blank');
    const claimers = await Promise.all([verified('Ann'), verified('Bea'), verified('Cy')]);
    const offices = [{ id: stored.office.id, ownerKey: stored.ownerKey }];
    const results = await Promise.all(claimers.map((c) => answer<{ claimed: string[] }>(post(c.jar, '/offices/claim', { offices }))));
    expect(results.map((r) => r.claimed.length).sort()).toEqual([0, 0, 1]);
    expect((await db.query("SELECT 1 FROM memberships WHERE office_id = $1 AND role = 'owner'", [stored.office.id])).rowCount).toBe(1);
  });

  it('puts a connection in one office at most, however fast it asks to join', async () => {
    const x = await createOffice(base, 'Xena', 'X HQ');
    const y = await createOffice(base, 'Yuri', 'Y HQ');
    // Signed in, a member of both, so each join waits on the database.
    const jar = await member(base, db, x.id, 'Racer');
    await member(base, db, y.id, jar);
    const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: jar.header() } });
    extra.push(socket);
    await new Promise((resolve) => socket.on('connect', () => resolve(null)));
    const id = socket.id!;
    const answers = await Promise.all([x.id, y.id, x.id, y.id].map((officeId) => socket.emitWithAck('join', { officeId, name: 'Racer', avatar: DEFAULT_AVATAR })));
    expect(answers.at(-1)).toMatchObject({ ok: true, role: 'member' });
    for (const a of answers.slice(0, -1)) if (!a.ok) expect(a.error).toBe('Replaced by a newer join.');
    const rooms = server.realtime.rooms;
    expect([rooms.get(x.id)?.players.has(id) ?? false, rooms.get(y.id)?.players.has(id)]).toEqual([false, true]);
    socket.disconnect();
    await until(() => !rooms.get(y.id)?.players.has(id));
    expect([rooms.get(x.id)?.players.size ?? 0, rooms.get(y.id)?.players.size ?? 0]).toEqual([0, 0]);
  });

  it('holds the guest cap while connections race between offices', { timeout: 30_000 }, async () => {
    const x = await createOffice(base);
    const y = await createOffice(base);
    const sockets = await Promise.all(
      Array.from({ length: MAX_GUESTS_PER_ROOM + 5 }, async () => {
        const socket: Client = connect(base, { transports: ['websocket'], forceNew: true });
        extra.push(socket);
        await new Promise((resolve) => socket.on('connect', () => resolve(null)));
        return socket;
      }),
    );
    // Busy, so they don't all call each other.
    const ask = (socket: Client, office: { id: string; guest: string }) =>
      socket.emitWithAck('join', { officeId: office.id, name: 'Guest', avatar: DEFAULT_AVATAR, status: 'busy', guest: office.guest });
    const answers = await Promise.all(sockets.map((socket) => Promise.all([ask(socket, x), ask(socket, y)])));
    expect(answers.filter(([, last]) => last.ok)).toHaveLength(MAX_GUESTS_PER_ROOM);
    const rooms = server.realtime.rooms;
    expect(rooms.get(x.id)?.players.size ?? 0).toBe(0);
    expect([rooms.get(y.id)?.players.size, rooms.get(y.id)?.guests.size]).toEqual([MAX_GUESTS_PER_ROOM, MAX_GUESTS_PER_ROOM]);
    for (const socket of sockets) socket.disconnect();
    await until(() => !rooms.get(y.id));
  });

  it(`keeps ${100 - MAX_GUESTS_PER_ROOM} places for members`, { timeout: 30_000 }, async () => {
    const office = await createOffice(base);
    // Busy, so they don't all call each other.
    const busyGuest = async () => {
      const socket: Client = connect(base, { transports: ['websocket'], forceNew: true });
      extra.push(socket);
      const res = await new Promise<JoinResponse>((resolve) =>
        socket.on('connect', () => socket.emit('join', { officeId: office.id, name: 'Guest', avatar: DEFAULT_AVATAR, status: 'busy', guest: office.guest }, resolve)),
      );
      return { socket, res };
    };
    const guests: Client[] = [];
    for (let i = 0; i < MAX_GUESTS_PER_ROOM / 10; i++) {
      for (const g of await Promise.all(Array.from({ length: 10 }, busyGuest))) {
        expect(g.res.ok).toBe(true);
        guests.push(g.socket);
      }
    }
    expect((await busyGuest()).res).toEqual({ ok: false, error: 'This office is full.' });
    expect((await join(base, office.id, 'Owner', { jar: office.owner })).res.ok).toBe(true);
    for (const g of guests) g.disconnect();
  });
});

describe('members', () => {
  it('are added by owners and admins, with roles only the owner changes, and can leave', async () => {
    const olive = await verified('Olive');
    const id = await workspace(olive.jar, 'Team HQ');
    const ada = await verified('Ada');
    const mo = await verified('Mo');
    const ned = await verified('Ned');

    // The owner adds an admin; an existing account is added at once, and emailed.
    const added = await post(olive.jar, `/offices/${id}/members`, { email: ada.email.toUpperCase(), role: 'admin' });
    expect(added.status).toBe(201);
    expect(((await added.json()) as { member: Member }).member).toMatchObject({ userId: ada.user.id, name: 'Ada', email: ada.email, role: 'admin' });
    expect(mailsTo(ada.email).at(-1)).toMatchObject({ subject: 'Olive added you to Team HQ' });
    expect(mailsTo(ada.email).at(-1)?.text).toContain(`${ORIGIN}/o/${id}`);

    // Admins add members, not admins; members add nobody.
    expect(await status(post(ada.jar, `/offices/${id}/members`, { email: ned.email, role: 'admin' }))).toBe(403);
    expect(await status(post(ada.jar, `/offices/${id}/members`, { email: mo.email }))).toBe(201);
    expect(await status(post(mo.jar, `/offices/${id}/members`, { email: ned.email }))).toBe(403);
    expect(await answer(post(ada.jar, `/offices/${id}/members`, { email: mo.email }))).toMatchObject({ code: 'member' });
    expect(await status(post(ada.jar, `/offices/${id}/members`, { email: 'not an address' }))).toBe(400);
    expect(await status(post(olive.jar, `/offices/${id}/members`, { email: ned.email, role: 'owner' }))).toBe(400);
    // Whoever adds people needs a confirmed address.
    const dev = await signIn(base, 'Dev');
    const devOffice = await workspace(dev);
    expect(await answer(post(dev, `/offices/${devOffice}/members`, { email: ned.email }))).toMatchObject({ code: 'unverified' });

    // Members see each other; only owners and admins see addresses, invitations and the guest link.
    const asMember = await members(mo.jar, id);
    expect(asMember.members.map((m) => [m.name, m.role])).toEqual([['Olive', 'owner'], ['Ada', 'admin'], ['Mo', 'member']]);
    expect(asMember.members.every((m) => !('email' in m))).toBe(true);
    expect(asMember.invites).toBeUndefined();
    expect(asMember.access).toBeUndefined();
    const asAdmin = await members(ada.jar, id);
    expect(asAdmin.members.map((m) => m.email)).toEqual([olive.email, ada.email, mo.email]);
    expect(asAdmin).toMatchObject({ invites: [], access: { guests: 'off', link: null } });

    // Spaces: their latest visit first.
    const moIn = await join(base, id, 'Mo', { jar: mo.jar });
    expect(moIn.res.ok && [moIn.res.role, moIn.res.isOwner]).toEqual(['member', false]);
    const adaIn = await join(base, id, 'Ada', { jar: ada.jar });
    expect((await answer<Space[]>(call(mo.jar, '/me/spaces'))).map((s) => [s.name, s.kind, s.role, s.online])).toEqual([['Team HQ', 'team', 'member', 2]]);

    // Only the owner changes roles, live for whoever it is.
    expect(await status(patch(ada.jar, `/offices/${id}/members/${mo.user.id}`, { role: 'admin' }))).toBe(403);
    const promoted = next(moIn.socket, 'office:role');
    expect(await answer(patch(olive.jar, `/offices/${id}/members/${mo.user.id}`, { role: 'admin' }))).toMatchObject({ member: { userId: mo.user.id, role: 'admin' } });
    expect(await promoted).toEqual(['admin', 'off']);
    expect(server.realtime.contextOf(moIn.socket.id!)?.role()).toBe('admin');
    expect(await status(patch(olive.jar, `/offices/${id}/members/${olive.user.id}`, { role: 'member' }))).toBe(400);
    expect(await status(patch(olive.jar, `/offices/${id}/members/${mo.user.id}`, { role: 'owner' }))).toBe(400);
    expect(await status(patch(olive.jar, `/offices/${id}/members/${ned.user.id}`, { role: 'admin' }))).toBe(404);
    await patch(olive.jar, `/offices/${id}/members/${mo.user.id}`, { role: 'member' });

    // Admins remove members (who are taken out at once), not admins or the owner.
    expect(await status(del(ada.jar, `/offices/${id}/members/${olive.user.id}`))).toBe(403);
    const out = next(moIn.socket, 'office:removed');
    expect(await status(del(ada.jar, `/offices/${id}/members/${mo.user.id}`))).toBe(200);
    expect(await out).toEqual(['removed']);
    await until(() => !inRoom(id, moIn.socket));
    expect(await attempt(id, { jar: mo.jar })).toMatchObject({ ok: false, reason: 'members-only' });
    expect(await status(del(ada.jar, `/offices/${id}/members/${mo.user.id}`))).toBe(404);

    // The owner can't leave without handing over first; others can.
    expect(await status(del(olive.jar, `/offices/${id}/members/${olive.user.id}`))).toBe(400);
    await post(olive.jar, `/offices/${id}/members`, { email: ned.email });
    expect(await status(del(ned.jar, `/offices/${id}/members/${ned.user.id}`))).toBe(200);
    expect(await answer<Space[]>(call(ned.jar, '/me/spaces'))).toEqual([]);

    // Handing over: the old owner becomes an admin, live, and there's still one owner.
    expect(await status(post(ada.jar, `/offices/${id}/owner`, { userId: ada.user.id }))).toBe(403);
    expect(await status(post(olive.jar, `/offices/${id}/owner`, { userId: ned.user.id }))).toBe(404);
    const oliveIn = await join(base, id, 'Olive', { jar: olive.jar });
    const demoted = next(oliveIn.socket, 'office:role');
    const crowned = next(adaIn.socket, 'office:role');
    expect(await status(post(olive.jar, `/offices/${id}/owner`, { userId: ada.user.id }))).toBe(200);
    expect(await demoted).toEqual(['admin', 'off']);
    expect(await crowned).toEqual(['owner', 'off']);
    expect(server.realtime.contextOf(adaIn.socket.id!)?.isOwner()).toBe(true);
    expect(server.realtime.contextOf(oliveIn.socket.id!)?.isOwner()).toBe(false);
    expect((await members(ada.jar, id)).members.map((m) => [m.name, m.role])).toEqual([['Ada', 'owner'], ['Olive', 'admin']]);
    expect(await status(post(olive.jar, `/offices/${id}/owner`, { userId: olive.user.id }))).toBe(403);
    // Now the owner can remove the admin.
    expect(await status(del(ada.jar, `/offices/${id}/members/${olive.user.id}`))).toBe(200);
  });

  it('are invited by email when they have no account, and join on accepting or signing up later', async () => {
    const olive = await verified('Olive');
    const id = await workspace(olive.jar, 'Invite HQ');
    const ada = await verified('Ada');
    await post(olive.jar, `/offices/${id}/members`, { email: ada.email, role: 'admin' });

    // No account with that address: an invitation, emailed.
    const res = await post(olive.jar, `/offices/${id}/members`, { email: 'Pat.New@Example.com' });
    expect(res.status).toBe(202);
    const { invite } = (await res.json()) as { invite: Invite };
    expect(invite).toMatchObject({ email: 'pat.new@example.com', role: 'member', invitedBy: 'Olive', emailed: true });
    expect(invite.expiresAt - Date.now()).toBeGreaterThan(13.9 * 24 * 3600_000);
    expect(mailsTo('pat.new@example.com').at(-1)).toMatchObject({ subject: 'Olive invited you to Invite HQ' });
    const token = inviteToken('pat.new@example.com');
    expect(token).toHaveLength(43);
    expect(await answer(post(olive.jar, `/offices/${id}/members`, { email: 'pat.new@example.com' }))).toMatchObject({ code: 'invited' });
    // Once expired, an invitation stops working and gives way to a new one.
    await post(olive.jar, `/offices/${id}/members`, { email: 'gone@example.com' });
    await db.query("UPDATE office_invites SET expires_at = now() - interval '1 minute' WHERE email = 'gone@example.com'");
    expect(await status(post(null, '/invites/preview', { token: inviteToken('gone@example.com') }))).toBe(400);
    const renewed = await post(olive.jar, `/offices/${id}/members`, { email: 'gone@example.com' });
    expect(renewed.status).toBe(202);
    expect(await status(del(olive.jar, `/offices/${id}/invites/${((await renewed.json()) as { invite: Invite }).invite.id}`))).toBe(200);
    expect((await members(ada.jar, id)).invites?.map((i) => i.email)).toEqual(['pat.new@example.com']);
    // Only its hash is kept.
    expect(JSON.stringify((await db.query('SELECT * FROM office_invites')).rows)).not.toContain(token);

    // The link shows what it's for, without using it up.
    expect(await answer(post(null, '/invites/preview', { token }))).toEqual({ officeId: id, officeName: 'Invite HQ', email: 'pat.new@example.com', role: 'member', hasAccount: false });
    expect(await answer(post(null, '/invites/preview', { token: 'x'.repeat(43) }))).toMatchObject({ code: 'expired' });

    // Accepting makes the account (with that address confirmed) and signs in.
    const pat = new Jar();
    expect(await status(post(pat, '/invites/accept', { token, name: 'Pat', password: 'short' }))).toBe(400);
    expect(await status(post(pat, '/invites/accept', { token, name: ' ', password: PASSWORD }))).toBe(400);
    const accepted = await post(pat, '/invites/accept', { token, name: 'Pat', password: PASSWORD, avatar: { ...DEFAULT_AVATAR, hair: 'bun' } });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { user: AccountUser; officeId: string };
    expect(body).toMatchObject({ officeId: id, user: { name: 'Pat', email: 'pat.new@example.com', emailVerified: true, hasPassword: true, profile: { avatar: { hair: 'bun' } } } });
    expect((await answer<Space[]>(call(pat, '/me/spaces'))).map((s) => [s.id, s.role])).toEqual([[id, 'member']]);
    expect(await status(post(new Jar(), '/invites/accept', { token, name: 'Pat', password: PASSWORD }))).toBe(400);
    expect((await members(ada.jar, id)).invites).toEqual([]);

    // Signed in with another address: not yours to accept. With the account that has it: accepted.
    await post(olive.jar, `/offices/${id}/members`, { email: 'sam@example.com' });
    const samToken = inviteToken('sam@example.com');
    expect(await answer(post(pat, '/invites/accept', { token: samToken }))).toEqual({ error: 'This invite is for sam@example.com.', code: 'other-account' });
    const sam = await verified('Sam', 'sam@example.com');
    // (Signing up with the address joined it already, so this link is used up.)
    expect(await answer(post(sam.jar, '/invites/accept', { token: samToken }))).toMatchObject({ code: 'expired' });
    expect((await answer<Space[]>(call(sam.jar, '/me/spaces'))).map((s) => [s.id, s.role])).toEqual([[id, 'member']]);

    // Admins revoke and resend members' invitations, not admins'; a resent one has a new link.
    await post(olive.jar, `/offices/${id}/members`, { email: 'boss@example.com', role: 'admin' });
    await post(ada.jar, `/offices/${id}/members`, { email: 'kim@example.com' });
    const pending = (await members(ada.jar, id)).invites!;
    const boss = pending.find((i) => i.email === 'boss@example.com')!;
    const kim = pending.find((i) => i.email === 'kim@example.com')!;
    expect(await status(del(ada.jar, `/offices/${id}/invites/${boss.id}`))).toBe(403);
    const oldKim = inviteToken('kim@example.com');
    expect(await status(post(ada.jar, `/offices/${id}/invites/${kim.id}/resend`))).toBe(202);
    const newKim = inviteToken('kim@example.com');
    expect(newKim).not.toBe(oldKim);
    expect(await status(post(null, '/invites/preview', { token: oldKim }))).toBe(400);
    expect(await answer(post(null, '/invites/preview', { token: newKim }))).toMatchObject({ email: 'kim@example.com' });
    expect(await status(del(ada.jar, `/offices/${id}/invites/${kim.id}`))).toBe(200);
    expect(await status(post(null, '/invites/preview', { token: newKim }))).toBe(400);
    expect(await status(del(ada.jar, `/offices/${id}/invites/${kim.id}`))).toBe(404);

    // An invitation joins whoever later confirms the address, not an account that only claims it.
    await signIn(base, 'Not Boss', 'boss@example.com');
    expect((await members(olive.jar, id)).members.map((m) => m.name)).not.toContain('Not Boss');
    const realBoss = await verified('Boss', 'boss@example.com');
    expect((await members(olive.jar, id)).members.find((m) => m.userId === realBoss.user.id)?.role).toBe('admin');
    expect((await members(olive.jar, id)).invites).toEqual([]);
  });

  it('see the workspaces they have been to first, most recent first, then the ones they were added to', async () => {
    const carol = await verified('Carol');
    const olive = await verified('Olive');
    const team = await workspace(olive.jar, 'Team HQ');
    const own = await workspace(carol.jar, 'Carol HQ');
    const spaces = async () => (await answer<Space[]>(call(carol.jar, '/me/spaces'))).map((s) => s.name);
    // Added (and invited, then signing up) after making her own: hers stays her default.
    await post(olive.jar, `/offices/${team}/members`, { email: carol.email });
    const side = await workspace(olive.jar, 'Side HQ');
    await post(olive.jar, `/offices/${side}/members`, { email: 'carol.other@example.com' });
    await accounts.confirmEmail(carol.user.id, 'carol.other@example.com');
    expect(await spaces()).toEqual(['Carol HQ', 'Side HQ', 'Team HQ']);
    const visits = async () => (await answer<Space[]>(call(carol.jar, '/me/spaces'))).map((s) => s.lastVisitAt);
    expect((await visits()).map((v) => v !== null)).toEqual([true, false, false]);
    // Once she has been there, it's first.
    const visit = await join(base, team, 'Carol', { jar: carol.jar });
    expect(await spaces()).toEqual(['Team HQ', 'Carol HQ', 'Side HQ']);
    expect((await visits())[0]).toBeGreaterThan(Date.now() - 60_000);
    visit.socket.disconnect();
    await join(base, own, 'Carol', { jar: carol.jar });
    expect(await spaces()).toEqual(['Carol HQ', 'Team HQ', 'Side HQ']);
  });

  it('who come in as guests become members at once when added', async () => {
    const olive = await verified('Olive');
    const office = await createOffice(base, olive.jar, 'Guest HQ');
    const gia = await verified('Gia');
    const visiting = await join(base, office.id, 'Gia', { jar: gia.jar });
    expect(visiting.res.ok && visiting.res.role).toBe('guest');
    const welcomed = next(visiting.socket, 'office:role');
    await post(olive.jar, `/offices/${office.id}/members`, { email: gia.email });
    expect(await welcomed).toEqual(['member', 'link']);
    // And member() (for other tests) does the same as adding them.
    const jar = await member(base, db, office.id, 'Mem');
    expect((await join(base, office.id, 'Mem', { jar, guest: '' })).res).toMatchObject({ ok: true, role: 'member' });
  });

  it('who come in as guests become members as soon as an invitation applies', async () => {
    const olive = await verified('Olive');
    const office = await createOffice(base, olive.jar, 'Live HQ');
    // In with the guest link, signed in with an address not confirmed yet.
    const gia = await signIn(base, 'Gia', 'gia.live@example.com');
    const visiting = await join(base, office.id, 'Gia', { jar: gia });
    expect(await status(post(olive.jar, `/offices/${office.id}/members`, { email: 'gia.live@example.com' }))).toBe(202);
    const welcomed = next(visiting.socket, 'office:role');
    // Confirming the address (in Profile) applies the invitation.
    expect(await status(post(gia, '/me/email', { email: 'gia.live@example.com' }))).toBe(202);
    const confirmLink = () => mailsTo('gia.live@example.com').at(-1)?.text.match(new RegExp(`${ORIGIN}/confirm-email#t=([\\w-]{43})`))?.[1];
    await until(() => !!confirmLink());
    expect(await status(post(gia, '/auth/email/confirm', { token: confirmLink() }))).toBe(200);
    expect(await welcomed).toEqual(['member', 'link']);

    // Accepting one while signed in, and there as a guest, does the same.
    const hal = await verified('Hal');
    const there = await join(base, office.id, 'Hal', { jar: hal.jar });
    const token = 'h'.repeat(43);
    // (An invitation from before Hal's account had this address.)
    await db.query(`INSERT INTO office_invites (id, office_id, email, role, token_hash, expires_at) VALUES ('halinvite', $1, $2, 'member', $3, now() + interval '1 day')`, [
      office.id,
      hal.email,
      hashToken(token),
    ]);
    const promoted = next(there.socket, 'office:role');
    expect(await answer(post(hal.jar, '/invites/accept', { token }))).toMatchObject({ officeId: office.id });
    expect(await promoted).toEqual(['member', 'link']);
  });

  it('are listed in chat for members only', async () => {
    const office = await createOffice(base, 'Olga');
    const mel = await member(base, db, office.id, 'Mel');
    const guest = await join(base, office.id, 'Gus');
    const inside = await join(base, office.id, 'Mel', { jar: mel });
    expect(await guest.socket.emitWithAck('chat:people')).toEqual({ ok: true, people: [] });
    const people = await inside.socket.emitWithAck('chat:people');
    expect(people.ok && people.people.map((p) => p.name).sort()).toEqual(['Mel', 'Olga']);
  });
});

describe('while someone is joining or accepting', () => {
  let other: Awaited<ReturnType<typeof startServer>>;
  let at: string;
  /** Runs before an account is loaded (a join waits on it). */
  let hold: (() => Promise<void>) | null = null;
  let failMemberships = false;

  beforeAll(async () => {
    const wrap = (tx: Tx): Tx => ({
      query: async <T,>(sql: string, params?: unknown[]) => {
        if (hold && /FROM users WHERE id = \$1$/.test(sql)) await hold();
        if (failMemberships && sql.startsWith('INSERT INTO memberships (user_id, office_id, role) VALUES')) throw new Error('database is away');
        return tx.query<T>(sql, params);
      },
      exec: (sql) => tx.exec(sql),
    });
    const wrapped: Db = { ...wrap(db), kind: db.kind, description: db.description, transaction: (fn) => db.transaction((tx) => fn(wrap(tx))), close: async () => {} };
    other = await startServer({ port: 0, host: '127.0.0.1', db: wrapped, quiet: true, iceServers: [], publicUrl: ORIGIN, auth: { google: null, apple: null, devLogin: true }, mailer: recorder });
    at = `http://127.0.0.1:${other.port}`;
  }, 60_000);

  afterAll(() => other?.close());

  /** Holds the next account load until the returned function is called; `held` says when it waits. */
  function holdNext() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const state = { held: false };
    hold = async () => {
      hold = null;
      state.held = true;
      await gate;
    };
    return { state, release };
  }

  const joinAt = (officeId: string, jar: Jar, guest?: string) => {
    const socket: Client = connect(at, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: jar.header() } });
    extra.push(socket);
    return new Promise<JoinResponse>((resolve) => socket.on('connect', () => socket.emitWithAck('join', { officeId, name: 'Joiner', avatar: DEFAULT_AVATAR, guest }).then(resolve)));
  };
  const userId = async (jar: Jar) => ((await (await jar.fetch(`${at}/api/me`)).json()) as { user: AccountUser }).user.id;

  it('checks again who may come in when that changed meanwhile', async () => {
    const office = await createOffice(at, 'Olive');
    const mo = await member(at, db, office.id, 'Mo');
    // Removed while the join waits.
    let wait = holdNext();
    const moJoining = joinAt(office.id, mo, '');
    await until(() => wait.state.held);
    expect((await office.owner.fetch(`${at}/api/offices/${office.id}/members/${await userId(mo)}`, { method: 'DELETE' })).status).toBe(200);
    wait.release();
    expect(await moJoining).toMatchObject({ ok: false, reason: 'members-only' });

    // The guest link turned off while a signed-in guest's join waits.
    const vic = await signIn(at, 'Vic');
    wait = holdNext();
    const vicJoining = joinAt(office.id, vic, office.guest);
    await until(() => wait.state.held);
    expect((await office.owner.fetch(`${at}/api/offices/${office.id}/access`, json({ guests: 'off' }, 'PUT'))).status).toBe(200);
    wait.release();
    expect(await vicJoining).toMatchObject({ ok: false, reason: 'members-only' });
    expect(other.realtime.onlineCount(office.id)).toBe(0);
  });

  it('accepts an invitation entirely or not at all', async () => {
    const olive = await verified('Olive');
    const office = await createOffice(at, olive.jar, 'Careful HQ');
    expect((await olive.jar.fetch(`${at}/api/offices/${office.id}/members`, json({ email: 'wanda@example.com' }))).status).toBe(202);
    const token = inviteToken('wanda@example.com');
    const accept = () => new Jar().fetch(`${at}/api/invites/accept`, json({ token, name: 'Wanda', password: PASSWORD }));
    failMemberships = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await accept()).status).toBe(500);
    } finally {
      failMemberships = false;
      errors.mockRestore();
    }
    // No account, and the invitation still works.
    expect(await accounts.byVerifiedEmail('wanda@example.com')).toBeNull();
    expect((await fetch(`${at}/api/invites/preview`, json({ token }))).status).toBe(200);
    const res = await accept();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ officeId: office.id, user: { email: 'wanda@example.com' } });
  });
});
