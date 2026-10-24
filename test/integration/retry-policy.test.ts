import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let loadMonitor: typeof import('../../src/server/monitors/service').loadMonitor; // imported after the harness has set the environment
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); ({ loadMonitor } = await import('../../src/server/monitors/service')); });
afterAll(async () => { await t?.close(); });

const monitor = async (name: string, extra: object = {}) => (await c.post('/api/monitors', { name, type: 'push', config: {}, ...extra })).json.id as number;
const stateOf = async (id: number) => (await t.ctx.db.selectFrom('monitor_state').select(['status', 'consecutive_fail']).where('monitor_id', '=', id).executeTakeFirstOrThrow());
/** Feed the engine one failed check with the given error kind, the way the scheduler would. */
const fail = async (id: number, errorKind: string) => t.ctx.engine.record((await loadMonitor(t.ctx, id))!, { ok: false, errorKind: errorKind as any, message: errorKind }, { advance: false });
const ok = async (id: number) => t.ctx.engine.record((await loadMonitor(t.ctx, id))!, { ok: true, latencyMs: 5 }, { advance: false });

describe('retries like Uptime Kuma', () => {
  it('starts a new monitor with Kuma timing: timeout 80% of the interval, retry as often as a check', async () => {
    const id = await monitor('rp-defaults');
    expect((await c.get(`/api/monitors/${id}`)).json).toMatchObject({ intervalS: 60, timeoutS: 48, retries: 0, retryIntervalS: 60 });
    // a short interval cannot be combined with the long default timeout: it follows the interval
    const quick = await monitor('rp-quick', { intervalS: 10 });
    expect((await c.get(`/api/monitors/${quick}`)).json.timeoutS).toBe(8);
    expect((await c.get(`/api/monitors/${await monitor('rp-explicit', { intervalS: 10, timeoutS: 9 })}`)).json.timeoutS).toBe(9); // an explicit value is kept
  });

  it('validates the retries and carries them over to a copy', async () => {
    const id = await monitor('rp-api', { retries: 100 });
    expect((await c.get(`/api/monitors/${id}`)).json.retries).toBe(100);
    expect((await c.put(`/api/monitors/${id}`, { retries: 101 })).status).toBe(400);
    expect((await c.post(`/api/monitors/${id}/clone`)).json.retries).toBe(100);
  });

  it('goes down after the retries are used up, whatever the failure was, and waits the retry interval in between', async () => {
    const id = await monitor('rp-engine', { retries: 2, retryIntervalS: 30 });
    await ok(id);
    await fail(id, 'timeout');
    expect((await stateOf(id)).status).toBe('pending');
    const beat = await t.ctx.db.selectFrom('heartbeats').select('message').where('monitor_id', '=', id).orderBy('ts', 'desc').executeTakeFirstOrThrow();
    expect(beat.message).toBe('Failed, retry 1 of 2 follows in 30s: timeout'); // the check list shows where the round of retries stands
    const next = (await t.ctx.db.selectFrom('monitors').select('next_run_at').where('id', '=', id).executeTakeFirstOrThrow()).next_run_at!.getTime() - Date.now();
    expect(next).toBeGreaterThan(15_000); expect(next).toBeLessThan(45_000); // the retry interval, not the regular one
    await fail(id, 'refused');
    expect((await stateOf(id)).status).toBe('pending'); // a timeout and an unreachable host are retried alike
    await fail(id, 'http_status');
    expect((await stateOf(id)).status).toBe('down'); // first failure + 2 retries
    await ok(id);
    expect((await stateOf(id)).status).toBe('up');
  });
});

describe('defaults', () => {
  it('keep the timeout within 80% of the interval', async () => {
    const body = (timeoutS: number) => ({ intervalS: 60, timeoutS, retries: 0, retryIntervalS: 60, upThreshold: 1, flapWindow: 10, flapThreshold: 6 });
    expect((await c.put('/api/settings/monitor-defaults', body(49))).status).toBe(400);
    expect((await c.put('/api/settings/monitor-defaults', body(48))).status).toBe(200);
    expect((await c.del('/api/settings/monitor-defaults')).status).toBe(200);
    expect((await c.get('/api/settings/monitor-defaults')).json.defaults).toMatchObject({ timeoutS: 48, retryIntervalS: 60 });
  });
});

describe('settings saved before retries worked like Uptime Kuma', () => {
  it('keep their timing: the failure threshold folds into the retries', async () => {
    const { monitorDefaults, retriesFromThreshold } = await import('../../src/server/monitors/defaults');
    expect([retriesFromThreshold(0, 1), retriesFromThreshold(0, 3), retriesFromThreshold(2, 2), retriesFromThreshold(20, 20)]).toEqual([0, 2, 5, 100]);
    await t.ctx.settings.set('monitor.defaults', { retries: 1, downThreshold: 3, retryIntervalS: 25 });
    expect(await monitorDefaults(t.ctx)).toMatchObject({ retries: 5, retryIntervalS: 25 });
    expect((await c.del('/api/settings/monitor-defaults')).status).toBe(200);
  });

  it('are imported from an old export, and a new export carries the retries', async () => {
    const old = { version: 1, monitors: [{ name: 'rp-old-export', type: 'push', config: {}, retries: 1, downThreshold: 2 }] };
    const rep = (await c.post('/api/config/import', { content: JSON.stringify(old) })).json;
    expect(rep.errors).toEqual([]);
    const row = (await c.get('/api/monitors')).json.find((m: any) => m.name === 'rp-old-export');
    expect((await c.get(`/api/monitors/${row.id}`)).json.retries).toBe(3); // 2 rounds of 1 retry each: 4 failed checks, i.e. 3 retries
    await monitor('rp-export', { retries: 4 });
    const exported = JSON.parse((await c.get('/api/config/export?format=json')).body).monitors.find((m: any) => m.name === 'rp-export');
    expect(exported).toMatchObject({ retries: 4 });
    expect(exported.downThreshold).toBeUndefined();
    expect(exported.retryOn).toBeUndefined();
  });
});
