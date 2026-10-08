import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../server/index';
import type { UploadedFile, UploadStorage } from '../server/uploads';
import { createTestDb } from './helpers/db';
import { createOffice, disconnectAll, join } from './helpers/http';

const dirs: string[] = [];
afterAll(() => {
  disconnectAll();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workchop-uploads-'));
  dirs.push(dir);
  return dir;
}

/** A stand-in S3 endpoint: keeps objects in memory and insists on a SigV4 signature. */
async function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const server: Server = createServer((req, res) => {
    if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=test-key/')) {
      res.writeHead(403).end('unsigned');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const key = decodeURIComponent(req.url!);
      if (req.method === 'PUT') {
        objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) });
        res.writeHead(200).end();
      } else if (req.method === 'GET') {
        const o = objects.get(key);
        if (o) res.writeHead(200, { 'content-type': o.type }).end(o.body);
        else res.writeHead(404).end();
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { objects, server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const MAX = 1000;
const QUOTA = 2500;

for (const storage of ['db', 'fs', 's3'] as UploadStorage[]) {
  describe(`uploads stored in ${storage}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    let base: string;
    let dataDir: string;
    let s3: Awaited<ReturnType<typeof fakeS3>> | null = null;

    beforeAll(async () => {
      dataDir = tempDir();
      if (storage === 's3') s3 = await fakeS3();
      server = await startServer({
        port: 0,
        host: '127.0.0.1',
        db: await createTestDb(),
        dataDir,
        quiet: true,
        iceServers: [],
        uploads: {
          storage,
          maxBytes: MAX,
          quotaBytes: QUOTA,
          s3: s3 && { endpoint: s3.endpoint, bucket: 'files', accessKeyId: 'test-key', secretAccessKey: 'secret', region: 'auto' },
        },
      });
      base = `http://127.0.0.1:${server.port}`;
    }, 60_000);

    afterAll(async () => {
      await server?.close();
      s3?.server.close();
    });

    /** Someone in a new office, ready to upload. */
    async function inOffice() {
      const office = await createOffice(base);
      const { socket } = await join(base, office.id, 'Uploader');
      const upload = (body: BodyInit, headers: Record<string, string> = {}) =>
        fetch(`${base}/api/offices/${office.id}/uploads`, { method: 'POST', body, headers: { 'X-Workchop-Socket': socket.id!, ...headers } });
      return { office, socket, upload };
    }

    it('stores a file (even a JSON one) and serves it back as a download', async () => {
      const { office, upload } = await inOffice();
      const content = JSON.stringify({ hello: 'world', list: [1, 2, 3] });
      const res = await upload(content, { 'Content-Type': 'application/json', 'X-Filename': encodeURIComponent('résumé "v2".json') });
      expect(res.status).toBe(201);
      const file = (await res.json()) as UploadedFile;
      expect(file).toMatchObject({ name: 'résumé "v2".json', contentType: 'application/json', size: content.length });
      expect(file.url).toBe(`/api/uploads/${file.id}/${encodeURIComponent('résumé "v2".json')}`);

      const got = await fetch(`${base}${file.url}`);
      expect(got.status).toBe(200);
      expect(await got.text()).toBe(content);
      expect(got.headers.get('content-type')).toBe('application/json');
      expect(got.headers.get('content-disposition')).toBe(`attachment; filename="r_sum_ _v2_.json"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.json`);
      expect(got.headers.get('x-content-type-options')).toBe('nosniff');
      expect(got.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(got.headers.get('cache-control')).toMatch(/immutable/);
      // The name in the URL is decoration; the id finds the file.
      expect(await (await fetch(`${base}/api/uploads/${file.id}`)).text()).toBe(content);
      const etag = got.headers.get('etag')!;
      expect((await fetch(`${base}${file.url}`, { headers: { 'If-None-Match': etag } })).status).toBe(304);

      const row = await server.db.query<{ storage: string; storage_key: string; office_id: string; uploader_name: string }>(
        'SELECT storage, storage_key, office_id, uploader_name FROM uploads WHERE id = $1',
        [file.id],
      );
      expect(row.rows[0]).toMatchObject({ storage, office_id: office.id, uploader_name: 'Uploader' });
      const blobs = await server.db.query('SELECT 1 FROM upload_blobs WHERE upload_id = $1', [file.id]);
      expect(blobs.rowCount).toBe(storage === 'db' ? 1 : 0);
      if (storage === 'fs') expect(existsSync(path.join(dataDir, 'uploads', office.id, file.id))).toBe(true);
      if (storage === 's3') expect(s3!.objects.get(`/files/${office.id}/${file.id}`)?.body.toString()).toBe(content);
    });

    it('shows raster images inline and everything else, SVG included, as a download', async () => {
      const { upload } = await inOffice();
      const png = (await (await upload(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { 'Content-Type': 'image/png', 'X-Filename': 'dot.png' })).json()) as UploadedFile;
      expect((await fetch(`${base}${png.url}`)).headers.get('content-disposition')).toMatch(/^inline; filename="dot.png"/);
      const svg = (await (await upload('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { 'Content-Type': 'image/svg+xml', 'X-Filename': 'x.svg' })).json()) as UploadedFile;
      const got = await fetch(`${base}${svg.url}`);
      expect(got.headers.get('content-disposition')).toMatch(/^attachment; filename="x.svg"/);
      expect(got.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      // Unusable names and types are cleaned up.
      const odd = (await (await upload('x', { 'Content-Type': 'not a type', 'X-Filename': '..%2F..%2Fetc%2Fpasswd' })).json()) as UploadedFile;
      expect(odd).toMatchObject({ name: 'passwd', contentType: 'application/octet-stream' });
    });

    it('refuses files that are too big, before and while reading them', async () => {
      const { office, socket, upload } = await inOffice();
      const tooBig = await upload(Buffer.alloc(MAX + 1, 1), { 'Content-Type': 'application/octet-stream' });
      expect(tooBig.status).toBe(413);
      expect(((await tooBig.json()) as { error: string }).error).toMatch(/at most/);
      // Sent in chunks, without a Content-Length.
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(600));
          controller.close();
        },
      });
      const chunked = await fetch(`${base}/api/offices/${office.id}/uploads`, {
        method: 'POST',
        body: stream,
        headers: { 'X-Workchop-Socket': socket.id!, 'Content-Type': 'application/octet-stream' },
        duplex: 'half',
      } as RequestInit);
      expect(chunked.status).toBe(413);
      expect((await upload('', { 'Content-Type': 'text/plain' })).status).toBe(400);
      const exact = await upload(Buffer.alloc(MAX, 1), { 'Content-Type': 'application/octet-stream' });
      expect(exact.status).toBe(201);
    });

    it('keeps each office within its quota', async () => {
      const { upload } = await inOffice();
      const piece = Buffer.alloc(900, 7);
      expect((await upload(piece)).status).toBe(201);
      expect((await upload(piece)).status).toBe(201);
      const over = await upload(piece);
      expect(over.status).toBe(413);
      expect(((await over.json()) as { error: string }).error).toMatch(/used up/);
      // Other offices have their own.
      expect((await (await inOffice()).upload(piece)).status).toBe(201);
    });

    it('only accepts uploads from someone in that office', async () => {
      const { office, socket, upload } = await inOffice();
      const elsewhere = await inOffice();
      const post = (headers: Record<string, string>) => fetch(`${base}/api/offices/${office.id}/uploads`, { method: 'POST', body: 'hi', headers });
      expect((await post({})).status).toBe(403);
      expect((await post({ 'X-Workchop-Socket': 'made-up-socket-id' })).status).toBe(403);
      expect((await post({ 'X-Workchop-Socket': elsewhere.socket.id! })).status).toBe(403);
      expect((await upload('hi')).status).toBe(201);
      socket.disconnect();
      await new Promise((r) => setTimeout(r, 100));
      expect((await post({ 'X-Workchop-Socket': socket.id ?? 'gone' })).status).toBe(403);
      expect((await fetch(`${base}/api/uploads/00000000-0000-4000-8000-000000000000/x`)).status).toBe(404);
      expect((await fetch(`${base}/api/uploads/not-a-uuid`)).status).toBe(404);
    });
  });
}

describe('switching upload storage', () => {
  it('keeps serving files from the store they were saved in', { timeout: 60_000 }, async () => {
    const dataDir = tempDir();
    const db = await createTestDb();
    const options = { port: 0, host: '127.0.0.1', db, dataDir, quiet: true, iceServers: [] };
    const first = await startServer({ ...options, uploads: { storage: 'fs' } });
    const office = await createOffice(`http://127.0.0.1:${first.port}`);
    const { socket } = await join(`http://127.0.0.1:${first.port}`, office.id, 'A');
    const res = await fetch(`http://127.0.0.1:${first.port}/api/offices/${office.id}/uploads`, {
      method: 'POST',
      body: 'kept on disk',
      headers: { 'X-Workchop-Socket': socket.id!, 'Content-Type': 'text/plain' },
    });
    const file = (await res.json()) as UploadedFile;
    socket.disconnect();
    await first.close();

    const second = await startServer({ ...options, uploads: { storage: 'db' } });
    expect(await (await fetch(`http://127.0.0.1:${second.port}${file.url}`)).text()).toBe('kept on disk');
    await second.close();
  });
});
