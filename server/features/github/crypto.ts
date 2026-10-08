import crypto from 'node:crypto';

// GitHub tokens are kept encrypted (AES-256-GCM) with TOKEN_ENCRYPTION_KEY. The associated data ties
// each ciphertext to its user and field, so a stored value copied to another row doesn't decrypt.

export type TokenField = 'access' | 'refresh';

const B64URL = /^[A-Za-z0-9_-]+$/;

/** TOKEN_ENCRYPTION_KEY (base64 of exactly 32 bytes) as a key, or null when it isn't one. */
export function parseTokenKey(raw: string | null | undefined): Buffer | null {
  const s = raw?.trim() ?? '';
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) return null;
  const key = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return key.length === 32 ? key : null;
}

const aad = (userId: string, field: TokenField) => Buffer.from(`github:${userId}:${field}`, 'utf8');

/** `v1.<iv>.<ciphertext>.<tag>`, each part base64url. */
export function encryptToken(key: Buffer, userId: string, field: TokenField, token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(userId, field));
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** The token, or an error when the value was changed, belongs elsewhere, or was made with another key. */
export function decryptToken(key: Buffer, userId: string, field: TokenField, stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !parts.slice(1).every((p) => B64URL.test(p))) throw new Error('Not an encrypted token');
  const [iv, ct, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Not an encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(aad(userId, field));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
