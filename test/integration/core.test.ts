import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t?.close(); });

describe('migrations', () => {
  it('are idempotent and create the partitioned heartbeat table', async () => {
    const { migrate } = await import('../../src/server/db/migrate');
    const again = await migrate(process.env.PW_MIGRATIONS_DIR, () => {});
    expect(again.applied).toEqual([]);
    const { ensurePartitions } = await import('../../src/server/jobs/housekeeping');
    const created = await ensurePartitions(t.ctx.db, 3);
    expect(created.length).toBeGreaterThan(0);
    expect(await ensurePartitions(t.ctx.db, 3)).toEqual([]);
  });
});

describe('auth and CSRF', () => {
  it('runs the first-run setup once and enforces CSRF on mutations', async () => {
    const c = t.client();
    expect((await c.get('/api/setup/status')).json.needsSetup).toBe(true);
    expect((await c.post('/api/setup', { username: 'admin', password: 'correct-horse-battery-1' })).status).toBe(200);
    expect((await c.post('/api/setup', { username: 'second', password: 'correct-horse-battery-2' })).status).toBe(409);
    const noCsrf = await c.call('POST', '/api/tags', { name: 'x' }, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.error).toBe('csrf');
    expect((await c.post('/api/tags', { name: 'prod', color: '#059669' })).status).toBe(200);
  });

  it('rejects wrong passwords and accepts API tokens by scope', async () => {
    const anon = t.client();
    expect((await anon.post('/api/auth/login', { username: 'admin', password: 'wrong-password-123' })).status).toBe(401);
    const c = await (async () => { const x = t.client(); await x.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' }); return x; })();
    const tok = await c.post('/api/tokens', { name: 'ci', scopes: ['read'] });
    expect(tok.status).toBe(200);
    const bearer = t.client({ bearer: tok.json.token });
    expect((await bearer.get('/api/monitors')).status).toBe(200);
    expect((await bearer.post('/api/tags', { name: 'nope' })).status).toBe(403); // read scope cannot write
    expect((await t.client({ bearer: 'pw_invalid' }).get('/api/monitors')).status).toBe(401);
  });
});

describe('monitors', () => {
  it('turns a push monitor up on heartbeat and reports failures', async () => {
    const c = t.client(); await c.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' });
    const m = await c.post('/api/monitors', { name: 'backup', type: 'push', config: {}, intervalS: 60, timeoutS: 10 });
    expect(m.status).toBe(200);
    const token = m.json.pushToken as string;
    expect(token).toBeTruthy();
    expect((await t.client().get(`/api/push/${token}`)).status).toBe(200);
    expect((await c.get(`/api/monitors/${m.json.id}`)).json.status).toBe('up');
    expect((await t.client().get(`/api/push/${token}?status=down&msg=disk%20full`)).status).toBe(200);
    const detail = (await c.get(`/api/monitors/${m.json.id}`)).json;
    expect(detail.status).toBe('down');
    expect(detail.errorKind).toBe('reported');
    expect((await t.client().get('/api/push/unknown-token')).status).toBe(404);
  });

  it('rejects invalid configuration with a readable message', async () => {
    const c = t.client(); await c.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' });
    const r = await c.post('/api/monitors', { name: 'bad', type: 'http', config: {}, intervalS: 60, timeoutS: 10 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('validation');
  });
});

describe('rollups', () => {
  it('aggregates minute buckets with exact percentiles and count-weighted hour rollups', async () => {
    const c = await (async () => { const x = t.client(); await x.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' }); return x; })();
    const m = await c.post('/api/monitors', { name: 'rollup', type: 'push', config: {}, intervalS: 60, timeoutS: 10, active: false });
    const id = m.json.id as number;
    const base = new Date(Date.UTC(2026, 0, 5, 10, 0, 0));
    const rows = [100, 200, 300, 400].map((lat, i) => ({ monitor_id: id, location_id: 0, ts: new Date(base.getTime() + i * 10_000), status: 1, latency_ms: lat }));
    rows.push({ monitor_id: id, location_id: 0, ts: new Date(base.getTime() + 50_000), status: 0, latency_ms: null as any });
    await t.ctx.db.insertInto('heartbeats').values(rows as any).execute();
    const { rollupMinutes, rollupCoarse } = await import('../../src/server/jobs/housekeeping');
    expect(await rollupMinutes(t.ctx.db, base, new Date(base.getTime() + 60_000))).toBe(1);
    const min = await t.ctx.db.selectFrom('rollups').selectAll().where('monitor_id', '=', id).where('res', '=', 'minute').executeTakeFirstOrThrow();
    expect([min.total, min.up_n, min.down_n, min.lat_min, min.lat_max, min.lat_p50]).toEqual([5, 4, 1, 100, 400, 200]);
    await rollupCoarse(t.ctx.db, 'hour', base);
    const hour = await t.ctx.db.selectFrom('rollups').selectAll().where('monitor_id', '=', id).where('res', '=', 'hour').executeTakeFirstOrThrow();
    expect([hour.total, hour.up_n, Number(hour.lat_sum) / hour.lat_n]).toEqual([5, 4, 250]);
  });
});

describe('status pages', () => {
  it('protects password pages and keeps private pages away from anonymous users', async () => {
    const c = await loggedInAdminAgain();
    const mon = (await c.get('/api/monitors')).json[0];
    const page = { slug: 'secret', title: 'Secret', isPublic: true, password: 'open-sesame', sections: [{ name: 'Core', components: [{ monitorId: mon.id }] }] };
    expect((await c.post('/api/status-pages', page)).status).toBe(200);
    const anon = t.client();
    const locked = await anon.get('/api/public/status/secret');
    expect([401, 403]).toContain(locked.status);
    expect(locked.json.error).toBe('password_required');
    expect((await anon.post('/api/public/status/secret/unlock', { password: 'nope-nope' })).status).toBe(401);
    expect((await anon.post('/api/public/status/secret/unlock', { password: 'open-sesame' })).status).toBe(200);
    expect((await anon.get('/api/public/status/secret')).status).toBe(200);
    expect((await c.post('/api/status-pages', { slug: 'private', title: 'Private', isPublic: false, sections: [] })).status).toBe(200);
    expect([401, 403]).toContain((await t.client().get('/api/public/status/private')).status);
  });
});

describe('config export and import', () => {
  it('masks secrets on export and keeps stored secrets when the masked document is imported', async () => {
    const c = await loggedInAdminAgain();
    const created = await c.post('/api/monitors', { name: 'secure api', type: 'http', config: { url: 'https://example.com/health', headers: { Authorization: 'Bearer very-secret-token' } }, intervalS: 60, timeoutS: 10, active: false });
    expect(created.status).toBe(200);
    const exp = await c.get('/api/config/export?format=json');
    expect(exp.status).toBe(200);
    expect(exp.body).not.toContain('very-secret-token');
    const dry = await c.post('/api/config/import', { content: exp.body, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.json.errors ?? []).toEqual([]);
    const applied = await c.post('/api/config/import', { content: exp.body, dryRun: false });
    expect(applied.status).toBe(200);
    const row = await t.ctx.db.selectFrom('monitors').select('config').where('id', '=', created.json.id).executeTakeFirstOrThrow();
    const { decryptConfig } = await import('../../src/server/monitors/model');
    const { getRunner } = await import('../../src/core');
    expect(JSON.stringify(decryptConfig(getRunner('http'), JSON.parse(row.config)))).toContain('very-secret-token');
  });
});

describe('probes and quorum', () => {
  it('goes down only when the configured quorum of locations fails', async () => {
    const c = await loggedInAdminAgain();
    const p1 = (await c.post('/api/probes', { name: 'eu' })).json; const p2 = (await c.post('/api/probes', { name: 'us' })).json;
    const m = (await c.post('/api/monitors', { name: 'quorum', type: 'tcp', config: { host: '127.0.0.1', port: 9 }, intervalS: 60, timeoutS: 5, locations: [p1.id, p2.id], quorum: 2, active: true })).json;
    const probe = (tok: string) => t.client({ bearer: tok });
    const jobs = await probe(p1.token).get('/api/probe/v1/jobs');
    expect(jobs.json.jobs.map((j: any) => j.id)).toContain(m.id);
    expect((await probe('pwp_bogus').get('/api/probe/v1/jobs')).status).toBe(401);
    const fail = { results: [{ monitorId: m.id, ok: false, errorKind: 'connect', message: 'refused' }] };
    expect((await probe(p1.token).post('/api/probe/v1/results', fail)).json.accepted).toBe(1);
    // Probe results are stored immediately; the verdict is evaluated on the monitor's schedule (here: forced).
    await c.post(`/api/monitors/${m.id}/check`);
    expect((await c.get(`/api/monitors/${m.id}`)).json.status).not.toBe('down'); // 1 of 2 failing is below quorum
    await probe(p2.token).post('/api/probe/v1/results', fail);
    await c.post(`/api/monitors/${m.id}/check`);
    expect((await c.get(`/api/monitors/${m.id}`)).json.status).toBe('down');
  });
});

async function loggedInAdminAgain() { const x = t.client(); const r = await x.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' }); if (r.status !== 200) throw new Error('login failed'); return x; }
void loggedInAdmin;
