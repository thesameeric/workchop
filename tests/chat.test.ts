import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUser } from '../shared/account';
import type { ChatChannel, ChatResult, SendRequest } from '../shared/chat';
import type { ServerToClientEvents } from '../shared/types';
import type { UploadedFile } from '../shared/uploads';
import { chatFeature } from '../server/features/chat';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, json, until, type Client } from './helpers/http';

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-chat-'));
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    db: await createTestDb(),
    dataDir,
    quiet: true,
    iceServers: [],
    // Old conversations are looked for on every join here (hourly by default).
    features: [chatFeature({ retentionDays: 30, sweepEveryMs: 0 })],
    uploads: { storage: 'fs', maxBytes: 100_000 },
    auth: { google: null, apple: null, devLogin: true },
  });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  disconnectAll();
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ok<T extends object>(res: ChatResult<T>): T {
  if (!res.ok) throw new Error(res.error);
  return res;
}

function failed(res: ChatResult<object>): string {
  if (res.ok) throw new Error('expected the request to fail');
  return res.error;
}

/** Everything a socket receives of one event, from now on. */
function collect<E extends keyof ServerToClientEvents>(socket: Client, event: E): Parameters<ServerToClientEvents[E]>[] {
  const got: Parameters<ServerToClientEvents[E]>[] = [];
  socket.on(event, ((...args: Parameters<ServerToClientEvents[E]>) => got.push(args)) as never);
  return got;
}

async function signIn(name: string) {
  const jar = new Jar();
  const res = await jar.fetch(`${base}/api/auth/dev`, json({ name, email: `${name.toLowerCase()}@example.com` }));
  const { user } = (await res.json()) as { user: AccountUser };
  return { jar, user };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (c: Client, req: SendRequest) => c.emitWithAck('chat:send', req);
const channels = async (c: Client) => ok(await c.emitWithAck('chat:channels'));
const general = async (c: Client): Promise<ChatChannel> => (await channels(c)).channels.find((ch) => ch.isDefault)!;

/** Locks building (and so channel management and moderation) to the owner. */
async function ownerOnly(owner: Client, other: Client) {
  const seen = collect(other, 'office:op');
  owner.emit('office:op', { t: 'settings', settings: { buildPolicy: 'owner' } });
  await until(() => seen.length > 0);
}

async function upload(c: Client, uploadKey: string, officeId: string, name: string, body: Buffer, type = 'image/png'): Promise<UploadedFile> {
  const res = await fetch(`${base}/api/offices/${officeId}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(name), 'X-Workchop-Socket': c.id!, 'X-Workchop-Upload-Key': uploadKey },
    body: new Uint8Array(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as UploadedFile;
}

const keyOf = (r: Awaited<ReturnType<typeof join>>['res']) => (r.ok ? r.uploadKey : '');

describe('chat channels', () => {
  it('start with #general; anyone creates channels, editors rename and archive them', async () => {
    const { id, ownerKey } = await createOffice(base);
    const owner = await join(base, id, 'Owner', { ownerKey });
    const guest = await join(base, id, 'Gus');
    const list = await channels(owner.socket);
    expect(list.channels.map((c) => [c.name, c.isDefault])).toEqual([['general', true]]);
    expect(list).toMatchObject({ dms: [], counts: {} });

    const created = collect(owner.socket, 'channel:created');
    const design = ok(await guest.socket.emitWithAck('channel:create', { name: '  #Design Team ', topic: 'Pixels\nand things' })).channel;
    expect(design).toMatchObject({ name: 'design-team', topic: 'Pixels and things', archived: false, isDefault: false });
    await until(() => created.length === 1);
    expect(created[0][0]).toEqual(design);

    for (const [name, error] of [
      ['', /name/],
      ['bad!name', /lowercase/],
      ['x'.repeat(33), /32/],
      ['---', /letter or number/],
      ['Design-TEAM', /#design-team already exists/],
    ] as const) {
      expect(failed(await guest.socket.emitWithAck('channel:create', { name }))).toMatch(error);
    }

    // With building locked to the owner, only the owner renames and archives; anyone sets topics.
    await ownerOnly(owner.socket, guest.socket);
    expect(failed(await guest.socket.emitWithAck('channel:update', { id: design.id, name: 'mine' }))).toMatch(/Only people who can edit/);
    expect(failed(await guest.socket.emitWithAck('channel:archive', design.id, true))).toMatch(/Only people who can edit/);
    expect(ok(await guest.socket.emitWithAck('channel:update', { id: design.id, topic: 'Logos' })).channel.topic).toBe('Logos');
    const updates = collect(guest.socket, 'channel:updated');
    const renamed = ok(await owner.socket.emitWithAck('channel:update', { id: design.id, name: 'design' })).channel;
    expect(renamed.name).toBe('design');
    await until(() => updates.length === 1);

    const gen = list.channels[0];
    expect(failed(await owner.socket.emitWithAck('channel:update', { id: gen.id, name: 'all' }))).toMatch(/can’t be renamed/);
    expect(failed(await owner.socket.emitWithAck('channel:archive', gen.id, true))).toMatch(/can’t be archived/);

    // Archived channels keep their history but take no new messages; their name is free again.
    ok(await send(owner.socket, { conv: `c:${design.id}`, text: 'before' }));
    expect(ok(await owner.socket.emitWithAck('channel:archive', design.id, true)).channel.archived).toBe(true);
    expect(failed(await send(owner.socket, { conv: `c:${design.id}`, text: 'after' }))).toMatch(/archived/);
    expect(ok(await owner.socket.emitWithAck('chat:history', { conv: `c:${design.id}` })).messages.map((m) => m.text)).toEqual(['before']);
    const again = ok(await owner.socket.emitWithAck('channel:create', { name: 'design' })).channel;
    expect(again.id).not.toBe(design.id);
    expect(failed(await owner.socket.emitWithAck('channel:archive', design.id, false))).toMatch(/another #design/);
    expect((await channels(guest.socket)).channels.map((c) => `${c.name}${c.archived ? ' (archived)' : ''}`)).toEqual(['general', 'design', 'design (archived)']);
  });

  it('refuse requests from outside an office and unknown channels', async () => {
    const { id } = await createOffice(base);
    const a = await join(base, id, 'Ann');
    const elsewhere = await join(base, (await createOffice(base)).id, 'Eve');
    const gen = await general(a.socket);
    expect(failed(await send(elsewhere.socket, { conv: `c:${gen.id}`, text: 'hi' }))).toMatch(/doesn’t exist/);
    expect(failed(await elsewhere.socket.emitWithAck('chat:history', { conv: `c:${gen.id}` }))).toMatch(/doesn’t exist/);
    expect(failed(await send(a.socket, { conv: 'c:not-a-uuid', text: 'hi' }))).toMatch(/doesn’t exist/);
    expect(failed(await send(a.socket, { conv: 'x', text: 'hi' }))).toMatch(/doesn’t exist/);
  });
});

describe('chat messages', () => {
  it('are sent, edited and deleted by their authors; editors delete anyone’s', async () => {
    const { id, ownerKey } = await createOffice(base);
    const owner = await join(base, id, 'Owner', { ownerKey });
    const ann = await join(base, id, 'Ann');
    const bob = await join(base, id, 'Bob');
    await ownerOnly(owner.socket, bob.socket);
    const conv = `c:${(await general(ann.socket)).id}`;

    const arrived = collect(bob.socket, 'chat:message');
    const sent = ok(await send(ann.socket, { conv, text: '  hello **world**\r\n\u0007second line  ', nonce: 'n1' })).message;
    expect(sent).toMatchObject({ text: 'hello **world**\nsecond line', name: 'Ann', playerId: ann.socket.id, userId: null, nonce: 'n1', replyCount: 0, deleted: false });
    await until(() => arrived.length === 1);
    expect(arrived[0][0].id).toBe(sent.id);

    expect(failed(await send(ann.socket, { conv, text: '   ' }))).toMatch(/Write a message/);
    const long = ok(await send(ann.socket, { conv, text: 'x'.repeat(5000) })).message;
    expect(long.text).toHaveLength(4000);

    expect(failed(await bob.socket.emitWithAck('chat:edit', sent.id, 'hacked'))).toMatch(/your own/);
    const updates = collect(bob.socket, 'chat:updated');
    const edited = ok(await ann.socket.emitWithAck('chat:edit', sent.id, 'hello _there_')).message;
    expect(edited.text).toBe('hello _there_');
    expect(edited.editedAt).toBeGreaterThan(0);
    await until(() => updates.length === 1);
    expect(updates[0][0].text).toBe('hello _there_');
    expect(failed(await ann.socket.emitWithAck('chat:edit', sent.id, ' '))).toMatch(/can’t be empty/);

    // Bob may not delete Ann's message; the owner (who may edit the office) may.
    expect(failed(await bob.socket.emitWithAck('chat:delete', sent.id))).toMatch(/your own/);
    const deleted = collect(bob.socket, 'chat:deleted');
    ok(await owner.socket.emitWithAck('chat:delete', sent.id));
    await until(() => deleted.length === 1);
    expect(deleted[0][0]).toMatchObject({ id: sent.id, deleted: true, text: '', attachments: [], reactions: [] });
    ok(await ann.socket.emitWithAck('chat:delete', long.id));
    const history = ok(await bob.socket.emitWithAck('chat:history', { conv })).messages;
    expect(history.map((m) => [m.id, m.deleted, m.text])).toEqual([
      [sent.id, true, ''],
      [long.id, true, ''],
    ]);
    expect(failed(await ann.socket.emitWithAck('chat:edit', long.id, 'back'))).toMatch(/deleted/);
  });

  it('keep threads with reply counts, and replies also sent to the channel', async () => {
    const { id } = await createOffice(base);
    const ann = await join(base, id, 'Ann');
    const bob = await join(base, id, 'Bob');
    const conv = `c:${(await general(ann.socket)).id}`;
    const parent = ok(await send(ann.socket, { conv, text: 'Lunch at **noon**?' })).message;

    const updates = collect(ann.socket, 'chat:updated');
    const reply = ok(await send(bob.socket, { conv, text: 'Yes!', parentId: parent.id })).message;
    expect(reply).toMatchObject({ parentId: parent.id, inChannel: false });
    await until(() => updates.length === 1);
    expect(updates[0][0]).toMatchObject({ id: parent.id, replyCount: 1, replyNames: ['Bob'] });
    expect(updates[0][0].lastReplyAt).toBe(reply.createdAt);

    const also = ok(await send(ann.socket, { conv, text: 'See you there', parentId: parent.id, alsoToChannel: true })).message;
    expect(also).toMatchObject({ inChannel: true, parent: { name: 'Ann', text: 'Lunch at noon?' } });
    expect(failed(await send(bob.socket, { conv, text: 'nested', parentId: reply.id }))).toMatch(/thread of the first/);

    const thread = ok(await bob.socket.emitWithAck('chat:thread', { id: parent.id }));
    expect(thread.parent).toMatchObject({ id: parent.id, replyCount: 2, replyNames: ['Ann', 'Bob'] });
    expect(thread.replies.map((r) => r.text)).toEqual(['Yes!', 'See you there']);
    expect(thread.hasMore).toBe(false);

    // The channel shows the parent and the reply that was also sent to it, not the other one.
    const history = ok(await bob.socket.emitWithAck('chat:history', { conv })).messages;
    expect(history.map((m) => m.text)).toEqual(['Lunch at **noon**?', 'See you there']);
    expect(history[1].parent).toEqual({ name: 'Ann', text: 'Lunch at noon?' });

    ok(await bob.socket.emitWithAck('chat:delete', reply.id));
    await until(() => updates.some(([m]) => m.id === parent.id && m.replyCount === 1));
    expect(ok(await ann.socket.emitWithAck('chat:locate', also.id))).toMatchObject({ conv, parentId: parent.id });
  });

  it('toggle reactions, and refuse what isn’t an emoji', async () => {
    const { id } = await createOffice(base);
    const ann = await join(base, id, 'Ann');
    const bob = await join(base, id, 'Bob');
    const conv = `c:${(await general(ann.socket)).id}`;
    const msg = ok(await send(ann.socket, { conv, text: 'Shipped!' })).message;
    const updates = collect(ann.socket, 'chat:updated');
    ok(await bob.socket.emitWithAck('chat:react', msg.id, '🎉'));
    ok(await ann.socket.emitWithAck('chat:react', msg.id, '🎉'));
    ok(await ann.socket.emitWithAck('chat:react', msg.id, '👍🏽'));
    await until(() => updates.length === 3);
    expect(updates[2][0].reactions).toEqual([
      { emoji: '🎉', by: [{ id: `p:${bob.socket.id}`, name: 'Bob' }, { id: `p:${ann.socket.id}`, name: 'Ann' }] },
      { emoji: '👍🏽', by: [{ id: `p:${ann.socket.id}`, name: 'Ann' }] },
    ]);
    ok(await bob.socket.emitWithAck('chat:react', msg.id, '🎉'));
    ok(await ann.socket.emitWithAck('chat:react', msg.id, '👍🏽'));
    await until(() => updates.length === 5);
    expect(updates[4][0].reactions).toEqual([{ emoji: '🎉', by: [{ id: `p:${ann.socket.id}`, name: 'Ann' }] }]);
    for (const bad of ['a', '<b>', '👍 nope', '', '🎉'.repeat(9)]) expect(failed(await bob.socket.emitWithAck('chat:react', msg.id, bad))).toMatch(/emoji/);
  });

  it('page through history newest first, by time and then id', async () => {
    const { id } = await createOffice(base);
    const ann = await join(base, id, 'Ann');
    const gen = await general(ann.socket);
    // Two messages per second, so pages also have to break ties by id.
    await server.db.query(
      `INSERT INTO chat_messages (office_id, channel_id, author_name, text, created_at)
       SELECT $1, $2, 'Bot', 'm' || i, date_trunc('second', now()) - make_interval(secs => (120 - i) / 2) FROM generate_series(1, 120) i`,
      [id, gen.id],
    );
    const seen: string[] = [];
    let before: string | undefined;
    const pages: number[] = [];
    for (;;) {
      const page = ok(await ann.socket.emitWithAck('chat:history', { conv: `c:${gen.id}`, before }));
      pages.push(page.messages.length);
      // Oldest first within a page.
      const times = page.messages.map((m) => m.createdAt);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      seen.unshift(...page.messages.map((m) => m.text));
      if (!page.hasMore) break;
      before = page.messages[0].id;
    }
    expect(pages).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    expect(seen.slice(-2).sort()).toEqual(['m119', 'm120']);
    expect(failed(await ann.socket.emitWithAck('chat:history', { conv: `c:${gen.id}`, before: 'nope' }))).toBe('Bad request');
  });

  it('are rate limited', async () => {
    const { id } = await createOffice(base);
    const ann = await join(base, id, 'Ann');
    const conv = `c:${(await general(ann.socket)).id}`;
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => send(ann.socket, { conv, text: `spam ${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(6);
    expect(results.filter((r) => !r.ok).map(failed)[0]).toMatch(/too quickly/);
  });

  it('only go nearby to people in a call with you', async () => {
    const { id } = await createOffice(base);
    const ann = await join(base, id, 'Ann');
    const bob = await join(base, id, 'Bob');
    const cat = await join(base, id, 'Cat');
    // Ann and Bob stand together; Cat is far away.
    const linked = collect(ann.socket, 'peer:connect');
    ann.socket.emit('move', 5, 5, 0, 'idle');
    bob.socket.emit('move', 5.5, 5, 0, 'idle');
    cat.socket.emit('move', 18, 14, 0, 'idle');
    await until(() => linked.some(([peer]) => peer === bob.socket.id));
    await wait(100);
    const toBob = collect(bob.socket, 'chat:message');
    const toCat = collect(cat.socket, 'chat:message');
    const msg = ok(await send(ann.socket, { conv: 'nearby', text: 'psst <!here>' })).message;
    expect(msg).toMatchObject({ live: 'nearby', text: 'psst @here', channelId: null, dm: null });
    await until(() => toBob.length === 1);
    await wait(150);
    expect(toCat).toHaveLength(0);
    // Not stored: no history, no threads or reactions.
    expect(ok(await ann.socket.emitWithAck('chat:history', { conv: 'nearby' })).messages).toEqual([]);
    expect(failed(await bob.socket.emitWithAck('chat:react', msg.id, '👍'))).toMatch(/no longer exists/);
  });
});

describe('chat mentions', () => {
  it('reach members online and later, guests present now, and @here; never the author', async () => {
    const { id } = await createOffice(base);
    const ava = await signIn('Ava');
    const mia = await signIn('Mia');
    const ned = await signIn('Ned');
    const stranger = await signIn('Stranger');
    const a = await join(base, id, 'Ava', { jar: ava.jar });
    const m = await join(base, id, 'Mia', { jar: mia.jar });
    const g = await join(base, id, 'Gus');
    // Ned has been here before (so he's a member) but is away now.
    const n = await join(base, id, 'Ned', { jar: ned.jar });
    n.socket.disconnect();
    await until(() => server.realtime.onlineCount(id) === 3);
    const conv = `c:${(await general(a.socket)).id}`;

    const toAva = collect(a.socket, 'chat:mention');
    const toMia = collect(m.socket, 'chat:mention');
    const toGus = collect(g.socket, 'chat:mention');
    const text = `hey <@u:${mia.user.id}> <@u:${ned.user.id}> <@p:${g.socket.id}> <@u:${stranger.user.id}> <@u:${ava.user.id}> <!here> <@u:${mia.user.id}>`;
    const msg = ok(await send(a.socket, { conv, text })).message;
    expect(msg.text).toBe(`hey <@u:${mia.user.id}> <@u:${ned.user.id}> <@p:${g.socket.id}> @unknown <@u:${ava.user.id}> <!here> <@u:${mia.user.id}>`);
    expect(msg.mentions).toEqual([
      { kind: 'user', id: mia.user.id, name: 'Mia' },
      { kind: 'user', id: ned.user.id, name: 'Ned' },
      { kind: 'player', id: g.socket.id, name: 'Gus' },
      { kind: 'user', id: ava.user.id, name: 'Ava' },
      { kind: 'here' },
    ]);
    await until(() => toMia.length === 1 && toGus.length === 1);
    expect(toMia[0][0]).toMatchObject({ conv, message: { id: msg.id } });
    await wait(150);
    expect(toAva).toHaveLength(0);
    expect(toMia).toHaveLength(1);

    // Ned's mention waits for his next visit; Mia's is there until she reads the channel.
    const back = await join(base, id, 'Ned', { jar: ned.jar });
    expect((await channels(back.socket)).counts[conv]).toEqual({ unread: 1, mentions: 1 });
    expect((await channels(m.socket)).counts[conv]).toEqual({ unread: 1, mentions: 1 });
    expect((await channels(a.socket)).counts[conv]).toBeUndefined();
    m.socket.emit('chat:read', conv);
    await until(async () => (await channels(m.socket)).counts[conv] === undefined);

    // A guest's mention of a signed-in person present is saved as a mention of their account.
    const fromGus = ok(await send(g.socket, { conv, text: `<@p:${m.socket.id}> and <!here>: standup` })).message;
    expect(fromGus.text).toBe(`<@u:${mia.user.id}> and <!here>: standup`);
    await until(() => toAva.length === 1 && toMia.length === 2);
    await wait(150);
    expect(toGus).toHaveLength(1);
    expect((await channels(a.socket)).counts[conv]).toEqual({ unread: 1, mentions: 1 });

    // Edits notify only people mentioned for the first time.
    const plain = ok(await send(m.socket, { conv, text: 'no mentions yet' })).message;
    ok(await m.socket.emitWithAck('chat:edit', plain.id, `now <@u:${ava.user.id}>`));
    await until(() => toAva.length === 2);
    ok(await m.socket.emitWithAck('chat:edit', plain.id, `now <@u:${ava.user.id}>!`));
    await wait(150);
    expect(toAva).toHaveLength(2);
    // Deleting a message takes its mentions back.
    ok(await m.socket.emitWithAck('chat:delete', plain.id));
    a.socket.emit('chat:read', conv);
    await until(async () => (await channels(a.socket)).counts[conv] === undefined);
  });
});

describe('chat direct messages and read markers', () => {
  it('are saved between members, live with guests, and private', async () => {
    const { id } = await createOffice(base);
    const ava = await signIn('Ava');
    const mia = await signIn('Mia');
    const a = await join(base, id, 'Ava', { jar: ava.jar });
    const aOtherTab = await join(base, id, 'Ava', { jar: ava.jar });
    const m = await join(base, id, 'Mia', { jar: mia.jar });
    const g = await join(base, id, 'Gus');

    const toMia = collect(m.socket, 'chat:message');
    const toOtherTab = collect(aOtherTab.socket, 'chat:message');
    const toGus = collect(g.socket, 'chat:message');
    const dm = ok(await send(a.socket, { conv: `d:${mia.user.id}`, text: `just us <@u:${mia.user.id}> <!here>` })).message;
    expect(dm).toMatchObject({ channelId: null, dm: [ava.user.id, mia.user.id].sort().join(':'), text: `just us <@u:${mia.user.id}> @here` });
    await until(() => toMia.length === 1 && toOtherTab.length === 1);
    await wait(150);
    expect(toGus).toHaveLength(0);

    // Listed, with unread counts, for the recipient; history for both, not for others.
    const mias = await channels(m.socket);
    expect(mias.dms).toEqual([{ userId: ava.user.id, name: 'Ava', lastMessageAt: dm.createdAt }]);
    expect(mias.counts[`d:${ava.user.id}`]).toEqual({ unread: 1, mentions: 0 });
    expect(ok(await m.socket.emitWithAck('chat:history', { conv: `d:${ava.user.id}` })).messages.map((x) => x.id)).toEqual([dm.id]);
    expect(failed(await g.socket.emitWithAck('chat:thread', { id: dm.id }))).toMatch(/no longer exists/);
    expect(failed(await g.socket.emitWithAck('chat:react', dm.id, '👍'))).toMatch(/no longer exists/);
    expect(failed(await send(g.socket, { conv: `d:${mia.user.id}`, text: 'hi' }))).toMatch(/Sign in/);

    // Reading in one tab clears the other tab's badge too.
    const seen = collect(aOtherTab.socket, 'chat:seen');
    m.socket.emit('chat:read', `d:${ava.user.id}`);
    await until(async () => (await channels(m.socket)).counts[`d:${ava.user.id}`] === undefined);
    ok(await send(m.socket, { conv: `d:${ava.user.id}`, text: 'hello back' }));
    expect((await channels(a.socket)).counts[`d:${mia.user.id}`]).toEqual({ unread: 1, mentions: 0 });
    a.socket.emit('chat:read', `d:${mia.user.id}`);
    await until(() => seen.length === 1);
    expect(seen[0][0]).toBe(`d:${mia.user.id}`);

    // With a guest it's live: delivered to the two of them only, and not stored.
    const live = ok(await send(g.socket, { conv: `p:${m.socket.id}`, text: 'psst' })).message;
    expect(live).toMatchObject({ live: 'dm', to: m.socket.id, playerId: g.socket.id });
    await until(() => toMia.some(([x]) => x.id === live.id));
    expect(toOtherTab.some(([x]) => x.id === live.id)).toBe(false);
    expect(failed(await send(g.socket, { conv: `p:${g.socket.id}`, text: 'me' }))).toMatch(/left/);
    expect(failed(await send(g.socket, { conv: 'p:nobody', text: 'hi' }))).toMatch(/left/);
  });

  it('count unread messages since the last read, from when a member joined', async () => {
    const { id } = await createOffice(base);
    const ava = await signIn('Ava');
    const old = await join(base, id, 'Gus');
    const conv = `c:${(await general(old.socket)).id}`;
    const first = ok(await send(old.socket, { conv, text: 'before Ava came' })).message;
    await wait(5);
    const a = await join(base, id, 'Ava', { jar: ava.jar });
    expect((await channels(a.socket)).counts).toEqual({});
    ok(await send(old.socket, { conv, text: 'one' }));
    ok(await send(old.socket, { conv, text: 'two' }));
    ok(await send(old.socket, { conv, text: 'in a thread', parentId: first.id }));
    const gone = ok(await send(old.socket, { conv, text: 'oops' })).message;
    ok(await old.socket.emitWithAck('chat:delete', gone.id));
    // Thread replies don't count as unread in the channel; deleted messages don't either.
    expect((await channels(a.socket)).counts[conv]).toEqual({ unread: 2, mentions: 0 });
    a.socket.emit('chat:read', conv);
    await until(async () => (await channels(a.socket)).counts[conv] === undefined);
    // Your own messages are never unread.
    ok(await send(a.socket, { conv, text: 'mine' }));
    expect((await channels(a.socket)).counts[conv]).toBeUndefined();
  });
});

describe('chat attachments', () => {
  it('attach your recent uploads once, and delete them with the message', async () => {
    const { id } = await createOffice(base);
    const ann = await join(base, id, 'Ann');
    const bob = await join(base, id, 'Bob', { jar: (await signIn('Bob')).jar });
    const conv = `c:${(await general(ann.socket)).id}`;
    const png = await upload(ann.socket, keyOf(ann.res), id, 'cat.png', Buffer.from('fake png'));
    const pdf = await upload(ann.socket, keyOf(ann.res), id, 'notes.pdf', Buffer.from('%PDF'), 'application/pdf');
    const bobs = await upload(bob.socket, keyOf(bob.res), id, 'bob.txt', Buffer.from('hi'), 'text/plain');

    const msg = ok(await send(ann.socket, { conv, text: '', attachments: [{ id: png.id, w: 640, h: 480 }, { id: pdf.id, w: 10, h: 10 }] })).message;
    expect(msg.attachments).toEqual([
      { id: png.id, url: png.url, name: 'cat.png', contentType: 'image/png', size: png.size, w: 640, h: 480 },
      { id: pdf.id, url: pdf.url, name: 'notes.pdf', contentType: 'application/pdf', size: pdf.size },
    ]);
    // Not again, not someone else's, not made up, and at most five.
    expect(failed(await send(ann.socket, { conv, text: 'again', attachments: [{ id: png.id }] }))).toMatch(/upload them again/);
    expect(failed(await send(ann.socket, { conv, text: 'theirs', attachments: [{ id: bobs.id }] }))).toMatch(/upload them again/);
    expect(failed(await send(bob.socket, { conv, text: 'fake', attachments: [{ id: 'not-a-uuid' }] }))).toBe('Bad request');
    expect(failed(await send(bob.socket, { conv, text: 'many', attachments: Array.from({ length: 6 }, () => ({ id: bobs.id })) }))).toMatch(/Up to 5/);

    // Edits keep the files; deleting the message deletes them.
    expect(ok(await ann.socket.emitWithAck('chat:edit', msg.id, 'a cat')).message.attachments).toHaveLength(2);
    expect((await fetch(`${base}${png.url}`)).status).toBe(200);
    ok(await ann.socket.emitWithAck('chat:delete', msg.id));
    await until(async () => (await fetch(`${base}${png.url}`)).status === 404 && (await fetch(`${base}${pdf.url}`)).status === 404);
    expect((await fetch(`${base}${bobs.url}`)).status).toBe(200);
  });
});

describe('chat retention', () => {
  it('deletes conversations quiet for longer than CHAT_RETENTION_DAYS, with their files', async () => {
    const { id } = await createOffice(base);
    const ann = await join(base, id, 'Ann');
    const conv = `c:${(await general(ann.socket)).id}`;
    const file = await upload(ann.socket, keyOf(ann.res), id, 'old.png', Buffer.from('old'));
    const old = ok(await send(ann.socket, { conv, text: 'long ago', attachments: [{ id: file.id }] })).message;
    const reply = ok(await send(ann.socket, { conv, text: 'also long ago', parentId: old.id })).message;
    const recentThread = ok(await send(ann.socket, { conv, text: 'old start, recent reply' })).message;
    ok(await send(ann.socket, { conv, text: 'recent', parentId: recentThread.id }));
    await server.db.query(`UPDATE chat_messages SET created_at = now() - interval '40 days', last_reply_at = CASE WHEN id = $1 THEN now() - interval '40 days' ELSE last_reply_at END WHERE id = ANY($2::uuid[])`, [
      old.id,
      [old.id, reply.id, recentThread.id],
    ]);
    // A visit starts the clean-up (hourly by default).
    await join(base, id, 'Bob');
    await until(async () => ok(await ann.socket.emitWithAck('chat:history', { conv })).messages.length === 1);
    expect(ok(await ann.socket.emitWithAck('chat:history', { conv })).messages[0].id).toBe(recentThread.id);
    await until(async () => (await fetch(`${base}${file.url}`)).status === 404);
  });

  it('is read from CHAT_RETENTION_DAYS', async () => {
    const { retentionFromEnv } = await import('../server/features/chat');
    expect(retentionFromEnv({})).toBeNull();
    expect(retentionFromEnv({ CHAT_RETENTION_DAYS: ' 90 ' })).toBe(90);
    expect(() => retentionFromEnv({ CHAT_RETENTION_DAYS: '0' })).toThrow(/whole number/);
    expect(() => retentionFromEnv({ CHAT_RETENTION_DAYS: '1.5' })).toThrow(/whole number/);
  });
});
