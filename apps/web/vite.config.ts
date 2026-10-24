import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode live` produces the production admin UI (served from the image), with the demo as a lazy
// chunk at /demo; `--mode single` produces the demo alone as one self-contained HTML file.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  // `pnpm dev` talks to a local API server (apps/server) through the same origin, so the
  // session cookie works without CORS.
  server: {
    // Public links (/a assets, /f forms, /u unsubscribe) as regexes, so /approvals and /audience stay in the app.
    proxy: Object.fromEntries(['/api', '/v1', '/mcp', '/openapi.json', '^/(a|f|u|c)/'].map((p) => [p, process.env.API_URL ?? 'http://localhost:3000'])),
  },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 6000,
  },
}));
