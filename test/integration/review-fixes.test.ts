// Regression tests for the findings of the October review round.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); });
afterAll(async () => { await t?.close(); });

const importDoc = (doc: object) => c.post('/api/config/import', { content: JSON.stringify(doc) });

describe('review fixes', () => {
  it('a push that reported down is not turned back to up by the next scheduled round', async () => {
    const m = (await c.post('/api/monitors', { name: 'job', type: 'push', config: {}, intervalS: 60, timeoutS: 10 })).json as { id: number; pushToken: string };
    await t.client().get(`/api/push/${m.pushToken}`);
    await t.client().get(`/api/push/${m.pushToken}?status=down&msg=failed`);
    await c.post(`/api/monitors/${m.id}/check`); // what the scheduler does between pushes
    expect((await c.get(`/api/monitors/${m.id}`)).json.status).toBe('down');
  });

  it('new notification rules also get the flap notice, which is the only alert while a monitor flaps', async () => {
    const ch = (await c.post('/api/notification-channels', { name: 'hook', type: 'webhook', config: { url: 'https://hooks.example.com/x' } })).json.id;
    const m = (await c.post('/api/monitors', { name: 'flappy', type: 'push', config: {}, notifications: [{ channelId: ch }] })).json.id;
    expect((await c.get(`/api/monitors/${m}`)).json.notifications[0].events).toEqual(['down', 'up', 'flap']);
  });

  it('import: tags match without regard to case, groups with "/" are found again, equal names stay apart', async () => {
    await c.post('/api/tags', { name: 'prod' });
    const g1 = (await c.post('/api/groups', { name: 'a/b' })).json.id;
    const g2 = (await c.post('/api/groups', { name: 'other' })).json.id;
    for (const [groupId, intervalS] of [[g1, 60], [g2, 300]]) await c.post('/api/monitors', { name: 'sw', type: 'push', config: {}, groupId, intervalS, timeoutS: 10 });
    const exported = JSON.parse((await c.get('/api/config/export?format=json')).body);
    const again = await importDoc({ ...exported, monitors: [...exported.monitors, { name: 'tagged', type: 'push', config: {}, tags: ['Prod'] }] });
    expect(again.json.errors).toEqual([]);
    const groups = (await c.get('/api/groups')).json as { name: string }[];
    expect(groups.filter((g) => g.name === 'a/b' || g.name === 'a-b').map((g) => g.name)).toEqual(['a/b']);
    const sws = ((await c.get('/api/monitors')).json as { name: string; intervalS: number }[]).filter((m) => m.name === 'sw').map((m) => m.intervalS).sort((a, b) => a - b);
    expect(sws).toEqual([60, 300]);
  });

  it('rejects invalid SSRF rules in an import, garbage maintenance dates and unknown groups in a bulk edit', async () => {
    const r = await importDoc({ version: 1, settings: { ssrf: { mode: 'public-only', allow: ['not-a-cidr'], deny: [] } } });
    expect(r.json.warnings.join(' ')).toMatch(/SSRF/);
    expect((await c.get('/api/settings/ssrf')).json.allow).not.toContain('not-a-cidr');
    const m = (await c.post('/api/monitors', { name: 'x', type: 'push', config: {} })).json.id;
    expect((await c.post('/api/maintenance', { name: 'w', kind: 'once', startsAt: 'garbage', endsAt: '2030-01-01T00:00:00Z', targets: [{ type: 'monitor', id: m }] })).status).toBe(400);
    expect((await c.post('/api/monitors/bulk', { ids: [m], action: 'patch', patch: { groupId: 999999 } })).status).toBe(400);
  });
});

describe('overall status of a status page', () => {
  it('is unknown while nothing has a result, and operational with a count of unknown ones once one is up', async () => {
    const a = (await c.post('/api/monitors', { name: 'ov-a', type: 'push', config: {} })).json as { id: number; pushToken: string };
    const b = (await c.post('/api/monitors', { name: 'ov-b', type: 'push', config: {} })).json as { id: number };
    expect((await c.post('/api/status-pages', { slug: 'ov', title: 'Ov', isPublic: true, sections: [], components: [{ monitorId: a.id }, { monitorId: b.id }] })).status).toBe(200);
    const page = async () => (await t.client().get('/api/public/status/ov')).json as { overall: string; unknownCount: number };
    expect(await page()).toMatchObject({ overall: 'unknown', unknownCount: 2 });
    await t.client().get(`/api/push/${a.pushToken}`);
    expect(await page()).toMatchObject({ overall: 'operational', unknownCount: 1 });
  });
});

describe('retry timing', () => {
  it('counts the retry interval from the start of the failed attempt, like Uptime Kuma', async () => {
    const id = (await c.post('/api/monitors', { name: 'rt', type: 'push', config: {}, intervalS: 60, timeoutS: 48, retries: 3, retryIntervalS: 60 })).json.id;
    const { parseMonitor } = await import('../../src/server/monitors/model');
    const m = parseMonitor(await t.ctx.db.selectFrom('monitors').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
    const now = Date.now();
    const slow = t.ctx.engine.nextRun(m, undefined, true, now - 48_000).getTime() - now; // the attempt ran into its 48 s timeout
    expect(slow).toBeGreaterThan(5_000);
    expect(slow).toBeLessThan(20_000); // about 12 s left of the 60 s retry interval, not another full 60 s
    expect(t.ctx.engine.nextRun(m, undefined, true, now - 120_000).getTime() - now).toBeLessThanOrEqual(1_000); // overdue: right away
  });
});

describe('outages seen only by a probe', () => {
  it('a probe that stops reporting counts as failing, so the monitor goes down instead of freezing', async () => {
    const p = (await c.post('/api/probes', { name: 'site-b' })).json;
    const m = (await c.post('/api/monitors', { name: 'via-probe', type: 'tcp', config: { host: '127.0.0.1', port: 9 }, intervalS: 60, timeoutS: 5, retries: 1, retryIntervalS: 60, locations: [p.id], quorum: 1 })).json;
    await t.client({ bearer: p.token }).post('/api/probe/v1/results', { results: [{ monitorId: m.id, ok: true }] });
    const { parseMonitor } = await import('../../src/server/monitors/model');
    const round = async () => t.ctx.engine.runRound(parseMonitor(await t.ctx.db.selectFrom('monitors').selectAll().where('id', '=', m.id).executeTakeFirstOrThrow()), { advance: true });
    const status = async () => (await t.ctx.db.selectFrom('monitor_state').select('status').where('monitor_id', '=', m.id).executeTakeFirstOrThrow()).status;
    await round();
    expect(await status()).toBe('up');
    // the probe's uplink is gone: its last result ages past the stale window
    await t.ctx.db.updateTable('monitor_location_state').set({ ts: new Date(Date.now() - 600_000) }).where('monitor_id', '=', m.id).execute();
    await t.ctx.db.updateTable('monitors').set({ created_at: new Date(Date.now() - 3_600_000) }).where('id', '=', m.id).execute();
    expect((await round())?.errorKind).toBe('missed');
    expect(await status()).toBe('pending');
    await round();
    expect(await status()).toBe('down');
  });
});

describe('second review round', () => {
  it('a duplicate value is a 409 without database details', async () => {
    const r1 = await c.post('/api/users', { username: 'dup-a', password: 'long-password-123', role: 'viewer', email: 'dup@example.com' });
    expect(r1.status).toBe(200);
    const r = await c.post('/api/users', { username: 'dup-b', password: 'long-password-123', role: 'viewer', email: 'dup@example.com' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.json)).not.toMatch(/ER_|uq_|pw_it_/);
  });

  it('webhook JSON templates escape quotes and line breaks in values', async () => {
    const { render } = await import('../../src/server/notify/channels');
    const out = render('{"text":"{{text}}"}', { text: 'Keyword "ok" not found\nsecond line' }, (v) => JSON.stringify(v).slice(1, -1));
    expect(JSON.parse(out).text).toBe('Keyword "ok" not found\nsecond line');
  });

  it('passkeys are refused for single sign-on accounts', async () => {
    const u = (await c.post('/api/users', { username: 'sso-user', password: 'long-password-123', role: 'viewer' })).json;
    await t.ctx.db.updateTable('users').set({ auth_source: 'oidc', password_hash: null }).where('id', '=', u.id).execute();
    const x = t.client();
    await t.ctx.db.updateTable('users').set({ auth_source: 'local' }).where('id', '=', u.id).execute(); // sign in once with a password ...
    await t.ctx.db.updateTable('users').set({ password_hash: (await t.ctx.db.selectFrom('users').select('password_hash').where('username', '=', 'dup-a').executeTakeFirstOrThrow()).password_hash }).where('id', '=', u.id).execute();
    expect((await x.post('/api/auth/login', { username: 'sso-user', password: 'long-password-123' })).status).toBe(200);
    await t.ctx.db.updateTable('users').set({ auth_source: 'oidc' }).where('id', '=', u.id).execute(); // ... then it is an SSO account
    expect((await x.post('/api/auth/passkeys/register/options', {})).status).toBe(400);
  });
});
