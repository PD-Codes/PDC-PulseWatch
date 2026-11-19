// Alert snooze (API, no deliveries while snoozed, one reminder at the end, incidents and bulk) and SLO targets (validation,
// 30-day uptime and error budget from rollups, one notification per breach, hysteresis, period claim across processes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let alerts: typeof import('../../src/server/alerts');
let loadMonitor: typeof import('../../src/server/monitors/service').loadMonitor;
const sent: { channel: string; event: string; subject: string; text: string }[] = [];

beforeAll(async () => {
  t = await startApp();
  c = await loggedInAdmin(t);
  alerts = await import('../../src/server/alerts');
  ({ loadMonitor } = await import('../../src/server/monitors/service'));
  const { registerChannelType } = await import('../../src/server/notify/channels');
  registerChannelType({ type: 'snooze-sink', label: 'Test sink', fields: [{ key: 'name', label: 'Name', kind: 'text' }], send: async (cfg, msg) => { sent.push({ channel: cfg.name, event: msg.event, subject: msg.subject, text: msg.text }); } });
});
afterAll(async () => { await t?.close(); });

const db = () => t.ctx.db;
const channel = async (name: string) => (await c.post('/api/notification-channels', { name, type: 'snooze-sink', config: { name } })).json.id as number;
const push = async (name: string, extra: object = {}) => (await c.post('/api/monitors', { name, type: 'push', config: {}, ...extra })).json;
const fail = async (id: number) => t.ctx.engine.record((await loadMonitor(t.ctx, id))!, { ok: false, errorKind: 'refused', message: 'connection refused' }, { advance: false });
const ok = async (id: number) => t.ctx.engine.record((await loadMonitor(t.ctx, id))!, { ok: true, latencyMs: 5, message: 'fine' }, { advance: false });
const deliveries = (id: number) => db().selectFrom('notification_deliveries').select(['id', 'event', 'status', 'last_error']).where('monitor_id', '=', id).orderBy('id').execute();
const settle = async () => { await new Promise((r) => setImmediate(r)); await t.ctx.notifier.process(); };
const sentTo = (name: string) => sent.filter((s) => s.channel === name);

describe('snooze API', () => {
  it('sets, shows and clears a snooze with minutes or until, and validates the body', async () => {
    const m = await push('sn-api');
    const before = Date.now();
    const r = await c.post(`/api/monitors/${m.id}/snooze`, { minutes: 30 });
    expect(r.status).toBe(200);
    const until = new Date(r.json.snoozedUntil).getTime();
    expect(until - before).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(until - before).toBeLessThan(30 * 60_000 + 5000);
    expect(new Date((await c.get(`/api/monitors/${m.id}`)).json.snoozedUntil).getTime()).toBe(until);
    expect(new Date((await c.get('/api/monitors')).json.find((x: any) => x.id === m.id).snoozedUntil).getTime()).toBe(until);

    const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect((await c.post(`/api/monitors/${m.id}/snooze`, { until: at })).json).toEqual({ snoozedUntil: at });

    for (const bad of [{ minutes: 4 }, { minutes: 10081 }, {}, { minutes: 10, until: at }, { until: new Date(Date.now() - 1000).toISOString() }, { until: new Date(Date.now() + 8 * 86_400_000).toISOString() }, { until: 'tomorrow' }]) {
      expect((await c.post(`/api/monitors/${m.id}/snooze`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await c.del(`/api/monitors/${m.id}/snooze`)).json).toEqual({ snoozedUntil: null });
    expect((await c.get(`/api/monitors/${m.id}`)).json.snoozedUntil).toBeNull();
    const audit = await db().selectFrom('audit_log').select('action').where('entity_id', '=', String(m.id)).where('action', 'like', 'monitor.%snooze%').execute();
    expect(audit.map((a) => a.action)).toEqual(['monitor.snoozed', 'monitor.snoozed', 'monitor.unsnoozed']);
  });

  it('an expired snooze is shown as none', async () => {
    const m = await push('sn-expired');
    await db().updateTable('monitor_state').set({ snoozed_until: new Date(Date.now() - 1000) }).where('monitor_id', '=', m.id).execute();
    expect((await c.get(`/api/monitors/${m.id}`)).json.snoozedUntil).toBeNull();
  });

  it('needs the right to manage the monitor', async () => {
    const m = await push('sn-rights');
    await c.post('/api/users', { username: 'sn-viewer', password: 'viewer-password-123', role: 'viewer' });
    const v = t.client();
    expect((await v.post('/api/auth/login', { username: 'sn-viewer', password: 'viewer-password-123' })).status).toBe(200);
    expect((await v.post(`/api/monitors/${m.id}/snooze`, { minutes: 10 })).status).toBe(403);
    expect((await v.del(`/api/monitors/${m.id}/snooze`)).status).toBe(403);
    // a scope-restricted editor without a grant does not even see the monitor
    await c.post('/api/users', { username: 'sn-editor', password: 'editor-password-123', role: 'editor', scopeRestricted: true });
    const e = t.client();
    expect((await e.post('/api/auth/login', { username: 'sn-editor', password: 'editor-password-123' })).status).toBe(200);
    expect((await e.post(`/api/monitors/${m.id}/snooze`, { minutes: 10 })).status).toBe(404);
  });
});

describe('snooze effect', () => {
  it('holds back every notification while checks, events and incidents go on, then reminds once if still down', async () => {
    const ch = await channel('sn-effect');
    const m = await push('sn-effect', { notifications: [{ channelId: ch, events: ['down', 'up', 'flap', 'cert'] }] });
    await c.post(`/api/monitors/${m.id}/snooze`, { minutes: 60 });
    await fail(m.id);
    await settle();
    expect((await db().selectFrom('monitor_state').select('status').where('monitor_id', '=', m.id).executeTakeFirstOrThrow()).status).toBe('down');
    expect((await db().selectFrom('events').select('type').where('monitor_id', '=', m.id).where('type', '=', 'status_change').execute()).length).toBe(1);
    const inc = await db().selectFrom('incidents').select(['id', 'status']).where('monitor_id', '=', m.id).executeTakeFirstOrThrow();
    expect(inc.status).toBe('open');
    expect(await t.ctx.notifier.notify({ event: 'cert', monitor: (await loadMonitor(t.ctx, m.id))! })).toBe(0);
    expect(await deliveries(m.id)).toEqual([]);
    expect(sentTo('sn-effect')).toEqual([]);

    // a snooze that has not run out yet is left alone
    expect(await alerts.endSnoozes(t.ctx)).toEqual([]);
    // it runs out: one reminder, as a DOWN notification of the open incident
    await db().updateTable('monitor_state').set({ snoozed_until: new Date(Date.now() - 1000) }).where('monitor_id', '=', m.id).execute();
    expect(await alerts.endSnoozes(t.ctx)).toEqual([m.id]);
    expect(await alerts.endSnoozes(t.ctx)).toEqual([]);
    await settle();
    expect(sentTo('sn-effect').map((s) => s.event)).toEqual(['down']);
    expect(sentTo('sn-effect')[0]!.text).toContain('Snooze ended, the monitor is still down: connection refused');
    const ds = await db().selectFrom('notification_deliveries').select(['incident_id']).where('monitor_id', '=', m.id).execute();
    expect(ds).toEqual([{ incident_id: inc.id }]);
    expect((await db().selectFrom('monitor_state').select('snoozed_until').where('monitor_id', '=', m.id).executeTakeFirstOrThrow()).snoozed_until).toBeNull();

    // afterwards notifications flow normally again
    await ok(m.id);
    await settle();
    expect(sentTo('sn-effect').map((s) => s.event)).toEqual(['down', 'up']);
  });

  it('no reminder when the monitor recovered during the snooze, and none for a DOWN already sent after it ran out', async () => {
    const ch = await channel('sn-quiet');
    const a = await push('sn-recovered', { notifications: [{ channelId: ch, events: ['down', 'up'] }] });
    await c.post(`/api/monitors/${a.id}/snooze`, { minutes: 30 });
    await fail(a.id); await ok(a.id);
    await db().updateTable('monitor_state').set({ snoozed_until: new Date(Date.now() - 1000) }).where('monitor_id', '=', a.id).execute();
    expect(await alerts.endSnoozes(t.ctx)).toEqual([]);

    const b = await push('sn-told', { notifications: [{ channelId: ch, events: ['down', 'up'] }] });
    await db().insertInto('monitor_state').values({ monitor_id: b.id, snoozed_until: new Date(Date.now() - 60_000) }).onDuplicateKeyUpdate({ snoozed_until: new Date(Date.now() - 60_000) }).execute();
    await fail(b.id); // the snooze is over (not yet cleared by the job): this DOWN goes out normally
    expect(await alerts.endSnoozes(t.ctx)).toEqual([]);
    await settle();
    expect(sentTo('sn-quiet').map((s) => s.event)).toEqual(['down']);
  });

  it('drops deliveries that are still waiting when the snooze starts, and holds back escalations', async () => {
    const ch = await channel('sn-pending');
    const m = await push('sn-pending', { notifications: [{ channelId: ch, events: ['down', 'up'] }] });
    const mon = (await loadMonitor(t.ctx, m.id))!;
    await db().insertInto('notification_deliveries').values({ channel_id: ch, monitor_id: m.id, event: 'down', status: 'pending', next_attempt_at: new Date(Date.now() + 3_600_000), subject: 'x', payload: '{}' }).execute();
    await c.post(`/api/monitors/${m.id}/snooze`, { minutes: 15 });
    expect(await deliveries(m.id)).toEqual([expect.objectContaining({ status: 'skipped', last_error: 'Alerts snoozed' })]);

    const pol = Number((await db().insertInto('escalation_policies').values({ name: 'sn-pol', steps: JSON.stringify({ steps: [{ delayMin: 0, channelIds: [ch] }] }) }).executeTakeFirstOrThrow()).insertId);
    const inc = Number((await db().insertInto('incidents').values({ title: 'x', monitor_id: m.id, started_at: new Date() }).executeTakeFirstOrThrow()).insertId);
    await db().insertInto('escalation_runs').values({ incident_id: inc, monitor_id: mon.id, policy_id: pol, next_step: 0, next_at: new Date(Date.now() - 1000) }).execute();
    await t.ctx.notifier.process();
    const run = await db().selectFrom('escalation_runs').select(['next_step', 'next_at', 'active']).where('incident_id', '=', inc).executeTakeFirstOrThrow();
    expect(run).toMatchObject({ next_step: 0, active: 1 });
    const until = (await db().selectFrom('monitor_state').select('snoozed_until').where('monitor_id', '=', m.id).executeTakeFirstOrThrow()).snoozed_until!;
    expect(run.next_at.getTime()).toBe(until.getTime());
    expect(sentTo('sn-pending')).toEqual([]);
  });

  it('snoozes the manageable monitors of an incident, and works as a bulk action', async () => {
    const a = await push('sn-inc-a'), b = await push('sn-inc-b');
    await fail(a.id);
    const inc = await db().selectFrom('incidents').select('id').where('monitor_id', '=', a.id).executeTakeFirstOrThrow();
    await db().insertInto('incident_monitors').values({ incident_id: inc.id, monitor_id: b.id }).ignore().execute();
    const r = await c.post(`/api/incidents/${inc.id}/snooze`, { minutes: 45 });
    expect(r.status).toBe(200);
    expect(r.json.snoozed).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(new Date(r.json.snoozedUntil).getTime()).toBeGreaterThan(Date.now() + 44 * 60_000);
    expect((await c.post(`/api/incidents/${inc.id}/snooze`, { minutes: 1 })).status).toBe(400);
    expect((await c.post('/api/incidents/999999/snooze', { minutes: 10 })).status).toBe(404);
    expect(await db().selectFrom('audit_log').select('action').where('action', '=', 'incident.snoozed').executeTakeFirst()).toBeTruthy();

    const bulk = await c.post('/api/monitors/bulk', { ids: [a.id, b.id], action: 'unsnooze' });
    expect(bulk.json).toMatchObject({ affected: 2, snoozedUntil: null });
    expect((await c.get(`/api/monitors/${a.id}`)).json.snoozedUntil).toBeNull();
    const s2 = await c.post('/api/monitors/bulk', { ids: [a.id, b.id], action: 'snooze', minutes: 20 });
    expect(s2.json.affected).toBe(2);
    expect((await c.get(`/api/monitors/${b.id}`)).json.snoozedUntil).toBe(s2.json.snoozedUntil);
    expect((await c.post('/api/monitors/bulk', { ids: [a.id], action: 'snooze' })).status).toBe(400);
  });
});

describe('SLO target', () => {
  const tz = () => process.env.PW_TIMEZONE || 'UTC';
  /** One daily rollup for today holds the whole 30-day sample; the hourly head of the window stays empty. */
  const setCounts = async (id: number, up: number, down: number) => {
    const { startOfLocalDay } = await import('../../src/server/tz');
    const bucket = startOfLocalDay(tz(), new Date());
    await db().insertInto('rollups').values({ monitor_id: id, res: 'day', bucket, total: up + down, up_n: up, down_n: down }).onDuplicateKeyUpdate({ total: up + down, up_n: up, down_n: down }).execute();
  };

  it('validates the target on create, update and bulk patch', async () => {
    for (const bad of [49.999, 100, 100.5, 99.9999, '99.9']) expect((await c.post('/api/monitors', { name: `slo-bad-${bad}`, type: 'push', config: {}, sloTarget: bad })).status, String(bad)).toBe(400);
    const m = await push('slo-valid', { sloTarget: 99.995 });
    expect(m.sloTarget).toBe(99.995);
    expect((await c.call('PATCH', `/api/monitors/${m.id}`, { sloTarget: 50 })).json.sloTarget).toBe(50);
    expect((await c.call('PATCH', `/api/monitors/${m.id}`, { name: 'slo-valid-2' })).json.sloTarget).toBe(50); // kept when not sent
    expect((await c.call('PATCH', `/api/monitors/${m.id}`, { sloTarget: null })).json).toMatchObject({ sloTarget: null, slo: null });
    expect((await c.post('/api/monitors/bulk', { ids: [m.id], action: 'patch', patch: { sloTarget: 100 } })).status).toBe(400);
    expect((await c.post('/api/monitors/bulk', { ids: [m.id], action: 'patch', patch: { sloTarget: 99.5 } })).status).toBe(200);
    expect((await c.get(`/api/monitors/${m.id}`)).json.sloTarget).toBe(99.5);
    const clone = await c.post(`/api/monitors/${m.id}/clone`);
    expect(clone.json.sloTarget).toBe(99.5);
  });

  it('computes the 30-day uptime and the error budget from the rollups', async () => {
    const m = await push('slo-calc', { sloTarget: 99.9 });
    let d = (await c.get(`/api/monitors/${m.id}`)).json;
    expect(d.slo).toEqual({ target: 99.9, uptime30d: null, met: null, budgetMinutes: 43.2, usedMinutes: 0, remainingMinutes: 43.2, windowDays: 30 });
    await setCounts(m.id, 9990, 10); // exactly on target
    d = (await c.get(`/api/monitors/${m.id}`)).json;
    expect(d.slo).toEqual({ target: 99.9, uptime30d: 99.9, met: true, budgetMinutes: 43.2, usedMinutes: 43.2, remainingMinutes: 0, windowDays: 30 });
    await setCounts(m.id, 9980, 20);
    d = (await c.get(`/api/monitors/${m.id}`)).json;
    expect(d.slo).toMatchObject({ uptime30d: 99.8, met: false, usedMinutes: 86.4, remainingMinutes: -43.2 });
    const item = (await c.get('/api/monitors')).json.find((x: any) => x.id === m.id);
    expect(item.slo).toEqual({ target: 99.9, uptime30d: 99.8, met: false });
    expect(item.sloTarget).toBe(99.9);
    // rollups before the window do not count; the hourly part of the first day does
    const start = Date.now() - 30 * 86_400_000;
    await db().insertInto('rollups').values({ monitor_id: m.id, res: 'day', bucket: new Date(start - 3 * 86_400_000), total: 100, up_n: 0, down_n: 100 }).execute();
    expect((await alerts.sloCounts(db(), [m.id])).get(m.id)).toEqual({ up: 9980, down: 20 });
    await db().insertInto('rollups').values({ monitor_id: m.id, res: 'hour', bucket: new Date(Math.ceil(start / 3_600_000) * 3_600_000), total: 20, up_n: 20, down_n: 0 }).execute();
    expect((await alerts.sloCounts(db(), [m.id])).get(m.id)).toEqual({ up: 10000, down: 20 });
  });

  it('notifies once per breach (texts in both languages) and again only after a recovery with hysteresis', async () => {
    const ch = await channel('slo-sink');
    const m = await push('slo-notify', { sloTarget: 99, notifications: [{ channelId: ch, events: ['down'] }] });
    const other = await push('slo-not-subscribed', { sloTarget: 99, notifications: [{ channelId: ch, events: ['up'] }] });
    await alerts.evaluateSlos(t.ctx, new Date(), { force: true }); // breaches left by the tests above
    await setCounts(m.id, 995, 5); await setCounts(other.id, 900, 100);
    expect(await alerts.evaluateSlos(t.ctx, new Date(), { force: true })).toEqual({ breached: [other.id], recovered: [] });
    await setCounts(m.id, 985, 15);
    expect((await alerts.evaluateSlos(t.ctx, new Date(), { force: true }))!.breached).toEqual([m.id]);
    expect((await alerts.evaluateSlos(t.ctx, new Date(), { force: true }))!.breached).toEqual([]);
    await settle();
    expect(sentTo('slo-sink').map((s) => s.event)).toEqual(['slo']); // the monitor without a down/slo rule sends nothing
    expect(sentTo('slo-sink')[0]!.subject).toBe('[SLO] slo-notify');
    expect(sentTo('slo-sink')[0]!.text).toContain('slo-notify missed its availability target: 98.5% over the last 30 days (target 99%).');
    const de = t.ctx.notifier.buildMessage({ event: 'slo', monitor: (await loadMonitor(t.ctx, m.id))!, slo: { target: 99, uptime30d: 98.5, budgetMinutes: 432, usedMinutes: 648 } }, null, 'de');
    expect(de.text).toContain('slo-notify verfehlt sein Verfügbarkeitsziel: 98.5 % in den letzten 30 Tagen (Ziel 99 %).');
    expect(de.text).toContain('Verbrauchtes Fehlerbudget: 648 von 432 Minuten.');
    const ev = await db().selectFrom('events').select(['type', 'message']).where('monitor_id', '=', m.id).where('type', 'like', 'slo_%').execute();
    expect(ev).toEqual([{ type: 'slo_breach', message: '30-day uptime 98.5% is below the target of 99%' }]);

    // back on target, but with less than 5% of the budget left: still counted as breached
    await setCounts(m.id, 9901, 99);
    expect(await alerts.evaluateSlos(t.ctx, new Date(), { force: true })).toEqual({ breached: [], recovered: [] });
    await setCounts(m.id, 9906, 94);
    expect((await alerts.evaluateSlos(t.ctx, new Date(), { force: true }))!.recovered).toEqual([m.id]);
    await setCounts(m.id, 980, 20);
    expect((await alerts.evaluateSlos(t.ctx, new Date(), { force: true }))!.breached).toEqual([m.id]);
    await settle();
    expect(sentTo('slo-sink').map((s) => s.event)).toEqual(['slo', 'slo']);
    expect((await db().selectFrom('events').select('type').where('monitor_id', '=', m.id).where('type', 'like', 'slo_%').orderBy('id').execute()).map((e) => e.type)).toEqual(['slo_breach', 'slo_recovered', 'slo_breach']);
  });

  it('a snoozed monitor records the breach without notifying; a removed target forgets the breach', async () => {
    const ch = await channel('slo-snoozed');
    const m = await push('slo-snoozed', { sloTarget: 99, notifications: [{ channelId: ch, events: ['slo'] }] });
    await setCounts(m.id, 90, 10);
    await c.post(`/api/monitors/${m.id}/snooze`, { minutes: 60 });
    expect((await alerts.evaluateSlos(t.ctx, new Date(), { force: true }))!.breached).toEqual([m.id]);
    expect((await alerts.evaluateSlos(t.ctx, new Date(), { force: true }))!.breached).toEqual([]); // still snoozed: nothing new
    await settle();
    expect(sentTo('slo-snoozed')).toEqual([]);
    // after the snooze the miss that is still there is announced once, without a second event
    await c.del(`/api/monitors/${m.id}/snooze`);
    expect((await alerts.evaluateSlos(t.ctx, new Date(), { force: true }))!.breached).toEqual([m.id]);
    expect((await alerts.evaluateSlos(t.ctx, new Date(), { force: true }))!.breached).toEqual([]);
    await settle();
    expect(sentTo('slo-snoozed').map((x) => x.event)).toEqual(['slo']);
    expect((await db().selectFrom('events').select('type').where('monitor_id', '=', m.id).where('type', 'like', 'slo_%').execute()).map((e) => e.type)).toEqual(['slo_breach']);

    // a miss recorded during a snooze that is over by the end of it is not announced afterwards
    const r = await push('slo-snoozed-recovers', { sloTarget: 99, notifications: [{ channelId: ch, events: ['slo'] }] });
    await setCounts(r.id, 90, 10);
    await c.post(`/api/monitors/${r.id}/snooze`, { minutes: 60 });
    await alerts.evaluateSlos(t.ctx, new Date(), { force: true });
    await setCounts(r.id, 9999, 1);
    await c.del(`/api/monitors/${r.id}/snooze`);
    expect(await alerts.evaluateSlos(t.ctx, new Date(), { force: true })).toEqual({ breached: [], recovered: [r.id] });
    await settle();
    expect(sentTo('slo-snoozed').map((x) => x.event)).toEqual(['slo']);

    await c.call('PATCH', `/api/monitors/${m.id}`, { sloTarget: null });
    await alerts.evaluateSlos(t.ctx, new Date(), { force: true });
    expect((await db().selectFrom('monitor_state').select('slo_breached').where('monitor_id', '=', m.id).executeTakeFirstOrThrow()).slo_breached).toBe(0);
  });

  it('runs at most every 5 minutes across processes', async () => {
    const now = new Date(Date.now() + 86_400_000); // after any run of the other tests
    expect(await alerts.claimPeriodic(db(), 'slo.test', alerts.SLO_EVAL_EVERY_MS, now)).toBe(true);
    expect(await alerts.claimPeriodic(db(), 'slo.test', alerts.SLO_EVAL_EVERY_MS, now)).toBe(false);
    expect(await alerts.claimPeriodic(db(), 'slo.test', alerts.SLO_EVAL_EVERY_MS, new Date(now.getTime() + 4 * 60_000))).toBe(false);
    const later = new Date(now.getTime() + 5 * 60_000);
    const both = await Promise.all([alerts.claimPeriodic(db(), 'slo.test', alerts.SLO_EVAL_EVERY_MS, later), alerts.claimPeriodic(db(), 'slo.test', alerts.SLO_EVAL_EVERY_MS, later)]);
    expect(both.filter(Boolean).length).toBe(1);
    expect(await alerts.evaluateSlos(t.ctx, now)).not.toBeNull();
    expect(await alerts.evaluateSlos(t.ctx, now)).toBeNull();
  });
});
