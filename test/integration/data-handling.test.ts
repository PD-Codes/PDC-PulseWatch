// Data handling: rollups with index and time zone, partition lock timeouts, batched retention, the split-mode tailer,
// probe result intake and migration errors.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';
import type { BusEvent } from '../../src/server/bus';

process.env.PW_TIMEZONE = 'Europe/Berlin';

let t: TestApp;
let admin: Awaited<ReturnType<typeof loggedInAdmin>>;
const H = 3_600_000;
const quietLog = () => { const warns: string[] = []; return { warns, log: { info() {}, error() {}, debug() {}, warn: (_o: unknown, m?: string) => { warns.push(String(m)); } } as any }; };
const newMonitor = async (name: string, extra: Record<string, unknown> = {}) => (await admin.post('/api/monitors', { name, type: 'push', config: {}, intervalS: 60, timeoutS: 10, active: false, ...extra })).json.id as number;

beforeAll(async () => { t = await startApp(); admin = await loggedInAdmin(t); });
afterAll(async () => { await t?.close(); delete process.env.PW_TIMEZONE; });

describe('meta', () => {
  it('reports the configured time zone', async () => {
    const m = (await t.client().get('/api/meta')).json;
    expect(m.timezone).toBe('Europe/Berlin');
    expect(m.version).toBeTruthy();
    expect(m.brand).toBeTruthy();
  });
});

describe('rollups', () => {
  it('reads the minute window through idx_hb_location_ts', async () => {
    const plan = await sql<any>`EXPLAIN SELECT monitor_id, ts, status, latency_ms FROM heartbeats WHERE location_id = 0 AND ts >= ${new Date(Date.now() - 180_000)} AND ts < ${new Date()} AND status <> 2`.execute(t.ctx.db);
    expect(String(plan.rows[0].possible_keys)).toContain('idx_hb_location_ts');
  });

  it('builds daily rollups per local day across both DST changes and rebuilds them when the zone changes', async () => {
    const { runRollups } = await import('../../src/server/jobs/housekeeping');
    const id = await newMonitor('dst');
    const rows: any[] = [];
    // one heartbeat every 10 minutes around the March and October changes in Berlin (UTC instants)
    for (const [a, b] of [['2026-03-27T20:00:00Z', '2026-03-30T04:00:00Z'], ['2026-10-23T20:00:00Z', '2026-10-27T04:00:00Z']]) {
      for (let ts = Date.parse(a); ts < Date.parse(b); ts += 600_000) rows.push({ monitor_id: id, location_id: 0, ts: new Date(ts), status: ts % (3 * 600_000) === 0 ? 0 : 1, latency_ms: 50 });
    }
    rows.push({ monitor_id: id, location_id: 7, ts: new Date('2026-10-25T12:00:00Z'), status: 0, latency_ms: null }); // a probe's raw result: not rolled up
    for (let i = 0; i < rows.length; i += 500) await t.ctx.db.insertInto('heartbeats').values(rows.slice(i, i + 500)).execute();
    const { log } = quietLog();
    const ctx = { db: t.ctx.db, settings: t.ctx.settings, log };
    await runRollups(ctx, new Date('2026-10-27T05:00:00Z'), 'Europe/Berlin');
    const day = async (iso: string) => t.ctx.db.selectFrom('rollups').select(['total', 'up_n', 'down_n']).where('monitor_id', '=', id).where('res', '=', 'day').where('bucket', '=', new Date(iso)).executeTakeFirst();
    expect((await day('2026-03-28T23:00:00Z'))?.total).toBe(23 * 6); // 29 March: 23 hours
    expect((await day('2026-10-24T22:00:00Z'))?.total).toBe(25 * 6); // 25 October: 25 hours
    const oct25 = (await day('2026-10-24T22:00:00Z'))!;
    expect(oct25.up_n + oct25.down_n).toBe(150);
    expect(oct25.down_n).toBe(50);
    expect(await day('2026-10-25T00:00:00Z')).toBeUndefined(); // no UTC buckets
    expect(await t.ctx.settings.get('rollup.timezone', null)).toBe('Europe/Berlin');

    // switching to UTC rebuilds the days from the hourly rollups
    await runRollups(ctx, new Date('2026-10-27T05:00:00Z'), 'UTC');
    expect((await day('2026-10-25T00:00:00Z'))?.total).toBe(24 * 6);
    expect((await day('2026-03-29T00:00:00Z'))?.total).toBe(24 * 6);
    expect(await day('2026-10-24T22:00:00Z')).toBeUndefined();
    expect(await t.ctx.settings.get('rollup.timezone', null)).toBe('UTC');
    await runRollups(ctx, new Date('2026-10-27T05:00:00Z'), 'Europe/Berlin');
    expect((await day('2026-10-24T22:00:00Z'))?.total).toBe(150);
  });

  it('shows heatmap days as local days of PW_TIMEZONE', async () => {
    const { recentDays } = await import('../../src/server/tz');
    const id = await newMonitor('heat');
    const { dates } = recentDays('Europe/Berlin', 3);
    const { dayStart } = await import('../../src/server/tz');
    await t.ctx.db.insertInto('rollups').values(dates.map((d, i) => ({ monitor_id: id, res: 'day' as const, bucket: dayStart('Europe/Berlin', d), total: 10, up_n: 10 - i, down_n: i }))).execute();
    const r = await admin.get(`/api/insights/heatmap?monitorId=${id}&days=7`);
    const got = r.json.days.slice(-3);
    expect(got.map((x: any) => x.date)).toEqual(dates);
    expect(got.map((x: any) => x.uptime)).toEqual([100, 90, 80]);
  });
});

describe('partitions', () => {
  it('sets a short lock wait for the ALTER and restores the session afterwards', async () => {
    const { createDb } = await import('../../src/server/db');
    const { withLockWait } = await import('../../src/server/jobs/housekeeping');
    const one = createDb({ pool: 1 }); // a single connection: the check after the call sees the same session
    try {
      const inside = await withLockWait(one, 3, async (conn) => (await sql<any>`SELECT @@SESSION.lock_wait_timeout AS v`.execute(conn)).rows[0].v);
      expect(Number(inside)).toBe(3);
      const after = (await sql<any>`SELECT @@SESSION.lock_wait_timeout AS v, @@GLOBAL.lock_wait_timeout AS g`.execute(one)).rows[0];
      expect(Number(after.v)).toBe(Number(after.g));
    } finally { await one.destroy(); }
  });

  it('gives up waiting behind a long transaction, logs it and succeeds on a later run', async () => {
    const { maintainPartitions } = await import('../../src/server/jobs/housekeeping');
    const holder = await mysql.createConnection({ host: process.env.PW_DB_HOST, port: Number(process.env.PW_DB_PORT), user: process.env.PW_DB_USER, password: process.env.PW_DB_PASSWORD, database: process.env.PW_DB_NAME });
    const later = new Date(Date.now() + 40 * 86_400_000); // needs new partitions
    const { warns, log } = quietLog();
    try {
      await holder.query('START TRANSACTION');
      await holder.query('SELECT COUNT(*) FROM heartbeats'); // holds a metadata lock until commit, like mariadb-dump --single-transaction
      const started = Date.now();
      const r = await maintainPartitions({ db: t.ctx.db, log }, later, { lockWaitS: 1 });
      expect(r.deferred).toBe(true);
      expect(r.created).toEqual([]);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(warns.join('\n')).toMatch(/gave up waiting/);
      await t.ctx.db.insertInto('heartbeats').values({ monitor_id: 1, location_id: 0, ts: new Date(), status: 1, latency_ms: 1 }).execute(); // writes go on
    } finally { await holder.query('COMMIT'); await holder.end(); }
    const again = await maintainPartitions({ db: t.ctx.db, log }, later, { lockWaitS: 1 });
    expect(again.deferred).toBe(false);
    expect(again.created.length).toBeGreaterThanOrEqual(8); // today .. 7 days ahead of `later`
  });
});

describe('retention', () => {
  it('deletes expired rows in batches and keeps the rest', async () => {
    const { enforceRetention } = await import('../../src/server/jobs/housekeeping');
    const old = new Date(Date.now() - 400 * 86_400_000);
    await t.ctx.db.insertInto('events').values(Array.from({ length: 25 }, () => ({ monitor_id: null, ts: old, type: 'test_old' }))).execute();
    await t.ctx.db.insertInto('events').values({ monitor_id: null, ts: new Date(), type: 'test_new' }).execute();
    await t.ctx.db.insertInto('probe_results_seen').values({ probe_id: 99, result_id: 'old', ts: new Date(Date.now() - 3 * 86_400_000) }).execute();
    const statements: string[] = []; // tables of the DELETE statements sent
    const db = t.ctx.db.withPlugin({ transformQuery: (a) => { if (a.node.kind === 'DeleteQueryNode') statements.push((a.node as any).from.froms[0].table.identifier.name); return a.node; }, transformResult: async (a) => a.result });
    const { log } = quietLog();
    await enforceRetention({ db, log }, new Date(), { batch: 10, pauseMs: 0, lockWaitS: 1 });
    const left = await t.ctx.db.selectFrom('events').select('type').where('type', 'like', 'test_%').execute();
    expect(left.map((r) => r.type)).toEqual(['test_new']);
    expect(statements.filter((s) => s === 'events')).toHaveLength(3); // 10 + 10 + 5
    expect(await t.ctx.db.selectFrom('probe_results_seen').selectAll().where('probe_id', '=', 99).execute()).toEqual([]);
  });
});

describe('split-mode tailer', () => {
  it('publishes every changed monitor once, page by page, and catches late commits inside the overlap', async () => {
    const { Tailer } = await import('../../src/server/jobs/tail');
    const events: BusEvent[] = [];
    const unsub = t.ctx.bus.subscribe((e) => events.push(e));
    const { log } = quietLog();
    try {
      const tailer = new Tailer({ db: t.ctx.db, bus: t.ctx.bus, log }, { pageSize: 5, maxPages: 2 });
      await tailer.poll(); // starts at the current end: nothing old is replayed
      expect(events.filter((e) => e.type === 'monitor')).toEqual([]);
      const ids: number[] = [];
      for (let i = 0; i < 12; i++) ids.push(await newMonitor(`tail-${i}`));
      const same = new Date(Date.now() - 1000);
      await t.ctx.db.insertInto('monitor_state').values(ids.map((id) => ({ monitor_id: id, status: 'up' as const, updated_at: same }))).onDuplicateKeyUpdate({ status: 'up', updated_at: same }).execute();
      events.length = 0;
      await tailer.poll(); // at most two pages of five per poll
      expect(events.filter((e) => e.type === 'monitor').length).toBeLessThan(10);
      await tailer.poll(); // the rest, nothing twice
      const monitorIds = (l: BusEvent[]) => l.filter((e) => e.type === 'monitor').map((e) => (e as any).monitorId).sort((a: number, b: number) => a - b);
      expect(monitorIds(events)).toEqual(ids);
      events.length = 0;
      await tailer.poll();
      expect(events).toEqual([]);
      await t.ctx.db.updateTable('monitor_state').set({ status: 'down' }).where('monitor_id', '=', ids[7]).execute();
      await tailer.poll();
      expect(monitorIds(events)).toEqual([ids[7]]);
      expect((events[0] as any).data.status).toBe('down');
      // a change that became visible late: its updated_at is behind the watermark the last poll reached
      events.length = 0;
      const wm = (await t.ctx.db.selectFrom('monitor_state').select('updated_at').where('monitor_id', '=', ids[7]).executeTakeFirstOrThrow()).updated_at;
      await t.ctx.db.updateTable('monitor_state').set({ status: 'down', updated_at: new Date(wm.getTime() - 500) }).where('monitor_id', '=', ids[3]).execute();
      await tailer.poll();
      await tailer.poll();
      expect(monitorIds(events)).toEqual([ids[3]]);

      // automatic incident changes and maintenance events are relayed, changes by people are not (their API published them)
      events.length = 0;
      const inc = Number((await t.ctx.db.insertInto('incidents').values({ title: 'x is down', monitor_id: ids[0], started_at: new Date() }).executeTakeFirstOrThrow()).insertId);
      await t.ctx.db.insertInto('incident_updates').values([{ incident_id: inc, kind: 'auto', status: 'open', body: 'down' }, { incident_id: inc, kind: 'note', user_id: 1, body: 'looking' }]).execute();
      await t.ctx.db.insertInto('events').values([{ monitor_id: ids[1], ts: new Date(), type: 'maintenance_start' }, { monitor_id: ids[2], ts: new Date(), type: 'maintenance_start' }]).execute();
      await tailer.poll();
      expect(events).toEqual([{ type: 'incident', incidentId: inc, monitorId: ids[0], status: 'open' }, { type: 'maintenance' }]);
      events.length = 0;
      await tailer.poll();
      expect(events).toEqual([]);
    } finally { unsub(); }
  });
});

describe('probe results', () => {
  it('corrects the probe clock, keeps backlogs as history, drops future and repeated results', async () => {
    const p = (await admin.post('/api/probes', { name: 'skewed' })).json;
    const m = await newMonitor('remote', { type: 'tcp', config: { host: '127.0.0.1', port: 9 }, locations: [p.id], quorum: 1 });
    const probe = t.client({ bearer: p.token });
    const now = Date.now();
    const skew = -10 * 60_000; // the probe clock runs 10 minutes behind
    const pt = (ms: number) => new Date(now + skew + ms).toISOString();
    const send = (results: unknown[], extra: Record<string, unknown> = {}) => probe.post('/api/probe/v1/results', { results, sentAt: pt(0), ...extra });
    const state = async () => t.ctx.db.selectFrom('monitor_location_state').selectAll().where('monitor_id', '=', m).where('location_id', '=', p.id).executeTakeFirst();
    const beats = async () => t.ctx.db.selectFrom('heartbeats').select(['ts', 'status']).where('monitor_id', '=', m).where('location_id', '=', p.id).orderBy('ts').execute();

    const r1 = await send([{ id: 'a-1', monitorId: m, ts: pt(-2000), ok: true, latencyMs: 12 }], { skipped: 3 });
    expect(r1.json).toMatchObject({ accepted: 1, stale: 0, duplicates: 0, rejected: 0 });
    expect(Math.abs(r1.json.clockOffsetMs - 600_000)).toBeLessThan(5000);
    const s1 = (await state())!;
    expect(Math.abs(s1.ts.getTime() - (now - 2000))).toBeLessThan(5000); // corrected to server time
    expect(s1.ok).toBe(1);

    // a backlog from two hours ago (probe was offline) arrives after the fresh result
    const r2 = await send([{ id: 'a-0', monitorId: m, ts: pt(-2 * H), ok: false, errorKind: 'connect', message: 'refused' }]);
    expect(r2.json).toMatchObject({ accepted: 1, stale: 1 });
    const s2 = (await state())!;
    expect(s2.ok).toBe(1); // the location state stays with the newer result
    expect(s2.ts.getTime()).toBe(s1.ts.getTime());
    const hb = await beats();
    expect(hb).toHaveLength(2);
    expect(Math.abs(hb[0].ts.getTime() - (now - 2 * H))).toBeLessThan(5000); // stored with its real time
    expect(hb[0].status).toBe(0);

    // the same batch again (lost response): stored once
    const r3 = await send([{ id: 'a-1', monitorId: m, ts: pt(-2000), ok: true, latencyMs: 12 }]);
    expect(r3.json).toMatchObject({ accepted: 0, duplicates: 1 });
    // more than a minute in the future even after correction
    const r4 = await send([{ id: 'a-2', monitorId: m, ts: pt(5 * 60_000), ok: true }]);
    expect(r4.json).toMatchObject({ accepted: 0, rejected: 1 });
    expect(await beats()).toHaveLength(2);

    // a state an older probe version wrote far in the future does not freeze the location
    await t.ctx.db.updateTable('monitor_location_state').set({ ts: new Date(now + 50 * 60_000) }).where('monitor_id', '=', m).where('location_id', '=', p.id).execute();
    const r5 = await send([{ id: 'a-3', monitorId: m, ts: pt(-1000), ok: false, errorKind: 'connect' }]);
    expect(r5.json).toMatchObject({ accepted: 1, stale: 0 });
    const s5 = (await state())!;
    expect(s5.ok).toBe(0);
    expect(Math.abs(s5.ts.getTime() - Date.now())).toBeLessThan(5000);

    const listed = (await admin.get('/api/probes')).json.find((x: any) => x.id === p.id);
    expect(listed.skippedRuns).toBe(3);
    expect(Math.abs(listed.clockOffsetMs - 600_000)).toBeLessThan(5000);
  });

  it('still accepts probes without ids, sentAt or ts, and pulls a clock that runs ahead back to now', async () => {
    const p = (await admin.post('/api/probes', { name: 'legacy' })).json;
    const m = await newMonitor('legacy-remote', { type: 'tcp', config: { host: '127.0.0.1', port: 9 }, locations: [p.id], quorum: 1 });
    const probe = t.client({ bearer: p.token });
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
    expect((await probe.post('/api/probe/v1/results', { results: [{ monitorId: m, ts: ahead, ok: false, errorKind: 'connect' }] })).json.accepted).toBe(1);
    const s = await t.ctx.db.selectFrom('monitor_location_state').selectAll().where('monitor_id', '=', m).where('location_id', '=', p.id).executeTakeFirstOrThrow();
    expect(Math.abs(s.ts.getTime() - Date.now())).toBeLessThan(5000);
    expect((await probe.post('/api/probe/v1/results', { results: [{ monitorId: m, ok: true }] })).json.accepted).toBe(1);
    expect((await probe.post('/api/probe/v1/results', { results: [{ monitorId: m, ok: true }] })).json.accepted).toBe(1); // no id: no dedup
  });
});

describe('migrations', () => {
  const conn = () => mysql.createConnection({ host: process.env.PW_DB_HOST, port: Number(process.env.PW_DB_PORT), user: process.env.PW_DB_USER, password: process.env.PW_DB_PASSWORD, database: process.env.PW_DB_NAME });

  it('waits for another process that is migrating instead of failing the start', async () => {
    const { migrate } = await import('../../src/server/db/migrate');
    const holder = await conn();
    const logs: string[] = [];
    try {
      expect((await holder.query<any[]>("SELECT GET_LOCK('pulsewatch_migrate', 30) AS ok"))[0][0].ok).toBe(1);
      setTimeout(() => void holder.query("SELECT RELEASE_LOCK('pulsewatch_migrate')"), 2500);
      const r = await migrate(process.env.PW_MIGRATIONS_DIR, (m) => logs.push(m), { lockPollS: 1 });
      expect(r.applied).toEqual([]);
      expect(logs.filter((l) => l.includes('waiting for migrations of another process')).length).toBeGreaterThanOrEqual(1);
    } finally { await holder.end(); }
  });

  it('retries a DDL statement that waits too long for its table lock', async () => {
    const { migrate } = await import('../../src/server/db/migrate');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-mig-'));
    const holder = await conn();
    const logs: string[] = [];
    try {
      await sql`CREATE TABLE IF NOT EXISTS mig_busy (id INT PRIMARY KEY)`.execute(t.ctx.db);
      fs.writeFileSync(path.join(dir, '901_busy.sql'), 'ALTER TABLE mig_busy ADD COLUMN IF NOT EXISTS x INT;\n');
      await holder.query('START TRANSACTION');
      await holder.query('SELECT COUNT(*) FROM mig_busy'); // metadata lock held like a running dump
      setTimeout(() => void holder.query('COMMIT'), 2500);
      const r = await migrate(dir, (m) => logs.push(m), { ddlLockWaitS: 1, retryDelayMs: 100 });
      expect(r.applied).toEqual(['901_busy.sql']);
      expect(logs.some((l) => /901_busy\.sql statement 1: waited 1s for a table lock/.test(l))).toBe(true);
      const cols = await sql<any>`SHOW COLUMNS FROM mig_busy LIKE 'x'`.execute(t.ctx.db);
      expect(cols.rows).toHaveLength(1);
    } finally {
      await holder.end();
      fs.rmSync(dir, { recursive: true, force: true });
      await sql`DELETE FROM schema_migrations WHERE version = '901_busy.sql'`.execute(t.ctx.db);
      await sql`DROP TABLE IF EXISTS mig_busy`.execute(t.ctx.db);
    }
  });

  it('names file, statement and line when a migration stops half-way', async () => {
    const { migrate } = await import('../../src/server/db/migrate');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-mig-'));
    try {
      fs.writeFileSync(path.join(dir, '900_broken.sql'), '-- test\nCREATE TABLE IF NOT EXISTS mig_probe (id INT PRIMARY KEY);\n\nALTER TABLE mig_missing ADD COLUMN x INT;\n');
      const err = await migrate(dir, () => {}).catch((e) => e);
      expect(err.name).toBe('MigrationError');
      expect(err.message).toMatch(/Migration 900_broken\.sql failed at statement 2 of 2 \(line 4\)/);
      expect(err.message).toMatch(/Statements 1-1 of 900_broken\.sql are already applied/);
      expect(err.message).toMatch(/INSERT INTO schema_migrations \(version, checksum\) VALUES \('900_broken\.sql', '[0-9a-f]{64}'\)/);
      // idempotent first statement: after fixing the file the whole file runs again
      fs.writeFileSync(path.join(dir, '900_broken.sql'), '-- test\nCREATE TABLE IF NOT EXISTS mig_probe (id INT PRIMARY KEY);\n\nALTER TABLE mig_probe ADD COLUMN IF NOT EXISTS x INT;\n');
      expect((await migrate(dir, () => {})).applied).toEqual(['900_broken.sql']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await sql`DELETE FROM schema_migrations WHERE version = '900_broken.sql'`.execute(t.ctx.db);
      await sql`DROP TABLE IF EXISTS mig_probe`.execute(t.ctx.db);
    }
  });
});
