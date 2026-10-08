import crypto from 'node:crypto';
import { normalizeEmail } from '../shared/account';

// Sending email: through Resend (RESEND_API_KEY and EMAIL_FROM), or, in development without a key,
// into a dev outbox that prints each message's links to the log. Routes only queue messages: they
// never wait for delivery, and a failure is logged, never shown to the person who asked.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** `off`: no email (production without RESEND_API_KEY). */
  readonly kind: 'resend' | 'outbox' | 'off';
  /** Queues a message and returns at once. */
  send(message: MailMessage): void;
  /** Sends what is still queued (without waiting to retry), then stops. */
  close(): Promise<void>;
}

/** The dev outbox: keeps the last 50 messages, for tests and the terminal. */
export interface Outbox extends Mailer {
  readonly kind: 'outbox';
  readonly messages: MailMessage[];
}

const KEEP = 50;
const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;
const ATTEMPTS = 4;
const MAX_WAIT_MS = 60_000;
const MAX_QUEUE = 200;
/** How long closing waits for the queue. */
const CLOSE_MS = 15_000;

/** j***@example.com: enough to tell messages apart in a log, without the address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email[0]}***${email.slice(at)}` : '***';
}

const linksIn = (text: string) => text.match(/https?:\/\/\S+/g) ?? [];

export function noMail(): Mailer {
  return { kind: 'off', send() {}, async close() {} };
}

export function outboxMailer(opts: { log?: boolean } = {}): Outbox {
  const messages: MailMessage[] = [];
  return {
    kind: 'outbox',
    messages,
    send(message) {
      messages.push(message);
      if (messages.length > KEEP) messages.splice(0, messages.length - KEEP);
      if (opts.log !== false) console.log(`[mail] (not sent, dev outbox) to ${maskEmail(message.to)}: "${message.subject}" ${linksIn(message.text).join(' ')}`);
    },
    async close() {},
  };
}

export interface ResendOptions {
  apiKey: string;
  /** EMAIL_FROM, e.g. "Workchop <noreply@mail.example.com>". */
  from: string;
  fetch?: typeof fetch;
  /** Waits between attempts (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
}

/** Retry-After in ms (seconds or an HTTP date), or null. */
function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** Resend's error code (like rate_limit_exceeded), never its message, which may quote the address. */
async function errorName(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
  return typeof body?.name === 'string' ? body.name.replace(/[^\w-]/g, '').slice(0, 60) : '';
}

export function resendMailer(opts: ResendOptions): Mailer {
  const fetchImpl = opts.fetch ?? fetch;
  const queue: { message: MailMessage; key: string }[] = [];
  let running: Promise<void> | null = null;
  let closing = false;
  let wake: (() => void) | null = null;
  const pause = (ms: number) =>
    opts.sleep?.(ms) ??
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  const deliver = async ({ message, key }: { message: MailMessage; key: string }) => {
    for (let attempt = 1; ; attempt++) {
      let problem: string;
      let wait = 1000 * 2 ** (attempt - 1);
      try {
        const res = await fetchImpl(RESEND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
            // The same key on every attempt: Resend sends the message once even if an answer got lost.
            'Idempotency-Key': key,
            'User-Agent': 'Workchop',
          },
          body: JSON.stringify({ from: opts.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) {
          await res.body?.cancel().catch(() => {});
          return;
        }
        problem = `Resend answered ${res.status} ${await errorName(res)}`.trim();
        if (res.status !== 429 && res.status < 500) {
          console.warn(`[mail] could not send a message to ${maskEmail(message.to)}: ${problem}`);
          return;
        }
        wait = retryAfter(res.headers.get('retry-after')) ?? wait;
      } catch (err) {
        problem = (err as Error).name === 'TimeoutError' ? 'Resend did not answer in time' : `Resend could not be reached (${(err as Error).message})`;
      }
      if (attempt >= ATTEMPTS || closing) {
        console.warn(`[mail] could not send a message to ${maskEmail(message.to)}: ${problem}`);
        return;
      }
      await pause(Math.min(wait, MAX_WAIT_MS));
    }
  };

  const run = async () => {
    while (queue.length) await deliver(queue.shift()!);
    running = null;
  };

  return {
    kind: 'resend',
    send(message) {
      if (closing || queue.length >= MAX_QUEUE) {
        console.warn(`[mail] ${closing ? 'shutting down' : 'too much mail waiting'}: a message to ${maskEmail(message.to)} was not sent`);
        return;
      }
      queue.push({ message, key: crypto.randomUUID() });
      running ??= run().catch((err) => console.error('[mail] sending failed:', err));
    },
    async close() {
      closing = true;
      wake?.();
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), CLOSE_MS)));
      if ((await Promise.race([running, late])) === 'late' && queue.length) console.warn(`[mail] ${queue.length} messages were not sent`);
      clearTimeout(timer);
    },
  };
}

/** "Name <address>" or just an address, as Resend takes it. */
export function validSender(from: string): boolean {
  const m = /^(?:([^<>\r\n]{0,100}?)\s*<([^<>\s]+)>|([^<>\s]+))$/.exec(from);
  const address = m?.[2] ?? m?.[3];
  return !!address && normalizeEmail(address) !== null;
}

/**
 * Resend when RESEND_API_KEY is set (EMAIL_FROM must then be a valid sender, or the server doesn't
 * start); without a key, the dev outbox, or no email at all in production.
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env, production = env.NODE_ENV === 'production', quiet = false): Mailer {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (apiKey) {
    const from = env.EMAIL_FROM?.trim() ?? '';
    if (!validSender(from)) {
      throw new Error(`EMAIL_FROM must be the sender for Resend, like "Workchop <noreply@mail.example.com>", on a domain verified in Resend (${from ? `got "${from}"` : 'it is not set'})`);
    }
    if (!quiet) console.log(`[mail] sending email with Resend, from ${from.slice(from.lastIndexOf('@') + 1).replace(/>$/, '')}`);
    return resendMailer({ apiKey, from });
  }
  if (production) {
    console.warn('[mail] RESEND_API_KEY is not set: signing up with email, password resets and email changes are off');
    return noMail();
  }
  if (!quiet) console.log('[mail] no RESEND_API_KEY: emails are printed here instead of sent (dev outbox)');
  return outboxMailer({ log: !quiet });
}
