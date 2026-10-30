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
