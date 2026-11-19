// Open event streams must not keep app.close() waiting: the preClose hook of the system routes ends them.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t?.close(); });

describe('SSE on shutdown', () => {
  it('ends open streams when the app closes', async () => {
    const admin = await loggedInAdmin(t);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    const cookie = [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body = '';
    const ended = new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { cookie } }, (res) => {
        expect(res.statusCode).toBe(200);
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve());
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    for (let i = 0; i < 50 && !body.includes('event: hello'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(body).toContain('event: hello');
    const started = Date.now();
    await Promise.race([t.app.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('app.close() hung on the open stream')), 5000))]);
    await ended;
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
