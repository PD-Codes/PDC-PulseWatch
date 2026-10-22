import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { getRunner, restoreSecrets, runners, SECRET_MASK, validateConfig } from '../../core';
import { httpRequest } from '../../core/http';
import { authHeaders } from '../../core/runners/http';
import { timeoutSignal } from '../../core/util';
import { accessibleGroupIds, accessibleMonitorIds, canManageMonitor, canWrite, writeAudit } from '../auth/access';
import { config } from '../config';
import { parseJson } from '../db';
import { BUILT_IN_DEFAULTS, DEFAULT_LIMITS, monitorDefaults, resetMonitorDefaults, saveMonitorDefaults, type MonitorDefaults } from '../monitors/defaults';
import { parseMonitor } from '../monitors/model';
import { listMonitors, loadMonitor, monitorDetail, saveMonitor, ValidationError } from '../monitors/service';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
type Src = 'raw' | 'minute' | 'hour' | 'day';
const RANGES: Record<string, { ms: number; src: Src }> = {
  '15m': { ms: 900_000, src: 'raw' }, '30m': { ms: 1_800_000, src: 'raw' }, '1h': { ms: 3_600_000, src: 'raw' }, '3h': { ms: 3 * 3_600_000, src: 'raw' }, '6h': { ms: 6 * 3_600_000, src: 'raw' },
  '12h': { ms: 12 * 3_600_000, src: 'minute' }, '24h': { ms: 86_400_000, src: 'minute' }, '7d': { ms: 7 * 86_400_000, src: 'hour' },
  '30d': { ms: 30 * 86_400_000, src: 'hour' }, '90d': { ms: 90 * 86_400_000, src: 'day' }, '365d': { ms: 365 * 86_400_000, src: 'day' },
};
const DAY = 86_400_000;
const PageQuery = { page: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })), pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) };
const COUNT_CAP = 10_000;
/** Row count capped at COUNT_CAP so that paging a monitor with millions of checks stays cheap (the UI shows "10,000+"). */
const cappedCount = async (db: any, q: { limit(n: number): any }): Promise<number> => Number((await db.selectFrom(q.limit(COUNT_CAP).as('t')).select((eb: any) => eb.fn.countAll().as('n')).executeTakeFirst())?.n ?? 0);
const RollupKeep = { raw: config.retention.rawDays, minute: config.retention.minuteDays, hour: config.retention.hourDays, day: config.retention.dayDays } as const;
/** The finest resolution that suits the span and that still exists for the start of the window (raw data and fine rollups expire first). */
const sourceFor = (spanMs: number, fromMs: number, now = Date.now()): Src => {
  const order: Src[] = ['raw', 'minute', 'hour', 'day'];
  let i = order.indexOf(spanMs <= 6 * 3_600_000 ? 'raw' : spanMs <= 3 * DAY ? 'minute' : spanMs <= 45 * DAY ? 'hour' : 'day');
  while (i < order.length - 1 && fromMs < now - RollupKeep[order[i]!] * DAY) i++;
  return order[i]!;
};
const WindowQuery = { range: Type.Optional(Type.String()), from: Type.Optional(Type.String({ maxLength: 40 })), to: Type.Optional(Type.String({ maxLength: 40 })) };
/** A named range ("15m", "7d") or an explicit from/to window picked by selecting in the chart; returns null for an invalid window. */
function windowOf(q: { range?: string; from?: string; to?: string }, defRange: string): { key: string; from: Date; to: Date; src: Src; custom: boolean } | null {
  const now = Date.now();
  if (q.from || q.to) {
    const from = new Date(q.from ?? ''), to = new Date(q.to ?? now);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() < 60_000 || to.getTime() - from.getTime() > 400 * DAY) return null;
    return { key: 'custom', from, to, src: sourceFor(to.getTime() - from.getTime(), from.getTime(), now), custom: true };
  }
  const key = q.range && Object.hasOwn(RANGES, q.range) ? q.range : defRange;
  const spec = RANGES[key]!;
  return { key, from: new Date(now - spec.ms), to: new Date(now), src: spec.src, custom: false };
}
const pct = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : null);

/** Config as a read-only viewer gets it: free-form fields are masked and credentials inside URLs are removed. */
function viewerConfig(type: string, config: Record<string, any>): Record<string, any> {
  const out = { ...config };
  for (const f of getRunner(type)?.fields ?? []) {
    const v = out[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.kind === 'json' || f.kind === 'textarea') out[f.key] = SECRET_MASK;
    else if (f.kind === 'text' && typeof v === 'string') out[f.key] = v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/i, '$1');
  }
  return out;
}

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
    if (!(await canManageMonitor(ctx, req.user, id, level))) {
      // a monitor the user cannot even see answers like a missing one, so ids cannot be probed
      if (level === 'manage' && (await canManageMonitor(ctx, req.user, id, 'view'))) reply.code(403).send({ error: 'forbidden', message: 'No access to this monitor' });
      else reply.code(404).send({ error: 'not_found', message: 'Monitor not found' });
      return null;
    }
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

  /**
   * What a user may see of a monitor: the push token (a bearer secret for forging heartbeats) and the free-form parts of the config (query, body,
   * steps, URL credentials) only for people who may manage it; dependencies only as far as they are visible to a scope-restricted user.
   */
  async function forUser<T extends { id: number; type?: string; pushToken?: string | null; dependsOn?: number[]; config?: Record<string, any> }>(req: any, items: T[]): Promise<T[]> {
    const u = req.user;
    const mine = u.role === 'viewer' ? [] : await accessibleMonitorIds(ctx, u, 'manage');
    const seen = await accessibleMonitorIds(ctx, u);
    return items.map((m) => {
      const out = { ...m };
      if (mine !== null && !mine.includes(m.id)) {
        out.pushToken = null;
        if (out.config && out.type) out.config = viewerConfig(out.type, out.config);
      }
      if (seen && out.dependsOn) out.dependsOn = out.dependsOn.filter((d) => seen.includes(d));
      return out;
    });
  }
  app.get('/api/monitors', { ...auth, schema: { tags: ['monitors'], summary: 'List monitors with live state' } }, async (req) => forUser(req, await listMonitors(ctx, await accessibleMonitorIds(ctx, req.user!))));

  const body = Type.Object({}, { additionalProperties: true });
  app.post('/api/monitors', { ...writer, schema: { tags: ['monitors'], body } }, async (req, reply) => {
    const input = req.body as any;
    const denied = await scopeProblem(req, input, true);
    if (denied) return reply.code(403).send({ error: 'forbidden', message: denied });
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

  /**
   * What a scope-restricted editor may not do with a monitor payload: place it outside their groups (including "no group") or make it depend on a
   * monitor they cannot see. `creating` demands a group; on updates the group is checked only when the payload sets it.
   */
  async function scopeProblem(req: any, input: any, creating: boolean): Promise<string | null> {
    if (!req.user.scopeRestricted || req.user.role === 'admin') return null;
    if ((creating || input.groupId !== undefined) && !(await canManageGroup(req, input.groupId ?? null))) return input.groupId ? 'No access to that group' : 'Restricted users must pick a group';
    if (input.dependsOn?.length) {
      const seen = (await accessibleMonitorIds(ctx, req.user)) ?? [];
      if (input.dependsOn.some((d: number) => !seen.includes(d))) return 'A monitor can only depend on monitors you can see';
    }
    return null;
  }

  app.get('/api/monitors/:id', { ...auth, schema: { tags: ['monitors'], params: Id } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    return (await forUser(req, [(await monitorDetail(ctx, id))!]))[0];
  });

  const update = async (req: any, reply: any) => {
    const id = await guardMonitor(req, reply, 'manage'); if (!id) return;
    const existing = (await loadMonitor(ctx, id))!;
    const denied = await scopeProblem(req, req.body, false);
    if (denied) return reply.code(403).send({ error: 'forbidden', message: denied });
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

  /** A resumed push monitor gets a fresh grace period; otherwise its old last heartbeat makes it fail as "missed" the moment it resumes. */
  const startPushGrace = (ids: number[]) => db.updateTable('monitor_state').set({ last_push_at: new Date() }).where('monitor_id', 'in', db.selectFrom('monitors').select('id').where('type', '=', 'push').where('id', 'in', ids)).execute();
  const setActive = (active: boolean) => async (req: any, reply: any) => {
    const id = await guardMonitor(req, reply, 'manage'); if (!id) return;
    await db.updateTable('monitors').set(active ? { active: 1, next_run_at: new Date(), attempt: 0, lease_until: null, lease_owner: null } : { active: 0 }).where('id', '=', id).execute();
    if (active) await startPushGrace([id]);
    await writeAudit(ctx, req.user, active ? 'monitor.resumed' : 'monitor.paused', { type: 'monitor', id }, undefined, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'monitor', id });
    return { ok: true };
  };
  app.post('/api/monitors/:id/pause', { ...writer, schema: { tags: ['monitors'], params: Id } }, setActive(false));
  app.post('/api/monitors/:id/resume', { ...writer, schema: { tags: ['monitors'], params: Id } }, setActive(true));

  app.post('/api/monitors/:id/clone', { ...writer, schema: { tags: ['monitors'], params: Id } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'manage'); if (!id) return;
    const src = (await loadMonitor(ctx, id))!;
    const tags = await db.selectFrom('monitor_tags').select(['tag_id', 'value']).where('monitor_id', '=', id).execute();
    const deps = await db.selectFrom('monitor_dependencies').select('depends_on_id').where('monitor_id', '=', id).execute();
    const notes = await db.selectFrom('monitor_notifications').selectAll().where('monitor_id', '=', id).execute();
    const newId = await wrapValidation(reply, () => saveMonitor(ctx, {
      name: `${src.name} (copy)`, type: src.type, groupId: src.groupId, description: src.description, config: src.config, intervalS: src.intervalS, timeoutS: src.timeoutS,
      retries: src.retries, retryIntervalS: src.retryIntervalS, upThreshold: src.upThreshold, downThreshold: src.downThreshold, flapWindow: src.flapWindow, flapThreshold: src.flapThreshold, downAfterS: src.downAfterS,
      active: false, locations: src.locations, quorum: src.quorum, publicBadge: false, tagIds: tags.filter((t) => !t.value).map((t) => t.tag_id), tagValues: tags.filter((t) => t.value).map((t) => ({ tagId: t.tag_id, value: t.value })), dependsOn: deps.map((d) => d.depends_on_id),
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

  /**
   * "Fetch result" in the monitor form: runs the request of an HTTP-style monitor once and returns the parsed JSON so the form can offer its fields.
   * It uses the same SSRF guard as real checks. When editing, masked secrets are restored from the stored monitor.
   */
  app.post('/api/monitors/fetch-json', {
    ...writer, config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['monitors'], summary: 'Fetch a URL once and return its JSON body', body: Type.Object({ config: Type.Object({}, { additionalProperties: true }), monitorId: Type.Optional(Type.Integer({ minimum: 1 })) }) },
  }, async (req, reply) => {
    const b = req.body as { config: Record<string, any>; monitorId?: number };
    const runner = getRunner('http')!; // same request fields as the JSON monitor, minus the assertion
    let cfg = b.config;
    if (b.monitorId) {
      if (!(await canManageMonitor(ctx, req.user!, b.monitorId, 'manage'))) return reply.code(404).send({ error: 'not_found', message: 'Monitor not found' });
      const stored = await loadMonitor(ctx, b.monitorId);
      if (stored) cfg = restoreSecrets(runner, cfg, stored.config);
    }
    const v = validateConfig(runner, cfg);
    if (v.errors.length) return reply.code(400).send({ error: 'validation', message: v.errors.join('; ') });
    const c = v.config;
    try {
      const res = await httpRequest({ url: c.url, method: c.method, headers: authHeaders(c), body: c.body || undefined, signal: timeoutSignal(15_000), guard: ctx.guard, verifyTls: c.verifyTls, followRedirects: c.followRedirects, maxRedirects: c.maxRedirects });
      let json: unknown = null, jsonError: string | null = null;
      try { json = JSON.parse(res.body); } catch (e) { jsonError = res.truncated ? 'The response is larger than 1 MB and was cut off, so it is not valid JSON' : (e as Error).message; }
      return { status: res.status, statusText: res.statusText, contentType: String(res.headers['content-type'] ?? ''), ms: Math.round(res.timings.total), bytes: Buffer.byteLength(res.body), truncated: res.truncated, json, jsonError, preview: jsonError ? res.body.slice(0, 1000) : null };
    } catch (e) {
      return reply.code(502).send({ error: 'fetch_failed', message: (e as Error).message });
    }
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
          flapWindow: Type.Optional(Type.Integer({ minimum: 4, maximum: 60 })), flapThreshold: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })), downAfterS: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0, maximum: 86400 })])), publicBadge: Type.Optional(Type.Boolean()),
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
    const denied = b.action === 'patch' ? await scopeProblem(req, b.patch ?? {}, false) : null;
    if (denied) return reply.code(403).send({ error: 'forbidden', message: denied });
    if (b.action === 'pause') await db.updateTable('monitors').set({ active: 0 }).where('id', 'in', ids).execute();
    else if (b.action === 'resume') { await db.updateTable('monitors').set({ active: 1, next_run_at: new Date(), attempt: 0 }).where('id', 'in', ids).execute(); await startPushGrace(ids); }
    else if (b.action === 'delete') { await db.deleteFrom('monitors').where('id', 'in', ids).execute(); for (const t of ['heartbeats', 'rollups', 'events'] as const) await db.deleteFrom(t).where('monitor_id', 'in', ids).execute(); }
    else {
      const p = b.patch ?? {};
      const cols: Record<string, string> = { intervalS: 'interval_s', timeoutS: 'timeout_s', retries: 'retries', retryIntervalS: 'retry_interval_s', upThreshold: 'up_threshold', downThreshold: 'down_threshold', flapWindow: 'flap_window', flapThreshold: 'flap_threshold', downAfterS: 'down_after_s', groupId: 'group_id' };
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
    const denied = await scopeProblem(req, b.template, true);
    if (denied) return reply.code(403).send({ error: 'forbidden', message: denied });
    const visible = await accessibleMonitorIds(ctx, req.user!); // duplicates are judged among what the user can see, so hidden names stay hidden
    const existing = new Set((await (visible ? db.selectFrom('monitors').select('name').where('id', 'in', visible.concat(0)) : db.selectFrom('monitors').select('name')).execute()).map((r) => r.name.toLowerCase()));
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
  const defaultsBody = Type.Object(Object.fromEntries((Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]).map((k) => [k, k === 'downAfterS' ? Type.Optional(Type.Integer({ minimum: DEFAULT_LIMITS[k][0], maximum: DEFAULT_LIMITS[k][1] })) : Type.Integer({ minimum: DEFAULT_LIMITS[k][0], maximum: DEFAULT_LIMITS[k][1] })])) as any);
  app.get('/api/settings/monitor-defaults', { ...auth, schema: { tags: ['settings'], summary: 'Defaults for new monitors' } }, async () => ({ defaults: await monitorDefaults(ctx), builtIn: BUILT_IN_DEFAULTS, limits: DEFAULT_LIMITS }));
  app.put('/api/settings/monitor-defaults', { preHandler: app.requireRole('admin'), schema: { tags: ['settings'], body: defaultsBody } }, async (req, reply) => {
    const d = { ...BUILT_IN_DEFAULTS, ...(req.body as Partial<MonitorDefaults>) };
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
  app.get('/api/monitors/:id/heartbeats', { ...auth, schema: { tags: ['monitors'], params: Id, querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), before: Type.Optional(Type.String()), location: Type.Optional(Type.Integer()), status: Type.Optional(Type.String({ pattern: '^[0-9](,[0-9])*$' })), ...PageQuery }) } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    const q = req.query as { limit?: number; before?: string; location?: number; page?: number; pageSize?: number; status?: string };
    const loc = q.location ?? 0;
    const map = (r: any) => ({ id: r.id, ts: r.ts, status: r.status, latencyMs: r.latency_ms, errorKind: r.error_kind, message: r.message, locationId: r.location_id });
    let s = db.selectFrom('heartbeats').select(['id', 'ts', 'status', 'latency_ms', 'error_kind', 'message', 'location_id']).where('monitor_id', '=', id).where('location_id', '=', loc).orderBy('ts', 'desc');
    // optional filter on the stored status values (0 down, 1 up, 2 pending, 3 maintenance, 4 suppressed)
    const only = q.status ? [...new Set(q.status.split(',').map(Number))] : null;
    if (only) s = s.where('status', 'in', only);
    if (q.page) {
      if (q.page * (q.pageSize ?? 5) > COUNT_CAP + (q.pageSize ?? 5)) return reply.code(400).send({ error: 'validation', message: `Paging stops at ${COUNT_CAP} entries, narrow the time range instead` });
      const all = db.selectFrom('heartbeats').select('id').where('monitor_id', '=', id).where('location_id', '=', loc);
      const total = await cappedCount(db, only ? all.where('status', 'in', only) : all);
      // the values that occur in the latest entries, so the filter only offers statuses this monitor really has
      const statuses = (await db.selectFrom(db.selectFrom('heartbeats').select('status').where('monitor_id', '=', id).where('location_id', '=', loc).orderBy('ts', 'desc').limit(COUNT_CAP).as('t')).select('status').distinct().orderBy('status').execute()).map((r) => r.status);
      return { total, page: q.page, pageSize: q.pageSize ?? 5, statuses, items: (await s.limit(q.pageSize ?? 5).offset((q.page - 1) * (q.pageSize ?? 5)).execute()).map(map) };
    }
    s = s.limit(q.limit ?? 100);
    if (q.before) s = s.where('ts', '<', new Date(q.before));
    return (await s.execute()).map(map);
  });

  app.get('/api/monitors/:id/chart', { ...auth, schema: { tags: ['monitors'], params: Id, querystring: Type.Object(WindowQuery) } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    const w = windowOf(req.query as any, '24h');
    if (!w) return reply.code(400).send({ error: 'validation', message: 'Invalid time window (from/to must be dates, at least a minute and at most 400 days apart)' });
    let points: any[];
    if (w.src === 'raw') {
      const rows = await db.selectFrom('heartbeats').select(['ts', 'status', 'latency_ms']).where('monitor_id', '=', id).where('location_id', '=', 0).where('ts', '>=', w.from).where('ts', '<=', w.to).orderBy('ts').limit(5000).execute();
      points = rows.map((r) => ({ t: r.ts, avg: r.latency_ms, status: r.status }));
    } else {
      const bucketMs = w.src === 'minute' ? 60_000 : w.src === 'hour' ? 3_600_000 : DAY; // include the bucket the window starts in
      const rows = await db.selectFrom('rollups').selectAll().where('monitor_id', '=', id).where('res', '=', w.src).where('bucket', '>=', new Date(Math.floor(w.from.getTime() / bucketMs) * bucketMs)).where('bucket', '<=', w.to).orderBy('bucket').execute();
      points = rows.map((r) => ({ t: r.bucket, n: r.lat_n, avg: r.lat_n ? Math.round(Number(r.lat_sum) / r.lat_n) : null, min: r.lat_min, max: r.lat_max, p50: r.lat_p50, p95: r.lat_p95, p99: r.lat_p99, up: r.up_n, down: r.down_n, maint: r.maint_n }));
    }
    // exact percentiles from raw data while it is still retained, weighted rollup values for longer windows
    const span = w.to.getTime() - w.from.getTime();
    let summary: Record<string, number | null>;
    if (span <= DAY && w.from.getTime() >= Date.now() - config.retention.rawDays * DAY) {
      const lat = (await db.selectFrom('heartbeats').select('latency_ms').where('monitor_id', '=', id).where('location_id', '=', 0).where('status', '=', 1).where('ts', '>=', w.from).where('ts', '<=', w.to).where('latency_ms', 'is not', null).orderBy('latency_ms').execute()).map((r) => r.latency_ms as number);
      summary = { avg: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, min: lat[0] ?? null, max: lat[lat.length - 1] ?? null, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) };
    } else {
      // every bucket counts as often as it has samples (a bucket with one check must not weigh as much as one with thousands)
      const wavg = (k: string) => { const xs = points.filter((p) => p[k] != null && p.n > 0); const n = xs.reduce((a, p) => a + p.n, 0); return n ? Math.round(xs.reduce((a, p) => a + p[k] * p.n, 0) / n) : null; };
      const mins = points.filter((p) => p.min != null).map((p) => p.min), maxs = points.filter((p) => p.max != null).map((p) => p.max);
      summary = { avg: wavg('avg'), min: mins.length ? Math.min(...mins) : null, max: maxs.length ? Math.max(...maxs) : null, p50: wavg('p50'), p95: wavg('p95'), p99: wavg('p99') };
    }
    const up = points.reduce((a, p) => a + (p.up ?? (p.status === 1 ? 1 : 0)), 0), down = points.reduce((a, p) => a + (p.down ?? (p.status === 0 || p.status === 4 ? 1 : 0)), 0);
    return { range: w.key, resolution: w.src, from: w.from, to: w.to, points, summary, uptime: up + down ? Math.round((up / (up + down)) * 10000) / 100 : null };
  });

  app.get('/api/monitors/:id/events', { ...auth, schema: { tags: ['monitors'], params: Id, querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })), before: Type.Optional(Type.Integer()), ...PageQuery }) } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    const q = req.query as { limit?: number; before?: number; page?: number; pageSize?: number };
    const map = (e: any) => ({ id: e.id, ts: e.ts, type: e.type, from: e.from_status, to: e.to_status, errorKind: e.error_kind, message: e.message, details: parseJson(e.details, null) });
    let s = db.selectFrom('events').selectAll().where('monitor_id', '=', id).orderBy('ts', 'desc').orderBy('id', 'desc');
    if (q.page) {
      if (q.page * (q.pageSize ?? 5) > COUNT_CAP + (q.pageSize ?? 5)) return reply.code(400).send({ error: 'validation', message: `Paging stops at ${COUNT_CAP} entries, narrow the time range instead` });
      const total = await cappedCount(db, db.selectFrom('events').select('id').where('monitor_id', '=', id));
      return { total, page: q.page, pageSize: q.pageSize ?? 5, items: (await s.limit(q.pageSize ?? 5).offset((q.page - 1) * (q.pageSize ?? 5)).execute()).map(map) };
    }
    s = s.limit(q.limit ?? 100);
    if (q.before) s = s.where('id', '<', q.before);
    return (await s.execute()).map(map);
  });

  /** Up/down periods derived from status-change events; the state that began before the window is carried in so short windows still show an ongoing outage. */
  app.get('/api/monitors/:id/periods', { ...auth, schema: { tags: ['monitors'], params: Id, querystring: Type.Object(WindowQuery) } }, async (req, reply) => {
    const id = await guardMonitor(req, reply, 'view'); if (!id) return;
    const w = windowOf(req.query as any, '30d');
    if (!w) return reply.code(400).send({ error: 'validation', message: 'Invalid time window' });
    const evs = (await db.selectFrom('events').select(['ts', 'to_status', 'error_kind', 'message']).where('monitor_id', '=', id).where('type', '=', 'status_change').where('ts', '>=', w.from).where('ts', '<=', w.to).orderBy('ts', 'desc').limit(5000).execute()).reverse(); // the newest 5000 changes of the window
    const before = await db.selectFrom('events').select(['ts', 'to_status', 'error_kind', 'message']).where('monitor_id', '=', id).where('type', '=', 'status_change').where('ts', '<', w.from).orderBy('ts', 'desc').limit(1).executeTakeFirst();
    const all = before ? [{ ...before, ts: w.from }, ...evs] : evs;
    const periods: { status: string; from: Date; to: Date | null; durationS: number; errorKind?: string | null; message?: string | null }[] = [];
    for (const [i, e] of all.entries()) {
      const end = all[i + 1]?.ts ?? (w.custom ? new Date(Math.min(w.to.getTime(), Date.now())) : null);
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
  app.get('/api/tags', { ...auth, schema: { tags: ['monitors'], summary: 'Tags with usage and the values already in use' } }, async () => {
    const [tags, byValue, byTag] = await Promise.all([
      db.selectFrom('tags').selectAll().orderBy('name').execute(),
      db.selectFrom('monitor_tags').select(['tag_id', 'value', (eb) => eb.fn.countAll<number>().as('n')]).where('value', '<>', '').groupBy(['tag_id', 'value']).orderBy('value').execute(),
      db.selectFrom('monitor_tags').select(['tag_id', (eb) => eb.fn.count<number>('monitor_id').distinct().as('n')]).groupBy('tag_id').execute(),
    ]);
    return tags.map((t) => ({ ...t, monitors: Number(byTag.find((u) => u.tag_id === t.id)?.n ?? 0), values: byValue.filter((u) => u.tag_id === t.id).map((u) => ({ value: u.value, count: Number(u.n) })) }));
  });
  app.post('/api/tags', { ...writer, schema: { tags: ['monitors'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })) }) } }, async (req) => {
    const b = req.body as { name: string; color?: string };
    const q = db.insertInto('tags').values({ name: b.name, color: b.color ?? '#6366f1' });
    // tags are shared by everyone: a scope-restricted editor can add one but not recolor an existing one
    await (req.user!.scopeRestricted && req.user!.role !== 'admin' ? q.ignore() : q.onDuplicateKeyUpdate({ color: b.color ?? '#6366f1' })).execute();
    return db.selectFrom('tags').selectAll().where('name', '=', b.name).executeTakeFirst();
  });
  app.delete('/api/tags/:id', { ...writer, schema: { tags: ['monitors'], params: Id } }, async (req, reply) => {
    if (req.user!.scopeRestricted && req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'Restricted users cannot delete shared tags' });
    await db.deleteFrom('tags').where('id', '=', (req.params as any).id).execute(); return { ok: true }; });

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
    if (b.parentId) {
      // walking up from the new parent must never reach this group, or the tree would loop and the access checks never end
      const groups = new Map((await db.selectFrom('monitor_groups').select(['id', 'parent_id']).execute()).map((g) => [g.id, g.parent_id]));
      if (!groups.has(b.parentId)) return reply.code(400).send({ error: 'validation', message: 'Unknown parent group' });
      for (let at: number | null | undefined = b.parentId, hops = 0; at && hops < 1000; at = groups.get(at), hops++) if (at === id) return reply.code(400).send({ error: 'validation', message: 'A group cannot be moved below one of its own sub-groups' });
      if (req.user!.scopeRestricted && !(await canManageGroup(req, b.parentId))) return reply.code(403).send({ error: 'forbidden', message: 'No access to that group' });
    }
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
