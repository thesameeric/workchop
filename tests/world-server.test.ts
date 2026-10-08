import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR } from '../shared/avatar';
import type { AccountUser } from '../shared/account';
import type { OfficeItem, OfficeOp } from '../shared/types';
import { deskOwner, isLightOn, MAX_NOTES_PER_DESK, type DeskNote, type StickySummary } from '../shared/world';
import { feature as world } from '../server/features/world';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, json, until, type Client } from './helpers/http';

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-world-'));
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    db: await createTestDb(),
    dataDir,
    quiet: true,
    iceServers: [],
    features: [world],
    auth: { google: null, apple: null, devLogin: true },
  });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  for (const s of extra) s.disconnect();
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function signIn(name: string): Promise<{ jar: Jar; user: AccountUser }> {
  const jar = new Jar();
  const res = await jar.fetch(`${base}/api/auth/dev`, json({ name, email: `${name.toLowerCase()}@example.com` }));
  return { jar, user: ((await res.json()) as { user: AccountUser }).user };
}

/** Collects what a socket hears. */
function listen(socket: Client) {
  const heard = { ops: [] as OfficeOp[], stickies: [] as Record<string, StickySummary>[], inbox: [] as number[], notes: [] as DeskNote[], notices: [] as string[] };
  socket.on('office:op', (op) => heard.ops.push(op));
  socket.on('desk:stickies', (s) => heard.stickies.push(s));
  socket.on('desk:inbox', (_office, n) => heard.inbox.push(n));
  socket.on('desk:note:new', (note) => heard.notes.push(note));
  socket.on('notice', (text) => heard.notices.push(text));
  return heard;
}

const extra: Client[] = [];

const itemOf = (officeId: string, id: string) => server.store.peek(officeId)!.office.items.find((i) => i.id === id)!;

/** An office with a desk ('d1', 'd2'), a lamp and a light switch. */
async function setUp(ownerJar?: Jar) {
  const { id, ownerKey } = await createOffice(base, ownerJar);
  const owner = await join(base, id, 'Owner', { jar: ownerJar, ownerKey });
  const add = (item: OfficeItem) => owner.socket.emit('office:op', { t: 'add', item });
  add({ id: 'd1', type: 'desk', x: 5, z: 5, rot: 0 });
  add({ id: 'd2', type: 'desk', x: 9, z: 5, rot: 0 });
  add({ id: 'lamp', type: 'floor-lamp', x: 2.25, z: 2.25, rot: 0 });
  add({ id: 'sw', type: 'light-switch', x: 3.25, z: 0.25, rot: 0 });
  await until(() => !!server.store.peek(id)?.office.items.find((i) => i.id === 'sw'));
  return { id, ownerKey, owner };
}

describe('lights', () => {
  it('can be switched by anyone, guests included, and everyone sees it', async () => {
    const { id, owner } = await setUp();
    const guest = await join(base, id, 'Guest');
    const heard = listen(owner.socket);
    guest.socket.emit('world:light', 'lamp', false);
    guest.socket.emit('world:light', 'sw', false);
    await until(() => heard.ops.length === 2);
    expect(isLightOn(itemOf(id, 'lamp'))).toBe(false);
    expect(isLightOn(itemOf(id, 'sw'))).toBe(false);
    expect(heard.ops.map((op) => op.t === 'update' && [op.item.id, op.item.data])).toEqual([
      ['lamp', { on: false }],
      ['sw', { on: false }],
    ]);
    // Not a light: refused with a notice.
    const guestHeard = listen(guest.socket);
    guest.socket.emit('world:light', 'd1', true);
    await until(() => guestHeard.notices.length === 1);
    expect(guestHeard.notices).toEqual(['That light is gone.']);
  });

  it("can't be flipped or forged through build edits, even when only the owner may build", async () => {
    const { id, owner } = await setUp();
    owner.socket.emit('office:op', { t: 'settings', settings: { buildPolicy: 'owner' } });
    await until(() => server.store.peek(id)!.office.settings.buildPolicy === 'owner');
    // The owner moves the lamp with data that says it's off: the move happens, the data doesn't.
    owner.socket.emit('office:op', { t: 'update', item: { ...itemOf(id, 'lamp'), x: 3.25, data: { on: false } } });
    await until(() => itemOf(id, 'lamp').x === 3.25);
    expect(isLightOn(itemOf(id, 'lamp'))).toBe(true);
    // A guest still switches it with the light op.
    const guest = await join(base, id, 'Guest');
    guest.socket.emit('world:light', 'lamp', false);
    await until(() => !isLightOn(itemOf(id, 'lamp')));
  });
});

describe('desks', () => {
  it('are claimed by members only, one each, and freed by their owner or an editor', async () => {
    const ana = await signIn('Ana');
    const ben = await signIn('Ben');
    const { id, owner } = await setUp();
    const a = await join(base, id, 'Ana', { jar: ana.jar });
    const b = await join(base, id, 'Ben', { jar: ben.jar });
    const guest = await join(base, id, 'Gus');

    expect(await guest.socket.emitWithAck('desk:claim', 'd1')).toEqual({ ok: false, error: 'Sign in to claim a desk.' });
    expect(await a.socket.emitWithAck('desk:claim', 'd1')).toEqual({ ok: true });
    expect(deskOwner(itemOf(id, 'd1'))).toEqual({ ownerUserId: ana.user.id, ownerName: 'Ana' });
    expect(await b.socket.emitWithAck('desk:claim', 'd1')).toEqual({ ok: false, error: 'This is Ana’s desk.' });
    // Claiming another desk moves Ana's claim.
    expect(await a.socket.emitWithAck('desk:claim', 'd2')).toEqual({ ok: true });
    expect(deskOwner(itemOf(id, 'd1'))).toBeNull();
    expect(deskOwner(itemOf(id, 'd2'))?.ownerUserId).toBe(ana.user.id);

    // Ben can't free it… but the office is open for editing to everyone, so a guest editor can.
    owner.socket.emit('office:op', { t: 'settings', settings: { buildPolicy: 'owner' } });
    await until(() => server.store.peek(id)!.office.settings.buildPolicy === 'owner');
    expect(await b.socket.emitWithAck('desk:release', 'd2')).toMatchObject({ ok: false });
    expect(await owner.socket.emitWithAck('desk:release', 'd2')).toEqual({ ok: true });
    expect(deskOwner(itemOf(id, 'd2'))).toBeNull();
    expect(await a.socket.emitWithAck('desk:claim', 'd2')).toEqual({ ok: true });
    expect(await a.socket.emitWithAck('desk:release', 'd2')).toEqual({ ok: true });
  });

  it("keep their claim when moved, and copies don't inherit it", async () => {
    const ana = await signIn('Ana');
    const { id, owner } = await setUp();
    const a = await join(base, id, 'Ana', { jar: ana.jar });
    await a.socket.emitWithAck('desk:claim', 'd1');
    owner.socket.emit('office:op', { t: 'update', item: { ...itemOf(id, 'd1'), x: 6, data: undefined } });
    owner.socket.emit('office:op', { t: 'add', item: { ...itemOf(id, 'd1'), id: 'copy', z: 9 } });
    await until(() => !!server.store.peek(id)!.office.items.find((i) => i.id === 'copy'));
    expect(itemOf(id, 'd1').x).toBe(6);
    expect(deskOwner(itemOf(id, 'd1'))?.ownerUserId).toBe(ana.user.id);
    expect(deskOwner(itemOf(id, 'copy'))).toBeNull();
    // Forging a claim through a build edit doesn't work either.
    owner.socket.emit('office:op', { t: 'update', item: { ...itemOf(id, 'd2'), data: { ownerUserId: 'someone', ownerName: 'X' } } });
    await new Promise((r) => setTimeout(r, 100));
    expect(deskOwner(itemOf(id, 'd2'))).toBeNull();
  });
});

describe('desk notes', () => {
  it('reach the owner (live and on their next visit); everyone else sees only that they exist', async () => {
    const ana = await signIn('Ana');
    const ben = await signIn('Ben');
    const { id } = await setUp();
    const a = await join(base, id, 'Ana', { jar: ana.jar });
    await a.socket.emitWithAck('desk:claim', 'd1');
    const anaHeard = listen(a.socket);
    const b = await join(base, id, 'Ben', { jar: ben.jar });
    const bHeard = listen(b.socket);
    const guest = await join(base, id, 'Gus');
    const guestKey = 'g'.repeat(32);

    expect(await a.socket.emitWithAck('desk:note', 'd1', { text: 'note to self', color: '#ffe066' })).toEqual({ ok: false, error: 'That’s your own desk.' });
    expect(await b.socket.emitWithAck('desk:note', 'd2', { text: 'hi', color: '#ffe066' })).toEqual({ ok: false, error: 'Nobody has claimed this desk yet.' });
    expect(await b.socket.emitWithAck('desk:note', 'd1', { text: '   ', color: '#ffe066' })).toEqual({ ok: false, error: 'Write something first.' });

    const sent = await b.socket.emitWithAck('desk:note', 'd1', { text: 'Lunch at 12?', color: '#9fd4ff' });
    expect(sent).toMatchObject({ ok: true, note: { authorName: 'Ben', text: 'Lunch at 12?', color: '#9fd4ff', readAt: null } });
    const fromGuest = await guest.socket.emitWithAck('desk:note', 'd1', { text: 'Welcome!', color: 'nope', guestKey });
    expect(fromGuest).toMatchObject({ ok: true, note: { authorName: 'Gus', color: '#ffe066' } });

    // Ana hears about each note; everyone gets the sticky colours, never the text.
    await until(() => anaHeard.notes.length === 2 && anaHeard.inbox.at(-1) === 2 && bHeard.stickies.at(-1)?.[ana.user.id]?.count === 2);
    expect(anaHeard.notes.map((n) => n.text)).toEqual(['Lunch at 12?', 'Welcome!']);
    expect(bHeard.stickies.at(-1)).toEqual({ [ana.user.id]: { count: 2, colors: ['#9fd4ff', '#ffe066'] } });
    expect(JSON.stringify(bHeard.stickies)).not.toContain('Lunch');

    // Only Ana can list them; Ben and the guest see just their own.
    const list = await a.socket.emitWithAck('desk:notes');
    expect(list.ok && list.notes.map((n) => n.text)).toEqual(['Welcome!', 'Lunch at 12?']);
    expect(await guest.socket.emitWithAck('desk:notes')).toEqual({ ok: false, error: 'Sign in to have a desk.' });
    const bensList = await b.socket.emitWithAck('desk:notes');
    expect(bensList.ok && bensList.notes).toEqual([]);
    const bens = await b.socket.emitWithAck('desk:authored', ana.user.id, null);
    expect(bens.ok && bens.notes.map((n) => n.text)).toEqual(['Lunch at 12?']);
    const guests = await guest.socket.emitWithAck('desk:authored', ana.user.id, guestKey);
    expect(guests.ok && guests.notes.map((n) => n.text)).toEqual(['Welcome!']);
    const stranger = await guest.socket.emitWithAck('desk:authored', ana.user.id, 'x'.repeat(32));
    expect(stranger.ok && stranger.notes).toEqual([]);

    // Coming back later: the stickies and the unread count arrive on joining.
    a.socket.disconnect();
    const fresh = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: ana.jar.header() } }) as Client;
    extra.push(fresh);
    const later = listen(fresh);
    await new Promise((resolve) => fresh.on('connect', () => fresh.emit('join', { officeId: id, name: 'Ana', avatar: DEFAULT_AVATAR }, resolve)));
    await until(() => later.inbox.length > 0 && later.stickies.length > 0);
    expect(later.inbox).toEqual([2]);
    expect(later.stickies[0][ana.user.id].count).toBe(2);

    // Reading them clears the badge.
    const readAll = await fresh.emitWithAck('desk:note:read', 'all');
    expect(readAll).toEqual({ ok: true });
    const relisted = await fresh.emitWithAck('desk:notes');
    expect(relisted.ok && relisted.notes.every((n) => n.readAt !== null)).toBe(true);
  });

  it('can be deleted by their author or the desk owner, nobody else', async () => {
    const ana = await signIn('Ana');
    const ben = await signIn('Ben');
    const cat = await signIn('Cat');
    const { id } = await setUp();
    const a = await join(base, id, 'Ana', { jar: ana.jar });
    await a.socket.emitWithAck('desk:claim', 'd1');
    const b = await join(base, id, 'Ben', { jar: ben.jar });
    const c = await join(base, id, 'Cat', { jar: cat.jar });
    const guest = await join(base, id, 'Gus');
    const key = 'k'.repeat(30);
    const n1 = await b.socket.emitWithAck('desk:note', 'd1', { text: 'one', color: '#ffe066' });
    const n2 = await guest.socket.emitWithAck('desk:note', 'd1', { text: 'two', color: '#ffe066', guestKey: key });
    const n3 = await c.socket.emitWithAck('desk:note', 'd1', { text: 'three', color: '#ffe066' });
    if (!n1.ok || !n2.ok || !n3.ok) throw new Error('notes not saved');
    const denied = { ok: false, error: 'Only the desk’s owner or the note’s author can remove it.' };

    expect(await c.socket.emitWithAck('desk:note:delete', n1.note.id, null)).toEqual(denied);
    expect(await guest.socket.emitWithAck('desk:note:delete', n1.note.id, key)).toEqual(denied);
    expect(await guest.socket.emitWithAck('desk:note:delete', n2.note.id, 'z'.repeat(30))).toEqual(denied);
    expect(await b.socket.emitWithAck('desk:note:delete', n1.note.id, null)).toEqual({ ok: true });
    expect(await guest.socket.emitWithAck('desk:note:delete', n2.note.id, key)).toEqual({ ok: true });
    expect(await a.socket.emitWithAck('desk:note:delete', n3.note.id, null)).toEqual({ ok: true });
    expect(await a.socket.emitWithAck('desk:note:delete', n3.note.id, null)).toEqual({ ok: false, error: 'That note is gone.' });
    const left = await a.socket.emitWithAck('desk:notes');
    expect(left.ok && left.notes).toEqual([]);
  });

  it('make room by dropping old read notes, but never unread ones', async () => {
    const ana = await signIn('Ana');
    const { id } = await setUp();
    const a = await join(base, id, 'Ana', { jar: ana.jar });
    await a.socket.emitWithAck('desk:claim', 'd1');
    // Fill the desk straight in the database (the socket would rate-limit this).
    const ownerId = ana.user.id;
    for (let i = 0; i < MAX_NOTES_PER_DESK; i++) {
      await server.db.query(
        `INSERT INTO desk_notes (id, office_id, item_id, owner_user_id, author_name, text, color, created_at)
         VALUES ($1, $2, 'd1', $3, 'Bot', $4, '#ffe066', now() - make_interval(mins => $5))`,
        [`filler${i}abc`, id, ownerId, `n${i}`, MAX_NOTES_PER_DESK - i],
      );
    }
    const guest = await join(base, id, 'Gus');
    expect(await guest.socket.emitWithAck('desk:note', 'd1', { text: 'more', color: '#ffe066' })).toEqual({
      ok: false,
      error: 'Ana’s desk is covered in unread notes. Try again later.',
    });
    await a.socket.emitWithAck('desk:note:read', 'filler0abc');
    expect(await guest.socket.emitWithAck('desk:note', 'd1', { text: 'more', color: '#ffe066' })).toMatchObject({ ok: true });
    const list = await a.socket.emitWithAck('desk:notes');
    expect(list.ok && list.notes.length).toBe(MAX_NOTES_PER_DESK);
    expect(list.ok && list.notes.some((n) => n.id === 'filler0abc')).toBe(false);
  });

  it('never go over the limit, even when many arrive at once', async () => {
    const ana = await signIn('Ana');
    const { id } = await setUp();
    const a = await join(base, id, 'Ana', { jar: ana.jar });
    await a.socket.emitWithAck('desk:claim', 'd1');
    // Room for two more.
    await server.db.query(
      `INSERT INTO desk_notes (id, office_id, item_id, owner_user_id, author_name, text, color)
       SELECT 'rush' || i || 'abcd', $1, 'd1', $2, 'Bot', 'n' || i, '#ffe066' FROM generate_series(1, $3::int) AS i`,
      [id, ana.user.id, MAX_NOTES_PER_DESK - 2],
    );
    const guests = await Promise.all(['Gus', 'Hal', 'Ida', 'Jo'].map((name) => join(base, id, name)));
    const results = await Promise.all(
      guests.flatMap((g) => [1, 2, 3].map((n) => g.socket.emitWithAck('desk:note', 'd1', { text: `Note ${n}`, color: '#ffe066' }))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const { rows } = await server.db.query<{ n: number }>('SELECT count(*)::int AS n FROM desk_notes WHERE office_id = $1', [id]);
    expect(rows[0].n).toBe(MAX_NOTES_PER_DESK);
  });
});
