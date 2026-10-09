// Saves the landing page's stills into client/public/landing/. Run it, then open the dev server at
// /?capture=<the address it prints>: client/src/landing3d/capture.tsx renders them and sends them here.
//   node scripts/capture-landing.mjs [port]
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = new Set(['hero-wide.webp', 'hero-narrow.webp', 'shot-lounge.webp', 'shot-support.webp', 'og.jpg']);
const MAX_BYTES = 5 * 1024 * 1024;
const dir = fileURLToPath(new URL('../client/public/landing/', import.meta.url));
const port = Number(process.argv[2] ?? 4790);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`The port must be a number between 1 and 65535 (got "${process.argv[2]}").`);
  process.exit(1);
}

// Only pages from this machine's dev servers may send files.
const LOCAL_ORIGIN = /^http:\/\/([a-z0-9-]+\.)*localhost(:\d+)?$/;

const server = http.createServer((req, res) => {
  const origin = req.headers.origin ?? '';
  if (LOCAL_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const name = req.url?.match(/^\/save\/([\w.-]+)$/)?.[1];
  if (req.method !== 'POST' || !name || !FILES.has(name) || !LOCAL_ORIGIN.test(origin)) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BYTES) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', async () => {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), Buffer.concat(chunks));
      console.log(`Saved ${name} (${Math.round(size / 1024)} KB)`);
      res.writeHead(200).end('saved');
    } catch (err) {
      console.error(`Couldn't save ${name}:`, err);
      res.writeHead(500).end();
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Waiting for the stills at http://127.0.0.1:${port}`);
  console.log(`Open the dev server at /?capture=http://127.0.0.1:${port} (Ctrl+C here when it's done).`);
});
