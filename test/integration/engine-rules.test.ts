// Engine rules: maintenance exact at check time and announced once, dependency suppression, retries of multi-location
// monitors without fresh results, and the attempt counter beyond 255.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let loadMonitor: typeof import('../../src/server/monitors/service').loadMonitor;

beforeAll(async () => {
  t = await startApp();
  c = await loggedInAdmin(t);
  ({ loadMonitor } = await import('../../src/server/monitors/service'));
});
afterAll(async () => { t?.ctx.maintenance.stop(); await t?.close(); });

const db = () => t.ctx.db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mkPush = async (name: string, extra: object = {}) => (await c.post('/api/monitors', { name, type: 'push', config: {}, intervalS: 60, timeoutS: 10, ...extra })).json as { id: number; pushToken: string };
const push = (token: string) => t.client().get(`/api/push/${token}`);
const fail = async (id: number) => t.ctx.engine.record((await loadMonitor(t.ctx, id))!, { ok: false, errorKind: 'refused', message: 'refused' }, { advance: false });
const state = (id: number) => db().selectFrom('monitor_state').select(['status', 'overlay', 'fail_since']).where('monitor_id', '=', id).executeTakeFirstOrThrow();
const lastBeat = async (id: number) => (await db().selectFrom('heartbeats').select('status').where('monitor_id', '=', id).where('location_id', '=', 0).orderBy('id', 'desc').executeTakeFirstOrThrow()).status;
const eventsOf = async (id: number, type: string) => (await db().selectFrom('events').select('id').where('monitor_id', '=', id).where('type', '=', type).execute()).length;

describe('maintenance', () => {
  it('takes effect exactly at its start, without waiting for the next refresh', async () => {
    const m = await mkPush('maint-exact');
    await push(m.pushToken);
    const start = new Date(Date.now() + 1500), end = new Date(Date.now() + 3_600_000);
    const w = await c.post('/api/maintenance', { name: 'patch', kind: 'once', startsAt: start.toISOString(), endsAt: end.toISOString(), targets: [{ type: 'monitor', id: m.id }] });
    expect(w.status).toBe(200);
    const mt = t.ctx.maintenance;
    expect(mt.isActive(m.id, new Date(start.getTime() - 1))).toBe(false);
    expect(mt.isActive(m.id, start)).toBe(true);
    expect(mt.isActive(m.id, new Date(end.getTime() - 1))).toBe(true);
    expect(mt.isActive(m.id, end)).toBe(false);
    expect(mt.isActive(m.id)).toBe(false);
    await sleep(start.getTime() - Date.now() + 20);
    await fail(m.id); // the window began after the last refresh; the failure is still maintenance, not an outage
    expect(await state(m.id)).toMatchObject({ status: 'up', overlay: 'maintenance' });
    expect(await lastBeat(m.id)).toBe(3);
    expect(await eventsOf(m.id, 'status_change')).toBe(0);
  });

  it('start and end are announced once, however many processes watch the windows', async () => {
    const { Maintenance } = await import('../../src/server/engine/maintenance');
    const m = await mkPush('maint-once');
    const w = (await c.post('/api/maintenance', { name: 'shared', kind: 'once', startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), targets: [{ type: 'monitor', id: m.id }] })).json;
    const api = new Maintenance(t.ctx), worker = new Maintenance(t.ctx), worker2 = new Maintenance(t.ctx);
    try {
      await Promise.all([api.refresh(), worker.refresh(), worker2.refresh(), t.ctx.maintenance.refresh()]);
      await Promise.all([api.refresh(), worker.refresh()]);
      expect(await eventsOf(m.id, 'maintenance_start')).toBe(1);
      expect(api.isActive(m.id) && worker.isActive(m.id)).toBe(true);
      await db().updateTable('maintenance_windows').set({ ends_at: new Date(Date.now() - 1000) }).where('id', '=', w.id).execute();
      await Promise.all([api.refresh(), worker.refresh(), worker2.refresh(), t.ctx.maintenance.refresh()]);
      expect(await eventsOf(m.id, 'maintenance_end')).toBe(1);
      expect(await eventsOf(m.id, 'maintenance_start')).toBe(1);
    } finally { api.stop(); worker.stop(); worker2.stop(); }
  });

  it('a cron window in its own time zone puts the monitor into maintenance (DST rules: see the unit tests)', async () => {
    const m = await mkPush('maint-cron');
    await push(m.pushToken);
    const w = await c.post('/api/maintenance', { name: 'always', kind: 'cron', cronExpr: '* * * * *', durationMin: 2, timezone: 'Asia/Tokyo', targets: [{ type: 'monitor', id: m.id }] });
    expect(w.status).toBe(200);
    expect(t.ctx.maintenance.isActive(m.id)).toBe(true);
    expect(t.ctx.maintenance.activeWindows().find((x) => x.name === 'always')?.endsAt.getTime()).toBeGreaterThan(Date.now());
    await fail(m.id);
    expect(await lastBeat(m.id)).toBe(3);
    await c.del(`/api/maintenance/${w.json.id}`);
  });
});

describe('dependencies', () => {
  it('a child is suppressed while its parent is down, pending, or inside a failure streak', async () => {
    const parent = await mkPush('dep-parent', { retries: 2 });
    await push(parent.pushToken);
    const child = await mkPush('dep-child', { retries: 0, dependsOn: [parent.id] });
    await push(child.pushToken);

    await fail(parent.id);
    expect((await state(parent.id)).status).toBe('pending');
    await fail(child.id);
    expect(await state(child.id)).toMatchObject({ status: 'up', overlay: 'suppressed' });
    expect(await lastBeat(child.id)).toBe(4);

    // parent counted as up, but its failure streak is running (e.g. it failed during maintenance)
    await db().updateTable('monitor_state').set({ status: 'up', fail_since: new Date() }).where('monitor_id', '=', parent.id).execute();
    await fail(child.id);
    expect((await state(child.id)).overlay).toBe('suppressed');

    // parent healthy: the child's own failure counts
    await db().updateTable('monitor_state').set({ status: 'up', fail_since: null, overlay: 'none' }).where('monitor_id', '=', parent.id).execute();
    await fail(child.id);
    expect(await state(child.id)).toMatchObject({ status: 'down', overlay: 'none' });
    expect(await eventsOf(child.id, 'status_change')).toBe(1);
  });
});

describe('retries of a multi-location monitor', () => {
  it('count only results that arrived after the previous attempt and wait for them without using up an attempt', async () => {
    const p = (await c.post('/api/probes', { name: 'site-a' })).json as { id: number; token: string };
    const probe = t.client({ bearer: p.token });
    const report = async (ok: boolean) => { await sleep(5); await probe.post('/api/probe/v1/results', { results: [{ monitorId: m.id, ok, ...(ok ? {} : { errorKind: 'refused', message: 'refused' }) }] }); };
    const m = (await c.post('/api/monitors', { name: 'probe-retry', type: 'tcp', config: { host: '127.0.0.1', port: 9 }, intervalS: 60, timeoutS: 5, retries: 2, retryIntervalS: 20, locations: [p.id], quorum: 1 })).json as { id: number };
    const round = async () => {
      await db().updateTable('monitors').set({ lease_owner: t.ctx.instanceId }).where('id', '=', m.id).execute();
      const mon = (await loadMonitor(t.ctx, m.id))!;
      return t.ctx.engine.runRound(mon, { advance: true, scheduledFor: mon.nextRunAt ?? undefined });
    };
    const attempt = async () => (await db().selectFrom('monitors').select(['attempt', 'next_run_at']).where('id', '=', m.id).executeTakeFirstOrThrow());

    await report(true);
    await round();
    expect((await state(m.id)).status).toBe('up');
    await report(false);
    await round();
    expect([(await state(m.id)).status, (await attempt()).attempt]).toEqual(['pending', 1]);

    // retry due, but the probe has not measured again: postponed, the attempt is not used up
    expect(await round()).toBeNull();
    const a = await attempt();
    expect([(await state(m.id)).status, a.attempt]).toEqual(['pending', 1]);
    expect(a.next_run_at!.getTime() - Date.now()).toBeLessThan(15_000);
    expect(await round()).toBeNull();
    expect((await attempt()).attempt).toBe(1);

    await report(false);
    await round();
    expect((await attempt()).attempt).toBe(2);
    await report(false);
    await round();
    expect((await state(m.id)).status).toBe('down'); // three real measurements: first failure + 2 retries

    // recovery: a fresh ok result counts at once
    await report(true);
    await round();
    expect((await state(m.id)).status).toBe('up');
  });

  it('a probe that never reports again does not hold the retry forever', async () => {
    const p = (await c.post('/api/probes', { name: 'site-c' })).json as { id: number; token: string };
    const m = (await c.post('/api/monitors', { name: 'probe-silent', type: 'tcp', config: { host: '127.0.0.1', port: 9 }, intervalS: 60, timeoutS: 5, retries: 1, retryIntervalS: 20, locations: [p.id], quorum: 1 })).json as { id: number };
    await t.client({ bearer: p.token }).post('/api/probe/v1/results', { results: [{ monitorId: m.id, ok: false, errorKind: 'refused' }] });
    const round = async () => {
      await db().updateTable('monitors').set({ lease_owner: t.ctx.instanceId }).where('id', '=', m.id).execute();
      const mon = (await loadMonitor(t.ctx, m.id))!;
      return t.ctx.engine.runRound(mon, { advance: true, scheduledFor: mon.nextRunAt ?? undefined });
    };
    await round();
    expect((await state(m.id)).status).toBe('pending');
    expect(await round()).toBeNull();
    // about one interval later the last result is used after all
    await db().updateTable('monitor_state').set({ last_check_at: new Date(Date.now() - 120_000) }).where('monitor_id', '=', m.id).execute();
    await db().updateTable('monitor_location_state').set({ ts: new Date(Date.now() - 125_000) }).where('monitor_id', '=', m.id).execute();
    expect((await round())?.ok).toBe(false);
    expect((await state(m.id)).status).toBe('down');
  });
});

describe('attempt counter', () => {
  it('goes past 255 (long down delay, short retry interval)', async () => {
    const col = await db().selectFrom('information_schema.COLUMNS' as any).select('DATA_TYPE as t' as any).where('TABLE_SCHEMA' as any, '=', t.dbName).where('TABLE_NAME' as any, '=', 'monitors').where('COLUMN_NAME' as any, '=', 'attempt').executeTakeFirstOrThrow() as { t: string };
    expect(col.t).toBe('smallint');
    const m = await mkPush('long-delay', { retries: 0, retryIntervalS: 5, downAfterS: 86_400 });
    await push(m.pushToken);
    await fail(m.id);
    await db().updateTable('monitors').set({ attempt: 300 }).where('id', '=', m.id).execute();
    await fail(m.id);
    expect((await db().selectFrom('monitors').select('attempt').where('id', '=', m.id).executeTakeFirstOrThrow()).attempt).toBe(301);
    expect((await state(m.id)).status).toBe('pending');
  });
});
