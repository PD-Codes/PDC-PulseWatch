import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); });
afterAll(async () => { await t?.close(); });

const kumaDb = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kuma-')), 'kuma.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE monitor (id INTEGER PRIMARY KEY, name TEXT, type TEXT, url TEXT, hostname TEXT, port INTEGER, interval INTEGER, maxretries INTEGER, retry_interval INTEGER, timeout REAL, active INTEGER, parent INTEGER, ignore_tls INTEGER, upside_down INTEGER, maxredirects INTEGER, accepted_statuscodes_json TEXT, method TEXT, keyword TEXT);
    CREATE TABLE tag (id INTEGER PRIMARY KEY, name TEXT, color TEXT);
    CREATE TABLE monitor_tag (id INTEGER PRIMARY KEY, monitor_id INTEGER, tag_id INTEGER, value TEXT);
    CREATE TABLE notification (id INTEGER PRIMARY KEY, name TEXT, config TEXT, active INTEGER, is_default INTEGER);
    CREATE TABLE monitor_notification (id INTEGER PRIMARY KEY, monitor_id INTEGER, notification_id INTEGER);
    CREATE TABLE maintenance (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, monitor_id INTEGER, status INTEGER);
    INSERT INTO monitor VALUES (1,'Kuma group','group',NULL,NULL,NULL,60,0,60,48,1,NULL,0,0,10,'["200-299"]','GET',NULL);
    INSERT INTO monitor VALUES (2,'Kuma site','http','https://kuma-site.example.com',NULL,NULL,120,2,30,10,1,1,1,0,5,'["200-299","301"]','GET',NULL);
    INSERT INTO monitor VALUES (3,'Kuma db port','port',NULL,'db.example.com',5432,60,0,60,10,0,1,0,0,10,'["200-299"]','GET',NULL);
    INSERT INTO monitor VALUES (4,'Kuma snmp','snmp',NULL,'sw.example.com',161,60,0,60,10,1,NULL,0,0,10,'["200-299"]','GET',NULL);
    INSERT INTO tag VALUES (1,'prod','#059669');
    INSERT INTO monitor_tag VALUES (1,2,1,'');
    INSERT INTO notification VALUES (1,'Kuma ntfy','{"type":"ntfy","ntfyserverurl":"https://ntfy.example.com","ntfytopic":"alerts"}',1,1);
    INSERT INTO monitor_notification VALUES (1,2,1);
    INSERT INTO maintenance VALUES (1,'Patch night');
  `);
  db.close();
  return file;
};

const check = async (c0: typeof c) => {
  const mons = (await c0.get('/api/monitors')).json as any[];
  const site = mons.find((m) => m.name === 'Kuma site');
  expect(site).toBeTruthy();
  const d = (await c0.get(`/api/monitors/${site.id}`)).json;
  expect([d.intervalS, d.retries, d.config.url, d.config.verifyTls, d.tags.map((x: any) => x.name)]).toEqual([120, 2, 'https://kuma-site.example.com', false, ['prod']]);
  expect(d.notifications).toHaveLength(1);
  expect(mons.find((m) => m.name === 'Kuma db port').active).toBe(false);
  expect(mons.find((m) => m.name === 'Kuma snmp')).toBeUndefined(); // unsupported type
};

describe('Uptime Kuma 2.x import', () => {
  it('previews and applies a kuma.db upload', async () => {
    const file = kumaDb();
    const pre = await c.call('POST', '/api/import/kuma-db', fs.readFileSync(file), { headers: { 'content-type': 'application/octet-stream' } });
    expect(pre.status).toBe(200);
    expect(pre.json.dryRun).toBe(true);
    expect(pre.json.counts.monitors.created).toBe(2);
    expect(pre.json.warnings.join(' ')).toMatch(/snmp/);
    expect(pre.json.warnings.join(' ')).toMatch(/maintenance/i);
    expect((await c.get('/api/monitors')).json.some((m: any) => m.name === 'Kuma site')).toBe(false); // preview wrote nothing
    expect((await c.post('/api/import/kuma-apply', { previewId: pre.json.previewId })).status).toBe(200);
    await check(c);
    expect((await c.post('/api/import/kuma-apply', { previewId: pre.json.previewId })).status).toBe(404); // single use
    expect(fs.readdirSync(path.join(process.env.PW_DATA_DIR!, 'import-tmp'))).toEqual([]); // upload removed
  });

  it('rejects a file that is not a Kuma database', async () => {
    const r = await c.call('POST', '/api/import/kuma-db', Buffer.from('not sqlite'), { headers: { 'content-type': 'application/octet-stream' } });
    expect(r.status).toBe(400);
  });

  it('logs in over Socket.IO, handles the 2FA prompt and imports the pushed lists', async () => {
    const kuma = new Server(0, { serveClient: false });
    const mon = { id: 9, name: 'Api site', type: 'http', url: 'https://api-site.example.com', interval: 90, maxretries: 1, retryInterval: 30, timeout: 10, active: true, parent: null, ignoreTls: false, accepted_statuscodes: ['200-299'], tags: [{ name: 'live', color: '#2563eb' }], notificationIDList: {} };
    kuma.on('connection', (s) => {
      s.on('login', (d: any, cb: (r: unknown) => void) => {
        if (d.password !== 'secret') return cb({ ok: false, msg: 'Incorrect username or password.' });
        if (d.token !== '123456') return cb({ tokenRequired: true });
        s.emit('notificationList', []);
        s.emit('monitorList', { 9: mon });
        s.emit('maintenanceList', {});
        cb({ ok: true, token: 'jwt' });
      });
    });
    const url = `http://127.0.0.1:${(kuma.httpServer.address() as AddressInfo).port}`;
    try {
      expect((await c.post('/api/import/kuma-api', { url, username: 'admin', password: 'wrong' })).json.message).toMatch(/Incorrect/);
      const need = await c.post('/api/import/kuma-api', { url, username: 'admin', password: 'secret' });
      expect([need.status, need.json.error]).toEqual([401, 'token_required']);
      const pre = await c.post('/api/import/kuma-api', { url, username: 'admin', password: 'secret', token: '123456' });
      expect(pre.status).toBe(200);
      expect(pre.json.counts.monitors.created).toBe(1);
      expect((await c.post('/api/import/kuma-apply', { previewId: pre.json.previewId })).status).toBe(200);
      expect((await c.get('/api/monitors')).json.some((m: any) => m.name === 'Api site')).toBe(true);
      expect((await c.post('/api/import/kuma-api', { url: 'ftp://x', username: 'a', password: 'b' })).status).toBe(400);
    } finally { await kuma.close(); }
  });
});
