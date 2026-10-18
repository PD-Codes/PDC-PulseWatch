import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API server runs on PW_DEV_API (default http://localhost:3000) during development.
const api = process.env.PW_DEV_API ?? 'http://localhost:3000';
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 700 },
  server: { port: 5173, proxy: { '/api': api, '/badge': api, '/demo': api, '/heartbeat': api, '/health': api, '/metrics': api } },
});
