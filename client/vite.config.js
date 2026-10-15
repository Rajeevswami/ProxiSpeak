import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const clientRoot = path.dirname(fileURLToPath(import.meta.url));

// Dev only: the client runs on Vite's port (5173) while the ProxiSpeak
// server owns port 4000. /socket.io (websocket) and /api are proxied to
// the server so dev never runs into a cross-origin wall for those paths.
// The socket itself targets config.js' SERVER_URL; the proxy is the
// same-origin fallback when VITE_SERVER_URL is left empty in dev.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, clientRoot, 'VITE_');

  /**
   * Vite only answers requests whose Host header it recognises (DNS rebinding
   * protection), so a dev server reached through a preview/tunnel hostname
   * replies 403. The default stays strict: list the extra hosts — or a suffix
   * such as ".example.dev" — in VITE_DEV_ALLOWED_HOSTS when you need one.
   */
  const allowedHosts = (env.VITE_DEV_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      ...(allowedHosts.length ? { allowedHosts } : {}),
      proxy: {
        '/socket.io': {
          target: 'http://localhost:4000',
          ws: true,
        },
        '/api': {
          target: 'http://localhost:4000',
        },
      },
    },
  };
});
