// Runs the API server (with reload) and the Vite dev server side by side.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const bin = (path) => fileURLToPath(new URL(`node_modules/${path}`, root));

const apiPort = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  console.error(`PORT must be a number between 1 and 65535 (got "${process.env.PORT}").`);
  process.exit(1);
}

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
  child.on('close', (code, signal) => {
    if (!stopping) {
      // One side stopped on its own (e.g. a crash): take the other down with it.
      console.log(`${prefix}stopped (${signal ?? `exit code ${code}`})`);
      stop(code || 1, 'SIGTERM');
    } else {
      stop();
    }
  });
  return child;
});

const running = () => procs.filter((p) => p.exitCode === null && p.signalCode === null);
let stopping = false;
let exitCode = 0;

/**
 * Stop everything, then exit once both children are gone. `forward` is the signal to pass on;
 * on Ctrl+C the terminal has already sent SIGINT to the children, and signalling them a second
 * time makes tsx force-kill the API server before it finishes saving.
 */
function stop(code = exitCode, forward = null) {
  if (!stopping) {
    stopping = true;
    exitCode = code;
    if (forward) for (const p of running()) p.kill(forward);
    // Escalate only if something hangs.
    setTimeout(() => running().forEach((p) => p.kill('SIGTERM')), 4000).unref();
    setTimeout(() => {
      running().forEach((p) => p.kill('SIGKILL'));
      process.exit(exitCode);
    }, 8000).unref();
  }
  if (procs.every((p) => p.exitCode !== null || p.signalCode !== null)) process.exit(exitCode);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0, 'SIGTERM'));
