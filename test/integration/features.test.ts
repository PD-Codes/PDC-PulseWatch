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

describe('default status page', () => {
  it('is exclusive, public-only, switchable and survives export/import', async () => {
    const mk = async (slug: string, extra: object = {}) => (await c.post('/api/status-pages', { slug, title: slug, isPublic: true, sections: [], ...extra })).json.id as number;
    const a = await mk('home-a');
    const b = await mk('home-b');
    const home = async () => (await t.client().get('/api/public/default-page')).json.slug;
    expect(await home()).toBeNull();
    expect((await c.put(`/api/status-pages/${a}/default`, { isDefault: true })).status).toBe(200);
    expect(await home()).toBe('home-a');
    expect((await c.put(`/api/status-pages/${b}/default`, { isDefault: true })).status).toBe(200);
    expect(await home()).toBe('home-b');
    expect(((await c.get('/api/status-pages')).json as any[]).filter((p) => p.isDefault).map((p) => p.slug)).toEqual(['home-b']);
    const exp = JSON.parse((await c.get('/api/config/export?format=json')).body);
    expect(exp.statusPages.find((p: any) => p.slug === 'home-b').isDefault).toBe(true);
    expect((await c.put('/api/status-pages/999999/default', { isDefault: true })).status).toBe(404);
    expect((await c.put(`/api/status-pages/${b}/default`, { isDefault: false })).status).toBe(200);
    expect(await home()).toBeNull();
    // a hidden page never becomes the public home page
    const hidden = await mk('home-hidden', { isDefault: true, isPublic: false });
    expect(hidden).toBeGreaterThan(0);
    expect(await home()).toBeNull();
  });
});

describe('monitor detail windows and paging', () => {
  it('serves 15 minute ranges, custom windows and paged check lists', async () => {
    const m = await push('window-push');
    const token = (await c.get(`/api/monitors/${m.json.id}`)).json.pushToken;
    for (let i = 0; i < 7; i++) expect((await t.client().get(`/api/push/${token}?status=down&msg=boom${i}`)).status).toBe(200);
    const chart = (qs: string) => c.get(`/api/monitors/${m.json.id}/chart${qs}`);
    expect((await chart('?range=15m')).json).toMatchObject({ range: '15m', resolution: 'raw' });
    expect((await chart('?range=15m')).json.points.length).toBe(7);
    const from = new Date(Date.now() - 600_000).toISOString(), to = new Date().toISOString();
    expect((await chart(`?from=${from}&to=${to}`)).json).toMatchObject({ range: 'custom', resolution: 'raw' });
    expect((await chart(`?from=${new Date(Date.now() - 20 * 86_400_000).toISOString()}&to=${to}`)).json.resolution).toBe('hour');
    expect((await chart(`?from=${to}&to=${from}`)).status).toBe(400);
    expect((await chart(`?from=${new Date(Date.now() - 1000).toISOString()}&to=${to}`)).status).toBe(400); // under a minute
    // an outage that began before a short window still shows up as a period
    const periods = (await c.get(`/api/monitors/${m.json.id}/periods?range=15m`)).json as any[];
    expect(periods[0].status).toBe('down');
    // page numbers with a total instead of "load more"
    const p1 = (await c.get(`/api/monitors/${m.json.id}/heartbeats?page=1&pageSize=5`)).json;
    const p2 = (await c.get(`/api/monitors/${m.json.id}/heartbeats?page=2&pageSize=5`)).json;
    expect([p1.total, p1.items.length, p2.items.length]).toEqual([7, 5, 2]);
    expect(p1.items.map((r: any) => r.id).some((id: number) => p2.items.some((r: any) => r.id === id))).toBe(false);
    const ev = (await c.get(`/api/monitors/${m.json.id}/events?page=1&pageSize=5`)).json;
    expect(ev.total).toBeGreaterThan(0);
    expect(Array.isArray((await c.get(`/api/monitors/${m.json.id}/heartbeats?limit=3`)).json)).toBe(true); // the plain list still works
  });
});

describe('incident statuses', () => {
  it('walks through the phases, shows them on the status page and keeps "monitoring" open on recovery', async () => {
    const mon = await push('phase-push');
    const monitorId = mon.json.id as number;
    const other = await push('phase-other');
    const page = await c.post('/api/status-pages', { slug: 'phases', title: 'Phases', isPublic: true, sections: [{ name: 'Core', components: [{ monitorId }] }] });
    expect(page.status).toBe(200);
    const inc = await c.post('/api/incidents', { title: 'Phase test', monitorIds: [monitorId], public: true });
    const id = inc.json.id as number;
    const status = (s: string, message?: string) => c.post(`/api/incidents/${id}/status`, { status: s, message });
    const row = async () => (await c.get(`/api/incidents/${id}`)).json;

    expect((await status('identified', 'Found the broken disk')).status).toBe(200);
    let d = await row();
    expect([d.status, d.acknowledgedAt !== null, d.resolvedAt]).toEqual(['identified', true, null]); // any move off "open" counts as acknowledged
    expect((await status('identified')).status).toBe(409);
    expect((await c.get('/api/incidents?status=active')).json.some((i: any) => i.id === id)).toBe(true);
    expect((await c.post(`/api/incidents/${id}/ack`)).status).toBe(409);
    expect((await status('fixing', 'Replacing it')).status).toBe(200);
    expect((await c.post(`/api/incidents/${id}/status`, { status: 'bogus' })).status).toBe(400);

    // the public page carries the phase and the per-update status
    let pub = (await t.client().get('/api/public/status/phases')).json.incidents.find((i: any) => i.id === id);
    expect(pub.status).toBe('fixing');
    expect(pub.updates.map((u: any) => u.status)).toEqual(expect.arrayContaining(['identified', 'fixing']));

    // a recovering monitor resolves automatic incidents, except one a person moved to "monitoring"
    const auto = async (st: string) => Number((await t.ctx.db.insertInto('incidents').values({ title: `auto ${st}`, severity: 'major', source: 'auto', started_at: new Date(), status: st as any, monitor_id: monitorId }).executeTakeFirstOrThrow()).insertId);
    const [watched, fixing] = [await auto('monitoring'), await auto('fixing')];
    await t.ctx.incidents.resolveFor({ id: monitorId } as any);
    const st = async (i: number) => (await t.ctx.db.selectFrom('incidents').select('status').where('id', '=', i).executeTakeFirstOrThrow()).status;
    expect([await st(watched), await st(fixing)]).toEqual(['monitoring', 'resolved']);

    expect((await status('resolved')).status).toBe(200);
    d = await row();
    expect([d.status, d.resolvedAt !== null]).toEqual(['resolved', true]);
    expect((await status('open')).status).toBe(200); // reopening clears the end
    expect((await row()).resolvedAt).toBeNull();

    // a scope-restricted editor cannot touch incidents of monitors they do not manage
    expect((await c.post('/api/users', { username: 'scoped', password: 'correct-horse-battery-2', role: 'editor', scopeRestricted: true })).status).toBe(200);
    const ed = t.client(); await ed.post('/api/auth/login', { username: 'scoped', password: 'correct-horse-battery-2' });
    expect((await ed.post(`/api/incidents/${id}/status`, { status: 'fixing' })).status).toBe(403);
    expect((await ed.post('/api/incidents', { title: 'Nope', monitorIds: [other.json.id] })).status).toBe(403);
  });
});

describe('recent checks status filter', () => {
  it('filters by one or several statuses, counts the filtered rows and lists the statuses that exist', async () => {
    const id = (await push('hb-filter', { active: false })).json.id as number;
    const now = Date.now();
    const rows = [1, 1, 1, 0, 0, 3].map((status, i) => ({ monitor_id: id, location_id: 0, ts: new Date(now - i * 10_000), status, latency_ms: status === 1 ? 50 : null }));
    await t.ctx.db.insertInto('heartbeats').values(rows as any).execute();
    const list = async (qs = '') => (await c.get(`/api/monitors/${id}/heartbeats?page=1&pageSize=10${qs}`)).json as { total: number; statuses: number[]; items: { status: number }[] };
    const all = await list();
    expect([all.total, all.statuses]).toEqual([6, [0, 1, 3]]);
    const down = await list('&status=0');
    expect([down.total, down.items.map((x) => x.status)]).toEqual([2, [0, 0]]);
    const upAndMaint = await list('&status=1,3');
    expect([upAndMaint.total, upAndMaint.items.map((x) => x.status).sort()]).toEqual([4, [1, 1, 1, 3]]);
    expect((await list('&status=0')).statuses).toEqual([0, 1, 3]); // the options do not shrink with the filter
    expect((await c.get(`/api/monitors/${id}/heartbeats?page=1&status=abc`)).status).toBe(400);
  });
});

describe('past incidents on a status page', () => {
  it('limits them by age, can switch them off, and drops incidents an operator hid', async () => {
    const m = await push('pi-monitor', { active: false });
    const body = { slug: 'pi', title: 'Past incidents', isPublic: true, sections: [], components: [{ monitorId: m.json.id }] };
    const page = await c.post('/api/status-pages', body);
    const monitorId = m.json.id as number;
    const DAY = 86_400_000;
    const resolved = async (title: string, daysAgo: number) => {
      const at = new Date(Date.now() - daysAgo * DAY);
      const id = Number((await t.ctx.db.insertInto('incidents').values({ title, severity: 'major', source: 'manual', public: 1, started_at: at, resolved_at: new Date(at.getTime() + 60_000), status: 'resolved', monitor_id: monitorId }).executeTakeFirstOrThrow()).insertId);
      await t.ctx.db.insertInto('incident_monitors').values({ incident_id: id, monitor_id: monitorId }).execute();
      return id;
    };
    const fresh = await resolved('two days ago', 2), mid = await resolved('twenty days ago', 20);
    await resolved('forty days ago', 40);
    const open = Number((await t.ctx.db.insertInto('incidents').values({ title: 'still open', severity: 'major', source: 'manual', public: 1, started_at: new Date(), status: 'open', monitor_id: monitorId }).executeTakeFirstOrThrow()).insertId);
    await t.ctx.db.insertInto('incident_monitors').values({ incident_id: open, monitor_id: monitorId }).execute();

    const view = async () => (await t.client().get('/api/public/status/pi')).json as { incidentDays: number; incidentPageSize: number; incidents: { title: string }[]; recentIncidents: { title: string }[] };
    const titles = async () => (await view()).recentIncidents.map((x) => x.title);
    let v = await view();
    expect([v.incidentDays, v.incidentPageSize]).toEqual([30, 10]); // defaults
    expect(await titles()).toEqual(['two days ago', 'twenty days ago']);

    expect((await c.put(`/api/status-pages/${page.json.id}`, { ...body, incidentDays: 7, incidentPageSize: 5 })).status).toBe(200);
    v = await view();
    expect([v.incidentDays, v.incidentPageSize, await titles()]).toEqual([7, 5, ['two days ago']]);
    expect((await c.get(`/api/status-pages/${page.json.id}`)).json).toMatchObject({ incidentDays: 7, incidentPageSize: 5 });

    expect((await c.put(`/api/status-pages/${page.json.id}`, { ...body, incidentDays: 0 })).status).toBe(200);
    v = await view();
    expect([await titles(), v.incidents.map((x) => x.title)]).toEqual([[], ['still open']]); // ongoing incidents always show
    expect((await c.put(`/api/status-pages/${page.json.id}`, { ...body, incidentDays: 400 })).status).toBe(400);

    await c.put(`/api/status-pages/${page.json.id}`, { ...body, incidentDays: 30 });
    expect((await c.call('PATCH', `/api/incidents/${fresh}`, { hidden: true })).status).toBe(200);
    expect(await titles()).toEqual(['twenty days ago']);
    const rss = (await t.client().get('/api/public/status/pi/rss')).body;
    expect(rss).not.toContain('two days ago');
    expect(rss).toContain('twenty days ago');
    expect(((await c.get('/api/incidents')).json as { id: number; hidden: boolean }[]).find((x) => x.id === fresh)?.hidden).toBe(true); // still listed in the dashboard
    await c.call('PATCH', `/api/incidents/${fresh}`, { hidden: false });
    expect(await titles()).toEqual(['two days ago', 'twenty days ago']);
    expect(mid).toBeGreaterThan(0);
    const exported = JSON.parse((await c.get('/api/config/export?format=json')).body).statusPages.find((x: any) => x.slug === 'pi');
    expect([exported.incidentDays, exported.incidentPageSize]).toEqual([30, 5]); // the settings travel with export and import
  });
});
