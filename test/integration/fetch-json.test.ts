import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let srv: http.Server;
let base: string;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
beforeAll(async () => {
  t = await startApp();
  c = await loggedInAdmin(t); // the first-run setup only works once per database
  srv = http.createServer((req, res) => {
    if (req.url === '/api') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', checks: [{ name: 'db', healthy: true }], auth: req.headers.authorization ?? null })); } else res.end('<html>nope</html>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(async () => { srv?.close(); await t?.close(); });

describe('fetch result for JSON monitors', () => {
  it('returns the parsed body and applies the configured authentication', async () => {
    const r = await c.post('/api/monitors/fetch-json', { config: { url: `${base}/api`, authType: 'bearer', bearerToken: 's3cret' } });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe(200);
    expect(r.json.json.checks[0].healthy).toBe(true);
    expect(r.json.json.auth).toBe('Bearer s3cret');
  });

  it('keeps the stored secret when the form sends the mask back', async () => {
    const m = await c.post('/api/monitors', { name: 'api', type: 'json', config: { url: `${base}/api`, jsonPath: '$.status', jsonOp: 'eq', jsonExpected: 'ok', authType: 'bearer', bearerToken: 'stored-token' }, intervalS: 60, timeoutS: 10 });
    expect(m.status).toBe(200);
    const r = await c.post('/api/monitors/fetch-json', { monitorId: m.json.id, config: { url: `${base}/api`, authType: 'bearer', bearerToken: '••••••••' } });
    expect(r.json.json.auth).toBe('Bearer stored-token');
  });

  it('says so when the answer is not JSON, and refuses bad input and viewers', async () => {
    const html = await c.post('/api/monitors/fetch-json', { config: { url: `${base}/page` } });
    expect(html.status).toBe(200);
    expect(html.json.json).toBeNull();
    expect(html.json.jsonError).toBeTruthy();
    expect(html.json.preview).toContain('nope');
    expect((await c.post('/api/monitors/fetch-json', { config: {} })).status).toBe(400); // no URL
    expect((await c.post('/api/monitors/fetch-json', { config: { url: 'http://127.0.0.1:1/x' } })).status).toBe(502); // nothing listens there
    expect((await t.client().post('/api/monitors/fetch-json', { config: { url: `${base}/api` } })).status).toBe(401);
  });
});
