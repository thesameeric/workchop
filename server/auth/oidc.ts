import crypto from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import * as client from 'openid-client';
import { sanitizeUserName } from '../../shared/account';
import type { Identity } from '../accounts';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Overridable for tests (a local mock server). */
  issuer: string;
}

export interface AppleConfig {
  /** The Services ID. */
  clientId: string;
  teamId: string;
  keyId: string;
  /** The .p8 key, as PEM. */
  privateKey: string;
  issuer: string;
}

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const APPLE_ISSUER = 'https://appleid.apple.com';

/** A sign-in provider the routes in ./index.ts drive. */
export interface OidcProvider {
  name: 'google' | 'apple';
  /** PKCE where the provider documents it (Google); Apple relies on state and nonce. */
  pkce: boolean;
  config(): Promise<client.Configuration>;
  /** Extra authorization parameters. */
  params: Record<string, string>;
  identity(claims: client.IDToken, extra: { appleUser?: unknown }): Identity;
}

/** allowInsecureRequests is only ever applied to a mock issuer on this machine. */
function localHttp(issuer: string): boolean {
  const url = new URL(issuer);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** Discovery is fetched on first use and retried after a failure, so startup never depends on it. */
function lazy(load: () => Promise<client.Configuration>): () => Promise<client.Configuration> {
  let pending: Promise<client.Configuration> | null = null;
  return () => {
    pending ??= load().catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

/** "true"/"false" strings (Apple) or booleans. */
function flag(v: unknown): boolean {
  return v === true || v === 'true';
}

function emailOf(claims: client.IDToken): string | null {
  return typeof claims.email === 'string' && claims.email.length <= 254 ? claims.email.toLowerCase() : null;
}

export function googleProvider(cfg: GoogleConfig): OidcProvider {
  return {
    name: 'google',
    pkce: true,
    params: { scope: 'openid email profile', prompt: 'select_account' },
    config: lazy(() =>
      client.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret, undefined, {
        execute: localHttp(cfg.issuer) ? [client.allowInsecureRequests] : [],
      }),
    ),
    identity(claims) {
      const email = emailOf(claims);
      const picture = typeof claims.picture === 'string' && claims.picture.startsWith('https://') && claims.picture.length < 1000 ? claims.picture : null;
      return {
        provider: 'google',
        subject: claims.sub,
        email,
        emailVerified: flag(claims.email_verified),
        isPrivateEmail: false,
        name: sanitizeUserName(claims.name) || sanitizeUserName(email?.split('@')[0]) || 'Google user',
        avatarUrl: picture,
      };
    },
  };
}

/** Accepts the .p8 PEM as is, with "\n" escapes (one-line env vars), or base64-encoded. */
export function parsePrivateKey(raw: string): string {
  const text = raw.trim().replace(/\\n/g, '\n');
  if (text.includes('-----BEGIN')) return text;
  const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
  if (decoded.includes('-----BEGIN')) return decoded;
  // Just the key's base64 body.
  const body = text.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

/** Throws if the key isn't a usable EC private key. */
export function checkPrivateKey(pem: string): void {
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ec') throw new Error('APPLE_PRIVATE_KEY must be the EC (.p8) key from Apple');
}

/** Apple's name for the user, sent (unsigned) only the very first time they consent. */
function appleName(user: unknown): string {
  if (typeof user !== 'string' || user.length > 2000) return '';
  try {
    const name = (JSON.parse(user) as { name?: { firstName?: unknown; lastName?: unknown } })?.name;
    const first = sanitizeUserName(name?.firstName);
    const last = sanitizeUserName(name?.lastName);
    return sanitizeUserName(`${first} ${last}`);
  } catch {
    return '';
  }
}

export function appleProvider(cfg: AppleConfig): OidcProvider {
  // Apple's client secret is a JWT signed with the .p8 key, valid for at most 6 months: make one
  // at runtime and replace it well before it expires.
  let secret: { jwt: string; renewAt: number } | null = null;
  const clientSecret = async () => {
    if (secret && secret.renewAt > Date.now()) return secret.jwt;
    const key = await importPKCS8(cfg.privateKey, 'ES256');
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: cfg.keyId })
      .setIssuer(cfg.teamId)
      .setIssuedAt()
      .setExpirationTime('30d')
      .setAudience(APPLE_ISSUER)
      .setSubject(cfg.clientId)
      .sign(key);
    secret = { jwt, renewAt: Date.now() + 20 * 24 * 3600 * 1000 };
    return jwt;
  };
  // client_secret_post with a secret that changes over time (a Configuration's own auth is fixed).
  const auth: client.ClientAuth = async (_as, meta, body) => {
    body.set('client_id', meta.client_id);
    body.set('client_secret', await clientSecret());
  };
  // Apple's endpoints are fixed; any other issuer (a test mock) is discovered.
  const config =
    cfg.issuer === APPLE_ISSUER
      ? lazy(async () =>
          new client.Configuration(
            {
              issuer: APPLE_ISSUER,
              authorization_endpoint: `${APPLE_ISSUER}/auth/authorize`,
              token_endpoint: `${APPLE_ISSUER}/auth/token`,
              jwks_uri: `${APPLE_ISSUER}/auth/keys`,
            },
            cfg.clientId,
            undefined,
            auth,
          ),
        )
      : lazy(() =>
          client.discovery(new URL(cfg.issuer), cfg.clientId, undefined, auth, {
            execute: localHttp(cfg.issuer) ? [client.allowInsecureRequests] : [],
          }),
        );
  return {
    name: 'apple',
    pkce: false,
    params: { scope: 'name email', response_mode: 'form_post' },
    config,
    identity(claims, extra) {
      const email = emailOf(claims);
      const isPrivateEmail = flag(claims.is_private_email);
      return {
        provider: 'apple',
        subject: claims.sub,
        email,
        emailVerified: flag(claims.email_verified),
        isPrivateEmail,
        name: appleName(extra.appleUser) || (isPrivateEmail ? '' : sanitizeUserName(email?.split('@')[0])) || 'Apple user',
        avatarUrl: null,
      };
    },
  };
}
