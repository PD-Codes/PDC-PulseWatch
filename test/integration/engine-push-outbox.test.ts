// Engine: push monitor heartbeats per round (uptime), the push race, and the outbox for incidents and notifications.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let parseMonitor: typeof import('../../src/server/monitors/model').parseMonitor;
const sent: { channel: string; event: string; subject: string }[] = [];

beforeAll(async () => {
  t = await startApp();
  c = await loggedInAdmin(t);
  ({ parseMonitor } = await import('../../src/server/monitors/model'));
  const { registerChannelType } = await import('../../src/server/notify/channels');
  registerChannelType({ type: 'engine-test', label: 'Test sink', fields: [{ key: 'name', label: 'Name', kind: 'text' }], send: async (cfg, msg) => { sent.push({ channel: cfg.name, event: msg.event, subject: msg.subject }); } });
});
afterAll(async () => { await t?.close(); });

const db = () => t.ctx.db;
const load = async (id: number) => parseMonitor(await db().selectFrom('monitors').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
/** One scheduled round the way the scheduler runs it: holding the lease, for the slot it claimed. */
const round = async (id: number) => {
  await db().updateTable('monitors').set({ lease_owner: t.ctx.instanceId, lease_until: new Date(Date.now() + 60_000) }).where('id', '=', id).execute();
  const m = await load(id);
  return t.ctx.engine.runRound(m, { advance: true, scheduledFor: m.nextRunAt ?? undefined });
};
const beats = async (id: number) => db().selectFrom('heartbeats').select(['status', 'message']).where('monitor_id', '=', id).where('location_id', '=', 0).orderBy('id').execute();
const statusOf = async (id: number) => (await db().selectFrom('monitor_state').select('status').where('monitor_id', '=', id).executeTakeFirstOrThrow()).status;
const setPushAge = (id: number, ageS: number) => db().updateTable('monitor_state').set({ last_push_at: new Date(Date.now() - ageS * 1000) }).where('monitor_id', '=', id).execute();
const push = (token: string, down = false) => t.client().get(`/api/push/${token}${down ? '?status=down&msg=job%20failed' : ''}`);
/** Uptime the way rollups count it: 1 up, 3 maintenance (excluded), 2 pending (excluded), everything else down. */
const uptime = (bs: { status: number }[]) => { const up = bs.filter((b) => b.status === 1).length; const down = bs.filter((b) => b.status === 0 || b.status === 4).length; return up / (up + down); };

describe('push monitors: one heartbeat per scheduled round', () => {
  it('uptime follows rounds with a fresh push vs. missed rounds', async () => {
    const m = (await c.post('/api/monitors', { name: 'cron-job', type: 'push', config: {}, intervalS: 60, timeoutS: 10 })).json as { id: number; pushToken: string };
    await push(m.pushToken);
    const N = 12, M = 2;
    let roundBeats = 0;
    const counted = async () => { const before = (await beats(m.id)).length; await round(m.id); const after = (await beats(m.id)).length; expect(after - before).toBe(1); roundBeats++; };
    for (let i = 0; i < N / 2; i++) { await setPushAge(m.id, 5); await counted(); }
    for (let i = 0; i < M; i++) { await setPushAge(m.id, 200); await counted(); }
    expect(await statusOf(m.id)).toBe('down');
    await push(m.pushToken); // the job runs again
    for (let i = 0; i < N / 2; i++) { await setPushAge(m.id, 5); await counted(); }
    expect(roundBeats).toBe(N + M);
    const all = await beats(m.id);
    expect(all.filter((b) => b.status === 0)).toHaveLength(M);
    // the push endpoint adds a beat on each change (first push, recovery); the rounds alone give N / (N + M)
    expect(Math.abs(uptime(all) - N / (N + M))).toBeLessThan(0.03);
  });

  it('an ok push counts once: later rounds only show it (up threshold, flap window)', async () => {
    const m = (await c.post('/api/monitors', { name: 'threshold', type: 'push', config: {}, intervalS: 60, timeoutS: 10, upThreshold: 3 })).json as { id: number; pushToken: string };
    const st = () => db().selectFrom('monitor_state').select(['status', 'consecutive_ok', 'outcomes']).where('monitor_id', '=', m.id).executeTakeFirstOrThrow();
    await push(m.pushToken);
    await push(m.pushToken, true);
    expect((await st()).status).toBe('down');
    await push(m.pushToken); // one successful run of the job
    expect(await st()).toMatchObject({ status: 'down', consecutive_ok: 1 });
    const outcomes = (await st()).outcomes;
    await round(m.id); await round(m.id);
    expect(await st()).toMatchObject({ status: 'down', consecutive_ok: 1, outcomes }); // not confirmed by repetition
    expect((await beats(m.id)).slice(-2).map((b) => b.status)).toEqual([0, 0]);
    await push(m.pushToken); await push(m.pushToken);
    expect((await st()).status).toBe('up');
    // a push the endpoint did not record (status already up) is counted by the next round, once
    const before = (await st()).outcomes.length;
    await push(m.pushToken);
    await round(m.id); await round(m.id);
    expect((await st()).outcomes.length).toBe(Math.min(before + 1, 10));
    expect((await beats(m.id)).slice(-2).map((b) => b.status)).toEqual([1, 1]);
  });

  it('a fresh push that reported a failure is shown as down every round, without a new transition or alert', async () => {
    const m = (await c.post('/api/monitors', { name: 'reports-down', type: 'push', config: {}, intervalS: 60, timeoutS: 10 })).json as { id: number; pushToken: string };
    await push(m.pushToken);
    await push(m.pushToken, true);
    expect(await statusOf(m.id)).toBe('down');
    const events = async () => (await db().selectFrom('events').select('id').where('monitor_id', '=', m.id).where('type', '=', 'status_change').execute()).length;
    const outbox = async () => (await db().selectFrom('engine_outbox').select('id').where('monitor_id', '=', m.id).execute()).length;
    const [e0, o0] = [await events(), await outbox()];
    for (let i = 0; i < 3; i++) await round(m.id);
    const last = (await beats(m.id)).slice(-3);
    expect(last.map((b) => b.status)).toEqual([0, 0, 0]);
    expect(last[0].message).toBe('job failed');
    expect([await events(), await outbox(), await statusOf(m.id)]).toEqual([e0, o0, 'down']);
    // checkNow does not touch a push monitor whose heartbeat is fresh
    const before = (await beats(m.id)).length;
    await c.post(`/api/monitors/${m.id}/check`);
    expect((await beats(m.id)).length).toBe(before);
  });

  it('a failure the job reported during maintenance counts once the window is over', async () => {
    const m = (await c.post('/api/monitors', { name: 'maint-push', type: 'push', config: {}, intervalS: 60, timeoutS: 10 })).json as { id: number; pushToken: string };
    await push(m.pushToken);
    const w = (await c.post('/api/maintenance', { name: 'mp', kind: 'once', startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), targets: [{ type: 'monitor', id: m.id }] })).json;
    await push(m.pushToken, true);
    expect(await statusOf(m.id)).toBe('up'); // absorbed by the window
    await round(m.id);
    expect((await beats(m.id)).slice(-1)[0].status).toBe(3);
    await db().updateTable('maintenance_windows').set({ ends_at: new Date(Date.now() - 1000) }).where('id', '=', w.id).execute();
    await t.ctx.maintenance.refresh();
    await round(m.id);
    expect(await statusOf(m.id)).toBe('down');
    expect((await beats(m.id)).slice(-1)[0].status).toBe(0);
  });

  it('a push that arrives while a round decides "missed" wins: the decision is checked again under the row lock', async () => {
    const m = (await c.post('/api/monitors', { name: 'racy', type: 'push', config: {}, intervalS: 60, timeoutS: 10 })).json as { id: number; pushToken: string };
    await push(m.pushToken);
    const mon = await load(m.id);
    // the round read last_push_at before the push came in and concluded "missed"
    const stale = { ok: false as const, errorKind: 'missed' as const, message: 'No heartbeat received for 300s (expected every 60s)' };
    await db().updateTable('monitors').set({ lease_owner: t.ctx.instanceId }).where('id', '=', m.id).execute();
    await t.ctx.engine.record(mon, stale, { advance: true, scheduledFor: mon.nextRunAt ?? undefined, push: true });
    expect(await statusOf(m.id)).toBe('up');
    expect((await beats(m.id)).slice(-1)[0].status).toBe(1);
    expect(await db().selectFrom('events').select('id').where('monitor_id', '=', m.id).where('type', 'in', ['status_change', 'check_error']).execute()).toHaveLength(0);
  });
});

describe('outbox: incidents and alerts survive a crash between commit and follow-up', () => {
  let channelId: number;
  beforeAll(async () => {
    channelId = (await c.post('/api/notification-channels', { name: 'sink', type: 'engine-test', config: { name: 'sink' } })).json.id;
  });
  const mk = async (name: string) => (await c.post('/api/monitors', { name, type: 'push', config: {}, intervalS: 60, timeoutS: 10, notifications: [{ channelId, events: ['down', 'up'] }] })).json as { id: number; pushToken: string };
  const incidentsOf = (id: number) => db().selectFrom('incidents').select(['id', 'status']).where('monitor_id', '=', id).execute();
  const deliveriesOf = (id: number) => db().selectFrom('notification_deliveries').select(['event', 'status']).where('monitor_id', '=', id).orderBy('id').execute();
  const outboxOf = (id: number) => db().selectFrom('engine_outbox').selectAll().where('monitor_id', '=', id).orderBy('id').execute();
  const fail = async (id: number) => t.ctx.engine.record(await load(id), { ok: false, errorKind: 'refused', message: 'connection refused' }, { advance: false });
  const ok = async (id: number) => t.ctx.engine.record(await load(id), { ok: true, latencyMs: 3 }, { advance: false });

  it('runs the follow-up right after the commit', async () => {
    const m = await mk('inline');
    await ok(m.id); await fail(m.id);
    expect(await incidentsOf(m.id)).toMatchObject([{ status: 'open' }]);
    expect(await deliveriesOf(m.id)).toMatchObject([{ event: 'down' }]);
    expect(await outboxOf(m.id)).toMatchObject([{ status: 'done', attempts: 1, incident_done: 1 }]);
  });

  it('a process that dies after the commit leaves the entry to the sweep, which runs it exactly once', async () => {
    const m = await mk('crashy');
    await ok(m.id);
    const spy = vi.spyOn(t.ctx.engine, 'processOutbox').mockResolvedValueOnce(false); // "killed" before the follow-up ran
    await fail(m.id);
    spy.mockRestore();
    expect(await statusOf(m.id)).toBe('down');
    expect(await incidentsOf(m.id)).toHaveLength(0);
    expect(await deliveriesOf(m.id)).toHaveLength(0);
    expect(await outboxOf(m.id)).toMatchObject([{ status: 'pending', attempts: 0 }]);
    expect(await t.ctx.engine.sweepOutbox()).toBeGreaterThanOrEqual(1);
    expect(await incidentsOf(m.id)).toMatchObject([{ status: 'open' }]);
    expect(await deliveriesOf(m.id)).toMatchObject([{ event: 'down' }]);
    await t.ctx.engine.sweepOutbox(); // nothing left: no second incident, no second alert
    expect(await incidentsOf(m.id)).toHaveLength(1);
    expect(await deliveriesOf(m.id)).toHaveLength(1);
  });

  it('retries with backoff; the incident is opened once and the alert queued once', async () => {
    const m = await mk('flaky-db');
    await ok(m.id);
    const spy = vi.spyOn(t.ctx.notifier, 'notify').mockRejectedValueOnce(new Error('Lock wait timeout exceeded'));
    await fail(m.id);
    spy.mockRestore();
    const [e] = await outboxOf(m.id);
    expect(e).toMatchObject({ status: 'pending', attempts: 1, incident_done: 1, last_error: 'Lock wait timeout exceeded' });
    expect(e.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(2_000); // backoff, not right away
    expect(await t.ctx.engine.sweepOutbox()).toBe(0); // not due yet
    await db().updateTable('engine_outbox').set({ next_attempt_at: new Date(Date.now() - 1000) }).where('id', '=', e.id).execute();
    await t.ctx.engine.sweepOutbox();
    expect(await outboxOf(m.id)).toMatchObject([{ status: 'done', attempts: 2 }]);
    expect(await incidentsOf(m.id)).toHaveLength(1);
    expect(await deliveriesOf(m.id)).toMatchObject([{ event: 'down' }]);
  });

  it('entries of one monitor run in order: the recovery waits for the outage before it', async () => {
    const m = await mk('ordered');
    await ok(m.id);
    const spy = vi.spyOn(t.ctx.engine, 'processOutbox').mockResolvedValue(false);
    await fail(m.id); await ok(m.id);
    spy.mockRestore();
    const [down, up] = await outboxOf(m.id);
    expect(await t.ctx.engine.processOutbox(up.id)).toBe(false); // the older entry goes first
    expect(await incidentsOf(m.id)).toHaveLength(0);
    await t.ctx.engine.sweepOutbox();
    expect(await incidentsOf(m.id)).toMatchObject([{ status: 'resolved' }]);
    expect((await deliveriesOf(m.id)).map((d) => d.event)).toEqual(['down', 'up']);
    expect((await outboxOf(m.id)).map((o) => o.status)).toEqual(['done', 'done']);
    expect(down.id).toBeLessThan(up.id);
  });

  it('two processes claiming the same entry: only one carries it out', async () => {
    const { createServices } = await import('../../src/server/services');
    const other = createServices();
    try {
      const m = await mk('contended');
      await ok(m.id);
      const spy = vi.spyOn(t.ctx.engine, 'processOutbox').mockResolvedValueOnce(false);
      await fail(m.id);
      spy.mockRestore();
      const [e] = await outboxOf(m.id);
      const res = await Promise.all([t.ctx.engine.processOutbox(e.id), other.engine.processOutbox(e.id)]);
      expect(res.filter(Boolean)).toHaveLength(1);
      expect(await incidentsOf(m.id)).toHaveLength(1);
      expect(await deliveriesOf(m.id)).toHaveLength(1);
    } finally { await other.db.destroy(); }
  });
});
