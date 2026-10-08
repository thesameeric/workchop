import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appMatchers, HELPER_TTL_MS, MANUAL_MAX_MS, matchApp, sanitizeHelperApp, sanitizeManualApp } from '../shared/apps';
import { sanitizePresenceUpdate, type PresenceState } from '../shared/presence';
import type { PlayerPatch } from '../shared/types';
import { collectMigrations, migrate } from '../server/db/migrations';
import { feature } from '../server/features/presence';
import { PresenceMap } from '../server/features/presence/presence';
import { hashToken, HelperTokens, isTokenFormat, MAX_DEVICES, newToken, TooManyDevices } from '../server/features/presence/tokens';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, Jar, join, json, until } from './helpers/http';

describe('app allowlist', () => {
  it('matches macOS bundle ids, Windows process names and Linux window classes', () => {
    expect(matchApp('macos', ['com.figma.Desktop'])).toBe('figma');
    expect(matchApp('macos', ['com.microsoft.VSCode'])).toBe('vscode');
    expect(matchApp('macos', ['com.google.Chrome.canary'])).toBe('chrome');
    expect(matchApp('macos', ['com.apple.dt.Xcode'])).toBe('xcode');
    expect(matchApp('windows', ['Code'])).toBe('vscode');
    expect(matchApp('windows', ['WINWORD'])).toBe('word');
    expect(matchApp('windows', ['slack'])).toBe('slack');
    expect(matchApp('windows', ['ApplicationFrameHost'])).toBe('other');
    // WM_CLASS is "instance", "Class": either may match.
    expect(matchApp('linux', ['code', 'Code'])).toBe('vscode');
    expect(matchApp('linux', ['gnome-terminal-server', 'Gnome-terminal'])).toBe('terminal');
    expect(matchApp('linux', ['Navigator', 'firefox'])).toBe('browser');
    expect(matchApp('linux', ['google-chrome-beta'])).toBe('chrome');
  });

  it('keeps unknown apps anonymous and the lock screen empty', () => {
    expect(matchApp('macos', ['com.example.secret-diary'])).toBe('other');
    expect(matchApp('linux', ['someapp', 'SomeApp'])).toBe('other');
    expect(matchApp('macos', ['com.apple.loginwindow'])).toBeNull();
    expect(matchApp('windows', ['Idle'])).toBeNull();
    expect(matchApp('windows', ['LockApp'])).toBeNull();
    expect(matchApp('windows', [''])).toBeNull();
    expect(matchApp('linux', [])).toBeNull();
    // An app matched on one platform isn't matched by another platform's identifiers.
    expect(matchApp('windows', ['com.figma.Desktop'])).toBe('other');
  });

  it('serves every matcher in lower case', () => {
    const m = appMatchers();
    for (const app of m.apps) for (const list of Object.values(app.match)) for (const p of list!) expect(p).toBe(p.toLowerCase());
    expect(m.apps.some((a) => a.id === 'focus' || a.id === 'other')).toBe(false);
  });

  it('sanitizes app ids', () => {
    expect(sanitizeHelperApp('figma')).toBe('figma');
    expect(sanitizeHelperApp('other')).toBe('other');
    expect(sanitizeHelperApp('focus')).toBeNull();
    expect(sanitizeHelperApp('Tinder')).toBeNull();
    expect(sanitizeHelperApp(42)).toBeNull();
    expect(sanitizeManualApp('focus')).toBe('focus');
    expect(sanitizeManualApp('<script>')).toBeNull();
    expect(sanitizePresenceUpdate({ manual: { app: 'figma', until: null }, share: false, junk: 1 })).toEqual({ manual: { app: 'figma', until: null }, share: false });
    expect(sanitizePresenceUpdate({ manual: null })).toEqual({ manual: null });
    expect(sanitizePresenceUpdate({ manual: { app: 'nope' } })).toBeNull();
    expect(sanitizePresenceUpdate({ manual: { app: 'figma', until: 'soon' } })).toBeNull();
    expect(sanitizePresenceUpdate({ share: 'yes' })).toBeNull();
    expect(sanitizePresenceUpdate([1])).toBeNull();
    expect(sanitizePresenceUpdate({ manual: { app: 'figma', until: null }, restore: true })).toEqual({ manual: { app: 'figma', until: null }, restore: true });
    expect(sanitizePresenceUpdate({ share: true, restore: true })).toEqual({ share: true });
  });
});

describe('presence map', () => {
  let t = 1_000_000;
  const clock = () => t;
  const available = { status: 'available' as const };

  it('shows a helper report only while sharing is on, and forgets it after the TTL', () => {
    const map = new PresenceMap(clock);
    map.report('u:a', 'tok', { app: 'figma', platform: 'macos', unsupported: false });
    // Until the person's client says sharing is on, nothing shows.
    expect(map.effective(map.get('u:a'), available)).toBeNull();
    map.update('u:a', { share: true });
    expect(map.effective(map.get('u:a'), available)).toBe('figma');
    t += HELPER_TTL_MS - 1000;
    expect(map.sweep(() => true)).toEqual([]);
    t += 2000;
    expect(map.effective(map.get('u:a'), available)).toBeNull();
    expect(map.sweep(() => true)).toEqual(['u:a']);
    map.update('u:a', { share: false });
    map.report('u:a', 'tok', { app: 'figma', platform: 'macos', unsupported: false });
    expect(map.effective(map.get('u:a'), available)).toBeNull();
  });

  it('lets a hand-picked status win, until it expires', () => {
    const map = new PresenceMap(clock);
    map.update('u:a', { share: true, manual: { app: 'slack', until: t + 60_000 } });
    map.report('u:a', 'tok', { app: 'vscode', platform: 'linux', unsupported: false });
    expect(map.effective(map.get('u:a'), available)).toBe('slack');
    // Do not disturb and headphones hide the helper's app, but not what you picked.
    expect(map.effective(map.get('u:a'), { status: 'busy' })).toBe('slack');
    t += 61_000;
    map.report('u:a', 'tok', { app: 'vscode', platform: 'linux', unsupported: false });
    expect(map.sweep(() => true)).toEqual(['u:a']);
    expect(map.get('u:a')!.manual).toBeNull();
    expect(map.effective(map.get('u:a'), available)).toBe('vscode');
    expect(map.effective(map.get('u:a'), { status: 'busy' })).toBeNull();
    expect(map.effective(map.get('u:a'), { status: 'available', focus: true })).toBeNull();
    // Away hides everything.
    map.update('u:a', { manual: { app: 'figma', until: null } });
    expect(map.effective(map.get('u:a'), { status: 'away' })).toBeNull();
    // Clearing it brings the helper back.
    map.update('u:a', { manual: null });
    expect(map.effective(map.get('u:a'), available)).toBe('vscode');
  });

  it('caps how long a status lasts and ignores ones already over', () => {
    const map = new PresenceMap(clock);
    map.update('s:x', { manual: { app: 'figma', until: t + 10 * MANUAL_MAX_MS } });
    expect(map.get('s:x')!.manual!.until).toBe(t + MANUAL_MAX_MS);
    map.update('s:x', { manual: { app: 'figma', until: t - 1 } });
    expect(map.get('s:x')!.manual).toBeNull();
  });

  it('hides unknown apps when asked, and prefers the computer in use', () => {
    const map = new PresenceMap(clock);
    map.update('u:a', { share: true });
    map.report('u:a', 'laptop', { app: 'other', platform: 'macos', unsupported: false });
    expect(map.effective(map.get('u:a'), available)).toBe('other');
    map.update('u:a', { others: false });
    expect(map.effective(map.get('u:a'), available)).toBeNull();
    t += 1000;
    map.report('u:a', 'desktop', { app: 'excel', platform: 'windows', unsupported: false });
    expect(map.effective(map.get('u:a'), available)).toBe('excel');
    // Heartbeats don't count as a change; switching apps does.
    t += 1000;
    map.report('u:a', 'desktop', { app: 'excel', platform: 'windows', unsupported: false });
    map.report('u:a', 'laptop', { app: 'figma', platform: 'macos', unsupported: false });
    expect(map.effective(map.get('u:a'), available)).toBe('figma');
    // A locked computer gives way to one in use.
    t += 1000;
    map.report('u:a', 'laptop', { app: null, platform: 'macos', unsupported: false });
    expect(map.effective(map.get('u:a'), available)).toBe('excel');
    expect(map.state(map.get('u:a'), available).helper).toEqual({ app: 'excel', platform: 'windows', unsupported: false });
    expect(map.dropHelper('u:a', 'desktop')).toBe(true);
    expect(map.effective(map.get('u:a'), available)).toBeNull();
  });

  it('forgets people who are gone', () => {
    const map = new PresenceMap(clock);
    map.update('u:gone', { share: true });
    map.update('u:keep', { manual: { app: 'figma', until: null } });
    map.sweep(() => false);
    expect(map.get('u:gone')).toBeUndefined();
    expect(map.get('u:keep')).toBeDefined();
    t += 25 * 60 * 60 * 1000;
    map.sweep(() => false);
    expect(map.get('u:keep')).toBeUndefined();
  });
});

describe('helper tokens', () => {
  // PGlite takes a few seconds to start, more with every test file running alongside.
  beforeAll(() => createTestDb(), 60_000);

  it('look like wcp_ tokens and are stored only as a SHA-256', () => {
    const token = newToken();
    expect(token).toMatch(/^wcp_[A-Za-z0-9_-]{43}$/);
    expect(isTokenFormat(token)).toBe(true);
    expect(isTokenFormat('wcp_short')).toBe(false);
    expect(isTokenFormat(`${token} `)).toBe(false);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(newToken()).not.toBe(token);
  });

  it('pairs, verifies, lists, limits and revokes', async () => {
    const db = await createTestDb();
    await migrate(db, collectMigrations([feature]));
    await db.query("INSERT INTO users (id, name) VALUES ('tok-user', 'T'), ('tok-other', 'O') ON CONFLICT DO NOTHING");
    let now = Date.now();
    const tokens = new HelperTokens(db, () => now);
    const { device, token } = await tokens.create('tok-user', '  My   Mac ');
    expect(device).toMatchObject({ label: 'My Mac', lastUsedAt: null });
    const stored = await db.query<{ token_hash: string; scope: string }>('SELECT token_hash, scope FROM api_tokens WHERE id = $1', [device.id]);
    expect(stored.rows[0]).toEqual({ token_hash: hashToken(token), scope: 'presence:write' });
    expect(JSON.stringify(stored.rows)).not.toContain(token);

    expect(await tokens.verify(token)).toEqual({ id: device.id, userId: 'tok-user' });
    expect(await tokens.verify(newToken())).toBeNull();
    expect(await tokens.verify('not a token')).toBeNull();

    await tokens.touch(device.id);
    const used = await db.query<{ last_used_at: Date | null }>('SELECT last_used_at FROM api_tokens WHERE id = $1', [device.id]);
    expect(used.rows[0].last_used_at).not.toBeNull();
    // Not written again on every heartbeat.
    await db.query('UPDATE api_tokens SET last_used_at = NULL WHERE id = $1', [device.id]);
    now += 60_000;
    await tokens.touch(device.id);
    expect((await db.query('SELECT 1 FROM api_tokens WHERE id = $1 AND last_used_at IS NULL', [device.id])).rowCount).toBe(1);

    expect((await tokens.list('tok-user')).map((d) => d.id)).toEqual([device.id]);
    expect(await tokens.list('tok-other')).toEqual([]);
    // Only its owner can revoke it; then it stops working at once, cache or not.
    expect(await tokens.revoke('tok-other', device.id)).toBe(false);
    expect(await tokens.revoke('tok-user', device.id)).toBe(true);
    expect(await tokens.verify(token)).toBeNull();
    expect(await tokens.list('tok-user')).toEqual([]);

    // A lookup already under way when the computer is removed doesn't bring its token back.
    const second = await tokens.create('tok-user', 'Desktop');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new HelperTokens({ ...db, query: async (sql: string, params?: unknown[]) => {
      const res = await db.query(sql, params);
      if (sql.startsWith('SELECT id, user_id')) await gate;
      return res;
    } } as typeof db, () => now);
    const pending = slow.verify(second.token);
    await slow.revoke('tok-user', second.device.id);
    release();
    expect(await pending).toBeNull();
    expect(await slow.verify(second.token)).toBeNull();

    for (let i = 0; i < MAX_DEVICES; i++) await tokens.create('tok-other', `PC ${i}`);
    await expect(tokens.create('tok-other', 'one more')).rejects.toBeInstanceOf(TooManyDevices);
  });
});

describe('presence over the network', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-presence-'));
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      db: await createTestDb(),
      dataDir,
      quiet: true,
      iceServers: [],
      auth: { google: null, apple: null, devLogin: true },
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    disconnectAll();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const signIn = async (name: string) => {
    const jar = new Jar();
    const res = await jar.fetch(`${base}/api/auth/dev`, json({ name, email: `${name.toLowerCase()}@example.com` }));
    expect(res.status).toBe(200);
    return jar;
  };
  const report = (token: string, body: unknown) =>
    fetch(`${base}/api/me/app-presence`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('pairs a computer and shows what it reports to everyone in the office', async () => {
    const ada = await signIn('Ada');
    const paired = await ada.fetch(`${base}/api/me/devices`, json({ label: 'Laptop' }));
    expect(paired.status).toBe(201);
    const { device, token } = (await paired.json()) as { device: { id: string }; token: string };
    expect(isTokenFormat(token)).toBe(true);

    // Nobody of Ada's online: accepted, but the helper is asked to check back later.
    const idle = await report(token, { app: 'figma', platform: 'macos', v: 1 });
    expect(idle.status).toBe(204);
    expect(idle.headers.get('retry-after')).toBe('300');

    const { id } = await createOffice(base);
    const me = await join(base, id, 'Ada', { jar: ada });
    const bob = await join(base, id, 'Bob');
    const adaId = me.res.ok ? me.res.selfId : '';
    let seen: string | null | undefined;
    bob.socket.on('player:updated', (pid, patch: PlayerPatch) => {
      if (pid === adaId && 'app' in patch) seen = patch.app;
    });
    let mine: PresenceState | null = null;
    me.socket.on('presence:state', (s) => (mine = s));

    me.socket.emit('presence:set', { share: true, others: true });
    const active = await report(token, { app: 'figma', platform: 'macos', v: 1 });
    expect(active.status).toBe(204);
    expect(active.headers.get('retry-after')).toBeNull();
    await until(() => seen === 'figma');
    await until(() => mine?.app === 'figma');
    expect(mine!.helper).toEqual({ app: 'figma', platform: 'macos', unsupported: false });

    // Unknown ids from a newer helper show as "Working"; garbage is refused.
    await report(token, { app: 'some-new-app', platform: 'macos', v: 1 });
    await until(() => seen === 'other');

    // Do not disturb hides it; a hand-picked status wins.
    me.socket.emit('profile', { status: 'busy' });
    await until(() => seen === null);
    me.socket.emit('presence:set', { manual: { app: 'focus', until: null } });
    await until(() => seen === 'focus');
    me.socket.emit('profile', { status: 'available' });
    me.socket.emit('presence:set', { manual: null });
    await until(() => seen === 'other');

    // Turning sharing off hides it at once.
    me.socket.emit('presence:set', { share: false });
    await until(() => seen === null);
    me.socket.emit('presence:set', { share: true });
    await until(() => seen === 'other');

    // Others joining later see it in the player list.
    const carol = await join(base, id, 'Carol');
    expect(carol.res.ok && carol.res.players.find((p) => p.id === adaId)?.app).toBe('other');

    const list = (await (await ada.fetch(`${base}/api/me/devices`)).json()) as { id: string; active: boolean; platform: string }[];
    expect(list).toEqual([expect.objectContaining({ id: device.id, active: true, platform: 'macos' })]);

    // Removing the computer clears its app and stops its token.
    expect((await ada.fetch(`${base}/api/me/devices/${device.id}`, { method: 'DELETE' })).status).toBe(204);
    await until(() => seen === null);
    expect((await report(token, { app: 'figma', platform: 'macos', v: 1 })).status).toBe(401);
    expect((await ada.fetch(`${base}/api/me/devices/${device.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('turns away bad tokens, too many reports and guests', async () => {
    expect((await report('nope', { app: null, platform: 'linux', v: 1 })).status).toBe(401);
    expect((await report(newToken(), { app: null, platform: 'linux', v: 1 })).status).toBe(401);
    expect((await fetch(`${base}/api/me/app-presence`, { method: 'PUT' })).status).toBe(401);
    expect((await fetch(`${base}/api/me/devices`)).status).toBe(401);
    expect((await fetch(`${base}/api/me/devices`, json({ label: 'x' }))).status).toBe(401);

    const eve = await signIn('Eve');
    const { token } = (await (await eve.fetch(`${base}/api/me/devices`, json({}))).json()) as { token: string };
    const spare = ((await (await eve.fetch(`${base}/api/me/devices`, json({ label: 'Spare' }))).json()) as { token: string }).token;
    expect((await report(spare, { app: 'figma', platform: 'amiga', v: 1 })).status).toBe(400);
    expect((await report(spare, { app: { name: 'x' }, platform: 'macos', v: 1 })).status).toBe(400);
    expect((await report(spare, { app: 'figma', platform: 'macos' })).status).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await report(token, { app: null, platform: 'linux', v: 1 })).status);
    expect(codes.slice(0, 5)).toEqual([204, 204, 204, 204, 204]);
    expect(codes.at(-1)).toBe(429);
    // Another person can't see or remove Eve's computers.
    const mallory = await signIn('Mallory');
    expect(await (await mallory.fetch(`${base}/api/me/devices`)).json()).toEqual([]);
  });

  it('restores a hand-picked status after a restart, even if the helper reported first', async () => {
    const cy = await signIn('Cy');
    const { token } = (await (await cy.fetch(`${base}/api/me/devices`, json({ label: 'Desk' }))).json()) as { token: string };
    // The helper gets through before any of Cy's tabs is back.
    expect((await report(token, { app: 'vscode', platform: 'linux', v: 1 })).status).toBe(204);
    const { id } = await createOffice(base);
    const me = await join(base, id, 'Cy', { jar: cy });
    let mine: PresenceState | null = null;
    me.socket.on('presence:state', (s) => (mine = s));
    me.socket.emit('presence:set', { share: true, others: true, manual: { app: 'figma', until: null }, restore: true });
    await until(() => mine?.app === 'figma');
    // Offered again later (another reconnect), it doesn't undo a newer choice.
    me.socket.emit('presence:set', { manual: null });
    await until(() => mine?.app === 'vscode');
    me.socket.emit('presence:set', { manual: { app: 'figma', until: null }, restore: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(mine!.app).toBe('vscode');
  });

  it('lets guests pick a status, for their visit only', async () => {
    const { id } = await createOffice(base);
    const guest = await join(base, id, 'Guest');
    const other = await join(base, id, 'Other');
    const guestId = guest.res.ok ? guest.res.selfId : '';
    let seen: string | null | undefined;
    other.socket.on('player:updated', (pid, patch: PlayerPatch) => {
      if (pid === guestId && 'app' in patch) seen = patch.app;
    });
    guest.socket.emit('presence:set', { manual: { app: 'sheets', until: Date.now() + 60_000 } });
    await until(() => seen === 'sheets');
    // After reconnecting, a status is offered back but doesn't undo a newer one.
    guest.socket.emit('presence:set', { manual: { app: 'figma', until: null }, restore: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toBe('sheets');
    // A guest has no helper, so sharing settings change nothing; nonsense is ignored.
    guest.socket.emit('presence:set', { manual: { app: 'tinder', until: null } });
    guest.socket.emit('presence:set', { share: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toBe('sheets');
    // Clients can't set `app` directly.
    guest.socket.emit('profile', { app: 'figma' } as never);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toBe('sheets');
  });

  it('gives the helper the app list', async () => {
    const res = await fetch(`${base}/api/app-presence/apps`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(appMatchers())));
  });
});
