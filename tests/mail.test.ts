import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailerFromEnv, maskEmail, outboxMailer, resendMailer, validSender, type MailMessage } from '../server/mail';
import { mailTemplates } from '../server/mailTemplates';
import { until } from './helpers/http';

const KEY = 're_test_0123456789abcdef';
const message = (to = 'jane@example.com'): MailMessage => ({ to, subject: 'Hello', text: 'Hi http://localhost:5173/signup#t=abc', html: '<p>Hi</p>' });

/** A stand-in for Resend that answers each request with the next of `answers` (then 200). */
function fakeResend(...answers: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return (answers.shift() ?? (() => Response.json({ id: 'email-1' })))();
  });
  const waits: number[] = [];
  const mailer = resendMailer({ apiKey: KEY, from: 'Workchop <noreply@mail.example.com>', fetch: fetch as typeof globalThis.fetch, sleep: async (ms) => void waits.push(ms) });
  const headers = (i: number) => new Headers(calls[i].init.headers);
  return { mailer, calls, waits, headers };
}

afterEach(() => vi.restoreAllMocks());

describe('the Resend client', () => {
  it('posts each message once, with the key, an idempotency key and a timeout', async () => {
    const { mailer, calls, headers } = fakeResend();
    mailer.send(message());
    mailer.send(message('joe@example.com'));
    await until(() => calls.length === 2);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.method).toBe('POST');
    expect(headers(0).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers(0).get('content-type')).toBe('application/json');
    expect(headers(0).get('idempotency-key')).toMatch(/^[\w-]{36}$/);
    expect(headers(1).get('idempotency-key')).not.toBe(headers(0).get('idempotency-key'));
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      from: 'Workchop <noreply@mail.example.com>',
      to: ['jane@example.com'],
      subject: 'Hello',
      text: message().text,
      html: '<p>Hi</p>',
    });
    await mailer.close();
  });

  it('retries on 429 (after Retry-After), 5xx and network errors, with the same idempotency key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mailer, calls, waits, headers } = fakeResend(
      () => Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '3' } }),
      () => new Response('oops', { status: 502 }),
      () => Promise.reject(new TypeError('fetch failed')),
    );
    mailer.send(message());
    await until(() => calls.length === 4);
    expect(waits).toEqual([3000, 2000, 4000]);
    expect(new Set(calls.map((_, i) => headers(i).get('idempotency-key'))).size).toBe(1);
    await mailer.close();
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up on other refusals at once, and after four attempts, logging neither the key nor the address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = fakeResend(() => Response.json({ name: 'validation_error', message: 'Invalid `to`: jane@example.com' }, { status: 422 }));
    refused.mailer.send(message());
    await until(() => warn.mock.calls.length === 1);
    expect(refused.calls).toHaveLength(1);
    expect(warn.mock.calls[0].join(' ')).toBe('[mail] could not send a message to j***@example.com: Resend answered 422 validation_error');

    const down = fakeResend(...Array.from({ length: 4 }, () => () => new Response('', { status: 503 })));
    down.mailer.send(message());
    await until(() => warn.mock.calls.length === 2);
    expect(down.calls).toHaveLength(4);
    expect(down.waits).toEqual([1000, 2000, 4000]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('jane@example.com');
    await Promise.all([refused.mailer.close(), down.mailer.close()]);
  });

  it('sends what is queued on close, without waiting to retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release!: () => void;
    const { mailer, calls, waits } = fakeResend(
      () => new Promise<Response>((resolve) => (release = () => resolve(new Response('', { status: 500 })))),
      () => Response.json({ id: 'b' }),
    );
    mailer.send(message('a@example.com'));
    mailer.send(message('b@example.com'));
    await until(() => calls.length === 1);
    const closing = mailer.close();
    release();
    await closing;
    expect(calls.map((c) => JSON.parse(String(c.init.body)).to[0])).toEqual(['a@example.com', 'b@example.com']);
    expect(waits).toEqual([]);
    expect(warn.mock.calls.join(' ')).toContain('a***@example.com');
    // Nothing more is sent once closed.
    mailer.send(message('c@example.com'));
    expect(calls).toHaveLength(2);
  });
});

describe('choosing how to send email', () => {
  it('uses Resend with a key and a valid EMAIL_FROM, and refuses to start without one', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(mailerFromEnv({ RESEND_API_KEY: KEY, EMAIL_FROM: 'Workchop <noreply@mail.example.com>' }).kind).toBe('resend');
    expect(mailerFromEnv({ RESEND_API_KEY: ` ${KEY} `, EMAIL_FROM: 'noreply@mail.example.com' }, true).kind).toBe('resend');
    expect(log.mock.calls.flat().join(' ')).not.toContain(KEY);
    for (const from of [undefined, '', 'Workchop', 'Workchop <noreply>', '<a@b.example> extra', 'x\ny@example.com']) {
      let error: Error | null = null;
      try {
        mailerFromEnv({ RESEND_API_KEY: KEY, EMAIL_FROM: from });
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message, String(from)).toMatch(/EMAIL_FROM must be/);
      expect(error?.message).not.toContain(KEY);
    }
  });

  it('prints to a dev outbox without a key, and sends nothing in production', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mailerFromEnv({}).kind).toBe('outbox');
    expect(mailerFromEnv({ NODE_ENV: 'development', EMAIL_FROM: 'nonsense' }).kind).toBe('outbox');
    expect(warn).not.toHaveBeenCalled();
    expect(mailerFromEnv({ NODE_ENV: 'production' }).kind).toBe('off');
    expect(mailerFromEnv({}, true).kind).toBe('off');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RESEND_API_KEY is not set'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dev outbox'));
  });

  it('keeps the last 50 messages in the outbox and logs their links, not their addresses', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outbox = outboxMailer();
    for (let i = 0; i < 55; i++) outbox.send(message(`user${i}@example.com`));
    expect(outbox.messages).toHaveLength(50);
    expect(outbox.messages[0].to).toBe('user5@example.com');
    expect(log.mock.calls[0][0]).toBe('[mail] (not sent, dev outbox) to u***@example.com: "Hello" http://localhost:5173/signup#t=abc');
    expect(JSON.stringify(log.mock.calls)).not.toContain('user0@');
    outboxMailer({ log: false }).send(message());
    expect(log).toHaveBeenCalledTimes(55);
  });

  it('checks senders and masks addresses', () => {
    expect(validSender('"Workchop Team" <noreply@mail.example.com>')).toBe(true);
    expect(validSender('a@b.co')).toBe(true);
    expect(validSender('Workchop <a@b>')).toBe(false);
    expect(maskEmail('jane@example.com')).toBe('j***@example.com');
    expect(maskEmail('nonsense')).toBe('***');
  });
});

describe('email templates', () => {
  it('have a subject, a text and an escaped HTML version with the link', () => {
    const link = 'http://localhost:5173/reset#t=a"b<c>&d';
    const { signup, accountExists, resetPassword, setPassword, confirmEmail } = mailTemplates;
    for (const mail of [signup(link), accountExists(link), resetPassword(link), setPassword(link), confirmEmail(link, 'Mal <b>ory</b> (m@example.com)')]) {
      expect(mail.subject).toBeTruthy();
      expect(mail.text).toContain(link);
      expect(mail.html).toContain('href="http://localhost:5173/reset#t=a&#34;b&#60;c&#62;&#38;d"');
      expect(mail.html).not.toContain('a"b<c>');
      expect(mail.html).not.toContain('<b>');
    }
    const changed = mailTemplates.emailChanged('new@example.com');
    expect(changed.text).toContain('new@example.com');
    expect(changed.html).not.toContain('href');
  });
});
