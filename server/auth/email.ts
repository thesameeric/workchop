import type express from 'express';
import { MAX_PASSWORD, normalizeEmail, passwordProblem, sanitizeUserName, type AccountUser, type AuthProvider } from '../../shared/account';
import { sanitizeAvatar } from '../../shared/avatar';
import { EmailTaken, LastSignInMethod, providerName, type Accounts } from '../accounts';
import type { Db } from '../db';
import { addressKey, windowLimiter } from '../limits';
import type { Mailer } from '../mail';
import { mailTemplates, type MailContent } from '../mailTemplates';
import { Passwords, PasswordsBusy, type Verified } from './passwords';
import { hashToken, isToken, newToken, type Session } from './sessions';

// Email and password: signing up from an emailed link, signing in, password resets, email changes,
// and the account's sign-in methods. Answers never say whether an address has an account.

type Purpose = 'signup' | 'reset' | 'email';

/** How long each kind of link works, and the page it opens (which posts the token from the fragment). */
const LINKS: Record<Purpose, { hours: number; path: string }> = {
  signup: { hours: 24, path: '/signup' },
  reset: { hours: 1, path: '/reset' },
  email: { hours: 24, path: '/confirm-email' },
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface EmailDeps {
  db: Db;
  accounts: Accounts;
  mailer: Mailer;
  /** Links point here; without it, no links are sent. */
  publicOrigin: string | null;
  clientIp(req: express.Request): string;
  session(req: express.Request): Promise<Session | null>;
  requireUser: express.RequestHandler;
  /** Signs this browser in as `user`. */
  startSession(req: express.Request, res: express.Response, user: AccountUser): Promise<void>;
  /** Ends the person's sessions (but `keep`) and disconnects their sockets; returns how many. */
  endSessions(userId: string, keep?: string): Promise<number>;
  onUserUpdated?: (user: AccountUser) => void;
  /** The providers people can sign in with on this server. */
  usable(): AuthProvider[];
}

const bodyOf = (req: express.Request) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
/** A password as typed; anything longer than a password can be is never right. */
const passwordOf = (v: unknown) => (typeof v === 'string' && v.length <= 4 * MAX_PASSWORD ? v : '');

const tooMany = (res: express.Response, ms: number, error: string) => {
  res.status(429).set('Retry-After', String(Math.ceil(ms / 1000))).json({ error });
};
const expired = (res: express.Response) => {
  res.status(400).json({ error: 'This link has expired or was already used.', code: 'expired' });
};
const mailOff = (res: express.Response) => {
  res.status(503).json({ error: 'This server can’t send email.', code: 'mail-off' });
};
const badEmail = (res: express.Response) => {
  res.status(400).json({ error: 'Enter a valid email address.' });
};

/** A handler that answers 503 when too many passwords are being checked at once. */
const hashing =
  (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!(err instanceof PasswordsBusy)) throw err;
      res.status(503).set('Retry-After', '5').json({ error: 'Too many people are signing in right now. Try again in a moment.' });
    }
  };

/**
 * Answers 202 at once and does the rest afterwards, so how long the answer takes doesn't tell
 * whether the address has an account.
 */
const afterAnswering = (res: express.Response, work: () => Promise<void>) => {
  res.status(202).json({ ok: true });
  work().catch((err) => console.error('[auth] could not email a link:', (err as Error).message));
};

export function emailRoutes(router: express.Router, deps: EmailDeps) {
  const { db, accounts, mailer, publicOrigin, requireUser } = deps;
  const emailLinks = mailer.kind !== 'off' && !!publicOrigin;
  if (mailer.kind === 'resend' && !publicOrigin) console.warn('[mail] emailed links need PUBLIC_URL: signing up with email and password resets are off');
  // Once true, it stays true: passwords are never removed.
  let someoneHasPassword = false;

  // At most two passwords are hashed at once: one for signing in, and one kept for links and
  // changes, so a flood of sign-in attempts can't hold up someone finishing a sign-up or a reset.
  const signIns = new Passwords({ concurrency: 1 });
  const passwords = new Passwords({ concurrency: 1 });
  signIns.prepare();

  const visitor = (req: express.Request) => addressKey(deps.clientIp(req));
  // A few emails an hour per address (password resets counted apart, so sign-up requests can't use
  // them up), and a few more per visitor, whoever they write to.
  const mailsTo = windowLimiter(5, HOUR);
  const resetsTo = windowLimiter(1, 15 * MINUTE);
  const mailsFrom = windowLimiter(20, HOUR);
  // Wrong passwords per address from one visitor, and many more from everyone, so that strangers
  // can't easily lock someone out.
  const wrongFrom = windowLimiter(10, 15 * MINUTE);
  const wrongTo = windowLimiter(100, 15 * MINUTE);
  const wrongCurrent = windowLimiter(10, 15 * MINUTE);
  // Each check of an address without a password, or of a wrong password, costs a scrypt. Past this
  // budget (everyone together), addresses without a password only wait as long as a check takes.
  const costlyChecks = windowLimiter(600, 15 * MINUTE);

  /** Counts an email to `email`; false (after answering 429) when there have been too many. */
  const mayMail = (req: express.Request, res: express.Response, email: string, perAddress = mailsTo): boolean => {
    const from = visitor(req);
    const wait = Math.max(perAddress.wait(email), mailsFrom.wait(from));
    if (wait) {
      tooMany(res, wait, 'Too many emails. Try again later.');
      return false;
    }
    perAddress(email);
    mailsFrom(from);
    return true;
  };

  const sendLink = async (purpose: Purpose, email: string, userId: string | null, template: (link: string) => MailContent) => {
    const token = newToken();
    await db.query(
      `INSERT INTO email_tokens (token_hash, purpose, email, user_id, expires_at) VALUES ($1, $2, $3, $4, now() + $5::int * interval '1 hour')`,
      [hashToken(token), purpose, email, userId, LINKS[purpose].hours],
    );
    mailer.send({ to: email, ...template(`${publicOrigin}${LINKS[purpose].path}#t=${token}`) });
  };

  /** The link's details while it works, without using it up. */
  const peek = async (token: unknown, purpose: Purpose) => {
    if (!isToken(token)) return null;
    const res = await db.query<{ email: string; user_id: string | null }>(
      'SELECT email, user_id FROM email_tokens WHERE token_hash = $1 AND purpose = $2 AND expires_at > now()',
      [hashToken(token), purpose],
    );
    return res.rows[0] ?? null;
  };

  /** Uses the link up; null when it was used already or has expired. */
  const take = async (token: unknown, purpose: Purpose) => {
    if (!isToken(token)) return null;
    const res = await db.query<{ email: string; user_id: string | null; fresh: boolean }>(
      'DELETE FROM email_tokens WHERE token_hash = $1 AND purpose = $2 RETURNING email, user_id, expires_at > now() AS fresh',
      [hashToken(token), purpose],
    );
    const link = res.rows[0];
    return link?.fresh ? link : null;
  };

  /** The account's links of this kind sent so far stop working. */
  const dropLinks = (userId: string, purpose: Purpose) => db.query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);

  /** The account as an email names it: its name, and its address or how it signs in. */
  const describe = async (user: AccountUser): Promise<string> => {
    if (user.email) return `${user.name} (${user.email})`;
    const { methods } = await accounts.signInMethods(user.id);
    return methods.length ? `${user.name} (${methods.map((m) => `${providerName(m.provider)}: ${m.label}`).join(', ')})` : user.name;
  };

  router.post('/auth/signup', async (req, res) => {
    if (!emailLinks) return mailOff(res);
    const email = normalizeEmail(bodyOf(req).email);
    if (!email) return badEmail(res);
    if (!mayMail(req, res, email)) return;
    const owner = await accounts.byVerifiedEmail(email);
    if (owner) await sendLink('reset', email, owner.id, mailTemplates.accountExists);
    else await sendLink('signup', email, null, mailTemplates.signup);
    res.status(202).json({ ok: true });
  });

  // Which address a link is for, so its page can say so (without using it up). An email-change link
  // is only shown to the account that asked for it; to anyone else it looks like any unknown link.
  router.post('/auth/link/peek', async (req, res) => {
    const token = bodyOf(req).token;
    const found = isToken(token)
      ? await db.query<{ email: string; purpose: Purpose; user_id: string | null }>(
          'SELECT email, purpose, user_id FROM email_tokens WHERE token_hash = $1 AND expires_at > now()',
          [hashToken(token)],
        )
      : null;
    const link = found?.rows[0];
    if (!link || (link.purpose === 'email' && (await deps.session(req))?.user.id !== link.user_id)) return expired(res);
    res.json({ email: link.email, purpose: link.purpose });
  });

  router.post(
    '/auth/signup/finish',
    hashing(async (req, res) => {
      const body = bodyOf(req);
      const link = await peek(body.token, 'signup');
      if (!link) return expired(res);
      const name = sanitizeUserName(body.name);
      if (!name) {
        res.status(400).json({ error: 'Enter your name.' });
        return;
      }
      const password = passwordOf(body.password);
      const problem = passwordProblem(password, link.email);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
      const passwordHash = await passwords.hash(password);
      const used = await take(body.token, 'signup');
      if (!used) return expired(res);
      const avatar = body.avatar && typeof body.avatar === 'object' ? sanitizeAvatar(body.avatar) : undefined;
      const { user, existing, replaced } = await accounts.createWithPassword({ email: used.email, name, passwordHash, avatar });
      someoneHasPassword = true;
      // Someone verified this address meanwhile (with Google, say): that account now has this
      // password, and whoever knew its old one is signed out.
      if (existing) await dropLinks(user.id, 'reset');
      if (replaced) await deps.endSessions(user.id);
      await deps.startSession(req, res, user);
      res.json({ user });
    }),
  );

  router.post(
    '/auth/password',
    hashing(async (req, res) => {
      const body = bodyOf(req);
      const email = normalizeEmail(body.email) ?? '';
      const from = `${email} ${visitor(req)}`;
      const wait = Math.max(wrongFrom.wait(from), wrongTo.wait(email));
      if (wait) return tooMany(res, wait, 'Too many wrong passwords. Try again later.');
      const account = email ? await accounts.byVerifiedEmail(email) : null;
      const password = passwordOf(body.password);
      let check: Verified;
      if (account?.passwordHash) check = await signIns.verify(password, account.passwordHash);
      else if (!costlyChecks.wait('')) {
        costlyChecks('');
        // Checked against a made-up hash, which takes as long.
        check = await signIns.verify(password, null);
      } else check = await signIns.pretend();
      const user = check.ok && account ? (check.rehash ? await accounts.setPassword(account.id, await signIns.hash(password)) : await accounts.get(account.id)) : null;
      if (!user) {
        wrongFrom(from);
        wrongTo(email);
        if (account?.passwordHash) costlyChecks('');
        res.status(401).json({ error: 'Wrong email or password.' });
        return;
      }
      await deps.startSession(req, res, user);
      res.json({ user });
    }),
  );

  router.post('/auth/password/forgot', async (req, res) => {
    if (!emailLinks) return mailOff(res);
    const email = normalizeEmail(bodyOf(req).email);
    if (!email) return badEmail(res);
    if (!mayMail(req, res, email, resetsTo)) return;
    afterAnswering(res, async () => {
      const owner = await accounts.byVerifiedEmail(email);
      if (owner) await sendLink('reset', email, owner.id, mailTemplates.resetPassword);
    });
  });

  router.post(
    '/auth/password/reset',
    hashing(async (req, res) => {
      const body = bodyOf(req);
      const link = await peek(body.token, 'reset');
      if (!link?.user_id) return expired(res);
      const password = passwordOf(body.password);
      const problem = passwordProblem(password, link.email);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
      const passwordHash = await passwords.hash(password);
      const used = await take(body.token, 'reset');
      const replaced = !!used?.user_id && !!(await accounts.passwordHash(used.user_id));
      // Also when the account's address changed since the link was sent.
      const user = used?.user_id ? await accounts.setPassword(used.user_id, passwordHash, used.email) : null;
      if (!user) return expired(res);
      someoneHasPassword = true;
      await dropLinks(user.id, 'reset');
      // Whoever knew the old password is signed out everywhere (a first password changes nothing there).
      if (replaced) await deps.endSessions(user.id);
      await deps.startSession(req, res, user);
      res.json({ user });
    }),
  );

  // Only the account that asked can confirm its new address: whoever opens the link must be signed
  // in to it, so a link someone else asked for can't put your address on their account.
  router.post('/auth/email/confirm', async (req, res) => {
    const token = bodyOf(req).token;
    const link = await peek(token, 'email');
    if (!link?.user_id) return expired(res);
    const session = await deps.session(req);
    if (session?.user.id !== link.user_id) {
      res.status(401).json({ error: 'Sign in to the account that asked for this change, then open the link again.', code: 'sign-in' });
      return;
    }
    const used = await take(token, 'email');
    if (!used?.user_id) return expired(res);
    await dropLinks(used.user_id, 'email');
    let user: AccountUser | null;
    try {
      user = await accounts.confirmEmail(used.user_id, used.email);
    } catch (err) {
      if (!(err instanceof EmailTaken)) throw err;
      res.status(409).json({ error: 'Another account already uses this email address.', code: 'taken' });
      return;
    }
    if (!user) return expired(res);
    const before = session.user;
    if (before.email !== user.email) {
      // The old address hears of it (only a confirmed one: an unconfirmed one may be anyone's).
      if (before.email && before.emailVerified) mailer.send({ to: before.email, ...mailTemplates.emailChanged(user.email!) });
      await deps.endSessions(user.id, session.tokenHash);
    }
    deps.onUserUpdated?.(user);
    res.json({ user });
  });

  /** Checks the signed-in person's current password; false after answering when it isn't right. */
  const currentPassword = async (res: express.Response, user: AccountUser, current: unknown, stored: string | null): Promise<boolean> => {
    if (typeof current !== 'string' || !current) {
      res.status(400).json({ error: 'Enter your current password.', code: 'current-password' });
      return false;
    }
    const wait = wrongCurrent.wait(user.id);
    if (wait) {
      tooMany(res, wait, 'Too many wrong passwords. Try again later.');
      return false;
    }
    if ((await passwords.verify(passwordOf(current), stored)).ok) return true;
    wrongCurrent(user.id);
    res.status(401).json({ error: 'Wrong password.' });
    return false;
  };

  router.post(
    '/me/password',
    requireUser,
    hashing(async (req, res) => {
      const user = res.locals.user as AccountUser;
      const body = bodyOf(req);
      const stored = await accounts.passwordHash(user.id);
      if (!stored) {
        res.status(400).json({ error: 'Your account has no password yet.', code: 'no-password' });
        return;
      }
      const password = passwordOf(body.password);
      const problem = passwordProblem(password, user.email);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
      if (!(await currentPassword(res, user, body.current, stored))) return;
      await accounts.setPassword(user.id, await passwords.hash(password));
      await dropLinks(user.id, 'reset');
      await deps.endSessions(user.id, (await deps.session(req))?.tokenHash);
      res.json({ ok: true });
    }),
  );

  router.post('/me/password/link', requireUser, async (req, res) => {
    if (!emailLinks) return mailOff(res);
    const user = res.locals.user as AccountUser;
    if (!user.email || !user.emailVerified) {
      res.status(400).json({ error: user.email ? 'Confirm your email address first.' : 'Add an email address first.' });
      return;
    }
    if (!mayMail(req, res, user.email)) return;
    await sendLink('reset', user.email, user.id, mailTemplates.setPassword);
    res.status(202).json({ ok: true });
  });

  router.post(
    '/me/email',
    requireUser,
    hashing(async (req, res) => {
      if (!emailLinks) return mailOff(res);
      const user = res.locals.user as AccountUser;
      const body = bodyOf(req);
      const email = normalizeEmail(body.email);
      if (!email) return badEmail(res);
      if (email === user.email && user.emailVerified) {
        res.status(400).json({ error: 'That’s already your email address.' });
        return;
      }
      // Whoever has the address can reset the password, so changing it takes the password.
      const stored = await accounts.passwordHash(user.id);
      if (stored && !(await currentPassword(res, user, body.current, stored))) return;
      if (!mayMail(req, res, email)) return;
      const account = await describe(user);
      afterAnswering(res, async () => {
        // Only the newest link works.
        await dropLinks(user.id, 'email');
        // Another account has the address: nothing is sent, and the answer doesn't say so.
        const owner = await accounts.byVerifiedEmail(email);
        if (owner && owner.id !== user.id) return;
        await sendLink('email', email, user.id, (link) => mailTemplates.confirmEmail(link, account));
      });
    }),
  );

  router.get('/me/sign-in', requireUser, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await accounts.signInMethods((res.locals.user as AccountUser).id));
  });

  router.delete('/me/sign-in/:provider/:subject', requireUser, async (req, res) => {
    const user = res.locals.user as AccountUser;
    const { provider, subject } = req.params;
    let removed = false;
    if ((provider === 'google' || provider === 'apple' || provider === 'github') && typeof subject === 'string') {
      try {
        removed = await accounts.removeSignInMethod(user.id, provider, subject, deps.usable());
      } catch (err) {
        if (!(err instanceof LastSignInMethod)) throw err;
        res.status(409).json({ error: 'Add another way to sign in first.' });
        return;
      }
    }
    if (!removed) {
      res.status(404).json({ error: 'That sign-in method isn’t connected.' });
      return;
    }
    res.json(await accounts.signInMethods(user.id));
  });

  router.post('/auth/logout-others', requireUser, async (req, res) => {
    const session = await deps.session(req);
    res.json({ ended: await deps.endSessions((res.locals.user as AccountUser).id, session?.tokenHash) });
  });

  return {
    /** The server can email links (sign-up, resets, email changes). */
    emailLinks,
    /** Hashes a new password (with the hashing kept for links and changes); may throw PasswordsBusy. */
    hashPassword: (password: string) => passwords.hash(password),
    /** People can sign in with a password: the server can email links, or someone has a password. */
    async password(): Promise<boolean> {
      if (emailLinks) return true;
      someoneHasPassword ||= await accounts.anyPassword();
      return someoneHasPassword;
    },
  };
}
