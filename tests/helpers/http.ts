import { io as connect, type Socket } from 'socket.io-client';
import { DEFAULT_AVATAR } from '../../shared/avatar';
import type { ClientToServerEvents, JoinRequest, JoinResponse, ServerToClientEvents } from '../../shared/types';
import type { MemberRole } from '../../shared/workspace';
import type { Db } from '../../server/db';

export type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

/** A browser's cookies, for fetch (which keeps none by itself in Node). */
export class Jar {
  readonly cookies = new Map<string, string>();

  store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** fetch with these cookies, without following redirects. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', this.header());
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    this.store(res);
    return res;
  }
}

export function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

let accounts = 0;

/**
 * Signs a new browser in with the dev login, as a new account named `name` (its address, made up
 * unless given, isn't verified).
 */
export async function signIn(base: string, name = 'Tester', email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${++accounts}.${Date.now()}@example.com`): Promise<Jar> {
  const jar = new Jar();
  const res = await jar.fetch(`${base}/api/auth/dev`, json({ name, email }));
  if (res.status !== 200) throw new Error(`signing in failed: ${res.status}`);
  return jar;
}

export interface TestOffice {
  id: string;
  /** The owner's browser. */
  owner: Jar;
  /** The guest link's token, which join() uses by default. */
  guest: string;
}

/** The guest link's token of each office made here. */
const guestLinks = new Map<string, string>();

/**
 * Creates an office as people do: signed in (as a new account named `owner`, or in that browser),
 * then turns its guest link on, so anyone can join() it as a guest.
 */
export async function createOffice(base: string, owner: Jar | string = 'Owner', name = 'Test HQ', template = 'blank'): Promise<TestOffice> {
  const jar = typeof owner === 'string' ? await signIn(base, owner) : owner;
  const res = await jar.fetch(`${base}/api/offices`, json({ name, template }));
  if (res.status !== 201) throw new Error(`creating an office failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  const access = await jar.fetch(`${base}/api/offices/${id}/access`, json({ guests: 'link' }, 'PUT'));
  if (access.status !== 200) throw new Error(`turning the guest link on failed: ${access.status}`);
  const { link } = (await access.json()) as { link: string };
  const guest = link.slice(link.indexOf('#guest=') + 7);
  guestLinks.set(id, guest);
  return { id, owner: jar, guest };
}

/** Makes someone (a new account named `who`, or that browser's) a member of the office; returns their browser. */
export async function member(base: string, db: Db, officeId: string, who: Jar | string = 'Member', role: MemberRole = 'member'): Promise<Jar> {
  const jar = typeof who === 'string' ? await signIn(base, who) : who;
  const { user } = (await (await jar.fetch(`${base}/api/me`)).json()) as { user: { id: string } | null };
  if (!user) throw new Error('member() needs a signed-in browser');
  await db.query(
    'INSERT INTO memberships (user_id, office_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, office_id) DO UPDATE SET role = EXCLUDED.role',
    [user.id, officeId, role],
  );
  return jar;
}

const sockets: Client[] = [];

/**
 * Connects (with the jar's cookies, if any) and joins an office, with its guest link when
 * createOffice made it (`guest` gives another token; '' none). `request` adds to the join request.
 */
export async function join(
  base: string,
  officeId: string,
  name: string,
  opts: { jar?: Jar; ownerKey?: string; guest?: string; headers?: Record<string, string>; request?: Partial<JoinRequest> } = {},
) {
  const cookie = opts.jar?.header();
  const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { ...opts.headers, ...(cookie ? { cookie } : {}) } });
  sockets.push(socket);
  const guest = opts.guest ?? guestLinks.get(officeId);
  const res = await new Promise<JoinResponse>((resolve, reject) => {
    socket.on('connect_error', reject);
    socket.on('connect', () => socket.emit('join', { officeId, name, avatar: DEFAULT_AVATAR, ownerKey: opts.ownerKey, guest, ...opts.request }, resolve));
  });
  if (!res.ok) throw new Error(res.error);
  return { socket, res };
}

export function disconnectAll(): void {
  for (const s of sockets.splice(0)) s.disconnect();
}

/** Waits for `cond` to hold, polling. */
export async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
