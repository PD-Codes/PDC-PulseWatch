import { sql } from 'kysely';
import { config } from '../config';
import type { Ctx } from '../context';
import type { Database } from '../db';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Keep one partition per day for the raw heartbeat table, plus a catch-all for the future. */
export async function ensurePartitions(db: Database, daysAhead = 3, now = new Date()): Promise<string[]> {
  const rows = await sql<{ PARTITION_NAME: string }>`SELECT PARTITION_NAME FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'heartbeats' AND PARTITION_NAME IS NOT NULL`.execute(db);
  const existing = new Set(rows.rows.map((r) => r.PARTITION_NAME));
  const parts: string[] = [];
  for (let i = 0; i <= daysAhead; i++) {
    const day = addDays(startOfDay(now), i);
    if (!existing.has(`p${ymd(day)}`)) parts.push(`PARTITION p${ymd(day)} VALUES LESS THAN (TO_DAYS('${isoDay(addDays(day, 1))}'))`);
  }
  if (!parts.length) return [];
  await sql.raw(`ALTER TABLE heartbeats REORGANIZE PARTITION p_future INTO (${parts.join(', ')}, PARTITION p_future VALUES LESS THAN MAXVALUE)`).execute(db);
  return parts;
}

/** Dropping a daily partition is the cheap way to expire raw data. */
export async function dropExpiredPartitions(db: Database, rawDays: number, now = new Date()): Promise<string[]> {
  const rows = await sql<{ PARTITION_NAME: string }>`SELECT PARTITION_NAME FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'heartbeats' AND PARTITION_NAME LIKE 'p2%'`.execute(db);
  const cutoff = ymd(addDays(startOfDay(now), -rawDays));
  const drop = rows.rows.map((r) => r.PARTITION_NAME).filter((n) => n.slice(1) < cutoff);
  for (const n of drop) await sql.raw(`ALTER TABLE heartbeats DROP PARTITION ${n}`).execute(db);
  return drop;
}

interface MinuteAgg { total: number; up: number; down: number; maint: number; lats: number[] }
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

/** Aggregate raw heartbeats of [from, to) into per-minute rollups (exact percentiles). */
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

/** Roll finer buckets up into hours/days with SQL. Percentiles become count-weighted averages (documented approximation). */
export async function rollupCoarse(db: Database, res: 'hour' | 'day', from: Date): Promise<void> {
  const src = res === 'hour' ? 'minute' : 'hour';
  const fmt = res === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d 00:00:00';
  const start = res === 'hour' ? new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000) : startOfDay(from);
  await sql`
    INSERT INTO rollups (monitor_id, res, bucket, total, up_n, down_n, maint_n, lat_n, lat_sum, lat_min, lat_max, lat_p50, lat_p95, lat_p99)
    SELECT monitor_id, ${res}, STR_TO_DATE(DATE_FORMAT(bucket, ${fmt}), '%Y-%m-%d %H:%i:%s') AS b,
      SUM(total), SUM(up_n), SUM(down_n), SUM(maint_n), SUM(lat_n), SUM(lat_sum), MIN(lat_min), MAX(lat_max),
      ROUND(SUM(lat_p50 * lat_n) / NULLIF(SUM(lat_n), 0)), ROUND(SUM(lat_p95 * lat_n) / NULLIF(SUM(lat_n), 0)), ROUND(SUM(lat_p99 * lat_n) / NULLIF(SUM(lat_n), 0))
    FROM rollups WHERE res = ${src} AND bucket >= ${start}
    GROUP BY monitor_id, b
    ON DUPLICATE KEY UPDATE total = VALUES(total), up_n = VALUES(up_n), down_n = VALUES(down_n), maint_n = VALUES(maint_n), lat_n = VALUES(lat_n),
      lat_sum = VALUES(lat_sum), lat_min = VALUES(lat_min), lat_max = VALUES(lat_max), lat_p50 = VALUES(lat_p50), lat_p95 = VALUES(lat_p95), lat_p99 = VALUES(lat_p99)`.execute(db);
}

/** Process everything between the stored watermark and now. Safe to run repeatedly. */
export async function runRollups(ctx: Pick<Ctx, 'db' | 'settings'>, now = new Date()): Promise<void> {
  const { db, settings } = ctx;
  const wm = await settings.get<string | null>('rollup.watermark', null);
  let since: Date;
  if (wm) since = new Date(new Date(wm).getTime() - 3 * 60_000);
  else {
    const first = await db.selectFrom('heartbeats').select(sql<Date>`MIN(ts)`.as('t')).executeTakeFirst();
    since = first?.t ? new Date(first.t) : new Date(now.getTime() - 3 * 60_000);
  }
  since = new Date(Math.floor(since.getTime() / 60000) * 60000);
  for (let t = since.getTime(); t < now.getTime(); t += 3_600_000) await rollupMinutes(db, new Date(t), new Date(Math.min(t + 3_600_000, now.getTime() + 60_000)));
  await rollupCoarse(db, 'hour', since);
  await rollupCoarse(db, 'day', since);
  await settings.set('rollup.watermark', now.toISOString());
}

export async function enforceRetention(ctx: Pick<Ctx, 'db' | 'log'>, now = new Date()): Promise<void> {
  const { db, log } = ctx;
  const r = config.retention;
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000);
  await ensurePartitions(db, 3, now);
  const dropped = await dropExpiredPartitions(db, r.rawDays, now);
  if (dropped.length) log.info({ dropped }, 'dropped expired heartbeat partitions');
  for (const [res, days] of [['minute', r.minuteDays], ['hour', r.hourDays], ['day', r.dayDays]] as const) {
    await db.deleteFrom('rollups').where('res', '=', res).where('bucket', '<', cutoff(days)).execute();
  }
  await db.deleteFrom('events').where('ts', '<', cutoff(r.eventDays)).execute();
  await db.deleteFrom('audit_log').where('ts', '<', cutoff(r.auditDays)).execute();
  await db.deleteFrom('sessions').where('expires_at', '<', now).execute();
  await db.deleteFrom('notification_deliveries').where('ts', '<', cutoff(90)).execute();
  await db.deleteFrom('monitor_location_state').where('ts', '<', cutoff(7)).execute();
}

export class Housekeeping {
  private timers: NodeJS.Timeout[] = [];
  constructor(private ctx: Ctx) {}

  async start(): Promise<void> {
    await ensurePartitions(this.ctx.db);
    // A run that is still going when the next tick fires is skipped. Rollups and retention are idempotent, so a second process running them too is harmless.
    const safe = (name: string, fn: () => Promise<unknown>) => {
      let busy = false;
      return () => {
        if (busy) return Promise.resolve();
        busy = true;
        return fn().catch((e) => this.ctx.log.error({ err: e }, `${name} failed`)).finally(() => { busy = false; });
      };
    };
    const rollups = safe('rollups', () => runRollups(this.ctx));
    const retention = safe('retention', () => enforceRetention(this.ctx));
    this.timers.push(setInterval(rollups, 30_000));
    this.timers.push(setInterval(retention, 3_600_000));
    for (const t of this.timers) t.unref();
    void retention();
    void rollups();
  }
  stop() { this.timers.forEach(clearInterval); }
}
