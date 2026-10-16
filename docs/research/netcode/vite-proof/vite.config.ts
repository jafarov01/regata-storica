import { defineConfig } from 'vite';
export default defineConfig({
  build: { outDir: 'dist', target: 'es2022' },
  server: { allowedHosts: true, ws: { clientPort: 443, protocol: 'wss', host: 'example.trycloudflare.com' } },
});
