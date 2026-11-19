// Scheduler with two instances on one database: SKIP LOCKED claims, lease expiry and take-over, lease release on stop,
// plus spreading of rounds after a stall or an interval change and the reset of a failure streak after a pause.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';
import type { Ctx } from '../../src/server/context';
import type { Scheduler } from '../../src/server/engine/scheduler';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let other: Ctx;
let A: Scheduler, B: Scheduler;
let parseMonitor: typeof import('../../src/server/monitors/model').parseMonitor;

beforeAll(async () => {
  t = await startApp();
  c = await loggedInAdmin(t);
  ({ parseMonitor } = await import('../../src/server/monitors/model'));
  const { createServices } = await import('../../src/server/services');
  const { Scheduler } = await import('../../src/server/engine/scheduler');
  other = createServices();
  A = new Scheduler(t.ctx);
  B = new Scheduler(other);
});
afterAll(async () => { await other?.db.destroy(); await t?.close(); });

const db = () => t.ctx.db;
type Row = Awaited<ReturnType<Scheduler['claim']>>[number];
const claim = (s: Scheduler, n = 100): Promise<Row[]> => (s as any).claim(n);
const mkPush = async (name: string, extra: object = {}) => (await c.post('/api/monitors', { name, type: 'push', config: {}, intervalS: 60, timeoutS: 10, ...extra })).json as { id: number; pushToken: string };
/** Make exactly these monitors due (everything else is planned an hour ahead and unleased). */
const due = async (ids: number[], at = new Date(Date.now() - 1000)) => {
  await db().updateTable('monitors').set({ next_run_at: new Date(Date.now() + 3_600_000), lease_owner: null, lease_until: null }).where('id', 'not in', ids).execute();
  await db().updateTable('monitors').set({ next_run_at: at, lease_owner: null, lease_until: null }).where('id', 'in', ids).execute();
};
const beats = async (id: number) => (await db().selectFrom('heartbeats').select('id').where('monitor_id', '=', id).where('location_id', '=', 0).execute()).length;
const row = (id: number) => db().selectFrom('monitors').select(['next_run_at', 'lease_owner', 'lease_until', 'attempt']).where('id', '=', id).executeTakeFirstOrThrow();
const runAs = (ctx: Ctx, r: Row) => ctx.engine.runRound(parseMonitor(r), { advance: true, scheduledFor: r.next_run_at! });

describe('two scheduler instances', () => {
  it('claim disjoint sets of due monitors (SKIP LOCKED)', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) ids.push((await mkPush(`claim-${i}`)).id);
    await due(ids);
    const ia: number[] = [], ib: number[] = [];
    // concurrent ticks until everything is claimed; how the rows are split depends on InnoDB's locking, never overlapping
    for (let i = 0; i < 10 && ia.length + ib.length < 20; i++) {
      const [a, b] = await Promise.all([claim(A, 7), claim(B, 7)]);
      ia.push(...a.map((r) => r.id)); ib.push(...b.map((r) => r.id));
    }
    expect(ia.filter((id) => ib.includes(id))).toEqual([]);
    expect(new Set([...ia, ...ib]).size).toBe(ia.length + ib.length);
    expect([...ia, ...ib].sort((x, y) => x - y)).toEqual(ids);
    for (const id of ia) expect((await row(id)).lease_owner).toBe(t.ctx.instanceId);
    for (const id of ib) expect((await row(id)).lease_owner).toBe(other.instanceId);
    expect(await claim(B)).toEqual([]); // leased rows are not claimed again while the lease runs
  });

  it('a late round whose lease expired and was taken over is discarded', async () => {
    const m = await mkPush('take-over');
    await t.client().get(`/api/push/${m.pushToken}`);
    await due([m.id]);
    const [late] = await claim(A);
    expect(late.id).toBe(m.id);
    // A hangs past its lease; B takes the monitor over
    await db().updateTable('monitors').set({ lease_until: new Date(Date.now() - 1000) }).where('id', '=', m.id).execute();
    const [fresh] = await claim(B);
    expect(fresh.id).toBe(m.id);
    expect((await row(m.id)).lease_owner).toBe(other.instanceId);
    const b0 = await beats(m.id);
    // A finishes while B still holds the lease: discarded
    expect(await runAs(t.ctx, late)).toBeNull();
    expect(await beats(m.id)).toBe(b0);
    expect((await row(m.id)).lease_owner).toBe(other.instanceId);
    // B's round counts and plans the next one
    expect(await runAs(other, fresh)).not.toBeNull();
    const afterB = await row(m.id);
    expect(await beats(m.id)).toBe(b0 + 1);
    expect(afterB.lease_owner).toBeNull();
    expect(afterB.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    // A finishes once more after B released the lease: its slot was already handled, still discarded
    expect(await runAs(t.ctx, late)).toBeNull();
    expect(await beats(m.id)).toBe(b0 + 1);
    expect((await row(m.id)).next_run_at!.getTime()).toBe(afterB.next_run_at!.getTime());
  });

  it('a push failure during a running round does not move that round\'s schedule or lease', async () => {
    const m = await mkPush('push-during-round', { retries: 2, retryIntervalS: 20 });
    await t.client().get(`/api/push/${m.pushToken}`);
    await due([m.id]);
    const [r] = await claim(A);
    const before = await row(m.id);
    await t.client().get(`/api/push/${m.pushToken}?status=down`);
    const after = await row(m.id);
    expect(after.attempt).toBe(1); // the failure itself counts
    expect(after.lease_owner).toBe(t.ctx.instanceId);
    expect(after.next_run_at!.getTime()).toBe(before.next_run_at!.getTime());
    // the running round then plans the next round itself; it sees the attempt the push wrote (no lost update)
    await runAs(t.ctx, r);
    const done = await row(m.id);
    expect(done.lease_owner).toBeNull();
    expect(done.attempt).toBe(1); // a fresh push that reported a failure is shown again, it is not a new attempt
    expect(done.next_run_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it('"check now" during a running round: no schedule change, and the round counts on from the current attempt', async () => {
    const m = (await c.post('/api/monitors', { name: 'tcp-refused', type: 'tcp', config: { host: '127.0.0.1', port: 9 }, intervalS: 60, timeoutS: 5, retries: 3, retryIntervalS: 20 })).json as { id: number };
    await due([m.id]);
    const [r] = await claim(A);
    expect(r.attempt).toBe(0);
    const before = await row(m.id);
    await c.post(`/api/monitors/${m.id}/check`);
    expect(await row(m.id)).toMatchObject({ attempt: 1, lease_owner: t.ctx.instanceId, next_run_at: before.next_run_at });
    await runAs(t.ctx, r); // claimed with attempt 0, but the row says 1 by now
    const done = await row(m.id);
    expect(done).toMatchObject({ attempt: 2, lease_owner: null });
    expect(done.next_run_at!.getTime() - Date.now()).toBeLessThan(25_000); // the retry interval
  });

  it('stop() releases only its own leases', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await mkPush(`stop-${i}`)).id);
    await due(ids);
    const a = await claim(A, 2);
    const b = await claim(B, 2);
    expect([a.length, b.length]).toEqual([2, 2]);
    const S = (await import('../../src/server/engine/scheduler')).Scheduler;
    const stopping = new S(t.ctx);
    await stopping.stop(100);
    expect(await claim(stopping)).toEqual([]); // a stopped scheduler claims nothing
    for (const r of a) expect((await row(r.id)).lease_owner).toBeNull();
    for (const r of b) expect((await row(r.id)).lease_owner).toBe(other.instanceId);
  });
});

describe('spreading rounds', () => {
  const nextOffsets = async (ids: number[]) => (await db().selectFrom('monitors').select('next_run_at').where('id', 'in', ids).execute()).map((r) => r.next_run_at!.getTime() - Date.now());

  it('after a stall the overdue monitors are spread over their whole interval', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) { const m = await mkPush(`stall-${i}`); ids.push(m.id); await t.client().get(`/api/push/${m.pushToken}`); }
    await due(ids, new Date(Date.now() - 3_600_000));
    await db().updateTable('monitor_state').set({ sched_interval_s: 60 }).where('monitor_id', 'in', ids).execute();
    for (const r of await claim(A)) if (ids.includes(r.id)) await runAs(t.ctx, r);
    const off = await nextOffsets(ids);
    expect(Math.min(...off)).toBeGreaterThan(0);
    expect(Math.max(...off)).toBeLessThanOrEqual(61_000);
    expect(Math.max(...off) - Math.min(...off)).toBeGreaterThan(15_000); // used to be squeezed into 5 s
  });

  it('a changed interval (bulk edit) spreads the next round over the new interval', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) { const m = await mkPush(`bulk-${i}`); ids.push(m.id); await t.client().get(`/api/push/${m.pushToken}`); }
    const slot = new Date(Date.now() - 500);
    await due(ids, slot);
    await db().updateTable('monitor_state').set({ sched_interval_s: 60 }).where('monitor_id', 'in', ids).execute();
    await c.post('/api/monitors/bulk', { ids, action: 'patch', patch: { intervalS: 600 } });
    for (const r of await claim(A)) if (ids.includes(r.id)) await runAs(t.ctx, r);
    const off = await nextOffsets(ids);
    expect(Math.max(...off) - Math.min(...off)).toBeGreaterThan(120_000); // in step they would all sit within the 5 % jitter (30 s)
    expect((await db().selectFrom('monitor_state').select('sched_interval_s').where('monitor_id', 'in', ids).execute()).every((s) => s.sched_interval_s === 600)).toBe(true);
  });

  it('a round planned further out than a shortened interval is pulled in', async () => {
    const m = await mkPush('shortened');
    await db().updateTable('monitors').set({ next_run_at: new Date(Date.now() + 3_600_000), interval_s: 60 }).where('id', '=', m.id).execute();
    await A.respread();
    const off = (await nextOffsets([m.id]))[0];
    expect(off).toBeLessThanOrEqual(61_000);
  });

  it('editing the interval or resuming plans the next round within the interval', async () => {
    const m = await mkPush('edited');
    expect((await c.put(`/api/monitors/${m.id}`, { intervalS: 300 })).status).toBe(200);
    const off = (await nextOffsets([m.id]))[0];
    expect(off).toBeGreaterThan(0); expect(off).toBeLessThanOrEqual(301_000);
  });
});

describe('a failure streak does not survive a pause', () => {
  it('resume (edit) clears fail_since, a long gap or the end of maintenance starts a new streak', async () => {
    const m = await mkPush('paused', { retries: 0, downAfterS: 300 });
    const { loadMonitor } = await import('../../src/server/monitors/service');
    const fail = async () => t.ctx.engine.record((await loadMonitor(t.ctx, m.id))!, { ok: false, errorKind: 'refused', message: 'refused' }, { advance: false });
    const state = () => db().selectFrom('monitor_state').select(['status', 'fail_since', 'last_check_at']).where('monitor_id', '=', m.id).executeTakeFirstOrThrow();
    await t.client().get(`/api/push/${m.pushToken}`);
    await fail();
    expect((await state()).status).toBe('pending');
    // a streak that began an hour ago, then the monitor was paused and resumed
    await db().updateTable('monitor_state').set({ fail_since: new Date(Date.now() - 3_600_000) }).where('monitor_id', '=', m.id).execute();
    expect((await c.put(`/api/monitors/${m.id}`, { active: false })).status).toBe(200);
    expect((await c.put(`/api/monitors/${m.id}`, { active: true })).status).toBe(200);
    expect((await state()).fail_since).toBeNull();
    await fail();
    expect((await state()).status).toBe('pending'); // the down delay starts over instead of going down at once

    // paused through the route (no edit): the long gap since the last check tells the engine
    await db().updateTable('monitor_state').set({ fail_since: new Date(Date.now() - 3_600_000), last_check_at: new Date(Date.now() - 3_600_000) }).where('monitor_id', '=', m.id).execute();
    await fail();
    expect((await state()).status).toBe('pending');
    expect((await state()).fail_since!.getTime()).toBeGreaterThan(Date.now() - 10_000);

    // a streak from before a maintenance window
    await db().updateTable('monitor_state').set({ fail_since: new Date(Date.now() - 3_600_000), overlay: 'maintenance' }).where('monitor_id', '=', m.id).execute();
    await fail();
    expect((await state()).status).toBe('pending');
  });
});
