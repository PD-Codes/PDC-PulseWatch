// Notifier: retry backoff and give-up, delivery order per channel and monitor, outdated DOWNs, quiet hours, escalations, shutdown.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';
import type { Monitor } from '../../src/server/monitors/model';
import type { NotifyEvent } from '../../src/server/notify/notifier';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let loadMonitor: typeof import('../../src/server/monitors/service').loadMonitor;
const sent: { channel: string; event: string; text: string }[] = [];
const failing = new Set<string>();
const slow = new Map<string, number>();

beforeAll(async () => {
  t = await startApp();
  c = await loggedInAdmin(t);
  ({ loadMonitor } = await import('../../src/server/monitors/service'));
  const { registerChannelType } = await import('../../src/server/notify/channels');
  registerChannelType({
    type: 'engine-sink', label: 'Test sink', fields: [{ key: 'name', label: 'Name', kind: 'text' }],
    send: async (cfg, msg) => {
      if (slow.has(cfg.name)) await new Promise((r) => setTimeout(r, slow.get(cfg.name)));
      if (failing.has(cfg.name)) throw new Error(`${cfg.name} is unreachable`);
      if (failing.has(`${cfg.name}:${msg.event}`)) throw new Error('400 Bad Request');
      sent.push({ channel: cfg.name, event: msg.event, text: msg.text });
    },
  });
});
afterAll(async () => { await t?.close(); });

const db = () => t.ctx.db;
const channel = async (name: string, quietHours?: object) => (await c.post('/api/notification-channels', { name, type: 'engine-sink', config: { name }, ...(quietHours ? { quietHours } : {}) })).json.id as number;
const monitor = async (name: string, rules: object[]) => (await loadMonitor(t.ctx, (await c.post('/api/monitors', { name, type: 'push', config: {}, notifications: rules })).json.id))!;
const notify = (m: Monitor, event: NotifyEvent, incidentId?: number, message = `${event} message`) => t.ctx.notifier.notify({ event, monitor: m, result: { ok: event !== 'down', message }, incidentId });
const deliveries = (m: Monitor) => db().selectFrom('notification_deliveries').select(['id', 'event', 'status', 'attempts', 'next_attempt_at', 'last_error', 'channel_id']).where('monitor_id', '=', m.id).orderBy('id').execute();
/** Let the worker pass that notify() kicked off finish, then run one more. */
const settle = async () => { await new Promise((r) => setImmediate(r)); await t.ctx.notifier.process(); };
const makeDue = (ids: number[]) => db().updateTable('notification_deliveries').set({ next_attempt_at: new Date(Date.now() - 1000) }).where('id', 'in', ids).execute();
const sentTo = (name: string) => sent.filter((s) => s.channel === name).map((s) => s.event);
const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const quietNow = (extra: object = {}) => ({ start: hhmm(new Date(Date.now() - 3_600_000)), end: hhmm(new Date(Date.now() + 3_600_000)), timezone: 'UTC', mode: 'defer', ...extra });

describe('retries', () => {
  it('backs off 30 s, 2 min, 10 min, 30 min and gives up after MAX_ATTEMPTS', async () => {
    const { BACKOFF_S, MAX_ATTEMPTS } = await import('../../src/server/notify/notifier');
    const ch = await channel('backoff');
    const m = await monitor('n-backoff', [{ channelId: ch, events: ['down'] }]);
    failing.add('backoff');
    await notify(m, 'down');
    await settle(); // first attempt right away
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const [d] = await deliveries(m);
        await makeDue([d.id]);
        await settle();
      }
      const [after] = await deliveries(m);
      expect(after.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(after).toMatchObject({ status: 'pending', last_error: 'backoff is unreachable' });
        const wait = (after.next_attempt_at!.getTime() - Date.now()) / 1000;
        expect(Math.abs(wait - BACKOFF_S[Math.min(attempt - 1, BACKOFF_S.length - 1)])).toBeLessThan(3);
      } else expect(after).toMatchObject({ status: 'failed', next_attempt_at: null });
    }
    expect(sentTo('backoff')).toEqual([]);
  });
});

describe('order per channel and monitor', () => {
  it('only DOWN/UP are ordered: a rejected certificate notice does not hold back the outage after it, nor the other way round', async () => {
    const ch = await channel('order');
    const m = await monitor('n-order', [{ channelId: ch, events: ['down', 'up', 'cert'] }]);
    failing.add('order:cert'); // the channel refuses this message for good
    await notify(m, 'cert');
    await settle();
    await notify(m, 'down');
    await settle();
    expect(sentTo('order')).toEqual(['down']);
    failing.delete('order:cert');
    failing.add('order:down');
    await notify(m, 'down'); // in backoff now
    await settle();
    const cert = (await deliveries(m))[0];
    await makeDue([cert.id]);
    await notify(m, 'cert');
    await settle();
    expect(sentTo('order')).toEqual(['down', 'cert', 'cert']);
    failing.delete('order:down');
  });

  it('a DOWN behind an earlier one in backoff waits for it, then both go out in order', async () => {
    const ch = await channel('order-dd');
    const m = await monitor('n-order-dd', [{ channelId: ch, events: ['down'] }]);
    failing.add('order-dd');
    await notify(m, 'down');
    await settle();
    failing.delete('order-dd');
    await notify(m, 'down', undefined, 'second');
    await settle();
    expect(sentTo('order-dd')).toEqual([]);
    await makeDue([(await deliveries(m))[0].id]);
    await settle();
    expect(sent.filter((x) => x.channel === 'order-dd').map((x) => x.text)).toEqual([expect.stringContaining('down message'), expect.stringContaining('second')]);
  });

  it('blocked rows of other chains cannot crowd out a chain that is due (more than 200 waiting, more than 5000 pending)', async () => {
    const a = await channel('crowd-a'), b = await channel('crowd-b');
    const m = await monitor('n-crowd', [{ channelId: b, events: ['down'] }]);
    const payload = JSON.stringify({ event: 'down', subject: 'x', text: 'crowd', vars: {} });
    const row = (channel_id: number, next: Date) => ({ channel_id, monitor_id: m.id, event: 'down', status: 'pending' as const, next_attempt_at: next, subject: 'x', payload });
    // channel A: a head in backoff with 300 due DOWNs behind it, then 5000 more deferred by quiet hours
    const rows = [row(a, new Date(Date.now() + 600_000)), ...Array.from({ length: 300 }, () => row(a, new Date(Date.now() - 1000))), ...Array.from({ length: 5000 }, () => row(a, new Date(Date.now() + 3_600_000)))];
    for (let i = 0; i < rows.length; i += 1000) await db().insertInto('notification_deliveries').values(rows.slice(i, i + 1000)).execute();
    await notify(m, 'down'); // channel B, same monitor, newest id
    await settle();
    expect(sentTo('crowd-b')).toEqual(['down']);
    expect(sentTo('crowd-a')).toEqual([]); // still behind its own head
  });

  it('a DOWN still waiting for a retry is dropped once the UP after it exists', async () => {
    const ch = await channel('supersede');
    const m = await monitor('n-supersede', [{ channelId: ch, events: ['down', 'up'] }]);
    failing.add('supersede');
    await notify(m, 'down');
    await settle();
    failing.delete('supersede');
    await notify(m, 'up');
    await settle();
    expect(sentTo('supersede')).toEqual(['up']); // never "down" after "up"
    expect(await deliveries(m)).toMatchObject([{ event: 'down', status: 'skipped', last_error: 'Superseded by a later recovery' }, { event: 'up', status: 'sent' }]);
  });

  it('chains of different channels do not hold each other up', async () => {
    const a = await channel('chain-a'), b = await channel('chain-b');
    const m = await monitor('n-chains', [{ channelId: a, events: ['down'] }, { channelId: b, events: ['down'] }]);
    failing.add('chain-a');
    await notify(m, 'down');
    await settle();
    expect([sentTo('chain-a'), sentTo('chain-b')]).toEqual([[], ['down']]);
    failing.delete('chain-a');
  });
});

describe('quiet hours', () => {
  it('defer: DOWN and UP wait for the end; the outdated DOWN is dropped then', async () => {
    const ch = await channel('quiet-defer', quietNow());
    const m = await monitor('n-quiet', [{ channelId: ch, events: ['down', 'up'] }]);
    await notify(m, 'down');
    await notify(m, 'up');
    const queued = await deliveries(m);
    expect(queued.map((d) => d.last_error)).toEqual(['Deferred until quiet hours end', 'Deferred until quiet hours end']);
    expect(queued[0].next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    await settle();
    expect(sentTo('quiet-defer')).toEqual([]);
    await makeDue(queued.map((d) => d.id)); // the quiet hours are over
    await settle();
    expect(sentTo('quiet-defer')).toEqual(['up']);
  });

  it('drop: nothing is queued during quiet hours', async () => {
    const ch = await channel('quiet-drop', quietNow({ mode: 'drop' }));
    const m = await monitor('n-quiet-drop', [{ channelId: ch, events: ['down'] }]);
    await notify(m, 'down');
    expect(await deliveries(m)).toMatchObject([{ status: 'skipped', last_error: 'Dropped during quiet hours' }]);
  });

  it('bypass for DOWN: a deferred UP does not hold back the next outage', async () => {
    const ch = await channel('quiet-bypass', quietNow({ bypassDown: true }));
    const m = await monitor('n-quiet-bypass', [{ channelId: ch, events: ['down', 'up'] }]);
    await notify(m, 'down');
    await settle();
    await notify(m, 'up'); // deferred
    await notify(m, 'down'); // due now
    await settle();
    expect(sentTo('quiet-bypass')).toEqual(['down', 'down']);
    expect((await deliveries(m)).map((d) => [d.event, d.status])).toEqual([['down', 'sent'], ['up', 'skipped'], ['down', 'sent']]);
  });
});

describe('escalations', () => {
  it('steps fire after their delay to their channels and stop with the incident', async () => {
    const first = await channel('esc-1'), second = await channel('esc-2');
    const policyId = Number((await db().insertInto('escalation_policies').values({ name: 'oncall', steps: JSON.stringify({ steps: [{ delayMin: 0, channelIds: [first] }, { delayMin: 5, channelIds: [second] }] }) }).executeTakeFirstOrThrow()).insertId);
    const m = await monitor('n-escalate', [{ policyId, events: ['down'] }]);
    const inc = await t.ctx.incidents.openFor(m, { ok: false, message: 'down' });
    await notify(m, 'down', inc.id);
    await notify(m, 'down', inc.id); // a second alert for the same incident does not start a second run
    const runs = () => db().selectFrom('escalation_runs').selectAll().where('incident_id', '=', inc.id).execute();
    expect(await runs()).toMatchObject([{ active: 1, next_step: 0 }]);
    await settle();
    expect(sentTo('esc-1')).toEqual(['down']);
    expect(sent.find((s) => s.channel === 'esc-1')!.text).toMatch(/1/);
    const [run] = await runs();
    expect(run).toMatchObject({ active: 1, next_step: 1 });
    expect(run.next_at.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    await settle();
    expect(sentTo('esc-2')).toEqual([]); // not yet
    await db().updateTable('escalation_runs').set({ next_at: new Date(Date.now() - 1000) }).where('id', '=', run.id).execute();
    await settle();
    expect(sentTo('esc-2')).toEqual(['down']);
    expect(await runs()).toMatchObject([{ active: 0 }]); // last step, no repeat

    // a resolved incident ends its run without another message
    await db().updateTable('escalation_runs').set({ active: 1, next_step: 1, next_at: new Date(Date.now() - 1000) }).where('id', '=', run.id).execute();
    await db().updateTable('incidents').set({ status: 'resolved' }).where('id', '=', inc.id).execute();
    const before = sent.length;
    await settle();
    expect(sent.length).toBe(before);
    expect(await runs()).toMatchObject([{ active: 0 }]);
  });
});

describe('shutdown', () => {
  it('stop() lets a delivery in flight finish instead of leaving it claimed', async () => {
    const ch = await channel('slow');
    const m = await monitor('n-slow', [{ channelId: ch, events: ['down'] }]);
    await notify(m, 'down');
    slow.set('slow', 300);
    const running = t.ctx.notifier.process();
    await new Promise((r) => setTimeout(r, 50));
    await t.ctx.notifier.stop(5_000);
    await running;
    expect(await deliveries(m)).toMatchObject([{ status: 'sent' }]);
    await notify(m, 'down');
    await settle(); // stopped: picks nothing up
    expect((await deliveries(m))[1]).toMatchObject({ status: 'pending' });
  });
});
