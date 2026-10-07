// Runs the API server (with reload) and the Vite dev server side by side.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const bin = (path) => fileURLToPath(new URL(`node_modules/${path}`, root));
const apiPort = Number(process.env.PORT ?? 3001);

// Fail fast with a clear message rather than letting Vite proxy to some other app.
const free = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(apiPort, '0.0.0.0', () => probe.close(() => resolve(true)));
});
if (!free) {
  console.error(`Port ${apiPort} (the API server) is already in use. Stop whatever is using it, or pick another port, e.g. PORT=${apiPort + 1} npm run dev`);
  process.exit(1);
}

// Spawn the tools' entry points with Node directly (no npx or shell in between),
// so stopping this script stops them too, on every platform.
const procs = [
  ['server', [bin('tsx/dist/cli.mjs'), 'watch', 'server/index.ts'], '\x1b[34m'],
  ['client', [bin('vite/bin/vite.js')], '\x1b[32m'],
].map(([name, args, color]) => {
  const child = spawn(process.execPath, args, { cwd: fileURLToPath(root), stdio: ['inherit', 'pipe', 'pipe'] });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (!stopping) console.log(`${prefix}stopped (${signal ?? `exit code ${code}`})`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
