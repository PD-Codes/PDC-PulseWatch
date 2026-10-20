import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); });
afterAll(async () => { await t?.close(); });

const push = (name: string, extra: object = {}) => c.post('/api/monitors', { name, type: 'push', config: {}, ...extra });

describe('monitor defaults', () => {
  it('apply to new monitors when the request omits values, and can be reset', async () => {
    expect((await c.put('/api/settings/monitor-defaults', { intervalS: 120, timeoutS: 20, retries: 2, retryIntervalS: 30, upThreshold: 2, downThreshold: 3, flapWindow: 12, flapThreshold: 5 })).status).toBe(200);
    const m = await push('defaults-push');
    const d = (await c.get(`/api/monitors/${m.json.id}`)).json;
    expect([d.intervalS, d.timeoutS, d.retries, d.downThreshold]).toEqual([120, 20, 2, 3]);
    const explicit = await push('explicit-push', { intervalS: 45, timeoutS: 5 });
    expect((await c.get(`/api/monitors/${explicit.json.id}`)).json.intervalS).toBe(45);
    expect((await c.put('/api/settings/monitor-defaults', { intervalS: 10, timeoutS: 20, retries: 0, retryIntervalS: 20, upThreshold: 1, downThreshold: 1, flapWindow: 10, flapThreshold: 6 })).status).toBe(400); // timeout > interval
    expect((await c.del('/api/settings/monitor-defaults')).status).toBe(200);
    expect((await c.get('/api/settings/monitor-defaults')).json.defaults.intervalS).toBe(60);
  });
});

describe('bulk create and bulk edit', () => {
  it('creates monitors from name/address pairs, skipping duplicates and reporting bad lines', async () => {
    const g = await c.post('/api/groups', { name: 'Websites' });
    const r = await c.post('/api/monitors/bulk-create', {
      type: 'http', addressKey: 'url', skipExisting: true, template: { groupId: g.json.id, intervalS: 90, timeoutS: 10 },
      items: [{ name: 'Site A', address: 'https://a.example.com' }, { name: 'Site B', address: 'https://b.example.com' }, { name: 'site a', address: 'https://dup.example.com' }, { name: 'Broken', address: '   ' }],
    });
    expect(r.status).toBe(200);
    expect(r.json.created.map((x: any) => x.index)).toEqual([0, 1]);
    expect(r.json.skipped.map((x: any) => x.index)).toEqual([2]);
    expect(r.json.failed.map((x: any) => x.index)).toEqual([3]);
    const a = (await c.get(`/api/monitors/${r.json.created[0].id}`)).json;
    expect([a.groupId, a.intervalS, a.config.url]).toEqual([g.json.id, 90, 'https://a.example.com']);
    expect((await c.post('/api/monitors/bulk-create', { type: 'http', addressKey: 'timeout_nope', template: {}, items: [{ name: 'x', address: 'y' }] })).status).toBe(400);
  });

  it('patches timings, tags and notification rules on many monitors at once', async () => {
    const ids = [(await push('bulk-1')).json.id, (await push('bulk-2')).json.id];
    const tag = await c.post('/api/tags', { name: 'bulk-tag', color: '#059669' });
    const ch = await c.post('/api/notification-channels', { name: 'hook', type: 'webhook', config: { url: 'https://hooks.example.com/x' } });
    const r = await c.post('/api/monitors/bulk', { ids, action: 'patch', patch: { intervalS: 300, downThreshold: 4, addTagIds: [tag.json.id], notifications: { mode: 'replace', rules: [{ channelId: ch.json.id, events: ['down'] }] } } });
    expect(r.json.affected).toBe(2);
    for (const id of ids) {
      const d = (await c.get(`/api/monitors/${id}`)).json;
      expect([d.intervalS, d.downThreshold, d.tags.length, d.notifications.length]).toEqual([300, 4, 1, 1]);
    }
  });
});

describe('explicit null ids', () => {
  it('are kept as null (no coercion to 0) when creating groups and clearing a monitor group', async () => {
    const g = await c.post('/api/groups', { name: 'null-parent', parentId: null });
    expect(g.status).toBe(200);
    const m = await push('in-group', { groupId: g.json.id });
    const r = await c.post('/api/monitors/bulk', { ids: [m.json.id], action: 'patch', patch: { groupId: null } });
    expect(r.status).toBe(200);
    expect((await c.get(`/api/monitors/${m.json.id}`)).json.groupId).toBeNull();
  });
});

describe('open incident count', () => {
  it('counts only open incidents and drops acknowledged ones', async () => {
    const before = (await c.get('/api/incidents/open-count')).json.count;
    const inc = await c.post('/api/incidents', { title: 'Manual outage' });
    expect((await c.get('/api/incidents/open-count')).json.count).toBe(before + 1);
    await c.post(`/api/incidents/${inc.json.id}/ack`);
    expect((await c.get('/api/incidents/open-count')).json.count).toBe(before);
  });
});

describe('status page history length', () => {
  it('defaults to 90 days, honors the setting on the public page and survives export/import', async () => {
    const m = await push('sp-monitor');
    const body = { slug: 'hist', title: 'History', isPublic: true, sections: [], components: [{ monitorId: m.json.id }] };
    const created = await c.post('/api/status-pages', body);
    expect(created.status).toBe(200);
    const pub = async () => (await t.client().get('/api/public/status/hist')).json;
    expect((await pub()).historyDays).toBe(90);
    expect((await pub()).components[0].daily).toHaveLength(90);
    expect((await c.put(`/api/status-pages/${created.json.id}`, { ...body, historyDays: 30 })).status).toBe(200);
    expect((await pub()).components[0].daily).toHaveLength(30);
    expect((await c.put(`/api/status-pages/${created.json.id}`, { ...body, historyDays: 45 })).status).toBe(400);
    const exp = await c.get('/api/config/export?format=json');
    expect(JSON.parse(exp.body).statusPages.find((p: any) => p.slug === 'hist').historyDays).toBe(30);
  });
});
