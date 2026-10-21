import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './harness';

let t: TestApp;
let server: https.Server;
let port = 0;
let ready = false;

/** Signs a certificate that ended in 2020 (needs the openssl CLI; the test is skipped without it). */
function expiredCert(dir: string): { key: string; cert: string } | null {
  try {
    fs.mkdirSync(path.join(dir, 'new'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.txt'), '');
    fs.writeFileSync(path.join(dir, 'serial'), '01\n');
    fs.writeFileSync(path.join(dir, 'ca.cnf'), `[ca]\ndefault_ca=c\n[c]\ndatabase=${dir}/index.txt\nserial=${dir}/serial\nnew_certs_dir=${dir}/new\ndefault_md=sha256\npolicy=p\nunique_subject=no\n[p]\ncommonName=supplied\n[req]\ndistinguished_name=d\nprompt=no\n[d]\nCN=expired.example.test\n`);
    const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'req.pem', '-subj', '/CN=expired.example.test']);
    run(['ca', '-config', 'ca.cnf', '-selfsign', '-keyfile', 'key.pem', '-in', 'req.pem', '-out', 'cert.pem', '-startdate', '20200101000000Z', '-enddate', '20200102000000Z', '-batch', '-notext']);
    return { key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
  } catch { return null; }
}

beforeAll(async () => {
  const pair = expiredCert(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-digest-')));
  if (!pair) return;
  server = https.createServer(pair, (_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  t = await startApp();
  await t.client().post('/api/setup', { username: 'admin', password: 'correct-horse-battery-1' });
  ready = true;
});
afterAll(async () => { server?.close(); await t?.close(); });

describe('daily digest', () => {
  it('names the target, the expiry date and the certificate for a monitor that is down on an expired certificate', async () => {
    if (!ready) return; // openssl is not installed here
    const c = t.client();
    await c.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' });
    const m = (await c.post('/api/monitors', { name: 'expired site', type: 'http', config: { url: `https://127.0.0.1:${port}/` }, intervalS: 60, timeoutS: 5, active: true })).json;
    await c.post(`/api/monitors/${m.id}/check`);
    const { buildDigest } = await import('../../src/server/reports');
    const d = await buildDigest(t.ctx);
    expect(d.text).toContain('expired site');
    expect(d.text).toContain(`127.0.0.1:${port}`);
    expect(d.text).toMatch(/expired on 2020-01-02/);
    expect(d.text).toContain('expired.example.test');
    expect(d.text).toContain('issuer CN=expired.example.test');
    expect(d.text).toContain('CERT_HAS_EXPIRED');
  });
});
