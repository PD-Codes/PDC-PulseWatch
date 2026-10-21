import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The built bundles run as native ES modules, which vitest does not exercise: a CommonJS dependency imported by name
// or a bare __dirname only fails at load time. Skipped until `npm run build` has produced dist/.
const dist = path.resolve(import.meta.dirname, '../../dist');
const built = fs.existsSync(path.join(dist, 'server/main.js')) && fs.existsSync(path.join(dist, 'probe/main.js'));
const LOAD_ERRORS = /SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Cannot find (module|package)|does not provide an export/;

describe.skipIf(!built)('built bundles', () => {
  const run = (file: string, env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [path.join(dist, file)], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 15_000, cwd: dist });
    return `${r.stdout}\n${r.stderr}`;
  };

  it('the probe loads and asks for its settings', () => {
    const out = run('probe/main.js', {});
    expect(out).not.toMatch(LOAD_ERRORS);
    expect(out).toContain('PW_PROBE_TOKEN');
  });

  it('the server loads all of its imports before it needs the database', () => {
    const out = run('server/main.js', { PW_DB_HOST: '127.0.0.1', PW_DB_PORT: '1', PW_DB_PASSWORD: 'x', PW_SECRET_KEY: 'bundle-smoke-test-key', PW_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pw-smoke-')) });
    expect(out).not.toMatch(LOAD_ERRORS);
  });
});
