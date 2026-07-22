import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the cinematic dashboard. The app lives under `web/`; the build
 * emits to `dist/web` (served as static assets by the Fastify server). In dev, the
 * Vite dev server proxies API and WebSocket traffic to the backend on port 8477 so
 * the frontend and backend share an origin.
 */
export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://localhost:8477', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8477', ws: true },
    },
  },
  build: {
    // Relative to `root` (web/), so this resolves to <repo>/dist/web.
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
});
