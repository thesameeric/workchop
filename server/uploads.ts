import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AwsClient } from 'aws4fetch';
import express from 'express';
import { isValidId } from '../shared/office';
import { clip } from '../shared/text';
import { tooLarge, type UploadedFile } from '../shared/uploads';
import type { Db, Tx } from './db';
import { windowLimiter } from './limits';

export type { UploadedFile };
export type UploadStorage = 'db' | 'fs' | 's3';

export interface S3Options {
  /** e.g. https://<account id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface UploadOptions {
  /** Where new files go. Default: s3 when configured, else the database with Postgres, else files. */
  storage?: UploadStorage;
  maxBytes: number;
  /** Total size of the files one office may keep. */
  quotaBytes: number;
  /** Folder for the "fs" store. */
  dir: string;
  s3: S3Options | null;
}

const MB = 1024 * 1024;
export const S3_MISSING = 'UPLOADS_STORAGE=s3 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY';

export function uploadOptionsFromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env): UploadOptions {
  const positive = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v && Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const storage = env.UPLOADS_STORAGE?.trim();
  if (storage && !['db', 'fs', 's3'].includes(storage)) throw new Error(`UPLOADS_STORAGE must be s3, db or fs (got "${storage}")`);
  const s3 =
    env.S3_BUCKET && env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          endpoint: env.S3_ENDPOINT,
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          region: env.S3_REGION || 'auto',
        }
      : null;
  if (env.S3_BUCKET && !s3) console.warn('[uploads] S3_BUCKET is set, but S3_ENDPOINT, S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY is missing');
  return {
    storage: (storage || undefined) as UploadStorage | undefined,
    maxBytes: Math.floor(positive(env.UPLOAD_MAX_BYTES, 10 * MB)),
    quotaBytes: Math.floor(positive(env.UPLOADS_QUOTA_MB, 1024) * MB),
    dir: path.join(dataDir, 'uploads'),
    s3,
  };
}

/** Where the bytes of uploaded files live. Each upload row records its store, so switching keeps old files readable. */
export interface BlobStore {
  readonly kind: UploadStorage;
  readonly description: string;
  /** `tx` is the transaction that inserts the upload's row (the db store writes in it). */
  put(key: string, data: Buffer, contentType: string, tx: Tx): Promise<void>;
  get(key: string): Promise<Buffer | Readable | null>;
  delete(key: string): Promise<void>;
}

/** Bytes in the upload_blobs table. Fine for small teams on Postgres; not for PGlite (big queries block the server). */
class DbBlobStore implements BlobStore {
  readonly kind = 'db';
  readonly description = 'the database';
  constructor(private readonly db: Db) {}

  async put(key: string, data: Buffer, _contentType: string, tx: Tx): Promise<void> {
    await tx.query('INSERT INTO upload_blobs (upload_id, data) VALUES ($1, $2)', [key, data]);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.db.query<{ data: Buffer }>('SELECT data FROM upload_blobs WHERE upload_id = $1', [key]);
    return res.rows[0]?.data ?? null;
  }

  async delete(key: string): Promise<void> {
    await this.db.query('DELETE FROM upload_blobs WHERE upload_id = $1', [key]);
  }
}

/** One file per upload under DATA_DIR/uploads/<office>/<id>. */
class FsBlobStore implements BlobStore {
  readonly kind = 'fs';
  readonly description: string;
  constructor(private readonly dir: string) {
    const relative = path.relative(process.cwd(), dir);
    this.description = relative && !relative.startsWith('..') ? relative : dir;
  }

  /** Keys are "<office id>/<uuid>", both checked, so they can't point outside the folder. */
  private file(key: string): string {
    const [office, id, ...rest] = key.split('/');
    if (!isValidId(office) || !UUID.test(id ?? '') || rest.length) throw new Error(`Bad upload key ${key}`);
    return path.join(this.dir, office, id);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }

  async get(key: string): Promise<Readable | null> {
    const file = this.file(key);
    try {
      await fs.access(file);
    } catch {
      return null;
    }
    return createReadStream(file);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}

/** Any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO…), with path-style URLs. */
class S3BlobStore implements BlobStore {
  readonly kind = 's3';
  readonly description: string;
  private readonly client: AwsClient;

  constructor(private readonly opts: S3Options) {
    // aws4fetch retries 5xx answers 10 times by default, which keeps a download waiting for half a minute.
    this.client = new AwsClient({ accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, service: 's3', region: opts.region, retries: 2 });
    this.description = `the S3 bucket ${opts.bucket}`;
  }

  private url(key: string): string {
    const base = this.opts.endpoint.replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(this.opts.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async check(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`S3 ${what} failed (${res.status}) ${detail}`);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    // A plain Uint8Array copy: fetch's types don't take a Buffer, and aws4fetch hashes the body for the signature.
    const res = await this.client.fetch(this.url(key), { method: 'PUT', body: new Uint8Array(data), headers: { 'content-type': contentType } });
    await this.check(res, 'upload');
  }

  async get(key: string): Promise<Readable | null> {
    const res = await this.client.fetch(this.url(key));
    if (res.status === 404) return null;
    await this.check(res, 'download');
    return res.body ? Readable.fromWeb(res.body as import('node:stream/web').ReadableStream) : Readable.from([]);
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' });
    if (res.status !== 404) await this.check(res, 'delete');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Shown in the page; everything else is downloaded (SVG can carry scripts). */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Control characters, and the bidi controls that can make "fdp.exe" read as "exe.pdf". */
const UNSAFE_IN_NAMES = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function sanitizeFilename(v: unknown): string {
  if (typeof v !== 'string') return 'file';
  const base = v.split(/[/\\]/).pop() ?? '';
  const clean = clip(base.replace(UNSAFE_IN_NAMES, '').replace(/\s+/g, ' ').trim(), 200).trim();
  return clean && clean !== '.' && clean !== '..' ? clean : 'file';
}

function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** Who is uploading: someone with a socket that is in the office right now. */
export interface Uploader {
  userId: string | null;
  name: string;
}

class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface UploadDeps {
  db: Db;
  options: UploadOptions;
  /** The person behind this socket if it is connected and in that office, and `uploadKey` is its key. */
  uploaderOf(socketId: string, uploadKey: string, officeId: string): Uploader | null;
  /** The visitor's address, to share the server's capacity fairly. */
  clientIp(req: express.Request): string;
}

/** Uploads one visitor (address) may have in progress at once, and start per PER_VISITOR_WINDOW. */
const PER_VISITOR_AT_ONCE = 3;
const PER_VISITOR_FILES = 60;
const PER_VISITOR_WINDOW = 10 * 60 * 1000;
/** Bodies are kept in memory until stored: at most this many of the largest files at once, server-wide. */
const BUFFERED_FILES = 4;

export type Uploads = ReturnType<typeof createUploads>;

/** File uploads for an office (chat attachments and the like), stored in the database, on disk or in S3. */
export function createUploads(deps: UploadDeps) {
  const { db, options } = deps;
  const stores: Partial<Record<UploadStorage, BlobStore>> = {
    db: new DbBlobStore(db),
    fs: new FsBlobStore(options.dir),
  };
  if (options.s3) stores.s3 = new S3BlobStore(options.s3);
  // PGlite runs queries on the main thread, so big blobs there would stall everyone's movement.
  const kind: UploadStorage = options.storage ?? (options.s3 ? 's3' : db.kind === 'postgres' ? 'db' : 'fs');
  const store = stores[kind];
  if (!store) throw new Error(S3_MISSING);
  const parseBody = express.raw({ type: () => true, limit: options.maxBytes });
  const quotaFull = () => new UploadError(413, `This office has used up its ${Math.round(options.quotaBytes / MB)} MB of file storage.`);
  const mayStart = windowLimiter(PER_VISITOR_FILES, PER_VISITOR_WINDOW);
  const inProgress = new Map<string, number>();
  let buffered = 0;

  const readBody = (req: express.Request, res: express.Response) =>
    new Promise<Buffer>((resolve, reject) => {
      parseBody(req, res, (err?: unknown) => {
        if (err) {
          const status = (err as { status?: number }).status;
          reject(new UploadError(status === 413 ? 413 : 400, status === 413 ? tooLarge(options.maxBytes) : 'Could not read the file.'));
        } else resolve(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      });
    });

  /** Bytes the office's files take up. */
  const usedBy = async (q: Tx, officeId: string) =>
    Number((await q.query<{ used: string }>('SELECT COALESCE(SUM(byte_size), 0)::bigint AS used FROM uploads WHERE office_id = $1', [officeId])).rows[0].used);

  /**
   * POST /api/offices/:id/uploads: the raw file as the body, its name in X-Filename (URL-encoded),
   * from someone in the office: X-Workchop-Socket is their socket id, X-Workchop-Upload-Key the key
   * their join answer gave them. Busy answers (429, 503) come with Retry-After.
   */
  const upload: express.RequestHandler = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let release = () => {};
    try {
      const officeId = String(req.params.id);
      const socketId = req.get('x-workchop-socket');
      const uploadKey = req.get('x-workchop-upload-key');
      const who = socketId && uploadKey && isValidId(officeId) ? deps.uploaderOf(socketId, uploadKey, officeId) : null;
      if (!who) throw new UploadError(403, 'Join the office before uploading files.');
      // Refuse big files before reading them.
      const declared = Number(req.get('content-length'));
      if (declared > options.maxBytes) throw new UploadError(413, tooLarge(options.maxBytes));
      const ip = deps.clientIp(req);
      // Without a Content-Length (a chunked body), the file may be as big as allowed.
      const known = Number.isSafeInteger(declared) && declared >= 0;
      const reserved = known ? declared : options.maxBytes;
      if ((inProgress.get(ip) ?? 0) >= PER_VISITOR_AT_ONCE) {
        res.set('Retry-After', '5');
        throw new UploadError(429, 'Too many uploads at once. Please wait for the others to finish.');
      }
      if (buffered + reserved > BUFFERED_FILES * options.maxBytes) {
        res.set('Retry-After', '5');
        throw new UploadError(503, 'The server is busy with other uploads. Please try again in a moment.');
      }
      if (!mayStart(ip)) {
        res.set('Retry-After', '60');
        throw new UploadError(429, 'Too many uploads. Please try again in a few minutes.');
      }
      inProgress.set(ip, (inProgress.get(ip) ?? 0) + 1);
      buffered += reserved;
      release = () => {
        buffered -= reserved;
        const n = (inProgress.get(ip) ?? 1) - 1;
        if (n > 0) inProgress.set(ip, n);
        else inProgress.delete(ip);
      };
      // A full office is told so before it sends the file (checked again, exactly, when saving).
      if ((await usedBy(db, officeId)) + (known ? declared : 1) > options.quotaBytes) throw quotaFull();
      const data = await readBody(req, res);
      if (!data.length) throw new UploadError(400, 'The file is empty.');
      let name = 'file';
      try {
        name = sanitizeFilename(decodeURIComponent(req.get('x-filename') ?? ''));
      } catch {
        name = sanitizeFilename(req.get('x-filename'));
      }
      const declaredType = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const contentType = CONTENT_TYPE.test(declaredType) ? declaredType : 'application/octet-stream';
      const id = crypto.randomUUID();
      const key = store.kind === 'db' ? id : `${officeId}/${id}`;
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      // Built before saving: nothing may fail once the file is stored.
      const file: UploadedFile = { id, url: `/api/uploads/${id}/${encodeURIComponent(name)}`, name, contentType, size: data.length };

      // Bytes stored elsewhere go first, so a row never points at a missing file.
      if (store.kind !== 'db') await store.put(key, data, contentType, db);
      try {
        await db.transaction(async (tx) => {
          // One upload per office at a time, so two can't both slip under the quota.
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`uploads:${officeId}`]);
          if ((await usedBy(tx, officeId)) + data.length > options.quotaBytes) throw quotaFull();
          await tx.query(
            `INSERT INTO uploads (id, office_id, uploader_user_id, uploader_name, filename, content_type, byte_size, sha256, storage, storage_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, officeId, who.userId, who.name, name, contentType, data.length, sha256, store.kind, key],
          );
          if (store.kind === 'db') await store.put(key, data, contentType, tx);
        });
      } catch (err) {
        if (store.kind !== 'db') await store.delete(key).catch(() => {});
        throw err;
      }
      res.status(201).json(file);
    } catch (err) {
      if (!(err instanceof UploadError)) {
        console.error('[uploads] upload failed:', err);
        res.status(503).json({ error: 'Could not save the file. Please try again.' });
        return;
      }
      // The rest of a refused body isn't read, so don't reuse the connection.
      if (!req.complete) res.set('Connection', 'close');
      res.status(err.status).json({ error: err.message });
    } finally {
      release();
    }
  };

  /** GET /api/uploads/:id/:name? The id is an unguessable uuid, so the URL itself grants access. */
  const download: express.RequestHandler = async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const found = await db.query<{ filename: string; content_type: string; byte_size: number; sha256: string; storage: UploadStorage; storage_key: string }>(
      'SELECT filename, content_type, byte_size, sha256, storage, storage_key FROM uploads WHERE id = $1',
      [id],
    );
    const row = found.rows[0];
    if (!row) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const from = stores[row.storage];
    if (!from) {
      res.status(503).json({ error: `This file is in ${row.storage} storage, which isn't configured.` });
      return;
    }
    const etag = `"${row.sha256}"`;
    // Files never change under the same id.
    const cacheForever = () => {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('ETag', etag);
    };
    if (req.get('if-none-match') === etag) {
      cacheForever();
      res.status(304).end();
      return;
    }
    // Only a file actually sent may be cached: a failure must not stick in browsers for a year.
    res.setHeader('Cache-Control', 'no-store');
    let data: Buffer | Readable | null;
    try {
      data = await from.get(row.storage_key);
    } catch (err) {
      console.error(`[uploads] could not read upload ${id} from ${from.description}:`, (err as Error).message);
      res.status(503).json({ error: 'This file is unavailable right now. Please try again.' });
      return;
    }
    if (!data) {
      console.error(`[uploads] the bytes of upload ${id} are missing from ${from.description}`);
      res.status(404).json({ error: 'File not found' });
      return;
    }
    cacheForever();
    // setHeader, not res.set: Express would add a charset the file may not have.
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', contentDisposition(INLINE_TYPES.has(row.content_type) ? 'inline' : 'attachment', row.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Content-Length', row.byte_size);
    if (Buffer.isBuffer(data)) res.end(data);
    else {
      await pipeline(data, res).catch((err: NodeJS.ErrnoException) => {
        // A visitor closing the page mid-download is normal.
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn(`[uploads] could not send upload ${id}:`, err.message);
      });
    }
  };

  return { upload, download, store, description: store.description };
}
