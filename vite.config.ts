import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

/**
 * Path to the dev port file written by the Python backend at startup.
 * The backend writes its chosen port number to this file so that the
 * Vite dev server middleware can serve it to the renderer.
 */
const portFilePath: string = path.resolve(__dirname, 'backend', '.dev-port');

/**
 * Read the backend dev port from the port file.
 * Falls back to 18000 if the file is missing or unreadable.
 */
function readDevPort(): number {
  try {
    const raw: string = fs.readFileSync(portFilePath, 'utf-8').trim();
    const parsed: number = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 18000 && parsed <= 18999) {
      return parsed;
    }
  } catch {
    // File doesn't exist or can't be read — use default 18000
  }
  return 18000;
}

/**
 * Vite plugin: serve the Python backend's actual dev port to the renderer.
 *
 * Middleware endpoint:
 *
 * `/__dev_port` — Returns the backend's actual port as JSON.
 *   Used by `resolveDevPort()` in `backend-client.ts`.
 *
 * The renderer's `getBackendBaseUrl()` returns an absolute URL and fetches
 * the backend directly (CORS allows `*`), so no /api proxy middleware is
 * needed on the dev server. Adding a catch-all /api proxy would intercept
 * the renderer's own module requests (e.g. /api/backend-client.ts) and
 * break the import chain, causing a white screen.
 */
function devPortServerPlugin(): Plugin {
  return {
    name: 'serve-dev-port',
    configureServer(server) {
      server.middlewares.use('/__dev_port', (_req, res) => {
        const port: number = readDevPort();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.end(JSON.stringify({ port }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devPortServerPlugin()],
  base: './',
  root: 'src/renderer',
  build: {
    outDir: path.resolve(__dirname, 'dist/src/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/index.html'),
      output: {
        format: 'es',
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@preload': path.resolve(__dirname, 'src/preload'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
