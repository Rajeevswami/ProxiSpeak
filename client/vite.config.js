import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const clientRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, clientRoot, 'VITE_');

  // Allow preview host dynamically by suffix or exact host
  const allowedHosts = [
    ...(env.VITE_DEV_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean),
    '5173-ik2isl5kp50o27xcmw3zl.e2b.app',
    '5174-ik2isl5kp50o27xcmw3zl.e2b.app',
    '5175-ik2isl5kp50o27xcmw3zl.e2b.app',
    '*.e2b.app'
  ];

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      allowedHosts,
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
