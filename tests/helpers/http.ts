import { io as connect, type Socket } from 'socket.io-client';
import { DEFAULT_AVATAR } from '../../shared/avatar';
import type { ClientToServerEvents, JoinResponse, ServerToClientEvents } from '../../shared/types';

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

export async function createOffice(base: string, jar?: Jar, name = 'Test HQ', template = 'blank') {
  const res = await (jar ?? new Jar()).fetch(`${base}/api/offices`, json({ name, template }));
  if (res.status !== 201) throw new Error(`creating an office failed: ${res.status}`);
  return (await res.json()) as { id: string; ownerKey: string };
}

const sockets: Client[] = [];

/** Connects (with the jar's cookies, if any) and joins an office. */
export async function join(base: string, officeId: string, name: string, opts: { jar?: Jar; ownerKey?: string; headers?: Record<string, string> } = {}) {
  const cookie = opts.jar?.header();
  const socket: Client = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { ...opts.headers, ...(cookie ? { cookie } : {}) } });
  sockets.push(socket);
  const res = await new Promise<JoinResponse>((resolve, reject) => {
    socket.on('connect_error', reject);
    socket.on('connect', () => socket.emit('join', { officeId, name, avatar: DEFAULT_AVATAR, ownerKey: opts.ownerKey }, resolve));
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
