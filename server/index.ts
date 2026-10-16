/**
 * Relay process: Express 5 serves the built app (dist/) with an SPA fallback for /scene and
 * /play, exposes /api/health, and hosts the Socket.IO relay on the same port.
 *
 *   dev : `tsx watch server/index.ts` on :3000, Vite on :5173 proxies /socket.io and /api here
 *   prod: `npm run build && NODE_ENV=production tsx server/index.ts`, tunnel to :3000
 *
 * Env: RELAY_PORT (default 3000), PORT (production only), HOST (default 0.0.0.0), ALLOWED_ORIGINS (comma list, optional).
 */
import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.ts';

// Dev: RELAY_PORT (default 3000; Vite proxies to it). Production hosts (Render, Railway, Fly) set PORT.
// PORT is ignored in dev because tools often export it for the Vite port, which would collide.
const isProd = process.env['NODE_ENV'] === 'production';
const PORT = Number(process.env['RELAY_PORT'] ?? (isProd ? process.env['PORT'] : undefined) ?? 3000);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(DIST, 'index.html');
const allowedOrigins = (process.env['ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const app = express();
app.disable('x-powered-by');
// Behind cloudflared/ngrok/Render the first proxy sets X-Forwarded-*; trust one hop for req.ip / req.protocol.
app.set('trust proxy', 1);

const httpServer = createServer(app);
const relay = createRelay(httpServer, { allowedOrigins });
const startedAt = Date.now();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    rooms: relay.registry.size,
    players: relay.registry.playerCount,
    sockets: relay.io.engine.clientsCount,
    dist: existsSync(INDEX),
  });
});

if (existsSync(INDEX)) {
  // Vite names assets with a content hash: cache forever. Everything else: revalidate.
  app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  app.use(express.static(DIST, { index: false, maxAge: 0 }));
  // Express 5 / path-to-regexp 8: the wildcard needs a name, braces make it match "/" too.
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
      res.status(404).type('text').send('not found');
      return;
    }
    res.sendFile(INDEX, { headers: { 'Cache-Control': 'no-store' } });
  });
} else {
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).type('text').send('not found');
      return;
    }
    res
      .status(503)
      .type('text')
      .send('dist/ is not built. Run `npm run build`, or open the Vite dev server on :5173 (it proxies /socket.io and /api to this relay).');
  });
}

httpServer.listen(PORT, HOST, () => {
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : PORT;
  console.log(`[relay] listening on http://${HOST}:${port} (dist: ${existsSync(INDEX) ? 'served' : 'missing, dev mode'})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[relay] ${signal}: closing`);
  await relay.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
