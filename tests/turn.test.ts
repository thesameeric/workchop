import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer } from '../server/index';
import { createTestDb } from './helpers/db';
import { Jar } from './helpers/http';
import { cloudflareTurnFromEnv, mintCloudflareIceServers } from '../server/turn';

// The 201 response from Cloudflare's docs (Realtime TURN → Generate credentials).
const CLOUDFLARE_ANSWER = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'user-1',
      credential: 'secret-1',
    },
  ],
};
const TURN = { keyId: 'key-id', apiToken: 'api-token', ttl: 3600 };

const realFetch = globalThis.fetch;
/** Answer Cloudflare TURN API calls with `answer`; everything else goes to the network as usual. */
function fakeCloudflare(answer: (init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://rtc.live.cloudflare.com/')) return realFetch(input, init);
    calls.push({ url, init: init ?? {} });
    return answer(init ?? {});
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('Cloudflare TURN credentials', () => {
  it('mints ICE servers with the TURN key, leaving out port 53', async () => {
    const calls = fakeCloudflare(() => Response.json(CLOUDFLARE_ANSWER, { status: 201 }));
    const servers = await mintCloudflareIceServers(TURN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer api-token');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ttl: 3600 });
    expect(servers).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'user-1',
        credential: 'secret-1',
      },
    ]);
  });

  it('fails on errors and on answers without TURN servers', async () => {
    fakeCloudflare(() => new Response('nope', { status: 401 }));
    await expect(mintCloudflareIceServers(TURN)).rejects.toThrow(/401/);
    vi.restoreAllMocks();
    fakeCloudflare(() => Response.json({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }, { status: 201 }));
    await expect(mintCloudflareIceServers(TURN)).rejects.toThrow(/no TURN/);
  });

  it('reads its settings from the environment', () => {
    expect(cloudflareTurnFromEnv({})).toBeNull();
    expect(cloudflareTurnFromEnv({ CLOUDFLARE_TURN_KEY_ID: 'k' })).toBeNull();
    expect(cloudflareTurnFromEnv({ CLOUDFLARE_TURN_KEY_ID: ' k ', CLOUDFLARE_TURN_KEY_API_TOKEN: 't' })).toEqual({ keyId: 'k', apiToken: 't', ttl: 86400 });
    expect(cloudflareTurnFromEnv({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_KEY_API_TOKEN: 't', CLOUDFLARE_TURN_TTL: '999999' })?.ttl).toBe(48 * 3600);
    expect(cloudflareTurnFromEnv({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_KEY_API_TOKEN: 't', CLOUDFLARE_TURN_TTL: 'soon' })?.ttl).toBe(86400);
    expect(cloudflareTurnFromEnv({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_KEY_API_TOKEN: 't', CLOUDFLARE_TURN_TTL: '' })?.ttl).toBe(86400);
    expect(cloudflareTurnFromEnv({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_KEY_API_TOKEN: 't', CLOUDFLARE_TURN_TTL: '300' })?.ttl).toBe(600);
  });
});

describe('server behind a proxy', () => {
  const servers: { close(): Promise<void> }[] = [];
  const dirs: string[] = [];
  beforeAll(() => createTestDb(), 60_000);
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const start = async (opts: Parameters<typeof startServer>[0]) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'workchop-turn-'));
    dirs.push(dataDir);
    const db = await createTestDb();
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      db,
      quiet: true,
      iceServers: [{ urls: 'stun:static.example' }],
      auth: { google: null, apple: null, devLogin: true },
      ...opts,
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  };

  it('hands out fresh Cloudflare TURN credentials, and static servers when that fails', async () => {
    let answer = () => Response.json(CLOUDFLARE_ANSWER, { status: 201 });
    const calls = fakeCloudflare(() => answer());
    const base = await start({ cloudflareTurn: TURN, clientIpHeader: 'x-test-ip' });
    const config = async (ip = '1.1.1.1') => {
      const res = await fetch(`${base}/api/config`, { headers: { 'x-test-ip': ip } });
      expect(res.headers.get('cache-control')).toBe('no-store');
      return (await res.json()) as { iceServers: { urls: string[] }[]; iceTtl?: number; turn?: boolean };
    };
    const first = await config();
    expect(first.iceTtl).toBe(3600);
    expect(first.turn).toBe(true);
    expect(first.iceServers[1]).toMatchObject({ username: 'user-1', credential: 'secret-1' });
    expect(calls).toHaveLength(1);

    // Each address can mint a limited number per hour, then gets the static servers.
    for (let i = 0; i < 119; i++) await config('2.2.2.2');
    expect((await config('2.2.2.2')).iceTtl).toBe(3600);
    const limited = await config('2.2.2.2');
    expect(limited.iceTtl).toBeUndefined();
    expect(limited.turn).toBe(true); // so the client tries again later
    expect((await config('3.3.3.3')).iceTtl).toBe(3600);

    // Cloudflare down: calls fall back to the static servers, and for a while nobody waits on it.
    answer = () => new Response('down', { status: 500 });
    const before = calls.length;
    const fallback = await config();
    expect(fallback.iceServers).toEqual([{ urls: 'stun:static.example' }]);
    expect(fallback.iceTtl).toBeUndefined();
    await config('4.4.4.4');
    expect(calls.length).toBe(before + 1);
  });

  it('says nothing about TURN when it is not configured', async () => {
    const base = await start({ cloudflareTurn: null });
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as { turn?: boolean; iceTtl?: number };
    expect(cfg.turn).toBe(false);
    expect(cfg.iceTtl).toBeUndefined();
  });

  it('limits office creation per visitor, using the proxy’s client-IP header when told to', async () => {
    let makers = 0;
    const post = (jar: Jar, url: string, headers: Record<string, string>, body: object) =>
      jar.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    /**
     * Offices made by one visitor (the headers for each request say where from), signed in to a
     * new account for every 10, since an account makes at most 10 an hour.
     */
    const visitor = (base: string, headers: (i: number) => Record<string, string>) => {
      let jar: Jar | null = null;
      let made = 0;
      let i = 0;
      return async () => {
        const from = headers(i++);
        if (!jar || made === 10) {
          jar = new Jar();
          made = 0;
          expect((await post(jar, `${base}/api/auth/dev`, from, { name: `Maker ${++makers}` })).status).toBe(200);
        }
        const res = await post(jar, `${base}/api/offices`, from, {});
        if (res.status === 201) made++;
        return res.status;
      };
    };
    const header = (name: string, ip: string) => () => ({ [name]: ip });

    const behindCloudflare = await start({ clientIpHeader: 'cf-connecting-ip' });
    const fromCloudflare = visitor(behindCloudflare, header('cf-connecting-ip', '10.0.0.1'));
    for (let i = 0; i < 30; i++) expect(await fromCloudflare()).toBe(201);
    expect(await fromCloudflare()).toBe(429);
    expect(await visitor(behindCloudflare, header('cf-connecting-ip', '10.0.0.2'))()).toBe(201);

    // An account makes at most 10 an hour, wherever it is.
    const busy = new Jar();
    await post(busy, `${behindCloudflare}/api/auth/dev`, { 'cf-connecting-ip': '10.0.5.1' }, { name: 'Busy' });
    for (let i = 0; i < 10; i++) expect((await post(busy, `${behindCloudflare}/api/offices`, { 'cf-connecting-ip': `10.0.5.${i}` }, {})).status).toBe(201);
    expect((await post(busy, `${behindCloudflare}/api/offices`, { 'cf-connecting-ip': '10.0.6.1' }, {})).status).toBe(429);

    // Behind Caddy: X-Forwarded-For, first address (Caddy replaces whatever the visitor sent).
    const behindCaddy = await start({ clientIpHeader: 'x-forwarded-for' });
    const viaCaddy = visitor(behindCaddy, (i) => ({ 'x-forwarded-for': `10.2.0.1, 172.18.0.${i}` }));
    for (let i = 0; i < 30; i++) expect(await viaCaddy()).toBe(201);
    expect(await viaCaddy()).toBe(429);
    expect(await visitor(behindCaddy, header('x-forwarded-for', '10.2.0.2'))()).toBe(201);

    // The setting can also come from the environment.
    process.env.CLIENT_IP_HEADER = 'cf-connecting-ip';
    try {
      const fromEnv = await start({});
      const create = visitor(fromEnv, header('cf-connecting-ip', '10.3.0.1'));
      for (let i = 0; i < 30; i++) expect(await create()).toBe(201);
      expect(await create()).toBe(429);
      expect(await visitor(fromEnv, header('cf-connecting-ip', '10.3.0.2'))()).toBe(201);
    } finally {
      delete process.env.CLIENT_IP_HEADER;
    }

    // Without the setting the header is ignored, so nobody can dodge the limit by faking it.
    const direct = await start({ clientIpHeader: null });
    const faking = visitor(direct, (i) => ({ 'cf-connecting-ip': `10.1.0.${i}` }));
    for (let i = 0; i < 30; i++) expect(await faking()).toBe(201);
    expect(await visitor(direct, header('cf-connecting-ip', '10.9.9.9'))()).toBe(429);
  });
});
