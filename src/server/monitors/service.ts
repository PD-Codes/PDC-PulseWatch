import crypto from 'node:crypto';
import { sql } from 'kysely';
import { getRunner, maskSecrets, restoreSecrets, validateConfig } from '../../core';
import type { Ctx } from '../context';
import { parseJson } from '../db';
import { encryptConfig, parseMonitor, type Monitor } from './model';

export interface MonitorInput {
  name?: string; type?: string; groupId?: number | null; description?: string | null; config?: Record<string, any>;
  intervalS?: number; timeoutS?: number; retries?: number; retryIntervalS?: number; upThreshold?: number; downThreshold?: number;
  flapWindow?: number; flapThreshold?: number; active?: boolean; locations?: (number | 'local')[] | null; quorum?: number; publicBadge?: boolean;
  tagIds?: number[]; dependsOn?: number[]; notifications?: { channelId?: number | null; policyId?: number | null; events?: string[] }[];
}

const num = (v: unknown, def: number, min: number, max: number, label: string, errors: string[]) => {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) { errors.push(`${label} must be an integer between ${min} and ${max}`); return def; }
  return n;
};

export class ValidationError extends Error {
  constructor(public errors: string[]) { super(errors.join('; ')); }
}

/** Would adding edges monitor -> deps create a dependency cycle? */
async function hasCycle(ctx: Ctx, monitorId: number, deps: number[]): Promise<boolean> {
  if (deps.includes(monitorId)) return true;
  const all = await ctx.db.selectFrom('monitor_dependencies').selectAll().execute();
  const graph = new Map<number, number[]>();
  for (const e of all) if (e.monitor_id !== monitorId) graph.set(e.monitor_id, [...(graph.get(e.monitor_id) ?? []), e.depends_on_id]);
  const seen = new Set<number>();
  const stack = [...deps];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === monitorId) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(graph.get(n) ?? []));
  }
  return false;
}

export async function saveMonitor(ctx: Ctx, input: MonitorInput, userId: number | null, existing?: Monitor): Promise<number> {
  const { db } = ctx;
  const errors: string[] = [];
  const type = existing?.type ?? input.type;
  const runner = type ? getRunner(type) : undefined;
  if (!runner) throw new ValidationError([`Unknown monitor type "${type}"`]);
  if (existing && input.type && input.type !== existing.type) throw new ValidationError(['The monitor type cannot be changed, clone the monitor instead']);
  const name = (input.name ?? existing?.name ?? '').trim();
  if (!name || name.length > 255) errors.push('Name is required (max 255 characters)');

  let config = input.config ?? existing?.config ?? {};
  if (existing && input.config) config = restoreSecrets(runner, input.config, existing.config);
  const v = validateConfig(runner, config);
  errors.push(...v.errors);

  const intervalS = num(input.intervalS ?? existing?.intervalS, 60, 5, 86400, 'Interval', errors);
  const timeoutS = num(input.timeoutS ?? existing?.timeoutS, 10, 1, 300, 'Timeout', errors);
  const row = {
    name, type: runner.type, group_id: input.groupId === undefined ? existing?.groupId ?? null : input.groupId, description: input.description === undefined ? existing?.description ?? null : input.description,
    config: JSON.stringify(encryptConfig(runner, v.config)), interval_s: intervalS, timeout_s: timeoutS,
    retries: num(input.retries ?? existing?.retries, 0, 0, 20, 'Retries', errors), retry_interval_s: num(input.retryIntervalS ?? existing?.retryIntervalS, 20, 5, 3600, 'Retry interval', errors),
    up_threshold: num(input.upThreshold ?? existing?.upThreshold, 1, 1, 20, 'Up threshold', errors), down_threshold: num(input.downThreshold ?? existing?.downThreshold, 1, 1, 20, 'Down threshold', errors),
    flap_window: num(input.flapWindow ?? existing?.flapWindow, 10, 4, 60, 'Flap window', errors), flap_threshold: num(input.flapThreshold ?? existing?.flapThreshold, 6, 0, 60, 'Flap threshold', errors),
    active: (input.active ?? existing?.active ?? true) ? 1 : 0, public_badge: (input.publicBadge ?? existing?.publicBadge ?? false) ? 1 : 0,
  };
  let locations = input.locations === undefined ? existing?.locations ?? null : input.locations;
  if (locations && !locations.length) locations = null;
  if (locations) {
    const probeIds = locations.filter((l): l is number => l !== 'local');
    if (probeIds.length) {
      const found = await db.selectFrom('probes').select('id').where('id', 'in', probeIds).execute();
      if (found.length !== new Set(probeIds).size) errors.push('Unknown probe in locations');
    }
    if (runner.type === 'push') errors.push('Push monitors cannot run from probes');
  }
  const quorum = num(input.quorum ?? existing?.quorum, 1, 1, 50, 'Quorum', errors);
  if (locations && quorum > locations.length) errors.push('Quorum cannot exceed the number of locations');
  if (errors.length) throw new ValidationError(errors);

  const deps = input.dependsOn ? [...new Set(input.dependsOn)] : undefined;

  return db.transaction().execute(async (trx) => {
    let id: number;
    const common = { ...row, locations: locations ? JSON.stringify(locations) : null, quorum };
    if (existing) {
      id = existing.id;
      if (deps && (await hasCycle(ctx, id, deps))) throw new ValidationError(['Dependencies must not form a cycle']);
      await trx.updateTable('monitors').set(common).where('id', '=', id).execute();
      // changing the interval or resuming should take effect soon
      if (!existing.active && common.active) await trx.updateTable('monitors').set({ next_run_at: new Date(), attempt: 0 }).where('id', '=', id).execute();
      if (existing.intervalS !== intervalS && common.active) await trx.updateTable('monitors').set({ next_run_at: new Date(Date.now() + Math.random() * Math.min(intervalS, 10) * 1000) }).where('id', '=', id).execute();
    } else {
      const r = await trx.insertInto('monitors').values({
        ...common, created_by: userId, push_token: runner.type === 'push' ? crypto.randomBytes(16).toString('hex') : null,
        next_run_at: new Date(Date.now() + Math.random() * Math.min(intervalS, 10) * 1000),
      }).executeTakeFirstOrThrow();
      id = Number(r.insertId);
      await trx.insertInto('monitor_state').values({ monitor_id: id }).execute();
      if (deps && (await hasCycle(ctx, id, deps))) throw new ValidationError(['Dependencies must not form a cycle']);
    }
    if (input.tagIds) {
      await trx.deleteFrom('monitor_tags').where('monitor_id', '=', id).execute();
      if (input.tagIds.length) await trx.insertInto('monitor_tags').values([...new Set(input.tagIds)].map((t) => ({ monitor_id: id, tag_id: t }))).execute();
    }
    if (deps) {
      await trx.deleteFrom('monitor_dependencies').where('monitor_id', '=', id).execute();
      if (deps.length) await trx.insertInto('monitor_dependencies').values(deps.map((d) => ({ monitor_id: id, depends_on_id: d }))).execute();
    }
    if (input.notifications) {
      await trx.deleteFrom('monitor_notifications').where('monitor_id', '=', id).execute();
      const rules = input.notifications.filter((n) => n.channelId || n.policyId);
      if (rules.length) await trx.insertInto('monitor_notifications').values(rules.map((n) => ({ monitor_id: id, channel_id: n.channelId ?? null, policy_id: n.policyId ?? null, events: (n.events?.length ? n.events : ['down', 'up']).join(',') }))).execute();
    }
    return id;
  });
}

export async function loadMonitor(ctx: Ctx, id: number): Promise<Monitor | null> {
  const row = await ctx.db.selectFrom('monitors').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? parseMonitor(row) : null;
}

/* ------------------------------ read models ------------------------------ */
export interface UptimeSet { h24: number | null; d7: number | null; d30: number | null; d90: number | null; d365: number | null }

const pctOf = (up: number | null, down: number | null): number | null => {
  const u = Number(up ?? 0), d = Number(down ?? 0);
  return u + d === 0 ? null : Math.round((u / (u + d)) * 10000) / 100;
};

export async function uptimeFor(ctx: Ctx, ids: number[] | null): Promise<Map<number, UptimeSet>> {
  const now = Date.now();
  const t = (ms: number) => new Date(now - ms);
  const D = 86_400_000;
  const r = await sql<any>`
    SELECT monitor_id,
      SUM(CASE WHEN res='hour' AND bucket >= ${t(D)} THEN up_n END) u24, SUM(CASE WHEN res='hour' AND bucket >= ${t(D)} THEN down_n END) d24,
      SUM(CASE WHEN res='hour' AND bucket >= ${t(7 * D)} THEN up_n END) u7, SUM(CASE WHEN res='hour' AND bucket >= ${t(7 * D)} THEN down_n END) d7,
      SUM(CASE WHEN res='day' AND bucket >= ${t(30 * D)} THEN up_n END) u30, SUM(CASE WHEN res='day' AND bucket >= ${t(30 * D)} THEN down_n END) d30,
      SUM(CASE WHEN res='day' AND bucket >= ${t(90 * D)} THEN up_n END) u90, SUM(CASE WHEN res='day' AND bucket >= ${t(90 * D)} THEN down_n END) d90,
      SUM(CASE WHEN res='day' AND bucket >= ${t(365 * D)} THEN up_n END) u365, SUM(CASE WHEN res='day' AND bucket >= ${t(365 * D)} THEN down_n END) d365
    FROM rollups WHERE ((res='hour' AND bucket >= ${t(7 * D)}) OR (res='day' AND bucket >= ${t(365 * D)})) ${ids ? sql`AND monitor_id IN (${sql.join(ids.length ? ids : [0])})` : sql``}
    GROUP BY monitor_id`.execute(ctx.db);
  return new Map(r.rows.map((x: any) => [x.monitor_id, { h24: pctOf(x.u24, x.d24), d7: pctOf(x.u7, x.d7), d30: pctOf(x.u30, x.d30), d90: pctOf(x.u90, x.d90), d365: pctOf(x.u365, x.d365) }]));
}

export async function listMonitors(ctx: Ctx, ids: number[] | null) {
  const { db } = ctx;
  if (ids && !ids.length) return [];
  let q = db.selectFrom('monitors as m').leftJoin('monitor_state as s', 's.monitor_id', 'm.id')
    .select(['m.id', 'm.name', 'm.type', 'm.group_id', 'm.active', 'm.interval_s', 'm.description', 'm.public_badge', 'm.locations', 'm.push_token', 's.status', 's.overlay', 's.status_since', 's.last_check_at', 's.last_latency_ms', 's.last_error_kind', 's.last_message', 's.flapping', 's.recent', 's.cert_expires_at', 's.anomaly'])
    .orderBy('m.name');
  if (ids) q = q.where('m.id', 'in', ids);
  const rows = await q.execute();
  const mids = rows.map((r) => r.id);
  const [tags, deps, uptime] = await Promise.all([
    mids.length ? db.selectFrom('monitor_tags as mt').innerJoin('tags as t', 't.id', 'mt.tag_id').select(['mt.monitor_id', 't.id', 't.name', 't.color']).where('mt.monitor_id', 'in', mids).execute() : [],
    mids.length ? db.selectFrom('monitor_dependencies').selectAll().where('monitor_id', 'in', mids).execute() : [],
    uptimeFor(ctx, ids ?? (mids.length ? mids : [0])),
  ]);
  return rows.map((r) => ({
    id: r.id, name: r.name, type: r.type, groupId: r.group_id, active: !!r.active, intervalS: r.interval_s, description: r.description,
    status: r.status ?? 'unknown', overlay: r.overlay ?? 'none', statusSince: r.status_since, lastCheckAt: r.last_check_at, latencyMs: r.last_latency_ms,
    errorKind: r.last_error_kind, message: r.last_message, flapping: !!r.flapping, recent: parseJson<unknown[]>(r.recent, []),
    certExpiresAt: r.cert_expires_at, anomaly: !!parseJson<{ flagged?: boolean }>(r.anomaly, {}).flagged, publicBadge: !!r.public_badge,
    locations: parseJson(r.locations, null), pushToken: r.push_token,
    tags: tags.filter((t) => t.monitor_id === r.id).map((t) => ({ id: t.id, name: t.name, color: t.color })),
    dependsOn: deps.filter((d) => d.monitor_id === r.id).map((d) => d.depends_on_id),
    uptime: uptime.get(r.id) ?? { h24: null, d7: null, d30: null, d90: null, d365: null },
  }));
}

export async function monitorDetail(ctx: Ctx, id: number) {
  const m = await loadMonitor(ctx, id);
  if (!m) return null;
  const { db } = ctx;
  const [list, notifications, locStates, st] = await Promise.all([
    listMonitors(ctx, [id]),
    db.selectFrom('monitor_notifications').selectAll().where('monitor_id', '=', id).execute(),
    db.selectFrom('monitor_location_state').selectAll().where('monitor_id', '=', id).execute(),
    db.selectFrom('monitor_state').select(['cert_info', 'anomaly', 'consecutive_fail', 'consecutive_ok']).where('monitor_id', '=', id).executeTakeFirst(),
  ]);
  const runner = getRunner(m.type);
  const probes = locStates.length ? await db.selectFrom('probes').select(['id', 'name']).where('id', 'in', locStates.map((l) => l.location_id)).execute() : [];
  return {
    ...list[0],
    config: maskSecrets(runner, m.config), timeoutS: m.timeoutS, retries: m.retries, retryIntervalS: m.retryIntervalS, upThreshold: m.upThreshold, downThreshold: m.downThreshold,
    flapWindow: m.flapWindow, flapThreshold: m.flapThreshold, quorum: m.quorum,
    notifications: notifications.map((n) => ({ channelId: n.channel_id, policyId: n.policy_id, events: n.events.split(',') })),
    locationStates: locStates.map((l) => ({ locationId: l.location_id, name: l.location_id === 4294967295 ? 'Server' : probes.find((p) => p.id === l.location_id)?.name ?? `Probe ${l.location_id}`, ok: !!l.ok, ts: l.ts, latencyMs: l.latency_ms, errorKind: l.error_kind, message: l.message })),
    cert: parseJson(st?.cert_info, null), anomalyState: parseJson(st?.anomaly, null),
  };
}
