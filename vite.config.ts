import { defineConfig } from 'vitest/config';
import { createLogger } from 'vite';
import react from '@vitejs/plugin-react';

// The dev proxy follows the API server's PORT, so `PORT=4000 npm run dev` works end to end.
const SERVER = process.env.WORKCHOP_SERVER ?? `http://localhost:${process.env.PORT ?? 3001}`;

// Closing a browser tab drops its socket mid-stream and the dev proxy logs that as an error with
// a stack trace. It's expected and harmless, so keep it out of the terminal.
// And if the API server is down, say so in one line instead of a stack trace per request.
const logger = createLogger();
const logError = logger.error.bind(logger);
let lastRefused = 0;
logger.error = (msg, options) => {
  const code = (options?.error as NodeJS.ErrnoException | undefined)?.code;
  if (msg.includes('ws proxy') && (code === 'ECONNRESET' || code === 'EPIPE')) return;
  if (msg.includes('proxy error') && code === 'ECONNREFUSED') {
    if (Date.now() - lastRefused > 5000) logger.warn(`Can't reach the API server at ${SERVER}. Is it running?`, { timestamp: true });
    lastRefused = Date.now();
    return;
  }
  logError(msg, options);
};

export default defineConfig({
  root: 'client',
  plugins: [react()],
  customLogger: logger,
  server: {
    port: 5173,
    host: true,
    // Only browser errors are echoed to the terminal (three.js prints deprecation warnings).
    forwardConsole: { logLevels: ['error'], unhandledErrors: true },
    proxy: {
      '/api': SERVER,
      '/socket.io': { target: SERVER, ws: true },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
