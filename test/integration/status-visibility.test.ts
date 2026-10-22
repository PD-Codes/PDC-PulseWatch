import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let loadMonitor: typeof import('../../src/server/monitors/service').loadMonitor; // imported after the harness has set the environment
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); ({ loadMonitor } = await import('../../src/server/monitors/service')); });
afterAll(async () => { await t?.close(); });

const monitor = async (name: string, extra: object = {}) => (await c.post('/api/monitors', { name, type: 'push', config: {}, ...extra })).json.id as number;
const page = async (slug: string, monitorId: number, extra: object = {}) => {
  const body = { slug, title: slug, isPublic: true, sections: [], components: [{ monitorId }], ...extra };
  return { id: (await c.post('/api/status-pages', body)).json.id as number, body };
};
const view = async (slug: string) => (await t.client().get(`/api/public/status/${slug}`)).json as { language: string | null; incidents: { id: number; title: string; updates: { body: string | null; kind: string; edited: boolean }[] }[]; components: { info: any }[] };

describe('one visibility switch for incidents and their entries', () => {
  it('keeps incidents and notes internal until they are marked, and lets entries be edited afterwards', async () => {
    const m = await monitor('vis-monitor');
    await page('vis', m);
    const created = await c.post('/api/incidents', { title: 'Manual outage', monitorIds: [m], body: 'We are looking into it' });
    const id = created.json.id as number;
    expect((await c.get(`/api/incidents/${id}`)).json.public).toBe(false); // nothing is published by default
    expect((await view('vis')).incidents).toEqual([]);

    expect((await c.call('PATCH', `/api/incidents/${id}`, { public: true })).status).toBe(200);
    expect((await view('vis')).incidents.map((i) => i.title)).toEqual(['Manual outage']);

    // a plain note stays internal unless marked; a marked one shows
    await c.post(`/api/incidents/${id}/notes`, { body: 'internal: restart did not help' });
    await c.post(`/api/incidents/${id}/notes`, { body: 'We found the cause', public: true });
    const bodies = async () => (await view('vis')).incidents[0].updates.map((u) => u.body);
    expect(await bodies()).toEqual(['We found the cause', 'We are looking into it']);

    // edit the text and the visibility later; the entry is marked as edited
    const entries = (await c.get(`/api/incidents/${id}`)).json.updates as { id: number; body: string; public: boolean; editable: boolean; editedAt: string | null }[];
    const internal = entries.find((u) => u.body.startsWith('internal'))!;
    const shown = entries.find((u) => u.body === 'We found the cause')!;
    expect([internal.public, shown.public, internal.editable, internal.editedAt]).toEqual([false, true, true, null]);
    expect((await c.call('PATCH', `/api/incidents/${id}/updates/${internal.id}`, { body: 'Restarting did not help, investigating the database', public: true })).status).toBe(200);
    expect((await c.call('PATCH', `/api/incidents/${id}/updates/${shown.id}`, { public: false })).status).toBe(200);
    expect(await bodies()).toEqual(['Restarting did not help, investigating the database', 'We are looking into it']);
    expect((await view('vis')).incidents[0].updates[0].edited).toBe(true);
    expect(((await c.get(`/api/incidents/${id}`)).json.updates as any[]).find((u) => u.id === internal.id).editedAt).not.toBeNull();

    // the system's own entries and unknown ids cannot be edited
    const inc = await loadMonitor(t.ctx, m);
    await t.ctx.incidents.openFor(inc!, { ok: false, message: 'connection refused' });
    const auto = (await c.get('/api/incidents')).json.find((x: any) => x.source === 'auto');
    const sys = (await c.get(`/api/incidents/${auto.id}`)).json.updates[0];
    expect(sys.editable).toBe(false);
    expect((await c.call('PATCH', `/api/incidents/${auto.id}/updates/${sys.id}`, { body: 'x' })).status).toBe(409);
    expect((await c.call('PATCH', `/api/incidents/${id}/updates/${sys.id}`, { body: 'x' })).status).toBe(404); // an entry of another incident
  });

  it('shows detected incidents only when an admin turned that on', async () => {
    const off = await monitor('auto-off'), on = await monitor('auto-on');
    await page('auto-pg', off, { components: [{ monitorId: off }, { monitorId: on }], language: 'de' });
    const down = { ok: false as const, message: 'connection refused' };
    expect((await c.get('/api/settings/incidents')).json).toEqual({ autoPublish: false });
    await t.ctx.incidents.openFor((await loadMonitor(t.ctx, off))!, down);
    expect((await view('auto-pg')).incidents).toEqual([]);

    expect((await c.put('/api/settings/incidents', { autoPublish: true })).status).toBe(200);
    await t.ctx.incidents.openFor((await loadMonitor(t.ctx, on))!, down);
    expect((await view('auto-pg')).incidents.map((i) => i.title)).toEqual(['auto-on ist nicht erreichbar']); // titled in the page's language
    expect((await c.put('/api/settings/incidents', { autoPublish: false })).status).toBe(200);
  });
});

describe('language of a status page', () => {
  it('is stored per page, validated, and follows the page into feeds and the password gate', async () => {
    const m = await monitor('lang-monitor');
    const { id, body } = await page('lang', m);
    expect((await view('lang')).language).toBeNull(); // visitors choose
    expect((await c.put(`/api/status-pages/${id}`, { ...body, language: 'fr' })).status).toBe(400);
    expect((await c.put(`/api/status-pages/${id}`, { ...body, language: 'de' })).status).toBe(200);
    expect((await view('lang')).language).toBe('de');
    expect((await c.get(`/api/status-pages/${id}`)).json.language).toBe('de');

    await c.put(`/api/status-pages/${id}`, { ...body, language: 'de', password: 'secret-pass' });
    const locked = await t.client().get('/api/public/status/lang');
    expect([locked.status, locked.json.language]).toEqual([401, 'de']); // the password form already speaks German
    await c.put(`/api/status-pages/${id}`, { ...body, language: null, password: null });
    expect((await view('lang')).language).toBeNull();
    const exported = JSON.parse((await c.get('/api/config/export?format=json')).body).statusPages.find((x: any) => x.slug === 'lang');
    expect([exported.language, exported.serverInfo]).toEqual([null, 1]);
  });
});

describe('game server details', () => {
  it('stores what the check reports and shows as much of it on a status page as the page allows', async () => {
    const m = await monitor('mc', { type: 'minecraft', config: { host: '127.0.0.1', port: 25565 }, active: false });
    const { id, body } = await page('mcpage', m);
    const mon = (await loadMonitor(t.ctx, m))!;
    await t.ctx.engine.record(mon, { ok: true, latencyMs: 12, details: { online: 7, max: 50, version: '1.21.1', motd: 'Hello', names: ['Steve', 'Alex'], secret: 'never stored' } }, { advance: false });
    const listed = ((await c.get('/api/monitors')).json as any[]).find((x) => x.id === m);
    expect(listed.info).toEqual({ players: 7, maxPlayers: 50, names: ['Steve', 'Alex'], version: '1.21.1', motd: 'Hello' });

    expect((await view('mcpage')).components[0].info).toEqual({ players: 7, maxPlayers: 50, version: '1.21.1', motd: 'Hello' }); // default: no names
    await c.put(`/api/status-pages/${id}`, { ...body, serverInfo: 2 });
    expect((await view('mcpage')).components[0].info.names).toEqual(['Steve', 'Alex']);
    await c.put(`/api/status-pages/${id}`, { ...body, serverInfo: 0 });
    expect((await view('mcpage')).components[0].info).toBeNull();

    await t.ctx.engine.record(mon, { ok: false, errorKind: 'network', message: 'down' }, { advance: false });
    expect(((await c.get('/api/monitors')).json as any[]).find((x) => x.id === m).info).toBeNull(); // players are unknown while the server is down
  });
});
