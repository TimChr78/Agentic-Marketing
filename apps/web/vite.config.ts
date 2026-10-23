import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode live` produces the production admin UI (served from the image); `--mode single` produces
// one self-contained HTML file (used for the shareable demo link).
const liveTitle = (mode: string) => ({
  name: 'live-title',
  transformIndexHtml: (html: string) =>
    mode === 'live' ? html.replace('<title>Agentic Marketing Demo</title>', '<title>Agentic Marketing</title>') : html,
});

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), liveTitle(mode), ...(mode === 'single' ? [viteSingleFile()] : [])],
  // `pnpm dev` talks to a local API server (apps/server) through the same origin, so the
  // session cookie works without CORS.
  server: {
    proxy: Object.fromEntries(['/api', '/v1', '/openapi.json'].map((p) => [p, process.env.API_URL ?? 'http://localhost:3000'])),
  },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 6000,
  },
}));
