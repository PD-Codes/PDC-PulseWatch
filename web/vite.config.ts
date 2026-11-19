import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// The API server runs on PW_DEV_API (default http://localhost:3000) during development.
const api = process.env.PW_DEV_API ?? 'http://localhost:3000';
// The build knows its own version and build id (scripts/build.mjs sets PW_BUILD_ID): the UI compares them with /api/meta to notice a newer deployment,
// also one without a version bump. The id keys the service worker cache.
const version: string = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')).version;
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(process.env.PW_BUILD_ID ?? version) },
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 700 },
  server: { port: 5173, proxy: { '/api': api, '/badge': api, '/demo': api, '/heartbeat': api, '/health': api, '/metrics': api } },
});
