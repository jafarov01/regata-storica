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
    // Through a Cloudflare/ngrok tunnel the browser reaches us on 443; HMR must
    // connect back on that port, not 5173.
    hmr: process.env.TUNNEL_HOST
      ? { host: process.env.TUNNEL_HOST, clientPort: 443, protocol: 'wss' }
      : undefined,
    allowedHosts: true,
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
