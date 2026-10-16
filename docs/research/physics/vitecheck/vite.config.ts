import { defineConfig } from 'vite';
export default defineConfig({ appType: 'spa', build: { outDir: 'dist', sourcemap: false, target: 'es2022' } });
