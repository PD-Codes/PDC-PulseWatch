// Builds the server and probe bundles with esbuild and the web UI with Vite.
// Usage: node scripts/build.mjs [--skip-web]
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
fs.rmSync(path.join(out, 'server'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'probe'), { recursive: true, force: true });

// The server keeps its dependencies external (installed with `npm ci --omit=dev` in the image): packages such as
// swagger-ui and pdfkit load assets from their own package directory at runtime and cannot be bundled.
// The probe is self-contained and bundles everything except optional add-ons that are never used: the MongoDB driver's extras and the native speedups of ssh2 (it falls back to pure JavaScript).
const optional = ['kerberos', '@mongodb-js/zstd', 'snappy', 'mongodb-client-encryption', '@aws-sdk/credential-providers', 'gcp-metadata', 'socks', 'aws4', 'pg-native', 'cloudflare:sockets', 'cpu-features', '*.node'];
const common = { bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: true, logLevel: 'info', legalComments: 'none', loader: { '.json': 'json' } };

await build({ ...common, packages: 'external', entryPoints: [path.join(root, 'src/server/main.ts')], outfile: path.join(out, 'server/main.js') });
await build({
  ...common, external: optional, entryPoints: [path.join(root, 'src/probe/main.ts')], outfile: path.join(out, 'probe/main.js'),
  // bundled CommonJS packages (ssh2) still expect require, __filename and __dirname
  banner: { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" },
});

if (!process.argv.includes('--skip-web')) {
  const { build: viteBuild } = await import('vite');
  await viteBuild({ configFile: path.join(root, 'web/vite.config.ts') });
}
console.log('build complete');
