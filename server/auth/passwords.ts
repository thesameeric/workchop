import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { normalizePassword } from '../../shared/account';

// Password hashes: scrypt, stored as scrypt$N$r$p$salt$hash (salt and hash in base64url).

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Today's cost: about 100 ms and 32 MiB per hash. Hashes made with other values are redone at sign-in. */
export const SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };
const MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** A 32-byte hash in base64url is 43 characters. */
const FORMAT = /^scrypt\$(\d{1,7})\$(\d{1,2})\$(\d{1,2})\$([\w-]{16,64})\$([\w-]{43})$/;

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>;

/** Too many passwords are being checked at once; try again shortly (HTTP 503). */
export class PasswordsBusy extends Error {}

export interface Verified {
  ok: boolean;
  /** Right, but hashed with older parameters: save a new hash. */
  rehash: boolean;
}

/**
 * Hashes and checks passwords, at most `concurrency` at a time (each takes a thread and 32 MiB),
 * with up to `queue` more waiting; past that, PasswordsBusy.
 */
export class Passwords {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private dummy: Promise<string> | null = null;
  /** How long a hash takes lately, in ms (for pretend). */
  private typical = 100;

  constructor(private readonly opts: { params?: ScryptParams; concurrency?: number; queue?: number } = {}) {}

  private get params(): ScryptParams {
    return this.opts.params ?? SCRYPT;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= (this.opts.concurrency ?? 2)) {
      if (this.waiting.length >= (this.opts.queue ?? 16)) throw new PasswordsBusy('Too many passwords to check right now');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.running++;
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next one waiting, or free it.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  /** Runs scrypt, keeping track of how long it takes. */
  private run(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
    return this.limited(async () => {
      const started = performance.now();
      const key = await scrypt(normalizePassword(password), salt, KEY_BYTES, { N, r, p, maxmem: MAXMEM });
      this.typical = 0.8 * this.typical + 0.2 * (performance.now() - started);
      return key;
    });
  }

  /** The made-up hash checked when there's no real one. */
  private madeUp(): Promise<string> {
    this.dummy ??= this.hash(crypto.randomBytes(16).toString('base64url')).catch((err) => {
      this.dummy = null;
      throw err;
    });
    return this.dummy;
  }

  /** Makes the made-up hash now, so that the first check without an account takes no longer either. */
  prepare(): void {
    this.madeUp().catch(() => {});
  }

  async hash(password: string): Promise<string> {
    const { N, r, p } = this.params;
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = await this.run(password, salt, this.params);
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  /**
   * Whether `password` matches `stored`. Without a stored hash (no such account, or no password) a
   * made-up one is checked instead, so the answer takes as long either way.
   */
  async verify(password: string, stored: string | null): Promise<Verified> {
    const parts = stored ? FORMAT.exec(stored) : null;
    if (!parts) {
      await this.verify(password, await this.madeUp());
      return { ok: false, rehash: false };
    }
    const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    const expected = Buffer.from(parts[5], 'base64url');
    let key: Buffer;
    try {
      key = await this.run(password, Buffer.from(parts[4], 'base64url'), { N, r, p });
    } catch (err) {
      // Parameters scrypt refuses (a damaged hash) can never match.
      if (err instanceof PasswordsBusy) throw err;
      return { ok: false, rehash: false };
    }
    const ok = crypto.timingSafeEqual(key, expected);
    const current = this.params;
    return { ok, rehash: ok && (N !== current.N || r !== current.r || p !== current.p) };
  }

  /** A wrong answer that takes about as long as checking a password, without the work. */
  async pretend(): Promise<Verified> {
    await new Promise((resolve) => setTimeout(resolve, this.typical));
    return { ok: false, rehash: false };
  }
}
