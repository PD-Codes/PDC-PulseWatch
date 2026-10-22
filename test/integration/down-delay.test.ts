import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); });
afterAll(async () => { await t?.close(); });

const mk = async (name: string, extra: object = {}) => (await c.post('/api/monitors', { name, type: 'push', config: {}, intervalS: 60, timeoutS: 10, ...extra })).json as { id: number; pushToken: string };
const ping = (token: string, ok: boolean) => t.client().get(`/api/push/${token}${ok ? '' : '?status=down&msg=restarting'}`);
const status = async (id: number) => (await c.get(`/api/monitors/${id}`)).json.status as string;

describe('down delay rule', () => {
  it('holds back the outage for the monitor\'s own delay and never opens an incident for a short blip', async () => {
    const m = await mk('delayed', { downAfterS: 300 });
    expect((await c.get(`/api/monitors/${m.id}`)).json.downAfterS).toBe(300);
    await ping(m.pushToken, true);
    await ping(m.pushToken, false);
    expect(await status(m.id)).toBe('pending');
    await ping(m.pushToken, true); // back inside the window
    expect(await status(m.id)).toBe('up');
    expect(await t.ctx.db.selectFrom('incidents').select('id').where('monitor_id', '=', m.id).execute()).toHaveLength(0);
  });

  it('goes down once the failure has lasted long enough', async () => {
    const m = await mk('overdue', { downAfterS: 60 });
    await ping(m.pushToken, true);
    await ping(m.pushToken, false);
    expect(await status(m.id)).toBe('pending');
    // pretend the streak started two minutes ago
    await t.ctx.db.updateTable('monitor_state').set({ fail_since: new Date(Date.now() - 120_000) }).where('monitor_id', '=', m.id).execute();
    await ping(m.pushToken, false);
    expect(await status(m.id)).toBe('down');
  });

  it('follows the instance-wide rule unless the monitor has its own value, and rejects bad values', async () => {
    const own = await mk('own-zero', { downAfterS: 0 });
    const inherit = await mk('inherits');
    expect((await c.put('/api/settings/monitor-defaults', { intervalS: 60, timeoutS: 10, retries: 0, retryIntervalS: 20, upThreshold: 1, downThreshold: 1, flapWindow: 10, flapThreshold: 6, downAfterS: 600 })).status).toBe(200);
    expect((await c.get(`/api/monitors/${inherit.id}`)).json.downAfterS).toBeNull();
    for (const m of [own, inherit]) { await ping(m.pushToken, true); await ping(m.pushToken, false); }
    expect(await status(own.id)).toBe('down'); // its own 0 wins
    expect(await status(inherit.id)).toBe('pending'); // the global 600 s applies live
    expect((await c.post('/api/monitors', { name: 'bad', type: 'push', config: {}, downAfterS: 999999 })).status).toBe(400);
    expect((await c.del('/api/settings/monitor-defaults')).status).toBe(200); // the later tests expect immediate outages
  });
});

describe('hiding a component\'s incidents on a status page', () => {
  it('keeps resolved incidents of a flagged component out of the past list, open ones stay', async () => {
    const quiet = await mk('quiet'); const loud = await mk('loud');
    for (const m of [quiet, loud]) { await ping(m.pushToken, true); await ping(m.pushToken, false); await ping(m.pushToken, true); }
    const page = await c.post('/api/status-pages', { slug: 'hide', title: 'Hide', isPublic: true, sections: [], components: [{ monitorId: quiet.id, hideIncidents: true }, { monitorId: loud.id }] });
    expect(page.status).toBe(200);
    expect(page.json.components.map((x: any) => x.hideIncidents)).toEqual([true, false]);
    const pub = (await t.client().get('/api/public/status/hide')).json;
    expect(pub.recentIncidents.map((i: any) => i.title)).toEqual(['loud is down']);
    await ping(quiet.pushToken, false); // a new outage is still announced while it is open
    expect((await t.client().get('/api/public/status/hide')).json.incidents.map((i: any) => i.title)).toEqual(['quiet is down']);
  });
});
