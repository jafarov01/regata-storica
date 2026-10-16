// `test` is a vitest key: defineConfig must come from 'vitest/config' or `tsc` rejects it (TS2769).
import { defineConfig } from 'vitest/config';
import type { PluginOption } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath, URL } from 'node:url';

// One Vite app, three routes (/ , /scene, /play). Client-side routing on
// location.pathname; `appType: 'spa'` makes the dev server fall back to
// index.html for /scene and /play, and server/index.ts does the same in prod.
//
// HTTPS=1 enables a self-signed cert for LAN testing. Phones on iOS need a
// secure context for motion sensors; the recommended path is the tunnel
// (`npm run tunnel`), which terminates TLS for you. See docs/CHALLENGES.md.
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 3000);
const useHttps = process.env.HTTPS === '1';
// Public hostname of the tunnel (e.g. abc-def.trycloudflare.com) when phones load the dev server
// through it. Only needed for HMR on the scene PC; phones never need HMR.
const TUNNEL_HOST = process.env.TUNNEL_HOST;

export default defineConfig({
  appType: 'spa',
  plugins: [useHttps ? (basicSsl() as PluginOption) : null].filter(Boolean) as PluginOption[],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/socket.io': {
        target: `http://localhost:${RELAY_PORT}`,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: `http://localhost:${RELAY_PORT}`,
        changeOrigin: true,
      },
    },
    // Vite 8: `server.hmr.{host,clientPort,protocol}` are deprecated (still synced); `server.ws` is current.
    // Through a Cloudflare/ngrok tunnel the browser reaches us on 443; HMR must connect back on that port.
    ...(TUNNEL_HOST ? { ws: { host: TUNNEL_HOST, clientPort: 443, protocol: 'wss' } } : {}),
    // Tunnel hostnames are random per run, so allow the two tunnel domains rather than `true`
    // (`true` disables the DNS-rebinding protection for every host).
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'shared/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
  },
});
