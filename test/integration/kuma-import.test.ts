import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
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
    CREATE TABLE status_page (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, description TEXT, icon TEXT, published INTEGER, footer_text TEXT, custom_css TEXT);
    CREATE TABLE status_page_cname (id INTEGER PRIMARY KEY, status_page_id INTEGER, domain TEXT);
    CREATE TABLE "group" (id INTEGER PRIMARY KEY, name TEXT, public INTEGER, weight INTEGER, status_page_id INTEGER);
    CREATE TABLE monitor_group (id INTEGER PRIMARY KEY, monitor_id INTEGER, group_id INTEGER, weight INTEGER);
    CREATE TABLE incident (id INTEGER PRIMARY KEY, status_page_id INTEGER, pin INTEGER);
    INSERT INTO status_page VALUES (1,'kuma_public','Kuma Public','Our services','/icon.svg',1,'Powered by us','body{color:red}');
    INSERT INTO status_page VALUES (2,'kuma-hidden','Hidden page',NULL,NULL,0,NULL,NULL);
    INSERT INTO status_page_cname VALUES (1,1,'status.kuma-example.com');
    INSERT INTO "group" VALUES (1,'Web',1,2,1);
    INSERT INTO "group" VALUES (2,'Backend',1,1,1);
    INSERT INTO monitor_group VALUES (1,2,1,1);
    INSERT INTO monitor_group VALUES (2,3,2,1);
    INSERT INTO monitor_group VALUES (3,4,2,2);
    INSERT INTO incident VALUES (1,1,1);
    INSERT INTO monitor VALUES (1,'Kuma group','group',NULL,NULL,NULL,60,0,60,48,1,NULL,0,0,10,'["200-299"]','GET',NULL);
    INSERT INTO monitor VALUES (2,'Kuma site','http','https://kuma-site.example.com',NULL,NULL,120,2,30,10,1,1,1,0,5,'["200-299","301"]','GET',NULL);
    INSERT INTO monitor VALUES (3,'Kuma db port','port',NULL,'db.example.com',5432,60,0,60,10,0,1,0,0,10,'["200-299"]','GET',NULL);
    INSERT INTO monitor VALUES (4,'Kuma tailscale','tailscale-ping',NULL,'sw.example.com',161,60,0,60,10,1,NULL,0,0,10,'["200-299"]','GET',NULL);
    INSERT INTO tag VALUES (1,'prod','#059669');
    INSERT INTO monitor_tag VALUES (1,2,1,'');
    INSERT INTO notification VALUES (1,'Kuma ntfy','{"type":"ntfy","ntfyserverurl":"https://ntfy.example.com","ntfytopic":"alerts"}',1,1);
    INSERT INTO monitor_notification VALUES (1,2,1);
    INSERT INTO maintenance VALUES (1,'Patch night');
  `);
  db.close();
  return file;
};

/** Starts the background apply and waits for its report, like the UI does. */
const applyAndWait = async (previewId: string, selection?: object) => {
  const start = await c.post('/api/import/kuma-apply', { previewId, ...(selection ? { selection } : {}) });
  expect(start.status).toBe(200);
  for (let i = 0; i < 100; i++) {
    const j = await c.get(`/api/import/jobs/${start.json.jobId}`);
    if (j.json.state !== 'running') { expect(j.json.state).toBe('done'); return j.json as { report: any; done: number; total: number }; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('import job did not finish');
};

const check = async (c0: typeof c) => {
  const mons = (await c0.get('/api/monitors')).json as any[];
  const site = mons.find((m) => m.name === 'Kuma site');
  expect(site).toBeTruthy();
  const d = (await c0.get(`/api/monitors/${site.id}`)).json;
  expect([d.intervalS, d.retries, d.config.url, d.config.verifyTls, d.tags.map((x: any) => x.name)]).toEqual([120, 2, 'https://kuma-site.example.com', false, ['prod']]);
  expect(d.notifications).toHaveLength(1);
  expect(mons.find((m) => m.name === 'Kuma db port').active).toBe(false);
  expect(mons.find((m) => m.name === 'Kuma tailscale')).toBeUndefined(); // unsupported type
};

describe('Uptime Kuma 2.x import', () => {
  it('previews and applies a kuma.db upload', async () => {
    const file = kumaDb();
    const pre = await c.call('POST', '/api/import/kuma-db', fs.readFileSync(file), { headers: { 'content-type': 'application/octet-stream' } });
    expect(pre.status).toBe(200);
    expect(pre.json.dryRun).toBe(true);
    expect(pre.json.counts.monitors.created).toBe(2);
    expect(pre.json.warnings.join(' ')).toMatch(/tailscale/);
    expect(pre.json.warnings.join(' ')).toMatch(/maintenance/i);
    expect((await c.get('/api/monitors')).json.some((m: any) => m.name === 'Kuma site')).toBe(false); // preview wrote nothing
    expect(pre.json.items.statusPages.map((p: any) => [p.slug, p.components, p.exists])).toEqual([['kuma-public', 2, false], ['kuma-hidden', 0, false]]);
    expect(pre.json.warnings.join(' ')).toMatch(/pinned incident/);
    // everything that has no equivalent is listed with its reason, not only warned about
    const un = (pre.json.items.unsupported as { kind: string; name: string; reason: string }[]).map((u) => `${u.kind}:${u.name}`).sort();
    expect(un).toEqual(['incident:Kuma Public', 'maintenance:Patch night', 'monitor:Kuma tailscale']);
    expect(pre.json.items.unsupported.find((u: any) => u.kind === 'monitor').reason).toMatch(/Tailscale/);
    expect(pre.json.warnings.join(' ')).toMatch(/left out/); // the tailscale monitor of the "Backend" group is not importable
    const done = await applyAndWait(pre.json.previewId);
    expect(done.report.counts.statusPages.created).toBe(2);
    expect(done.total).toBeGreaterThan(0);
    await check(c);
    const pub = (await t.client().get('/api/public/status/kuma-public')).json;
    expect([pub.title, pub.description, pub.branding.footer, pub.customCss]).toEqual(['Kuma Public', 'Our services', 'Powered by us', 'body{color:red}']);
    expect(pub.sections.map((x: any) => x.name)).toEqual(['Backend', 'Web']); // Kuma orders groups by weight
    expect((await t.client().get('/api/public/status/kuma-hidden')).status).toBe(401); // unpublished stays private
    expect((await c.post('/api/import/kuma-apply', { previewId: pre.json.previewId })).status).toBe(404); // single use
    expect(fs.readdirSync(path.join(process.env.PW_DATA_DIR!, 'import-tmp'))).toEqual([]); // upload removed
  });

  it('rejects a file that is not a Kuma database', async () => {
    const r = await c.call('POST', '/api/import/kuma-db', Buffer.from('not sqlite'), { headers: { 'content-type': 'application/octet-stream' } });
    expect(r.status).toBe(400);
  });

  it('logs in over Socket.IO, handles the 2FA prompt and imports the pushed lists and status pages', async () => {
    const mon = { id: 9, name: 'Api site', type: 'http', url: 'https://api-site.example.com', interval: 90, maxretries: 1, retryInterval: 30, timeout: 10, active: true, parent: null, ignoreTls: false, accepted_statuscodes: ['200-299'], method: 'GET' };
    /** A stand-in for Kuma, optionally served below a reverse-proxy sub-path; it also insists on a matching Origin header like Kuma 2.x does. */
    const fakeKuma = async (base: string) => {
      const http = createServer((req, res) => {
        if (req.url === `${base}/api/status-page/api-page`) { res.setHeader('content-type', 'application/json'); return void res.end(JSON.stringify({ config: {}, incident: null, publicGroupList: [{ id: 1, name: 'Public', monitorList: [{ id: 9, name: 'Api site' }, { id: 77, name: 'gone' }] }] })); }
        res.statusCode = 404; res.end();
      });
      const kuma = new Server(http, { serveClient: false, path: `${base}/socket.io`, allowRequest: (req, cb) => cb(null, req.headers.origin === `http://${req.headers.host}`) });
      kuma.on('connection', (s) => {
        s.on('getSettings', (cb: (r: unknown) => void) => cb({ ok: true, data: {} }));
        s.on('login', (d: any, cb: (r: unknown) => void) => {
          if (d.password !== 'secret') return cb({ ok: false, msg: 'Incorrect username or password.' });
          if (d.token !== '123456') return cb({ tokenRequired: true });
          s.emit('notificationList', []);
          s.emit('monitorList', { 9: mon });
          s.emit('maintenanceList', {});
          s.emit('statusPageList', { 1: { id: 1, slug: 'api-page', title: 'API page', published: true, footerText: 'api footer', domainNameList: [] } });
          cb({ ok: true, token: 'jwt' });
        });
      });
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
      return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { void kuma.close(() => r()); }) };
    };
    const root = await fakeKuma('');
    const sub = await fakeKuma('/kuma');
    try {
      const url = root.url;
      expect((await c.post('/api/import/kuma-api', { url, username: 'admin', password: 'wrong' })).json.message).toMatch(/Incorrect/);
      const need = await c.post('/api/import/kuma-api', { url, username: 'admin', password: 'secret' });
      expect([need.status, need.json.error]).toEqual([401, 'token_required']);
      // addresses as people paste them: trailing slash, blanks, the dashboard page, and a sub-path behind a proxy
      for (const u of [`${url}/`, `  ${url}//  `, `${url}/dashboard`, `${sub.url}/kuma/`, `${sub.url}/kuma/dashboard/3`]) {
        const r = await c.post('/api/import/kuma-api', { url: u, username: 'admin', password: 'secret', token: '123456' });
        expect([u, r.status, r.json.counts?.monitors.created]).toEqual([u, 200, 1]);
      }
      const pre = await c.post('/api/import/kuma-api', { url: `${url}/`, username: 'admin', password: 'secret', token: '123456' });
      expect(pre.json.items.statusPages).toEqual([{ slug: 'api-page', title: 'API page', components: 1, exists: false, notes: ['1 monitor(s) are not part of the import and were left out'] }]);
      expect(pre.json.warnings.join(' ')).toMatch(/left out/); // monitor 77 is not part of the import
      await applyAndWait(pre.json.previewId);
      expect((await c.get('/api/monitors')).json.some((m: any) => m.name === 'Api site')).toBe(true);
      expect((await t.client().get('/api/public/status/api-page')).json.sections[0].name).toBe('Public');
      expect((await c.post('/api/import/kuma-api', { url: 'ftp://x', username: 'a', password: 'b' })).status).toBe(400);
      const down = await c.post('/api/import/kuma-api', { url: 'http://127.0.0.1:1', username: 'a', password: 'b' });
      expect([down.status, down.json.message]).toEqual([400, expect.stringMatching(/Could not connect to http:\/\/127\.0\.0\.1:1/)]);
    } finally { await root.close(); await sub.close(); }
  });

  const upload = async () => {
    const pre = await c.call('POST', '/api/import/kuma-db', fs.readFileSync(kumaDb()), { headers: { 'content-type': 'application/octet-stream' } });
    expect(pre.status).toBe(200);
    return pre;
  };
  const siteId = async () => ((await c.get('/api/monitors')).json as any[]).find((m) => m.name === 'Kuma site')?.id as number | undefined;

  it('imports only the selected parts and detaches de-selected groups and tags from new monitors', async () => {
    const before = await siteId();
    if (before) expect((await c.del(`/api/monitors/${before}`)).status).toBe(200); // start from "new"
    const pre = await upload();
    expect(pre.json.items.monitors.every((m: any) => typeof m.exists === 'boolean')).toBe(true);
    // everything except the page "kuma-hidden" and the tag; the monitor "Kuma db port" is left out as well
    const done = await applyAndWait(pre.json.previewId, { monitors: ['Kuma site'], tags: [], groups: [], channels: [], statusPages: ['kuma-public'] });
    expect(done.report.counts.monitors.updated + done.report.counts.monitors.created).toBe(1);
    const mons = (await c.get('/api/monitors')).json as any[];
    const site = (await c.get(`/api/monitors/${await siteId()}`)).json;
    expect([site.groupId, site.tags.length]).toEqual([null, 0]); // de-selected group and tag are not attached
    expect(mons.some((m) => m.name === 'Kuma db port' && m.groupId === null)).toBe(false);
  });

  it('keeps what an existing monitor already has when the import leaves it out', async () => {
    const id = (await siteId())!;
    const group = (await c.post('/api/groups', { name: 'Ours' })).json.id;
    const tag = Number((await t.ctx.db.insertInto('tags').values({ name: 'ours' }).executeTakeFirstOrThrow()).insertId);
    await t.ctx.db.insertInto('monitor_tags').values({ monitor_id: id, tag_id: tag }).execute();
    await c.call('PATCH', `/api/monitors/${id}`, { groupId: group });
    const pre = await upload();
    await applyAndWait(pre.json.previewId, { monitors: ['Kuma site'], tags: [], groups: [], channels: [], statusPages: [] });
    const site = (await c.get(`/api/monitors/${id}`)).json;
    expect(site.groupId).toBe(group);
    expect(site.tags.map((x: any) => x.name)).toEqual(['ours']);
    const pre2 = await upload(); // with the tag selected it is added next to the existing one
    await applyAndWait(pre2.json.previewId, { monitors: ['Kuma site'], tags: ['prod'], groups: [], channels: [], statusPages: [] });
    expect(((await c.get(`/api/monitors/${id}`)).json.tags as any[]).map((x) => x.name).sort()).toEqual(['ours', 'prod']);
  });

  it('never opens a private or sign-in-only status page when it is imported again', async () => {
    await t.ctx.db.updateTable('status_pages').set({ is_public: 0, sso_required: 1 }).where('slug', '=', 'kuma-public').execute();
    const pre = await upload();
    await applyAndWait(pre.json.previewId, { statusPages: ['kuma-public'], monitors: [], tags: [], groups: [], channels: [] });
    const row = await t.ctx.db.selectFrom('status_pages').select(['is_public', 'sso_required', 'title']).where('slug', '=', 'kuma-public').executeTakeFirstOrThrow();
    expect([row.is_public, row.sso_required, row.title]).toEqual([0, 1, 'Kuma Public']);
  });

  it('keeps monitors that share a name in Uptime Kuma apart', async () => {
    const { convertKuma } = await import('../../src/server/portability');
    const mk = (id: number) => ({ id, name: 'Same', type: 'port', hostname: `h${id}.example.com`, port: 80, interval: 60, active: true });
    const { doc, warnings } = convertKuma({ monitorList: [mk(1), mk(2), mk(3)], notificationList: [], statusPageList: [{ slug: 'p', title: 'P', groups: [{ name: 'g', monitors: [{ id: 2 }] }] }] });
    expect(doc.monitors!.map((m) => m.name)).toEqual(['Same', 'Same (2)', 'Same (3)']);
    expect(warnings.join(' ')).toMatch(/used twice/);
    expect(doc.statusPages![0].sections[0].components[0].monitor).toBe('Same (2)'); // the page points at the right one
  });

  it('refuses an unauthenticated upload and leaves nothing on disk', async () => {
    const r = await t.client().call('POST', '/api/import/kuma-db', Buffer.alloc(200_000, 1), { headers: { 'content-type': 'application/octet-stream' } });
    expect([401, 403]).toContain(r.status);
    const login = await t.client().call('POST', '/api/auth/login', Buffer.alloc(200_000, 1), { headers: { 'content-type': 'application/octet-stream' } });
    expect(login.status).toBe(415); // the raw parser does not exist outside the import route
    const dir = path.join(process.env.PW_DATA_DIR!, 'import-tmp');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });
});

describe('Kuma address normalizing', () => {
  it('strips pages, slashes and keeps sub-paths', async () => {
    const { normalizeKumaUrl } = await import('../../src/server/kuma-source');
    expect(normalizeKumaUrl('kuma.example.com')).toMatchObject({ origin: 'https://kuma.example.com', socketPath: '/socket.io/' });
    expect(normalizeKumaUrl(' http://h:3001/ ')).toMatchObject({ origin: 'http://h:3001', socketPath: '/socket.io/' });
    expect(normalizeKumaUrl('https://h/kuma/status/main')).toMatchObject({ basePath: '/kuma', socketPath: '/kuma/socket.io/' });
    expect(normalizeKumaUrl('https://h/dashboard/12')).toMatchObject({ basePath: '', socketPath: '/socket.io/' });
    expect(() => normalizeKumaUrl('ftp://h')).toThrow(/http/);
    expect(() => normalizeKumaUrl('   ')).toThrow();
  });
});

/* ---------------- protocols, maintenance, settings, and the list of what cannot be imported ---------------- */

const ins = (db: DatabaseSync, table: string, row: Record<string, unknown>) => {
  const k = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${k.map((x) => `"${x}"`).join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...(Object.values(row) as any[]));
};

/** A fuller Kuma 2.x database: every monitor type with a mapping, maintenance windows of every strategy, settings, docker hosts, proxies, a pinned incident. */
const kumaDbFull = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kuma-full-')), 'kuma.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE monitor (id INTEGER PRIMARY KEY, name TEXT, type TEXT, url TEXT, hostname TEXT, port INTEGER, interval INTEGER, maxretries INTEGER, retry_interval INTEGER, resend_interval INTEGER, timeout REAL, active INTEGER, parent INTEGER,
      ignore_tls INTEGER, upside_down INTEGER, maxredirects INTEGER, accepted_statuscodes_json TEXT, method TEXT, keyword TEXT, description TEXT, headers TEXT, body TEXT, http_body_encoding TEXT, auth_method TEXT, basic_auth_user TEXT,
      basic_auth_pass TEXT, proxy_id INTEGER, expiry_notification INTEGER, docker_container TEXT, docker_host INTEGER, radius_secret TEXT, radius_username TEXT, radius_password TEXT, radius_called_station_id TEXT, rabbitmq_nodes TEXT,
      rabbitmq_username TEXT, rabbitmq_password TEXT, kafka_producer_brokers TEXT, kafka_producer_topic TEXT, kafka_producer_ssl INTEGER, kafka_producer_sasl_options TEXT, snmp_oid TEXT, snmp_version TEXT, json_path_operator TEXT,
      expected_value TEXT, game TEXT, manual_status INTEGER, pm2_process_name TEXT, database_connection_string TEXT, database_query TEXT, grpc_url TEXT, grpc_service_name TEXT, grpc_enable_tls INTEGER, smtp_security TEXT, subtype TEXT, location TEXT);
    CREATE TABLE tag (id INTEGER PRIMARY KEY, name TEXT, color TEXT);
    CREATE TABLE monitor_tag (id INTEGER PRIMARY KEY, monitor_id INTEGER, tag_id INTEGER, value TEXT);
    CREATE TABLE notification (id INTEGER PRIMARY KEY, name TEXT, config TEXT, active INTEGER, is_default INTEGER);
    CREATE TABLE monitor_notification (id INTEGER PRIMARY KEY, monitor_id INTEGER, notification_id INTEGER);
    CREATE TABLE maintenance (id INTEGER PRIMARY KEY, title TEXT, description TEXT, active INTEGER, strategy TEXT, interval_day INTEGER, start_date TEXT, end_date TEXT, start_time TEXT, end_time TEXT, weekdays TEXT, days_of_month TEXT, cron TEXT, duration INTEGER, timezone TEXT);
    CREATE TABLE monitor_maintenance (id INTEGER PRIMARY KEY, monitor_id INTEGER, maintenance_id INTEGER);
    CREATE TABLE maintenance_status_page (id INTEGER PRIMARY KEY, status_page_id INTEGER, maintenance_id INTEGER);
    CREATE TABLE setting (id INTEGER PRIMARY KEY, key TEXT, value TEXT, type TEXT);
    CREATE TABLE docker_host (id INTEGER PRIMARY KEY, name TEXT, docker_type TEXT, docker_daemon TEXT);
    CREATE TABLE proxy (id INTEGER PRIMARY KEY, protocol TEXT, host TEXT, port INTEGER, password TEXT);
    CREATE TABLE api_key (id INTEGER PRIMARY KEY, name TEXT, key TEXT);
    CREATE TABLE remote_browser (id INTEGER PRIMARY KEY, name TEXT, url TEXT);
    CREATE TABLE status_page (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, description TEXT, icon TEXT, published INTEGER, footer_text TEXT, custom_css TEXT, theme TEXT, show_tags INTEGER, show_powered_by INTEGER, auto_refresh_interval INTEGER, google_analytics_tag_id TEXT, rss_title TEXT);
    CREATE TABLE status_page_cname (id INTEGER PRIMARY KEY, status_page_id INTEGER, domain TEXT);
    CREATE TABLE "group" (id INTEGER PRIMARY KEY, name TEXT, public INTEGER, weight INTEGER, status_page_id INTEGER);
    CREATE TABLE monitor_group (id INTEGER PRIMARY KEY, monitor_id INTEGER, group_id INTEGER, weight INTEGER);
    CREATE TABLE incident (id INTEGER PRIMARY KEY, status_page_id INTEGER, pin INTEGER, title TEXT, content TEXT, style TEXT, created_date TEXT);
  `);
  // every monitor is inactive: the import must not start real network checks in the test app
  const mon = (id: number, name: string, type: string, extra: Record<string, unknown> = {}) => ins(db, 'monitor', { id, name, type, interval: 60, maxretries: 0, retry_interval: 60, timeout: 10, active: 0, ...extra });
  mon(1, 'Infra', 'group');
  mon(2, 'Full site', 'http', { url: 'https://full.example.com', parent: 1, description: 'Main site', headers: '{"X-Token":"abc"}', body: '{"a":1}', http_body_encoding: 'json', method: 'POST', auth_method: 'basic', basic_auth_user: 'u', basic_auth_pass: 'p', proxy_id: 1, expiry_notification: 1, resend_interval: 5, upside_down: 1, maxredirects: 3, accepted_statuscodes_json: '["200-299"]' });
  mon(3, 'Docker remote', 'docker', { docker_container: 'web', docker_host: 1 });
  mon(4, 'Docker local', 'docker', { docker_container: 'web', docker_host: 2 });
  mon(5, 'Docker lost', 'docker', { docker_container: 'web', docker_host: 9 });
  mon(6, 'Clock', 'ntp', { hostname: 'pool.ntp.org', port: 123 });
  mon(7, 'Radius', 'radius', { hostname: 'radius.example.com', port: 1812, radius_secret: 's3cret', radius_username: 'bob', radius_password: 'pw', radius_called_station_id: 'ap1' });
  mon(8, 'Rabbit', 'rabbitmq', { rabbitmq_nodes: '["http://rabbit1.example.com:15672","http://rabbit2.example.com:15672"]', rabbitmq_username: 'guest', rabbitmq_password: 'guest' });
  mon(9, 'Kafka', 'kafka-producer', { kafka_producer_brokers: '["k1.example.com:9092","k2.example.com:9092"]', kafka_producer_topic: 'events', kafka_producer_ssl: 1, kafka_producer_sasl_options: '{"mechanism":"plain"}' });
  mon(10, 'Steam', 'steam', { hostname: 'steam.example.com', port: 27016 });
  mon(11, 'Valheim', 'gamedig', { hostname: 'game.example.com', port: 2457, game: 'valheim' });
  mon(12, 'Manual down', 'manual', { manual_status: 0 });
  mon(13, 'PM2 app', 'pm2', { pm2_process_name: 'api' });
  mon(14, 'Oracle', 'oracle', { database_connection_string: 'oracle://scott:tiger@ora.example.com:1522/ORCLPDB1', database_query: 'SELECT 1 FROM DUAL' });
  mon(15, 'Global http', 'globalping', { subtype: 'http', url: 'https://example.com/health', location: 'Germany' });
  mon(16, 'Browser', 'real-browser', { url: 'https://browser.example.com' });
  mon(17, 'gRPC', 'grpc-keyword', { grpc_url: 'grpc.example.com:50051', grpc_service_name: 'my.Service', grpc_enable_tls: 1, keyword: 'SERVING' });
  mon(18, 'WS', 'websocket-upgrade', { url: 'wss://ws.example.com/socket' });
  mon(19, 'SFTP', 'sftp', { hostname: 'files.example.com', port: 22, basic_auth_user: 'sf', basic_auth_pass: 'pw' });
  mon(20, 'SMTP', 'smtp', { hostname: 'mail.example.com', port: 465, smtp_security: 'secure' });
  mon(21, 'SNMP v3', 'snmp', { hostname: 'sw.example.com', port: 161, snmp_oid: '1.3.6.1.2.1.1.3.0', snmp_version: '3', radius_password: 'public', json_path_operator: '>=', expected_value: '5' });
  mon(22, 'Push job', 'push');
  mon(23, 'Tailscale', 'tailscale-ping', { hostname: 'ts.example.com' });
  ins(db, 'tag', { id: 1, name: 'prod', color: '#059669' });
  ins(db, 'monitor_tag', { id: 1, monitor_id: 2, tag_id: 1, value: 'eu' });
  ins(db, 'notification', { id: 1, name: 'Full ntfy', config: '{"type":"ntfy","ntfyserverurl":"https://ntfy.example.com","ntfytopic":"alerts","ntfyAuthenticationMethod":"usernamePassword"}', active: 1, is_default: 0 });
  ins(db, 'notification', { id: 2, name: 'Full pagerduty', config: '{"type":"PagerDuty","pagerdutyIntegrationKey":"k"}', active: 1, is_default: 0 });
  ins(db, 'notification', { id: 3, name: 'Full telegram', config: '{"type":"telegram","telegramBotToken":"t","telegramChatID":"1","telegramSendSilently":true,"applyExisting":true}', active: 1, is_default: 0 });
  ins(db, 'monitor_notification', { id: 1, monitor_id: 2, notification_id: 1 });
  ins(db, 'monitor_notification', { id: 2, monitor_id: 2, notification_id: 2 });
  const win = (id: number, title: string, extra: Record<string, unknown>) => ins(db, 'maintenance', { id, title, active: 1, timezone: 'UTC', ...extra });
  win(1, 'Single window', { strategy: 'single', start_date: '2030-03-10 02:00:00', end_date: '2030-03-10 04:00:00', timezone: 'Europe/Berlin' });
  win(2, 'Nightly', { strategy: 'recurring-interval', interval_day: 1, start_time: '01:30', end_time: '03:00', start_date: '2020-01-01 00:00:00' });
  win(3, 'Every 3 days', { strategy: 'recurring-interval', interval_day: 3, start_time: '01:00', end_time: '02:00' });
  win(4, 'Weekend', { strategy: 'recurring-weekday', weekdays: '[6,0]', start_time: '22:00', end_time: '02:00', timezone: 'SAME_AS_SERVER' });
  win(5, 'Month end', { strategy: 'recurring-day-of-month', days_of_month: '[1,15,"lastDay1","lastDay2"]', start_time: '03:00', end_time: '04:00' });
  win(6, 'Cron job', { strategy: 'cron', cron: '0 4 * * 1', duration: 3600 });
  win(7, 'Manual', { strategy: 'manual' });
  win(8, 'Bounded', { strategy: 'recurring-weekday', weekdays: '[1]', start_time: '01:00', end_time: '02:00', end_date: '2031-01-01 00:00:00' });
  win(9, 'No monitors', { strategy: 'single', start_date: '2030-05-01 00:00:00', end_date: '2030-05-01 01:00:00' });
  let link = 0;
  for (const [mid, monitors] of [[1, [2, 99]], [2, [2]], [3, [2]], [4, [1]], [5, [2]], [6, [2]], [7, [2]], [8, [2]], [9, []]] as [number, number[]][]) for (const m of monitors) ins(db, 'monitor_maintenance', { id: ++link, monitor_id: m, maintenance_id: mid });
  ins(db, 'maintenance_status_page', { id: 1, status_page_id: 1, maintenance_id: 1 });
  for (const [k, v] of Object.entries({ serverTimezone: 'Europe/Vienna', entryPage: 'statusPage-full', tlsExpiryNotifyDays: [7, 14, 21], keepDataPeriodDays: 180, primaryBaseURL: 'https://kuma.example.com', steamAPIKey: 'steam-key-123', jwtSecret: 'jwt-secret-zzz', trustProxy: false })) ins(db, 'setting', { key: k, value: JSON.stringify(v), type: null });
  ins(db, 'docker_host', { id: 1, name: 'remote', docker_type: 'tcp', docker_daemon: 'tcp://10.0.0.5:2375' });
  ins(db, 'docker_host', { id: 2, name: 'local', docker_type: 'socket', docker_daemon: '/run/docker.sock' });
  ins(db, 'proxy', { id: 1, protocol: 'http', host: 'proxy.example.com', port: 3128, password: 'p@ssw0rd-proxy' });
  ins(db, 'api_key', { id: 1, name: 'ci key', key: 'uk1_secret-api-key' });
  ins(db, 'remote_browser', { id: 1, name: 'chrome1', url: 'ws://chrome.example.com:3000' });
  ins(db, 'status_page', { id: 1, slug: 'full', title: 'Full page', published: 1, icon: '/icon.svg', theme: 'dark', show_tags: 1, show_powered_by: 0, auto_refresh_interval: 60, google_analytics_tag_id: 'G-1', rss_title: 'Feed' });
  ins(db, 'status_page_cname', { id: 1, status_page_id: 1, domain: 'full.example.com' });
  ins(db, 'status_page_cname', { id: 2, status_page_id: 1, domain: 'other.example.com' });
  ins(db, 'group', { id: 1, name: 'Public', public: 1, weight: 1, status_page_id: 1 });
  ins(db, 'monitor_group', { id: 1, monitor_id: 2, group_id: 1, weight: 1 });
  ins(db, 'incident', { id: 1, status_page_id: 1, pin: 1, title: 'Database slow', content: 'We are looking into it', style: 'warning', created_date: '2026-10-01 08:30:00' });
  db.close();
  return file;
};

const convertFull = async () => {
  const { kumaFromSqlite } = await import('../../src/server/kuma-source');
  const { convertKuma } = await import('../../src/server/portability');
  return convertKuma(await kumaFromSqlite(kumaDbFull()));
};

describe('Uptime Kuma import: monitor types', () => {
  it('maps the new protocols to the runner fields', async () => {
    const { doc, unsupported } = await convertFull();
    const mon = (n: string) => doc.monitors!.find((m) => m.name === n) as Record<string, any>;
    for (const m of doc.monitors!) expect(m.active, m.name).toBe(false);
    expect(mon('Clock')).toMatchObject({ type: 'ntp', config: { host: 'pool.ntp.org', port: 123 } });
    expect(mon('Radius')).toMatchObject({ type: 'radius', config: { host: 'radius.example.com', port: 1812, secret: 's3cret', username: 'bob', password: 'pw', calledStationId: 'ap1' } });
    expect(mon('Rabbit')).toMatchObject({ type: 'rabbitmq', config: { url: 'http://rabbit1.example.com:15672', username: 'guest', password: 'guest' } });
    expect(mon('Rabbit').notes.join(' ')).toMatch(/first of 2 nodes/);
    expect(mon('Kafka')).toMatchObject({ type: 'kafka', config: { brokers: 'k1.example.com:9092,k2.example.com:9092', topic: 'events', tls: true } });
    expect(mon('Kafka').notes.join(' ')).toMatch(/SASL/);
    expect(mon('Steam')).toMatchObject({ type: 'steam', config: { host: 'steam.example.com', port: 27016 } });
    expect(mon('Valheim')).toMatchObject({ type: 'gamedig', config: { game: 'valheim', host: 'game.example.com', port: 2457 } });
    expect(mon('Manual down')).toMatchObject({ type: 'manual', config: { state: 'down' } });
    expect(mon('PM2 app')).toMatchObject({ type: 'pm2', config: { processName: 'api' } });
    expect(mon('Oracle')).toMatchObject({ type: 'oracle', config: { host: 'ora.example.com', port: 1522, serviceName: 'ORCLPDB1', username: 'scott', password: 'tiger', query: 'SELECT 1 FROM DUAL' } });
    expect(mon('Global http')).toMatchObject({ type: 'globalping', config: { measurement: 'http', target: 'https://example.com/health', location: 'Germany' } });
    expect(mon('Browser')).toMatchObject({ type: 'http', config: { url: 'https://browser.example.com' } });
    expect(mon('Browser').notes.join(' ')).toMatch(/plain HTTP request, not a real browser/);
    expect(mon('gRPC')).toMatchObject({ type: 'grpc', config: { host: 'grpc.example.com', port: 50051, service: 'my.Service', useTls: true } });
    expect(mon('gRPC').notes.join(' ')).toMatch(/keyword/);
    expect(mon('WS')).toMatchObject({ type: 'websocket', config: { url: 'wss://ws.example.com/socket' } });
    expect(mon('SFTP')).toMatchObject({ type: 'sftp', config: { host: 'files.example.com', port: 22, username: 'sf', authMethod: 'password', password: 'pw' } });
    expect(mon('SMTP')).toMatchObject({ type: 'smtp', config: { host: 'mail.example.com', port: 465, security: 'implicit' } });
    expect(mon('SNMP v3')).toMatchObject({ type: 'snmp', config: { host: 'sw.example.com', community: 'public', oid: '1.3.6.1.2.1.1.3.0', op: 'exists' } });
    expect(mon('SNMP v3').notes.join(' ')).toMatch(/SNMP v3/);
    expect(mon('SNMP v3').notes.join(' ')).toMatch(/">="/);
    expect(mon('Push job').notes.join(' ')).toMatch(/new push URL/);
    expect(unsupported.find((u) => u.name === 'Tailscale')).toMatchObject({ kind: 'monitor', reason: expect.stringMatching(/Tailscale/) });
  });

  it('carries over the details of a monitor and says what was lost', async () => {
    const { doc } = await convertFull();
    const mon = (n: string) => doc.monitors!.find((m) => m.name === n) as Record<string, any>;
    const site = mon('Full site');
    expect(site).toMatchObject({ type: 'http', group: 'Infra', description: 'Main site', tags: ['prod'], config: { method: 'POST', maxRedirects: 3, authType: 'basic', basicUser: 'u', tlsExpiryDays: 21, headers: { 'X-Token': 'abc', 'Content-Type': 'application/json' } } });
    expect(site.notifications.map((n: any) => n.channel)).toEqual(['Full ntfy']);
    const notes = site.notes.join(' | ');
    for (const re of [/tag "prod" had the value "eu"/, /Resend notification every 5/, /proxy/, /"Full pagerduty"/, /Upside down/]) expect(notes).toMatch(re);
    expect(mon('Docker remote').config.endpoint).toBe('http://10.0.0.5:2375');
    expect(mon('Docker local').config.endpoint).toBe('/run/docker.sock');
    expect(mon('Docker lost').config.endpoint).toBe('/var/run/docker.sock');
    expect(mon('Docker lost').notes.join(' ')).toMatch(/docker host #9/);
  });

  it('turns channels into channels with notes and lists the types that have no equivalent', async () => {
    const { doc, unsupported } = await convertFull();
    const ch = (n: string) => doc.channels!.find((c) => c.name === n)!;
    expect(ch('Full ntfy').notes!.join(' ')).toMatch(/Username\/password/);
    expect(ch('Full telegram').notes!.join(' ')).toMatch(/silent/);
    expect(ch('Full telegram').notes!.join(' ')).toMatch(/one-time action/);
    expect(doc.channels!.some((c) => c.name === 'Full pagerduty')).toBe(false);
    expect(unsupported.find((u) => u.kind === 'notification')).toMatchObject({ name: 'Full pagerduty', reason: expect.stringMatching(/PagerDuty/) });
  });

  it('lists a monitor that would not validate instead of blocking the import', async () => {
    const { convertKuma } = await import('../../src/server/portability');
    const { doc, unsupported } = convertKuma({ monitorList: [{ id: 1, name: 'No host', type: 'port', port: 80, interval: 60, active: true }, { id: 2, name: 'Ok', type: 'port', hostname: 'h.example.com', port: 80, interval: 60, active: true }], notificationList: [] });
    expect(doc.monitors!.map((m) => m.name)).toEqual(['Ok']);
    expect(unsupported).toEqual([{ kind: 'monitor', name: 'No host', reason: expect.stringMatching(/incomplete after conversion.*Host is required/) }]);
  });
});

describe('Uptime Kuma import: maintenance, settings and the overview', () => {
  it('converts maintenance windows of every strategy exactly or lists them with the reason', async () => {
    const { doc, unsupported, warnings } = await convertFull();
    const w = (n: string) => doc.maintenance!.find((x) => x.name === n) as Record<string, any>;
    expect(doc.maintenance!.map((x) => x.name).sort()).toEqual(['Cron job', 'Month end', 'Nightly', 'Single window', 'Weekend']);
    // 02:00-04:00 in Berlin (UTC+1 in March) is 01:00-03:00 UTC
    expect(w('Single window')).toMatchObject({ kind: 'once', startsAt: '2030-03-10T01:00:00.000Z', endsAt: '2030-03-10T03:00:00.000Z', announce: true, targets: [{ type: 'monitor', name: 'Full site' }] });
    expect(w('Single window').notes.join(' ')).toMatch(/1 linked monitor\(s\) are not part of the import/);
    expect(w('Nightly')).toMatchObject({ kind: 'cron', cronExpr: '30 1 * * *', durationMin: 90, timezone: 'UTC', announce: false });
    expect(w('Weekend')).toMatchObject({ kind: 'cron', cronExpr: '0 22 * * 0,6', durationMin: 240, timezone: 'Europe/Vienna', targets: [{ type: 'group', name: 'Infra' }] }); // the server time zone from the settings, across midnight
    expect(w('Month end')).toMatchObject({ cronExpr: '0 3 1,15,L * *', durationMin: 60 });
    expect(w('Month end').notes.join(' ')).toMatch(/end of the month/);
    expect(w('Cron job')).toMatchObject({ cronExpr: '0 4 * * 1', durationMin: 60 }); // Kuma keeps the duration in seconds
    const why = Object.fromEntries(unsupported.filter((u) => u.kind === 'maintenance').map((u) => [u.name, u.reason]));
    expect(Object.keys(why).sort()).toEqual(['Bounded', 'Every 3 days', 'Manual', 'No monitors']);
    expect(why['Every 3 days']).toMatch(/every 3 days/);
    expect(why['Manual']).toMatch(/by hand/);
    expect(why['Bounded']).toMatch(/only valid until/);
    expect(why['No monitors']).toMatch(/not linked to any monitor/);
    expect(warnings.join(' ')).toMatch(/maintenance "Manual"/);
  });

  it('reads the socket shape of a maintenance window and respects daylight saving time', async () => {
    const { convertKuma } = await import('../../src/server/portability');
    const mk = { id: 1, name: 'S', type: 'port', hostname: 'h.example.com', port: 80, interval: 60, active: true };
    const { doc } = convertKuma({
      monitorList: [mk], notificationList: [],
      maintenanceList: [
        { id: 1, title: 'Summer', strategy: 'single', dateRange: ['2030-07-01 12:00:00', '2030-07-01 13:00:00'], timezoneOption: 'Europe/Berlin', timezone: 'Europe/Berlin', monitorIds: [1], statusPageIds: [], active: true },
        { id: 2, title: 'Tokyo', strategy: 'recurring-weekday', weekdays: [1, 2], timeRange: [{ hours: 2, minutes: 0 }, { hours: 3, minutes: 30 }], dateRange: [null], timezoneOption: 'SAME_AS_SERVER', timezone: 'Asia/Tokyo', monitorIds: [1], active: false },
        { id: 3, title: 'Linked later', strategy: 'cron', cron: '0 5 * * *', durationMinutes: 30, timezoneOption: 'UTC', active: true }, // the links could not be read
      ],
    });
    expect(doc.maintenance!.map((x) => [x.name, x.startsAt ?? x.cronExpr, x.durationMin ?? null, x.timezone, x.active])).toEqual([['Summer', '2030-07-01T10:00:00.000Z', null, 'Europe/Berlin', true], ['Tokyo', '0 2 * * 1,2', 90, 'Asia/Tokyo', false]]);
    expect(doc.unsupported).toEqual([{ kind: 'maintenance', name: 'Linked later', reason: expect.stringMatching(/could not be read from the source/) }]);
  });

  it('lists the settings, proxies, API keys and browsers that cannot be imported, never their secrets', async () => {
    const { unsupported, warnings } = await convertFull();
    const names = unsupported.map((u) => `${u.kind}:${u.name}`);
    expect(names).toEqual(expect.arrayContaining(['setting:primaryBaseURL', 'setting:keepDataPeriodDays', 'setting:steamAPIKey', 'proxy:http://proxy.example.com:3128', 'apiKey:ci key', 'browser:chrome1', 'notification:Full pagerduty', 'monitor:Tailscale']));
    for (const n of ['setting:jwtSecret', 'setting:serverTimezone', 'setting:entryPage', 'setting:trustProxy', 'setting:tlsExpiryNotifyDays']) expect(names).not.toContain(n); // mapped, empty, or internal
    expect(unsupported.find((u) => u.name === 'keepDataPeriodDays')!.reason).toMatch(/PW_RETENTION.*180/);
    expect(unsupported.find((u) => u.name === 'primaryBaseURL')!.reason).toMatch(/PW_BASE_URL/);
    expect(unsupported.find((u) => u.kind === 'proxy')!.reason).toMatch(/1 monitor\(s\) used it/);
    expect(JSON.stringify(unsupported)).not.toMatch(/steam-key-123|jwt-secret-zzz|p@ssw0rd-proxy|uk1_secret-api-key|tiger/);
    expect(warnings.join(' ')).toMatch(/7, 14, 21 days.*21 days/);
  });

  it('previews everything in one list with notes, imports it, and does not duplicate it when imported again', async () => {
    const full = () => c.call('POST', '/api/import/kuma-db', fs.readFileSync(kumaDbFull()), { headers: { 'content-type': 'application/octet-stream' } });
    const pre = await full();
    expect(pre.status).toBe(200);
    expect(pre.json.errors).toEqual([]); // maintenance windows of monitors that do not exist yet are no error in the preview
    expect(pre.json.counts.maintenance.created).toBe(5);
    const items = pre.json.items;
    expect(items.maintenance.map((m: any) => [m.name, m.kind, m.targets, m.exists])).toEqual([['Single window', 'once', 1, false], ['Nightly', 'cron', 1, false], ['Weekend', 'cron', 1, false], ['Month end', 'cron', 1, false], ['Cron job', 'cron', 1, false]]);
    expect(items.monitors.find((m: any) => m.name === 'Full site').notes.join(' ')).toMatch(/proxy/);
    expect(items.channels.find((x: any) => x.name === 'Full telegram').notes.length).toBeGreaterThan(0);
    expect(items.statusPages[0].notes.join(' ')).toMatch(/theme "dark"/);
    expect(items.statusPages[0].notes.join(' ')).toMatch(/default \(home\) page/);
    expect(items.statusPages[0].notes.join(' ')).toMatch(/1 pinned incident\(s\) imported as announcements/);
    expect(items.statusPages[0].notes.join(' ')).toMatch(/other\.example\.com/);
    expect(items.unsupported.length).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(pre.json)).not.toMatch(/steam-key-123|jwt-secret-zzz|p@ssw0rd-proxy|uk1_secret-api-key/);

    const done = await applyAndWait(pre.json.previewId);
    expect(done.report.errors).toEqual([]);
    expect(done.report.counts.maintenance.created).toBe(5);
    const windows = (await c.get('/api/maintenance')).json as any[];
    const win = (n: string) => windows.find((x) => x.name === n);
    expect([win('Single window').kind, win('Single window').announce, win('Single window').startsAt]).toEqual(['once', true, '2030-03-10T01:00:00.000Z']);
    expect([win('Weekend').cronExpr, win('Weekend').durationMin, win('Weekend').timezone, win('Weekend').targets.map((x: any) => x.type)]).toEqual(['0 22 * * 0,6', 240, 'Europe/Vienna', ['group']]);
    expect(win('Month end').cronExpr).toBe('0 3 1,15,L * *');
    const mons = (await c.get('/api/monitors')).json as any[];
    const endpoint = async (n: string) => (await c.get(`/api/monitors/${mons.find((m) => m.name === n).id}`)).json.config.endpoint;
    expect([await endpoint('Docker remote'), await endpoint('Docker local')]).toEqual(['http://10.0.0.5:2375', '/run/docker.sock']);
    expect(mons.find((m) => m.name === 'Clock').type).toBe('ntp');
    expect(mons.some((m) => m.name === 'Tailscale')).toBe(false);
    const page = await t.ctx.db.selectFrom('status_pages').select(['id', 'is_default']).where('slug', '=', 'full').executeTakeFirstOrThrow();
    expect(page.is_default).toBe(1); // Kuma's entry page
    const announcements = () => t.ctx.db.selectFrom('status_page_announcements').select(['kind', 'title', 'body']).where('page_id', '=', page.id).execute();
    expect(await announcements()).toEqual([{ kind: 'incident', title: 'Database slow', body: 'We are looking into it' }]);

    const again = await applyAndWait((await full()).json.previewId);
    expect(again.report.errors).toEqual([]);
    expect([again.report.counts.maintenance.created, again.report.counts.maintenance.updated]).toEqual([0, 5]);
    expect(await announcements()).toHaveLength(1); // the same announcement is not added twice
    expect(((await c.get('/api/maintenance')).json as any[]).filter((x) => x.name === 'Nightly')).toHaveLength(1);

    // only the picked window is taken over
    const picked = await applyAndWait((await full()).json.previewId, { maintenance: ['Nightly'], monitors: [], groups: [], tags: [], channels: [], statusPages: [] });
    expect([picked.report.counts.maintenance.created, picked.report.counts.maintenance.updated]).toEqual([0, 1]);

    // a window whose monitors are all missing here is skipped with a warning, not an error
    expect((await c.del(`/api/monitors/${mons.find((m) => m.name === 'Full site').id}`)).status).toBe(200);
    const orphan = await applyAndWait((await full()).json.previewId, { maintenance: ['Single window'], monitors: [], groups: [], tags: [], channels: [], statusPages: [] });
    expect(orphan.report.errors).toEqual([]);
    expect(orphan.report.warnings.join(' ')).toMatch(/Single window: none of its monitors or groups exists here/);
  });
});

describe('Uptime Kuma import over the API: the extra lists', () => {
  it('asks for maintenance links, settings, docker hosts, proxies, keys and browsers and imports what maps', async () => {
    const mon = { id: 9, name: 'Rich api site', type: 'http', url: 'https://rich-api.example.com', interval: 60, maxretries: 0, retryInterval: 60, timeout: 10, active: false, parent: null, ignoreTls: false, accepted_statuscodes: ['200-299'], method: 'GET' };
    const dock = { id: 10, name: 'Rich api docker', type: 'docker', docker_container: 'web', docker_host: 3, interval: 60, maxretries: 0, retryInterval: 60, timeout: 10, active: false, parent: null };
    const asked: string[] = [];
    const http = createServer((req, res) => {
      if (req.url === '/api/status-page/rich-page') { res.setHeader('content-type', 'application/json'); return void res.end(JSON.stringify({ config: {}, incident: { title: 'API incident', content: 'Investigating', style: 'danger', createdDate: '2026-10-01 09:00:00' }, publicGroupList: [{ id: 1, name: 'Public', monitorList: [{ id: 9 }] }] })); }
      res.statusCode = 404; res.end();
    });
    const kuma = new Server(http, { serveClient: false, path: '/socket.io', allowRequest: (req, cb) => cb(null, req.headers.origin === `http://${req.headers.host}`) });
    kuma.on('connection', (s) => {
      s.on('getSettings', (cb: (r: unknown) => void) => { asked.push('getSettings'); cb({ ok: true, data: { entryPage: 'statusPage-rich-page', serverTimezone: 'UTC', keepDataPeriodDays: 30 } }); });
      s.on('getMonitorMaintenance', (id: number, cb: (r: unknown) => void) => { asked.push(`monitors:${id}`); cb({ ok: true, monitors: [{ id: 9 }] }); });
      s.on('getMaintenanceStatusPage', (id: number, cb: (r: unknown) => void) => { asked.push(`pages:${id}`); cb({ ok: true, statusPages: [] }); });
      s.on('login', (_d: any, cb: (r: unknown) => void) => {
        s.emit('notificationList', []);
        s.emit('monitorList', { 9: mon, 10: dock });
        s.emit('maintenanceList', { 5: { id: 5, title: 'Rich api window', strategy: 'cron', cron: '0 5 * * *', durationMinutes: 30, duration: 1800, timezoneOption: 'UTC', timezone: 'UTC', active: true, dateRange: [null], timeRange: [{ hours: 0, minutes: 0 }, { hours: 0, minutes: 0 }], weekdays: [], daysOfMonth: [] } });
        s.emit('statusPageList', { 1: { id: 1, slug: 'rich-page', title: 'Rich page', published: true, domainNameList: [] } });
        s.emit('dockerHostList', { 3: { id: 3, name: 'remote', dockerType: 'tcp', dockerDaemon: 'tcp://docker.example.com:2376' } });
        s.emit('proxyList', [{ id: 1, protocol: 'socks5', host: 'proxy.example.com', port: 1080, password: 'proxy-pass-zzz' }]);
        s.emit('apiKeyList', [{ id: 1, name: 'rich key', key: 'uk1_zzz' }]);
        s.emit('remoteBrowserList', [{ id: 1, name: 'rich browser', url: 'ws://b' }]);
        cb({ ok: true, token: 'jwt' });
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const pre = await c.post('/api/import/kuma-api', { url, username: 'admin', password: 'x' });
      expect(pre.status).toBe(200);
      expect(pre.json.errors).toEqual([]);
      expect(asked.sort()).toEqual(['getSettings', 'monitors:5', 'pages:5']);
      expect(pre.json.items.maintenance).toEqual([{ name: 'Rich api window', kind: 'cron', targets: 1, exists: false }]);
      const un = (pre.json.items.unsupported as any[]).map((u) => `${u.kind}:${u.name}`);
      expect(un).toEqual(expect.arrayContaining(['proxy:socks5://proxy.example.com:1080', 'apiKey:rich key', 'browser:rich browser', 'setting:keepDataPeriodDays']));
      expect(JSON.stringify(pre.json)).not.toMatch(/proxy-pass-zzz|uk1_zzz/);
      expect(pre.json.items.statusPages[0].notes.join(' ')).toMatch(/default \(home\) page/);
      await applyAndWait(pre.json.previewId);
      const row = await t.ctx.db.selectFrom('maintenance_windows').select(['cron_expr', 'duration_min', 'timezone']).where('name', '=', 'Rich api window').executeTakeFirstOrThrow();
      expect([row.cron_expr, row.duration_min, row.timezone]).toEqual(['0 5 * * *', 30, 'UTC']);
      const mons = (await c.get('/api/monitors')).json as any[];
      expect((await c.get(`/api/monitors/${mons.find((m) => m.name === 'Rich api docker').id}`)).json.config.endpoint).toBe('http://docker.example.com:2376');
      const page = await t.ctx.db.selectFrom('status_pages').select(['id', 'is_default']).where('slug', '=', 'rich-page').executeTakeFirstOrThrow();
      expect(page.is_default).toBe(1);
      expect((await t.ctx.db.selectFrom('status_page_announcements').select(['kind', 'title']).where('page_id', '=', page.id).execute())).toEqual([{ kind: 'incident', title: 'API incident' }]);
    } finally { await new Promise<void>((r) => { void kuma.close(() => r()); }); }
  });
});
