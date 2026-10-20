import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './harness';

const CRT = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/localhost.crt'), 'utf8');
let t: TestApp;
beforeAll(async () => { t = await startApp(); await t.client().post('/api/setup', { username: 'admin', password: 'correct-horse-battery-1' }); });
afterAll(async () => { await t?.close(); });

describe('CA certificates', () => {
  it('imports a PEM, ignores duplicates, rejects garbage and deletes', async () => {
    const c = t.client(); await c.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' });
    const r = await c.post('/api/ca-certs', { pem: CRT });
    expect(r.status).toBe(200);
    expect(r.json.added).toBe(1);
    const again = await c.post('/api/ca-certs', { pem: CRT });
    expect(again.json).toMatchObject({ added: 0 });
    expect(again.json.skipped[0]).toContain('already imported');
    expect((await c.post('/api/ca-certs', { pem: 'not a certificate' })).status).toBe(400);
    const list = (await c.get('/api/ca-certs')).json;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'localhost', expired: false });
    expect((await c.del(`/api/ca-certs/${list[0].id}`)).status).toBe(200);
    expect((await c.get('/api/ca-certs')).json).toHaveLength(0);
  });
});
