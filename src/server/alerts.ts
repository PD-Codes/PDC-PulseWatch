import { sql } from 'kysely';
import type { CheckResult } from '../core';
import { config } from './config';
import type { Ctx } from './context';
import { parseJson, type Database } from './db';
import { parseMonitor } from './monitors/model';
import { fill, notifyLang, TEXTS, type Lang } from './notify/texts';
import { addDays, dayStart, localDate } from './tz';

/* --------------------------------- snooze --------------------------------- */

export const SNOOZE_MINUTES = { min: 5, max: 10080 } as const;
const SNOOZE_MAX_MS = SNOOZE_MINUTES.max * 60_000;

/** End of a snooze from `{ minutes }` or `{ until }` (ISO, in the future, at most 7 days ahead); a string is the validation message. */
export function snoozeEnd(b: { minutes?: number; until?: string }, now = new Date()): Date | string {
  if ((b.minutes === undefined) === (b.until === undefined)) return 'Send either "minutes" or "until"';
  if (b.minutes !== undefined) {
    if (!Number.isInteger(b.minutes) || b.minutes < SNOOZE_MINUTES.min || b.minutes > SNOOZE_MINUTES.max) return `"minutes" must be an integer between ${SNOOZE_MINUTES.min} and ${SNOOZE_MINUTES.max}`;
    return new Date(now.getTime() + b.minutes * 60_000);
  }
  const until = new Date(b.until!);
  if (Number.isNaN(until.getTime())) return '"until" must be an ISO date';
  if (until <= now) return '"until" must be in the future';
  // a minute of slack for the client's clock
  if (until.getTime() > now.getTime() + SNOOZE_MAX_MS + 60_000) return '"until" can be at most 7 days ahead';
  return until;
}

/**
 * Snooze (or, with null, wake) monitors. While snoozed, no notification of the monitor is queued (Notifier.notify) and escalations
 * wait; checks, events and incidents go on. Deliveries still waiting (backoff, quiet hours) are dropped when the snooze starts.
 */
export async function setSnooze(ctx: Pick<Ctx, 'db'>, ids: number[], until: Date | null): Promise<void> {
  if (!ids.length) return;
  await ctx.db.transaction().execute(async (trx) => {
    await trx.insertInto('monitor_state').values(ids.map((id) => ({ monitor_id: id, snoozed_until: until }))).onDuplicateKeyUpdate({ snoozed_until: until }).execute();
    if (until) await trx.updateTable('notification_deliveries').set({ status: 'skipped', next_attempt_at: null, last_error: 'Alerts snoozed' }).where('monitor_id', 'in', ids).where('status', '=', 'pending').execute();
  });
}

/** Is the monitor snoozed right now? `db` may be the transaction the notifications are queued in. */
export async function isSnoozed(db: Database, monitorId: number, now = new Date()): Promise<Date | null> {
  const r = await db.selectFrom('monitor_state').select('snoozed_until').where('monitor_id', '=', monitorId).where('snoozed_until', '>', now).executeTakeFirst();
  return r?.snoozed_until ?? null;
}

/**
 * End snoozes that ran out. Exactly one process ends each one (compare-and-set on the stored end); if the monitor is still down
 * then, one reminder goes out as a DOWN notification. Returns the monitors that were reminded.
 */
export async function endSnoozes(ctx: Pick<Ctx, 'db' | 'settings' | 'notifier'>, now = new Date()): Promise<number[]> {
  const { db } = ctx;
  const due = await db.selectFrom('monitor_state').select(['monitor_id', 'snoozed_until']).where('snoozed_until', '<=', now).orderBy('snoozed_until').limit(500).execute();
  if (!due.length) return [];
  const lang = (await notifyLang(ctx)).lang;
  const T = TEXTS[lang];
  const reminded: number[] = [];
  for (const d of due) {
    const id = d.monitor_id, end = d.snoozed_until!;
    const queued = await db.transaction().execute(async (trx) => {
      const cas = await trx.updateTable('monitor_state').set({ snoozed_until: null }).where('monitor_id', '=', id).where('snoozed_until', '=', end).executeTakeFirst();
      if (Number(cas.numUpdatedRows) !== 1) return 0;
      const st = await trx.selectFrom('monitor_state').select(['status', 'overlay', 'last_message', 'last_error_kind']).where('monitor_id', '=', id).executeTakeFirst();
      if (st?.status !== 'down' || st.overlay === 'maintenance') return 0;
      const row = await trx.selectFrom('monitors').selectAll().where('id', '=', id).where('active', '=', 1).executeTakeFirst();
      if (!row) return 0;
      // a DOWN that was queued after the snooze ran out (before this job came round) has told everybody already
      if (await trx.selectFrom('notification_deliveries').select('id').where('monitor_id', '=', id).where('event', '=', 'down').where('ts', '>=', end).limit(1).executeTakeFirst()) return 0;
      const inc = await trx.selectFrom('incidents').select('id').where('monitor_id', '=', id).where('source', '=', 'auto').where('status', '!=', 'resolved').orderBy('id', 'desc').executeTakeFirst();
      const result: CheckResult = { ok: false, errorKind: (st.last_error_kind ?? undefined) as CheckResult['errorKind'], message: fill(T.snoozeEnded, { msg: st.last_message ?? T.stillDown }) };
      return ctx.notifier.notify({ event: 'down', monitor: parseMonitor(row), result, incidentId: inc?.id }, { db: trx, lang });
    });
    if (queued) reminded.push(id);
  }
  if (reminded.length) ctx.notifier.kick();
  return reminded;
}

/* ----------------------------------- SLO ----------------------------------- */

export const SLO_WINDOW_DAYS = 30;
const WINDOW_MIN = SLO_WINDOW_DAYS * 1440;
export const SLO_EVAL_EVERY_MS = 5 * 60_000;
/** A breached target counts as met again once this share of the error budget is left (hysteresis against alerting on every wobble). */
export const SLO_RECOVERY_BUDGET_SHARE = 0.05;

/** A target as the API accepts it: 50 <= x < 100 with at most three decimals. */
export const validSloTarget = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 50 && v < 100 && Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;

export interface SloCounts { up: number; down: number }

/**
 * Up/down checks over the rolling 30 days: hourly rollups for the part of the first local day inside the window, daily rollups
 * (local days of PW_TIMEZONE) after it. At most about 24 + 31 rows per monitor.
 */
export async function sloCounts(db: Database, ids: number[], now = new Date(), tz = config.timezone): Promise<Map<number, SloCounts>> {
  if (!ids.length) return new Map();
  const start = new Date(now.getTime() - SLO_WINDOW_DAYS * 86_400_000);
  const first = localDate(tz, start);
  const head = dayStart(tz, first);
  const firstFull = head.getTime() === start.getTime() ? head : dayStart(tz, addDays(first, 1));
  const { rows } = await sql<{ monitor_id: number; u: unknown; d: unknown }>`
    SELECT monitor_id, SUM(up_n) u, SUM(down_n) d FROM rollups
    WHERE monitor_id IN (${sql.join(ids)}) AND ((res = 'hour' AND bucket >= ${start} AND bucket < ${firstFull}) OR (res = 'day' AND bucket >= ${firstFull}))
    GROUP BY monitor_id`.execute(db);
  return new Map(rows.map((r) => [r.monitor_id, { up: Number(r.u ?? 0), down: Number(r.d ?? 0) }]));
}

export interface SloDetail { target: number; uptime30d: number | null; met: boolean | null; budgetMinutes: number; usedMinutes: number; remainingMinutes: number; windowDays: 30 }

const r1 = (n: number) => Math.round(n * 10) / 10 || 0; // no -0

/**
 * Where a monitor stands against its target. Downtime minutes are estimated from the share of failed checks over the whole
 * window (as in the SLA report), so "met" and "budget left" always agree. uptime30d is cut (not rounded) to three decimals,
 * so a value shown as equal to the target never hides a miss.
 */
export function sloDetail(target: number, c: SloCounts | undefined): SloDetail {
  const n = c ? c.up + c.down : 0;
  const budget = (WINDOW_MIN * (100_000 - Math.round(target * 1000))) / 100_000; // in thousandths of a percent: 99.9 gives exactly 43.2
  if (!c || !n) return { target, uptime30d: null, met: null, budgetMinutes: r1(budget), usedMinutes: 0, remainingMinutes: r1(budget), windowDays: 30 };
  const used = (WINDOW_MIN * c.down) / n;
  return {
    target, uptime30d: Math.floor((c.up * 100_000) / n) / 1000, met: c.up * 100_000 >= Math.round(target * 1000) * n, // integer comparison, no float noise at the boundary
    budgetMinutes: r1(budget), usedMinutes: r1(used), remainingMinutes: r1(budget - used), windowDays: 30,
  };
}

/** Compare-and-set on a settings row holding the last run: true for exactly one process per period. */
export async function claimPeriodic(db: Database, key: string, everyMs: number, now = new Date()): Promise<boolean> {
  const value = JSON.stringify(now.toISOString());
  const row = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
  if (!row) return Number((await db.insertInto('settings').values({ key, value }).ignore().executeTakeFirst()).numInsertedOrUpdatedRows ?? 0) === 1;
  const last = Date.parse(parseJson<string>(row.value, ''));
  if (Number.isFinite(last) && now.getTime() - last < everyMs) return false;
  const r = await db.updateTable('settings').set({ value }).where('key', '=', key).where('value', '=', row.value).executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/**
 * Check every active monitor with a target against its 30-day uptime (after the rollups, at most every 5 minutes across all
 * processes). A miss is recorded once (event slo_breach plus a notification); the next one only after the monitor was back
 * above the target with some budget left (event slo_recovered). A miss found while the monitor is snoozed is recorded at once and
 * announced on the first run after the snooze if the target is still missed then. `force` skips the period claim (tests, manual runs).
 */
export async function evaluateSlos(ctx: Pick<Ctx, 'db' | 'settings' | 'notifier'>, now = new Date(), opts: { force?: boolean } = {}): Promise<{ breached: number[]; recovered: number[] } | null> {
  const { db } = ctx;
  if (!opts.force && !(await claimPeriodic(db, 'slo.evaluatedAt', SLO_EVAL_EVERY_MS, now))) return null;
  const out = { breached: [] as number[], recovered: [] as number[] };
  // a removed target forgets its breach
  await db.updateTable('monitor_state').set({ slo_breached: 0 }).where('slo_breached', '!=', 0).where('monitor_id', 'in', db.selectFrom('monitors').select('id').where('slo_target', 'is', null)).execute();
  const mons = await db.selectFrom('monitors as m').innerJoin('monitor_state as s', 's.monitor_id', 'm.id').selectAll('m').select('s.slo_breached').where('m.slo_target', 'is not', null).where('m.active', '=', 1).execute();
  if (!mons.length) return out;
  const counts = await sloCounts(db, mons.map((m) => m.id), now);
  let lang: Lang | undefined;
  let queued = 0;
  for (const row of mons) {
    const target = Number(row.slo_target);
    const s = sloDetail(target, counts.get(row.id));
    if (s.met === null) continue;
    const c = counts.get(row.id)!;
    // slo_breached: 0 met, 1 miss announced, 2 miss recorded while snoozed (the notification follows after the snooze)
    const state = Number(row.slo_breached);
    if (state !== 1 && !s.met) {
      lang ??= (await notifyLang(ctx)).lang;
      const n = await db.transaction().execute(async (trx) => {
        const snoozed = !!(await isSnoozed(trx, row.id, now));
        if (snoozed && state === 2) return -1; // recorded already, still waiting for the end of the snooze
        const cas = await trx.updateTable('monitor_state').set({ slo_breached: snoozed ? 2 : 1 }).where('monitor_id', '=', row.id).where('slo_breached', '=', state).executeTakeFirst();
        if (Number(cas.numUpdatedRows) !== 1) return -1;
        if (state === 0) await trx.insertInto('events').values({ monitor_id: row.id, ts: now, type: 'slo_breach', error_kind: null, message: `30-day uptime ${s.uptime30d}% is below the target of ${target}%`, details: JSON.stringify(s) }).execute();
        return snoozed ? 0 : ctx.notifier.notify({ event: 'slo', monitor: parseMonitor(row), slo: s }, { db: trx, lang });
      });
      if (n >= 0) { out.breached.push(row.id); queued += n; }
    } else if (state !== 0 && s.met && c.up * 100 >= (target + SLO_RECOVERY_BUDGET_SHARE * (100 - target)) * (c.up + c.down)) {
      const done = await db.transaction().execute(async (trx) => {
        const cas = await trx.updateTable('monitor_state').set({ slo_breached: 0 }).where('monitor_id', '=', row.id).where('slo_breached', '=', state).executeTakeFirst();
        if (Number(cas.numUpdatedRows) !== 1) return false;
        await trx.insertInto('events').values({ monitor_id: row.id, ts: now, type: 'slo_recovered', error_kind: null, message: `30-day uptime ${s.uptime30d}% meets the target of ${target}% again`, details: JSON.stringify(s) }).execute();
        return true;
      });
      if (done) out.recovered.push(row.id);
    }
  }
  if (queued) ctx.notifier.kick();
  return out;
}
