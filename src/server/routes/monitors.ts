import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { getRunner, runners } from '../../core';
import { accessibleGroupIds, accessibleMonitorIds, canManageMonitor, canWrite, writeAudit } from '../auth/access';
import { parseJson } from '../db';
import { BUILT_IN_DEFAULTS, DEFAULT_LIMITS, monitorDefaults, resetMonitorDefaults, saveMonitorDefaults, type MonitorDefaults } from '../monitors/defaults';
import { parseMonitor } from '../monitors/model';
import { listMonitors, loadMonitor, monitorDetail, saveMonitor, ValidationError } from '../monitors/service';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const RANGES: Record<string, { ms: number; src: 'raw' | 'minute' | 'hour' | 'day' }> = {
  '1h': { ms: 3_600_000, src: 'raw' }, '24h': { ms: 86_400_000, src: 'minute' }, '7d': { ms: 7 * 86_400_000, src: 'hour' },
  '30d': { ms: 30 * 86_400_000, src: 'hour' }, '90d': { ms: 90 * 86_400_000, src: 'day' }, '365d': { ms: 365 * 86_400_000, src: 'day' },
};
const pct = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : null);

export async function monitorRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const writer = { preHandler: app.requireRole('admin', 'editor') };

  /** Fetch and authorize: returns the monitor id or sends an error. */
  const guardMonitor = async (req: any, reply: any, level: 'view' | 'manage') => {
    const id = Number(req.params.id);
    const exists = await db.selectFrom('monitors').select('id').where('id', '=', id).executeTakeFirst();
    if (!exists) { reply.code(404).send({ error: 'not_found', message: 'Monitor not found' }); return null; }
    if (!(await canManageMonitor(ctx, req.user, id, level))) { reply.code(403).send({ error: 'forbidden', message: 'No access to this monitor' }); return null; }
    return id;
  };
  const wrapValidation = async <T>(reply: any, fn: () => Promise<T>) => {
    try { return await fn(); } catch (e) {
      if (e instanceof ValidationError) { reply.code(400).send({ error: 'validation', message: e.message, errors: e.errors }); return undefined; }
      throw e;
    }
  };

  app.get('/api/monitor-types', { ...auth, schema: { tags: ['monitors'], summary: 'Monitor types with their form definitions' } }, async () =>
    [...runners.values()].map((r) => ({ type: r.type, label: r.label, category: r.category, fields: r.fields })));

  app.get('/api/monitors', { ...auth, schema: { tags: ['monitors'], summary: 'List monitors with live state' } }, async (req) => listMonitors(ctx, await accessibleMonitorIds(ctx, req.user!)));

  const body = Type.Object({}, { additionalProperties: true });
  app.post('/api/monitors', { ...writer, schema: { tags: ['monitors'], body } }, async (req, reply) => {
    const input = req.body as any;
    if (input.groupId && !(await canManageGroup(req, input.groupId))) return reply.code(403).send({ error: 'forbidden', message: 'No access to that group' });
    const id = await wrapValidation(reply, () => saveMonitor(ctx, input, req.user!.id));
    if (id === undefined) return;
    await writeAudit(ctx, req.user, 'monitor.created', { type: 'monitor', id }, { name: input.name, type: input.type }, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'monitor', id });
    return monitorDetail(ctx, id);
  });

  async function canManageGroup(req: any, groupId: number | null) {
    const g = await accessibleGroupIds(ctx, req.user, 'manage');
    return g === null || (groupId !== null && g.has(groupId));
  }

  app.get('/api/monitors/:id', { ...auth, schema: { tags: ['monitors'], params: Id } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    return monitorDetail(ctx, id);
  });

  const update = async (req: any, reply: any) => {
    const id = await guardMonitor(req, reply, 'manage'); if (!id) return;
    const existing = (await loadMonitor(ctx, id))!;
    if (req.body.groupId !== undefined && req.body.groupId !== existing.groupId && !(await canManageGroup(req, req.body.groupId))) return reply.code(403).send({ error: 'forbidden', message: 'No access to that group' });
    const ok = await wrapValidation(reply, () => saveMonitor(ctx, req.body, req.user!.id, existing));
    if (ok === undefined) return;
    await writeAudit(ctx, req.user, 'monitor.updated', { type: 'monitor', id }, { name: req.body.name ?? existing.name }, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'monitor', id });
    return monitorDetail(ctx, id);
  };
  app.patch('/api/monitors/:id', { ...writer, schema: { tags: ['monitors'], params: Id, body } }, update);
  app.put('/api/monitors/:id', { ...writer, schema: { tags: ['monitors'], params: Id, body } }, update);

  app.delete('/api/monitors/:id', { ...writer, schema: { tags: ['monitors'], params: Id } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'manage'); if (!id) return;
    await db.deleteFrom('monitors').where('id', '=', id).execute();
    await db.deleteFrom('heartbeats').where('monitor_id', '=', id).execute();
    await db.deleteFrom('rollups').where('monitor_id', '=', id).execute();
    await db.deleteFrom('events').where('monitor_id', '=', id).execute();
    await writeAudit(ctx, req.user, 'monitor.deleted', { type: 'monitor', id }, undefined, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'monitor', id });
    return { ok: true };
  });

  const setActive = (active: boolean) => async (req: any, reply: any) => {
    const id = await guardMonitor(req, reply, 'manage'); if (!id) return;
    await db.updateTable('monitors').set(active ? { active: 1, next_run_at: new Date(), attempt: 0, lease_until: null, lease_owner: null } : { active: 0 }).where('id', '=', id).execute();
    await writeAudit(ctx, req.user, active ? 'monitor.resumed' : 'monitor.paused', { type: 'monitor', id }, undefined, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'monitor', id });
    return { ok: true };
  };
  app.post('/api/monitors/:id/pause', { ...writer, schema: { tags: ['monitors'], params: Id } }, setActive(false));
  app.post('/api/monitors/:id/resume', { ...writer, schema: { tags: ['monitors'], params: Id } }, setActive(true));

  app.post('/api/monitors/:id/clone', { ...writer, schema: { tags: ['monitors'], params: Id } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'manage'); if (!id) return;
    const src = (await loadMonitor(ctx, id))!;
    const tags = await db.selectFrom('monitor_tags').select('tag_id').where('monitor_id', '=', id).execute();
    const deps = await db.selectFrom('monitor_dependencies').select('depends_on_id').where('monitor_id', '=', id).execute();
    const notes = await db.selectFrom('monitor_notifications').selectAll().where('monitor_id', '=', id).execute();
    const newId = await wrapValidation(reply, () => saveMonitor(ctx, {
      name: `${src.name} (copy)`, type: src.type, groupId: src.groupId, description: src.description, config: src.config, intervalS: src.intervalS, timeoutS: src.timeoutS,
      retries: src.retries, retryIntervalS: src.retryIntervalS, upThreshold: src.upThreshold, downThreshold: src.downThreshold, flapWindow: src.flapWindow, flapThreshold: src.flapThreshold,
      active: false, locations: src.locations, quorum: src.quorum, publicBadge: false, tagIds: tags.map((t) => t.tag_id), dependsOn: deps.map((d) => d.depends_on_id),
      notifications: notes.map((n) => ({ channelId: n.channel_id, policyId: n.policy_id, events: n.events.split(',') })),
    }, req.user!.id));
    if (newId === undefined) return;
    await writeAudit(ctx, req.user, 'monitor.cloned', { type: 'monitor', id: newId }, { from: id }, req.ip);
    return monitorDetail(ctx, newId);
  });

  app.post('/api/monitors/:id/check', { ...writer, schema: { tags: ['monitors'], summary: 'Run a check immediately', params: Id }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'manage'); if (!id) return;
    return ctx.engine.checkNow(id);
  });

  const ruleBody = Type.Object({ channelId: Type.Optional(Type.Union([Type.Null(), Type.Integer()])), policyId: Type.Optional(Type.Union([Type.Null(), Type.Integer()])), events: Type.Optional(Type.Array(Type.String())) });
  app.post('/api/monitors/bulk', {
    ...writer,
    schema: {
      tags: ['monitors'], summary: 'Bulk actions',
      body: Type.Object({
        ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: 1000 }),
        action: Type.Union([Type.Literal('pause'), Type.Literal('resume'), Type.Literal('delete'), Type.Literal('patch')]),
        patch: Type.Optional(Type.Object({
          intervalS: Type.Optional(Type.Integer({ minimum: 5, maximum: 86400 })), timeoutS: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })), retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
          retryIntervalS: Type.Optional(Type.Integer({ minimum: 5, maximum: 3600 })), upThreshold: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), downThreshold: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
          flapWindow: Type.Optional(Type.Integer({ minimum: 4, maximum: 60 })), flapThreshold: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })), publicBadge: Type.Optional(Type.Boolean()),
          groupId: Type.Optional(Type.Union([Type.Null(), Type.Integer()])), addTagIds: Type.Optional(Type.Array(Type.Integer())), removeTagIds: Type.Optional(Type.Array(Type.Integer())),
          notifications: Type.Optional(Type.Object({ mode: Type.Union([Type.Literal('add'), Type.Literal('replace')]), rules: Type.Array(ruleBody, { maxItems: 20 }) })),
        })),
      }),
    },
  }, async (req, reply) => {
    const b = req.body as any;
    const allowed = await accessibleMonitorIds(ctx, req.user!, 'manage');
    const ids: number[] = b.ids.filter((i: number) => allowed === null || allowed.includes(i));
    if (!ids.length) return { ok: true, affected: 0 };
    if (b.action === 'patch' && b.patch?.groupId && !(await canManageGroup(req, b.patch.groupId))) return reply.code(403).send({ error: 'forbidden', message: 'No access to that group' });
    if (b.action === 'pause') await db.updateTable('monitors').set({ active: 0 }).where('id', 'in', ids).execute();
    else if (b.action === 'resume') await db.updateTable('monitors').set({ active: 1, next_run_at: new Date(), attempt: 0 }).where('id', 'in', ids).execute();
    else if (b.action === 'delete') { await db.deleteFrom('monitors').where('id', 'in', ids).execute(); for (const t of ['heartbeats', 'rollups', 'events'] as const) await db.deleteFrom(t).where('monitor_id', 'in', ids).execute(); }
    else {
      const p = b.patch ?? {};
      const cols: Record<string, string> = { intervalS: 'interval_s', timeoutS: 'timeout_s', retries: 'retries', retryIntervalS: 'retry_interval_s', upThreshold: 'up_threshold', downThreshold: 'down_threshold', flapWindow: 'flap_window', flapThreshold: 'flap_threshold', groupId: 'group_id' };
      const set: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(cols)) if (p[k] !== undefined) set[col] = p[k];
      if (p.publicBadge !== undefined) set.public_badge = p.publicBadge ? 1 : 0;
      if (Object.keys(set).length) await db.updateTable('monitors').set(set).where('id', 'in', ids).execute();
      if (p.removeTagIds?.length) await db.deleteFrom('monitor_tags').where('monitor_id', 'in', ids).where('tag_id', 'in', p.removeTagIds).execute();
      if (p.addTagIds?.length) await db.insertInto('monitor_tags').values(ids.flatMap((m: number) => p.addTagIds.map((t: number) => ({ monitor_id: m, tag_id: t })))).ignore().execute();
      const rules = (p.notifications?.rules ?? []).filter((r: any) => r.channelId || r.policyId);
      if (p.notifications) {
        if (p.notifications.mode === 'replace') await db.deleteFrom('monitor_notifications').where('monitor_id', 'in', ids).execute();
        if (rules.length) await db.insertInto('monitor_notifications').values(ids.flatMap((m: number) => rules.map((r: any) => ({ monitor_id: m, channel_id: r.channelId ?? null, policy_id: r.policyId ?? null, events: (r.events?.length ? r.events : ['down', 'up']).join(',') })))).execute();
      }
    }
    await writeAudit(ctx, req.user, `monitor.bulk_${b.action}`, { type: 'monitor' }, { ids, patch: b.patch }, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'monitor' });
    return { ok: true, affected: ids.length };
  });

  /** Create many monitors that share every setting except name and address. */
  app.post('/api/monitors/bulk-create', {
    ...writer,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['monitors'], summary: 'Create several monitors from a template plus name/address pairs',
      body: Type.Object({
        type: Type.String(), addressKey: Type.String({ minLength: 1, maxLength: 64 }), skipExisting: Type.Optional(Type.Boolean()),
        template: Type.Object({}, { additionalProperties: true }),
        items: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), address: Type.String({ minLength: 1, maxLength: 2000 }) }), { minItems: 1, maxItems: 500 }),
      }),
    },
  }, async (req, reply) => {
    const b = req.body as { type: string; addressKey: string; skipExisting?: boolean; template: Record<string, any>; items: { name: string; address: string }[] };
    const runner = getRunner(b.type);
    if (!runner) return reply.code(400).send({ error: 'validation', message: `Unknown monitor type "${b.type}"` });
    if (!runner.fields.some((f) => f.key === b.addressKey && (f.kind === 'text' || f.kind === 'secret'))) return reply.code(400).send({ error: 'validation', message: `"${b.addressKey}" is not a text field of this monitor type` });
    if (b.template.groupId && !(await canManageGroup(req, b.template.groupId))) return reply.code(403).send({ error: 'forbidden', message: 'No access to that group' });
    if (!b.template.groupId && req.user!.scopeRestricted) return reply.code(403).send({ error: 'forbidden', message: 'Restricted users must pick a group' });
    const existing = new Set((await db.selectFrom('monitors').select('name').execute()).map((r) => r.name.toLowerCase()));
    const created: { index: number; id: number }[] = [];
    const skipped: { index: number; reason: string }[] = [];
    const failed: { index: number; errors: string[] }[] = [];
    for (const [index, it] of b.items.entries()) {
      const name = it.name.trim();
      if (b.skipExisting && existing.has(name.toLowerCase())) { skipped.push({ index, reason: 'A monitor with this name already exists' }); continue; }
      try {
        const id = await saveMonitor(ctx, { ...b.template, name, type: b.type, config: { ...(b.template.config ?? {}), [b.addressKey]: it.address.trim() } }, req.user!.id);
        existing.add(name.toLowerCase());
        created.push({ index, id });
      } catch (e) {
        if (e instanceof ValidationError) failed.push({ index, errors: e.errors }); else throw e;
      }
    }
    await writeAudit(ctx, req.user, 'monitor.bulk_create', { type: 'monitor' }, { type: b.type, created: created.length, skipped: skipped.length, failed: failed.length }, req.ip);
    if (created.length) ctx.bus.publish({ type: 'config', entity: 'monitor' });
    return { created, skipped, failed };
  });

  /** Instance-wide defaults for new monitors (timings and thresholds). */
  const defaultsBody = Type.Object(Object.fromEntries((Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]).map((k) => [k, Type.Integer({ minimum: DEFAULT_LIMITS[k][0], maximum: DEFAULT_LIMITS[k][1] })])) as any);
  app.get('/api/settings/monitor-defaults', { ...auth, schema: { tags: ['settings'], summary: 'Defaults for new monitors' } }, async () => ({ defaults: await monitorDefaults(ctx), builtIn: BUILT_IN_DEFAULTS, limits: DEFAULT_LIMITS }));
  app.put('/api/settings/monitor-defaults', { preHandler: app.requireRole('admin'), schema: { tags: ['settings'], body: defaultsBody } }, async (req, reply) => {
    const d = req.body as MonitorDefaults;
    if (d.timeoutS > d.intervalS) return reply.code(400).send({ error: 'validation', message: 'The timeout must not exceed the interval' });
    await saveMonitorDefaults(ctx, d);
    await writeAudit(ctx, req.user, 'settings.monitor_defaults', { type: 'settings' }, d as any, req.ip);
    return { ok: true };
  });
  app.delete('/api/settings/monitor-defaults', { preHandler: app.requireRole('admin'), schema: { tags: ['settings'], summary: 'Reset to the built-in defaults' } }, async (req) => {
    await resetMonitorDefaults(ctx);
    await writeAudit(ctx, req.user, 'settings.monitor_defaults_reset', { type: 'settings' }, undefined, req.ip);
    return { ok: true };
  });

  /* ------------------------------- history ------------------------------- */
  app.get('/api/monitors/:id/heartbeats', { ...auth, schema: { tags: ['monitors'], params: Id, querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), before: Type.Optional(Type.String()), location: Type.Optional(Type.Integer()) }) } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    const q = req.query as { limit?: number; before?: string; location?: number };
    let s = db.selectFrom('heartbeats').select(['id', 'ts', 'status', 'latency_ms', 'error_kind', 'message', 'location_id']).where('monitor_id', '=', id).where('location_id', '=', q.location ?? 0).orderBy('ts', 'desc').limit(q.limit ?? 100);
    if (q.before) s = s.where('ts', '<', new Date(q.before));
    return (await s.execute()).map((r) => ({ id: r.id, ts: r.ts, status: r.status, latencyMs: r.latency_ms, errorKind: r.error_kind, message: r.message, locationId: r.location_id }));
  });

  app.get('/api/monitors/:id/chart', { ...auth, schema: { tags: ['monitors'], params: Id, querystring: Type.Object({ range: Type.Optional(Type.String()) }) } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    const rangeKey = (req.query as any).range && RANGES[(req.query as any).range] ? (req.query as any).range : '24h';
    const spec = RANGES[rangeKey];
    const since = new Date(Date.now() - spec.ms);
    let points: any[];
    if (spec.src === 'raw') {
      const rows = await db.selectFrom('heartbeats').select(['ts', 'status', 'latency_ms']).where('monitor_id', '=', id).where('location_id', '=', 0).where('ts', '>=', since).orderBy('ts').limit(5000).execute();
      points = rows.map((r) => ({ t: r.ts, avg: r.latency_ms, status: r.status }));
    } else {
      const rows = await db.selectFrom('rollups').selectAll().where('monitor_id', '=', id).where('res', '=', spec.src).where('bucket', '>=', since).orderBy('bucket').execute();
      points = rows.map((r) => ({ t: r.bucket, avg: r.lat_n ? Math.round(Number(r.lat_sum) / r.lat_n) : null, min: r.lat_min, max: r.lat_max, p50: r.lat_p50, p95: r.lat_p95, p99: r.lat_p99, up: r.up_n, down: r.down_n, maint: r.maint_n }));
    }
    // exact percentiles from raw data while it is still retained, weighted rollup values for longer ranges
    let summary: Record<string, number | null>;
    if (spec.ms <= 7 * 86_400_000) {
      const lat = (await db.selectFrom('heartbeats').select('latency_ms').where('monitor_id', '=', id).where('location_id', '=', 0).where('status', '=', 1).where('ts', '>=', since).where('latency_ms', 'is not', null).orderBy('latency_ms').limit(400_000).execute()).map((r) => r.latency_ms as number);
      summary = { avg: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, min: lat[0] ?? null, max: lat[lat.length - 1] ?? null, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) };
    } else {
      const w = (k: string) => { const xs = points.filter((p) => p[k] != null); return xs.length ? Math.round(xs.reduce((a, p) => a + p[k], 0) / xs.length) : null; };
      summary = { avg: w('avg'), min: points.length ? Math.min(...points.filter((p) => p.min != null).map((p) => p.min)) : null, max: points.length ? Math.max(...points.filter((p) => p.max != null).map((p) => p.max)) : null, p50: w('p50'), p95: w('p95'), p99: w('p99') };
    }
    const up = points.reduce((a, p) => a + (p.up ?? (p.status === 1 ? 1 : 0)), 0), down = points.reduce((a, p) => a + (p.down ?? (p.status === 0 || p.status === 4 ? 1 : 0)), 0);
    return { range: rangeKey, resolution: spec.src, points, summary, uptime: up + down ? Math.round((up / (up + down)) * 10000) / 100 : null };
  });

  app.get('/api/monitors/:id/events', { ...auth, schema: { tags: ['monitors'], params: Id, querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })), before: Type.Optional(Type.Integer()) }) } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    const q = req.query as { limit?: number; before?: number };
    let s = db.selectFrom('events').selectAll().where('monitor_id', '=', id).orderBy('id', 'desc').limit(q.limit ?? 100);
    if (q.before) s = s.where('id', '<', q.before);
    return (await s.execute()).map((e) => ({ id: e.id, ts: e.ts, type: e.type, from: e.from_status, to: e.to_status, errorKind: e.error_kind, message: e.message, details: parseJson(e.details, null) }));
  });

  /** Up/down periods derived from status-change events. */
  app.get('/api/monitors/:id/periods', { ...auth, schema: { tags: ['monitors'], params: Id, querystring: Type.Object({ range: Type.Optional(Type.String()) }) } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    const spec = RANGES[(req.query as any).range ?? '30d'] ?? RANGES['30d'];
    const since = new Date(Date.now() - spec.ms);
    const evs = await db.selectFrom('events').select(['ts', 'to_status', 'error_kind', 'message']).where('monitor_id', '=', id).where('type', '=', 'status_change').where('ts', '>=', since).orderBy('ts').execute();
    const periods: { status: string; from: Date; to: Date | null; durationS: number; errorKind?: string | null; message?: string | null }[] = [];
    for (const [i, e] of evs.entries()) {
      const end = evs[i + 1]?.ts ?? null;
      periods.push({ status: e.to_status ?? 'up', from: e.ts, to: end, durationS: Math.round(((end ?? new Date()).getTime() - e.ts.getTime()) / 1000), errorKind: e.error_kind, message: e.message });
    }
    return periods.reverse();
  });

  app.get('/api/monitors/:id/incidents', { ...auth, schema: { tags: ['monitors'], params: Id } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    return db.selectFrom('incidents as i').innerJoin('incident_monitors as im', 'im.incident_id', 'i.id').select(['i.id', 'i.title', 'i.status', 'i.severity', 'i.source', 'i.started_at', 'i.resolved_at']).where('im.monitor_id', '=', id).orderBy('i.started_at', 'desc').limit(50).execute();
  });

  /* --------------------------- push (heartbeat) --------------------------- */
  const push = async (req: any, reply: any) => {
    const row = await db.selectFrom('monitors').selectAll().where('push_token', '=', req.params.token).where('active', '=', 1).executeTakeFirst();
    if (!row) return reply.code(404).send({ ok: false, error: 'unknown_token' });
    const q = { ...(req.query ?? {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) } as Record<string, string>;
    const m = parseMonitor(row);
    const now = new Date();
    await db.insertInto('monitor_state').values({ monitor_id: m.id, last_push_at: now }).onDuplicateKeyUpdate({ last_push_at: now }).execute();
    const failed = String(q.status ?? 'up').toLowerCase() === 'down';
    const st = await db.selectFrom('monitor_state').select('status').where('monitor_id', '=', m.id).executeTakeFirst();
    if (failed) await ctx.engine.record(m, { ok: false, errorKind: 'reported', message: String(q.msg ?? 'The job reported a failure').slice(0, 400) }, { advance: false });
    else if (!st || st.status !== 'up') await ctx.engine.record(m, { ok: true, message: String(q.msg ?? 'Heartbeat received').slice(0, 400), latencyMs: q.ping ? Math.round(Number(q.ping)) || undefined : undefined }, { advance: false });
    return { ok: true };
  };
  const pushOpts = { config: { rateLimit: { max: 120, timeWindow: '1 minute' }, skipCsrf: true }, schema: { tags: ['push'], summary: 'Heartbeat endpoint for cron jobs and backups', params: Type.Object({ token: Type.String() }) } };
  app.get('/api/push/:token', pushOpts, push);
  app.post('/api/push/:token', pushOpts, push);

  /* ---------------------------- tags & groups ---------------------------- */
  app.get('/api/tags', { ...auth, schema: { tags: ['monitors'] } }, async () => db.selectFrom('tags').selectAll().orderBy('name').execute());
  app.post('/api/tags', { ...writer, schema: { tags: ['monitors'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })) }) } }, async (req) => {
    const b = req.body as { name: string; color?: string };
    await db.insertInto('tags').values({ name: b.name, color: b.color ?? '#6366f1' }).onDuplicateKeyUpdate({ color: b.color ?? '#6366f1' }).execute();
    return db.selectFrom('tags').selectAll().where('name', '=', b.name).executeTakeFirst();
  });
  app.delete('/api/tags/:id', { ...writer, schema: { tags: ['monitors'], params: Id } }, async (req) => { await db.deleteFrom('tags').where('id', '=', (req.params as any).id).execute(); return { ok: true }; });

  app.get('/api/groups', { ...auth, schema: { tags: ['monitors'] } }, async (req) => {
    const g = await accessibleGroupIds(ctx, req.user!);
    const all = await db.selectFrom('monitor_groups').selectAll().orderBy('sort').orderBy('name').execute();
    return all.filter((x) => g === null || g.has(x.id)).map((x) => ({ id: x.id, parentId: x.parent_id, name: x.name, description: x.description, sort: x.sort }));
  });
  const groupBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), parentId: Type.Optional(Type.Union([Type.Null(), Type.Integer()])), description: Type.Optional(Type.Union([Type.String(), Type.Null()])), sort: Type.Optional(Type.Integer()) });
  app.post('/api/groups', { ...writer, schema: { tags: ['monitors'], body: groupBody } }, async (req, reply) => {
    const b = req.body as any;
    if (b.parentId && !(await canManageGroup(req, b.parentId))) return reply.code(403).send({ error: 'forbidden' });
    if (!b.parentId && req.user!.scopeRestricted) return reply.code(403).send({ error: 'forbidden', message: 'Restricted users can only create sub-groups' });
    const r = await db.insertInto('monitor_groups').values({ name: b.name, parent_id: b.parentId ?? null, description: b.description ?? null, sort: b.sort ?? 0 }).executeTakeFirstOrThrow();
    await writeAudit(ctx, req.user, 'group.created', { type: 'group', id: Number(r.insertId) }, { name: b.name }, req.ip);
    return { id: Number(r.insertId) };
  });
  app.patch('/api/groups/:id', { ...writer, schema: { tags: ['monitors'], params: Id, body: Type.Partial(groupBody) } }, async (req, reply) => {
    const id = (req.params as any).id; const b = req.body as any;
    if (!(await canManageGroup(req, id))) return reply.code(403).send({ error: 'forbidden' });
    if (b.parentId === id) return reply.code(400).send({ error: 'validation', message: 'A group cannot be its own parent' });
    const set: Record<string, unknown> = {};
    if (b.name !== undefined) set.name = b.name; if (b.parentId !== undefined) set.parent_id = b.parentId; if (b.description !== undefined) set.description = b.description; if (b.sort !== undefined) set.sort = b.sort;
    if (Object.keys(set).length) await db.updateTable('monitor_groups').set(set).where('id', '=', id).execute();
    return { ok: true };
  });
  app.delete('/api/groups/:id', { ...writer, schema: { tags: ['monitors'], params: Id } }, async (req, reply) => {
    const id = (req.params as any).id;
    if (!(await canManageGroup(req, id))) return reply.code(403).send({ error: 'forbidden' });
    await db.deleteFrom('monitor_groups').where('id', '=', id).execute();
    await writeAudit(ctx, req.user, 'group.deleted', { type: 'group', id }, undefined, req.ip);
    return { ok: true };
  });

  /* ------------------------------ saved views ------------------------------ */
  app.get('/api/views', { ...auth, schema: { tags: ['monitors'] } }, async (req) =>
    (await db.selectFrom('saved_views').selectAll().where((eb) => eb.or([eb('user_id', '=', req.user!.id), eb('shared', '=', 1)])).orderBy('name').execute()).map((v) => ({ id: v.id, name: v.name, filters: parseJson(v.filters, {}), shared: !!v.shared, own: v.user_id === req.user!.id })));
  app.post('/api/views', { ...auth, schema: { tags: ['monitors'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), filters: Type.Object({}, { additionalProperties: true }), shared: Type.Optional(Type.Boolean()) }) } }, async (req) => {
    const b = req.body as any;
    const r = await db.insertInto('saved_views').values({ user_id: req.user!.id, name: b.name, filters: JSON.stringify(b.filters), shared: b.shared && canWrite(req.user!) ? 1 : 0 }).executeTakeFirstOrThrow();
    return { id: Number(r.insertId) };
  });
  app.delete('/api/views/:id', { ...auth, schema: { tags: ['monitors'], params: Id } }, async (req) => { await db.deleteFrom('saved_views').where('id', '=', (req.params as any).id).where('user_id', '=', req.user!.id).execute(); return { ok: true }; });

  /* -------------------------- global incident timeline -------------------------- */
  app.get('/api/timeline', { ...auth, schema: { tags: ['monitors'], querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), before: Type.Optional(Type.Integer()) }) } }, async (req) => {
    const vis = await accessibleMonitorIds(ctx, req.user!);
    if (vis && !vis.length) return [];
    const q = req.query as { limit?: number; before?: number };
    let s = db.selectFrom('events as e').innerJoin('monitors as m', 'm.id', 'e.monitor_id').select(['e.id', 'e.ts', 'e.type', 'e.from_status', 'e.to_status', 'e.error_kind', 'e.message', 'e.monitor_id', 'm.name'])
      .where('e.type', 'in', ['status_change', 'flap_start', 'cert_expiry', 'maintenance_start', 'maintenance_end']).orderBy('e.id', 'desc').limit(q.limit ?? 50);
    if (vis) s = s.where('e.monitor_id', 'in', vis);
    if (q.before) s = s.where('e.id', '<', q.before);
    return (await s.execute()).map((e) => ({ id: e.id, ts: e.ts, type: e.type, from: e.from_status, to: e.to_status, errorKind: e.error_kind, message: e.message, monitorId: e.monitor_id, monitorName: e.name }));
  });

  void sql; void getRunner;
}
