import { sql, type Kysely } from 'kysely';
import { config } from '../config';
import type { Ctx } from '../context';
import type { Database } from '../db';
import type { DB } from '../db/types';
import { endSnoozes, evaluateSlos } from '../alerts';
import { localDays, startOfLocalDay } from '../tz';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Partitions are created this many days ahead, so a few failed attempts (lock timeouts) never leave a day without one. */
export const PARTITION_DAYS_AHEAD = 7;
/** Seconds a partition ALTER waits for its metadata lock. While it waits, every heartbeat INSERT queues behind it. */
export const PARTITION_LOCK_WAIT_S = 5;

/** MariaDB answers ER_LOCK_WAIT_TIMEOUT (1205) when a statement gave up waiting for a (metadata) lock. */
export const isLockTimeout = (e: unknown) => (e as { errno?: number })?.errno === 1205;

/**
 * Run DDL on one pooled connection with a short lock_wait_timeout (the default is a day). An ALTER that waits for its exclusive
 * metadata lock, e.g. behind `mariadb-dump --single-transaction`, blocks all writes to the table, so it gives up quickly instead.
 */
export async function withLockWait<T>(db: Database, seconds: number, fn: (conn: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.connection().execute(async (conn) => {
    await sql.raw(`SET SESSION lock_wait_timeout = ${Math.max(1, Math.floor(seconds))}`).execute(conn);
    try { return await fn(conn); } finally { await sql`SET SESSION lock_wait_timeout = DEFAULT`.execute(conn).catch(() => {}); }
  });
}

/** Keep one partition per day for the raw heartbeat table, plus a catch-all for the future. */
export async function ensurePartitions(db: Database, daysAhead = PARTITION_DAYS_AHEAD, now = new Date(), lockWaitS = PARTITION_LOCK_WAIT_S): Promise<string[]> {
  const rows = await sql<{ PARTITION_NAME: string }>`SELECT PARTITION_NAME FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'heartbeats' AND PARTITION_NAME IS NOT NULL`.execute(db);
  // only p_future can be split, so new days go after the last dated partition (rows of an older missing day land in the next one)
  const last = rows.rows.map((r) => r.PARTITION_NAME).filter((n) => /^p\d{8}$/.test(n)).sort().pop() ?? '';
  const parts: string[] = [];
  for (let i = 0; i <= daysAhead; i++) {
    const day = addDays(startOfDay(now), i);
    if (`p${ymd(day)}` > last) parts.push(`PARTITION p${ymd(day)} VALUES LESS THAN (TO_DAYS('${isoDay(addDays(day, 1))}'))`);
  }
  if (!parts.length) return [];
  await withLockWait(db, lockWaitS, (conn) => sql.raw(`ALTER TABLE heartbeats REORGANIZE PARTITION p_future INTO (${parts.join(', ')}, PARTITION p_future VALUES LESS THAN MAXVALUE)`).execute(conn));
  return parts;
}

/** Dropping a daily partition is the cheap way to expire raw data. */
export async function dropExpiredPartitions(db: Database, rawDays: number, now = new Date(), lockWaitS = PARTITION_LOCK_WAIT_S): Promise<string[]> {
  const rows = await sql<{ PARTITION_NAME: string }>`SELECT PARTITION_NAME FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'heartbeats' AND PARTITION_NAME LIKE 'p2%'`.execute(db);
  const cutoff = ymd(addDays(startOfDay(now), -rawDays));
  const drop = rows.rows.map((r) => r.PARTITION_NAME).filter((n) => n.slice(1) < cutoff).sort();
  const done: string[] = [];
  await withLockWait(db, lockWaitS, async (conn) => {
    for (const n of drop) { await sql.raw(`ALTER TABLE heartbeats DROP PARTITION ${n}`).execute(conn); done.push(n); }
  }).catch((e) => { if (done.length) Object.assign(e as object, { dropped: done }); throw e; });
  return done;
}

/**
 * Create upcoming and drop expired partitions. A lock timeout is logged and left to the next run (retention runs hourly and
 * partitions exist a week ahead); the rows of a missing day land in p_future meanwhile and nothing is lost.
 */
export async function maintainPartitions(ctx: Pick<Ctx, 'db' | 'log'>, now = new Date(), opts: { rawDays?: number; lockWaitS?: number } = {}): Promise<{ created: string[]; dropped: string[]; deferred: boolean }> {
  const { db, log } = ctx;
  const out = { created: [] as string[], dropped: [] as string[], deferred: false };
  const lockWaitS = opts.lockWaitS ?? PARTITION_LOCK_WAIT_S;
  const attempt = async (what: string, fn: () => Promise<string[]>, into: string[]) => {
    try { into.push(...(await fn())); } catch (e) {
      if (!isLockTimeout(e)) throw e;
      into.push(...((e as { dropped?: string[] }).dropped ?? []));
      out.deferred = true;
      log.warn({ lockWaitS }, `heartbeat partitions: ${what} gave up waiting for the table lock (a long transaction or backup holds it); retrying on the next run`);
    }
  };
  await attempt('creating partitions', () => ensurePartitions(db, PARTITION_DAYS_AHEAD, now, lockWaitS), out.created);
  if (opts.rawDays !== undefined) await attempt('dropping expired partitions', () => dropExpiredPartitions(db, opts.rawDays!, now, lockWaitS), out.dropped);
  return out;
}

/**
 * Delete in small batches with short pauses, so a large expiry never holds locks for long, never builds a huge undo log and
 * leaves room for the regular writes in between.
 */
export async function deleteInBatches(run: (limit: number) => Promise<{ numDeletedRows: bigint }>, opts: { batch?: number; pauseMs?: number } = {}): Promise<{ deleted: number; batches: number }> {
  const batch = opts.batch ?? 10_000, pauseMs = opts.pauseMs ?? 50;
  let deleted = 0, batches = 0;
  for (;;) {
    const n = Number((await run(batch)).numDeletedRows);
    deleted += n; batches++;
    if (n < batch) return { deleted, batches };
    await sleep(pauseMs);
  }
}

interface MinuteAgg { total: number; up: number; down: number; maint: number; lats: number[] }
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
const UPSERT = sql`ON DUPLICATE KEY UPDATE total = VALUES(total), up_n = VALUES(up_n), down_n = VALUES(down_n), maint_n = VALUES(maint_n), lat_n = VALUES(lat_n),
      lat_sum = VALUES(lat_sum), lat_min = VALUES(lat_min), lat_max = VALUES(lat_max), lat_p50 = VALUES(lat_p50), lat_p95 = VALUES(lat_p95), lat_p99 = VALUES(lat_p99)`;
const AGG = sql`SUM(total), SUM(up_n), SUM(down_n), SUM(maint_n), SUM(lat_n), SUM(lat_sum), MIN(lat_min), MAX(lat_max),
      ROUND(SUM(lat_p50 * lat_n) / NULLIF(SUM(lat_n), 0)), ROUND(SUM(lat_p95 * lat_n) / NULLIF(SUM(lat_n), 0)), ROUND(SUM(lat_p99 * lat_n) / NULLIF(SUM(lat_n), 0))`;

/** Aggregate raw heartbeats of [from, to) into per-minute rollups (exact percentiles). Uses idx_hb_location_ts (migration 020). */
export async function rollupMinutes(db: Database, from: Date, to: Date): Promise<number> {
  const rows = await db.selectFrom('heartbeats').select(['monitor_id', 'ts', 'status', 'latency_ms']).where('location_id', '=', 0).where('ts', '>=', from).where('ts', '<', to).where('status', '!=', 2).execute();
  const buckets = new Map<string, { monitor: number; bucket: Date; a: MinuteAgg }>();
  for (const r of rows) {
    const b = new Date(Math.floor(r.ts.getTime() / 60000) * 60000);
    const key = `${r.monitor_id}|${b.getTime()}`;
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = { monitor: r.monitor_id, bucket: b, a: { total: 0, up: 0, down: 0, maint: 0, lats: [] } }));
    e.a.total++;
    if (r.status === 1) e.a.up++; else if (r.status === 3) e.a.maint++; else e.a.down++;
    if (r.status === 1 && r.latency_ms != null) e.a.lats.push(r.latency_ms);
  }
  const list = [...buckets.values()];
  for (let i = 0; i < list.length; i += 500) {
    const values = list.slice(i, i + 500).map(({ monitor, bucket, a }) => {
      const s = a.lats.sort((x, y) => x - y);
      return {
        monitor_id: monitor, res: 'minute' as const, bucket, total: a.total, up_n: a.up, down_n: a.down, maint_n: a.maint, lat_n: s.length,
        lat_sum: s.reduce((x, y) => x + y, 0), lat_min: s[0] ?? null, lat_max: s[s.length - 1] ?? null,
        lat_p50: s.length ? pct(s, 50) : null, lat_p95: s.length ? pct(s, 95) : null, lat_p99: s.length ? pct(s, 99) : null,
      };
    });
    const cols = ['total', 'up_n', 'down_n', 'maint_n', 'lat_n', 'lat_sum', 'lat_min', 'lat_max', 'lat_p50', 'lat_p95', 'lat_p99'] as const;
    await db.insertInto('rollups').values(values).onDuplicateKeyUpdate(Object.fromEntries(cols.map((c) => [c, sql.raw(`VALUES(${c})`)])) as any).execute();
  }
  return list.length;
}

/**
 * Daily rollups from the hourly ones, one local day of `tz` at a time (a day's bucket is the instant its local midnight falls on).
 * shortcut: an hour bucket counts for the day its start falls in, so zones with a half-hour offset (India, Nepal, ...) put up
 * to 45 minutes around midnight into the neighbouring day.
 */
export async function rollupDays(db: Database, tz: string, from: Date, to: Date): Promise<number> {
  const days = localDays(tz, from, to);
  for (const d of days) {
    await sql`
      INSERT INTO rollups (monitor_id, res, bucket, total, up_n, down_n, maint_n, lat_n, lat_sum, lat_min, lat_max, lat_p50, lat_p95, lat_p99)
      SELECT monitor_id, 'day', ${d.start}, ${AGG}
      FROM rollups WHERE res = 'hour' AND bucket >= ${d.start} AND bucket < ${d.end}
      GROUP BY monitor_id
      ${UPSERT}`.execute(db);
  }
  return days.length;
}

/** Roll finer buckets up into hours/days with SQL. Percentiles become count-weighted averages (documented approximation). */
export async function rollupCoarse(db: Database, res: 'hour' | 'day', from: Date, tz = config.timezone): Promise<void> {
  if (res === 'day') { await rollupDays(db, tz, from, new Date()); return; }
  const start = new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000);
  await sql`
    INSERT INTO rollups (monitor_id, res, bucket, total, up_n, down_n, maint_n, lat_n, lat_sum, lat_min, lat_max, lat_p50, lat_p95, lat_p99)
    SELECT monitor_id, 'hour', STR_TO_DATE(DATE_FORMAT(bucket, '%Y-%m-%d %H:00:00'), '%Y-%m-%d %H:%i:%s') AS b, ${AGG}
    FROM rollups WHERE res = 'minute' AND bucket >= ${start}
    GROUP BY monitor_id, b
    ${UPSERT}`.execute(db);
}

/**
 * Rebuild the daily rollups in a new time zone from the hourly ones, for as far back as those are kept.
 * shortcut: daily rollups older than the hourly retention keep the old day boundaries; the old bucket right before the first
 * rebuilt day may overlap it by a few hours.
 */
export async function rebuildDayRollups(db: Database, tz: string, now = new Date(), opts: { batch?: number; pauseMs?: number } = {}): Promise<number> {
  const first = await db.selectFrom('rollups').select(sql<Date | null>`MIN(bucket)`.as('t')).where('res', '=', 'hour').executeTakeFirst();
  if (!first?.t) return 0;
  const from = startOfLocalDay(tz, new Date(first.t));
  await deleteInBatches((n) => db.deleteFrom('rollups').where('res', '=', 'day').where('bucket', '>=', from).limit(n).executeTakeFirst(), opts);
  return rollupDays(db, tz, from, now);
}

/** Make sure the daily rollups use the configured zone. Installs from before PW_TIMEZONE counted days in UTC. */
export async function syncRollupZone(ctx: Pick<Ctx, 'db' | 'settings' | 'log'>, tz: string, now = new Date()): Promise<boolean> {
  const applied = await ctx.settings.get<string | null>('rollup.timezone', null);
  if (applied === tz) return false;
  const was = applied ?? 'UTC';
  if (was !== tz) {
    ctx.log.info({ from: was, to: tz }, 'time zone changed: rebuilding daily rollups from hourly rollups');
    const days = await rebuildDayRollups(ctx.db, tz, now);
    ctx.log.info({ days, timezone: tz }, 'daily rollups rebuilt');
  }
  await ctx.settings.set('rollup.timezone', tz);
  return was !== tz;
}

/** Process everything between the stored watermark and now. Safe to run repeatedly. */
export async function runRollups(ctx: Pick<Ctx, 'db' | 'settings' | 'log'>, now = new Date(), tz = config.timezone): Promise<void> {
  const { db, settings } = ctx;
  const wm = await settings.get<string | null>('rollup.watermark', null);
  let since: Date;
  if (wm) since = new Date(new Date(wm).getTime() - 3 * 60_000);
  else {
    const first = await db.selectFrom('heartbeats').select(sql<Date>`MIN(ts)`.as('t')).where('location_id', '=', 0).executeTakeFirst();
    since = first?.t ? new Date(first.t) : new Date(now.getTime() - 3 * 60_000);
  }
  since = new Date(Math.floor(since.getTime() / 60000) * 60000);
  for (let t = since.getTime(); t < now.getTime(); t += 3_600_000) await rollupMinutes(db, new Date(t), new Date(Math.min(t + 3_600_000, now.getTime() + 60_000)));
  await rollupCoarse(db, 'hour', since);
  await syncRollupZone(ctx, tz, now);
  await rollupDays(db, tz, since, now);
  await settings.set('rollup.watermark', now.toISOString());
}

export interface RetentionOpts { batch?: number; pauseMs?: number; lockWaitS?: number }

export async function enforceRetention(ctx: Pick<Ctx, 'db' | 'log'>, now = new Date(), opts: RetentionOpts = {}): Promise<void> {
  const { db, log } = ctx;
  const r = config.retention;
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const parts = await maintainPartitions(ctx, now, { rawDays: r.rawDays, lockWaitS: opts.lockWaitS });
  if (parts.dropped.length) log.info({ dropped: parts.dropped }, 'dropped expired heartbeat partitions');
  const del = (fn: (limit: number) => Promise<{ numDeletedRows: bigint }>) => deleteInBatches(fn, opts);
  for (const [res, days] of [['minute', r.minuteDays], ['hour', r.hourDays], ['day', r.dayDays]] as const) {
    await del((n) => db.deleteFrom('rollups').where('res', '=', res).where('bucket', '<', cutoff(days)).limit(n).executeTakeFirst());
  }
  await del((n) => db.deleteFrom('events').where('ts', '<', cutoff(r.eventDays)).limit(n).executeTakeFirst());
  await del((n) => db.deleteFrom('audit_log').where('ts', '<', cutoff(r.auditDays)).limit(n).executeTakeFirst());
  await del((n) => db.deleteFrom('sessions').where('expires_at', '<', now).limit(n).executeTakeFirst());
  await del((n) => db.deleteFrom('notification_deliveries').where('ts', '<', cutoff(90)).limit(n).executeTakeFirst());
  await del((n) => db.deleteFrom('monitor_location_state').where('ts', '<', cutoff(7)).limit(n).executeTakeFirst());
  await del((n) => db.deleteFrom('probe_results_seen').where('ts', '<', cutoff(2)).limit(n).executeTakeFirst());
}

export class Housekeeping {
  private timers: NodeJS.Timeout[] = [];
  constructor(private ctx: Ctx) {}

  async start(): Promise<void> {
    // tolerant: a failure here (lock timeout, database briefly away) is retried by the hourly retention run
    await maintainPartitions(this.ctx).catch((e) => this.ctx.log.error({ err: e }, 'heartbeat partition maintenance failed'));
    // A run that is still going when the next tick fires is skipped. Rollups and retention are idempotent, so a second process running them too is harmless.
    const safe = (name: string, fn: () => Promise<unknown>) => {
      let busy = false;
      return () => {
        if (busy) return Promise.resolve();
        busy = true;
        return fn().catch((e) => this.ctx.log.error({ err: e }, `${name} failed`)).finally(() => { busy = false; });
      };
    };
    // SLO targets are checked on fresh rollups; evaluateSlos itself runs at most every 5 minutes across all processes
    const rollups = safe('rollups', async () => { await runRollups(this.ctx); await evaluateSlos(this.ctx); });
    const retention = safe('retention', () => enforceRetention(this.ctx));
    const snoozes = safe('snooze end', () => endSnoozes(this.ctx));
    this.timers.push(setInterval(rollups, 30_000));
    this.timers.push(setInterval(snoozes, 15_000));
    this.timers.push(setInterval(retention, 3_600_000));
    for (const t of this.timers) t.unref();
    void retention();
    void rollups();
  }
  stop() { this.timers.forEach(clearInterval); }
}
