import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { accessibleMonitorIds, writeAudit } from '../auth/access';
import type { IncidentStatus } from '../db/types';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const STATUSES: IncidentStatus[] = ['open', 'acknowledged', 'identified', 'fixing', 'monitoring', 'resolved'];
const StatusT = Type.Union(STATUSES.map((s) => Type.Literal(s)));
const LABEL: Record<IncidentStatus, string> = { open: 'Reopened', acknowledged: 'Acknowledged', identified: 'Identified', fixing: 'Fix in progress', monitoring: 'Monitoring', resolved: 'Resolved' };

export async function incidentRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const writer = { preHandler: app.requireRole('admin', 'editor') };

  /** Incidents the user may see: those touching at least one visible monitor (or none at all for manual ones, admins/editors only). */
  async function visibleFilter(req: any) {
    const vis = await accessibleMonitorIds(ctx, req.user);
    if (vis === null) return null;
    if (!vis.length) return [] as number[];
    const rows = await db.selectFrom('incident_monitors').select('incident_id').where('monitor_id', 'in', vis).execute();
    return [...new Set(rows.map((r) => r.incident_id))];
  }

  /** Rows as the API shows them. A scope-restricted user only gets the names of monitors they may see, even on incidents that also touch others. */
  async function shape(rows: any[], user?: any) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const seen = user ? await accessibleMonitorIds(ctx, user) : null;
    const [mons, users] = await Promise.all([
      db.selectFrom('incident_monitors as im').innerJoin('monitors as m', 'm.id', 'im.monitor_id').select(['im.incident_id', 'm.id', 'm.name']).where('im.incident_id', 'in', ids).where('im.monitor_id', 'in', seen ? seen.concat(0) : db.selectFrom('monitors').select('id')).execute(),
      db.selectFrom('users').select(['id', 'display_name']).where('id', 'in', [...new Set(rows.flatMap((r) => [r.assignee_id, r.acknowledged_by]).filter(Boolean))].concat([0])).execute(),
    ]);
    const name = (id: number | null) => users.find((u) => u.id === id)?.display_name ?? null;
    return rows.map((r) => ({
      id: r.id, title: r.title, status: r.status, severity: r.severity, source: r.source, monitorId: !seen || (r.monitor_id && seen.includes(r.monitor_id)) ? r.monitor_id : null, startedAt: r.started_at, acknowledgedAt: r.acknowledged_at, acknowledgedBy: name(r.acknowledged_by),
      resolvedAt: r.resolved_at, assignee: r.assignee_id ? { id: r.assignee_id, name: name(r.assignee_id) } : null, public: !!r.public, hasPostmortem: !!r.postmortem,
      monitors: mons.filter((m) => m.incident_id === r.id).map((m) => ({ id: m.id, name: m.name })),
    }));
  }

  app.get('/api/incidents', { ...auth, schema: { tags: ['incidents'], querystring: Type.Object({ status: Type.Optional(Type.String()), monitorId: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), before: Type.Optional(Type.Integer()) }) } }, async (req) => {
    const q = req.query as any;
    const vis = await visibleFilter(req);
    if (vis && !vis.length) return [];
    let s = db.selectFrom('incidents').selectAll().orderBy('id', 'desc').limit(q.limit ?? 50);
    if (q.status === 'active') s = s.where('status', '!=', 'resolved'); else if (q.status) s = s.where('status', '=', q.status);
    if (vis) s = s.where('id', 'in', vis);
    if (q.before) s = s.where('id', '<', q.before);
    if (q.monitorId) s = s.where('id', 'in', db.selectFrom('incident_monitors').select('incident_id').where('monitor_id', '=', q.monitorId));
    return shape(await s.execute(), req.user);
  });

  /** Incidents nobody has acknowledged yet (drives the badge in the menu). */
  app.get('/api/incidents/open-count', { ...auth, schema: { tags: ['incidents'], summary: 'Number of open, unacknowledged incidents' } }, async (req) => {
    const vis = await visibleFilter(req);
    if (vis && !vis.length) return { count: 0 };
    let s = db.selectFrom('incidents').select((eb) => eb.fn.countAll().as('n')).where('status', '=', 'open');
    if (vis) s = s.where('id', 'in', vis);
    return { count: Number((await s.executeTakeFirst())?.n ?? 0) };
  });

  /** MTTR / MTTA over a period. */
  app.get('/api/incidents/stats', { ...auth, schema: { tags: ['incidents'], querystring: Type.Object({ days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })) }) } }, async (req) => {
    const days = (req.query as any).days ?? 30;
    const since = new Date(Date.now() - days * 86_400_000);
    const vis = await visibleFilter(req);
    if (vis && !vis.length) return { days, total: 0, open: 0, mttrSeconds: null, mttaSeconds: null, topMonitors: [] };
    let s = db.selectFrom('incidents').select(['id', 'monitor_id', 'started_at', 'acknowledged_at', 'resolved_at', 'status']).where('started_at', '>=', since);
    if (vis) s = s.where('id', 'in', vis);
    const rows = await s.execute();
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const mttr = avg(rows.filter((r) => r.resolved_at).map((r) => (r.resolved_at!.getTime() - r.started_at.getTime()) / 1000));
    const mtta = avg(rows.filter((r) => r.acknowledged_at).map((r) => (r.acknowledged_at!.getTime() - r.started_at.getTime()) / 1000));
    const per = new Map<number, number>();
    const seen = await accessibleMonitorIds(ctx, req.user!);
    for (const r of rows) if (r.monitor_id && (!seen || seen.includes(r.monitor_id))) per.set(r.monitor_id, (per.get(r.monitor_id) ?? 0) + 1);
    const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const names = top.length ? await db.selectFrom('monitors').select(['id', 'name']).where('id', 'in', top.map((t) => t[0])).execute() : [];
    return { days, total: rows.length, open: rows.filter((r) => r.status !== 'resolved').length, mttrSeconds: mttr, mttaSeconds: mtta, topMonitors: top.map(([id, n]) => ({ id, name: names.find((x) => x.id === id)?.name, incidents: n })) };
  });

  app.get('/api/incidents/:id', { ...auth, schema: { tags: ['incidents'], params: Id } }, async (req, reply) => {
    const id = (req.params as any).id;
    const row = await db.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    const vis = await visibleFilter(req);
    if (!row || (vis && !vis.includes(id))) return reply.code(404).send({ error: 'not_found' });
    const [inc] = await shape([row], req.user);
    const updates = await db.selectFrom('incident_updates as u').leftJoin('users as us', 'us.id', 'u.user_id').select(['u.id', 'u.ts', 'u.kind', 'u.status', 'u.body', 'us.display_name']).where('u.incident_id', '=', id).orderBy('u.ts').orderBy('u.id').execute();
    return { ...inc, postmortem: row.postmortem, updates: updates.map((u) => ({ id: u.id, ts: u.ts, kind: u.kind, status: u.status, body: u.body, author: u.display_name })) };
  });

  /** A scope-restricted editor may only touch incidents that involve a monitor they manage; unrestricted users may touch all. */
  async function mayChange(req: any, reply: any, id: number): Promise<boolean> {
    const mine = await accessibleMonitorIds(ctx, req.user, 'manage');
    if (mine === null) return true;
    const ids = (await db.selectFrom('incident_monitors').select('monitor_id').where('incident_id', '=', id).execute()).map((r) => r.monitor_id);
    if (ids.some((m) => mine.includes(m))) return true;
    reply.code(403).send({ error: 'forbidden', message: 'No access to this incident' });
    return false;
  }

  /**
   * Moves an incident to a status and records it on the timeline. Anything but "open" counts as "somebody is on it": the first such move sets the
   * acknowledgement (MTTA) and stops escalation. Resolving stamps the end, reopening clears it.
   */
  async function changeStatus(req: any, id: number, to: IncidentStatus, message?: string | null): Promise<'ok' | 'same' | 'missing'> {
    const row = await db.selectFrom('incidents').select(['status', 'monitor_id', 'acknowledged_at']).where('id', '=', id).executeTakeFirst();
    if (!row) return 'missing';
    if (row.status === to) return 'same';
    const now = new Date();
    const set: Record<string, unknown> = { status: to };
    if (to === 'resolved') set.resolved_at = now; else if (row.status === 'resolved') set.resolved_at = null;
    if (to !== 'open' && !row.acknowledged_at) Object.assign(set, { acknowledged_at: now, acknowledged_by: req.user.id });
    // only move the row if nobody changed it since we read it, so two people (or the auto-resolver) cannot both "win" and notify twice
    const moved = await db.updateTable('incidents').set(set).where('id', '=', id).where('status', '=', row.status).executeTakeFirst();
    if (!Number(moved.numUpdatedRows)) return 'same';
    await db.insertInto('incident_updates').values({ incident_id: id, user_id: req.user.id, kind: to === 'resolved' ? 'resolve' : to === 'acknowledged' ? 'ack' : 'status', status: to, body: message?.trim() || LABEL[to] }).execute();
    if (to !== 'open') await ctx.incidents.stopEscalation(id);
    await writeAudit(ctx, req.user, `incident.${to}`, { type: 'incident', id }, undefined, req.ip);
    ctx.bus.publish({ type: 'incident', incidentId: id, monitorId: row.monitor_id, status: to });
    return 'ok';
  }

  app.post('/api/incidents', {
    ...writer,
    schema: { tags: ['incidents'], body: Type.Object({ title: Type.String({ minLength: 1, maxLength: 255 }), severity: Type.Optional(Type.Union([Type.Literal('minor'), Type.Literal('major'), Type.Literal('critical')])), monitorIds: Type.Optional(Type.Array(Type.Integer())), body: Type.Optional(Type.String({ maxLength: 10000 })), public: Type.Optional(Type.Boolean()), startedAt: Type.Optional(Type.String({ format: 'date-time' })) }) },
  }, async (req, reply) => {
    const b = req.body as any;
    const now = new Date();
    const mine = await accessibleMonitorIds(ctx, req.user!, 'manage');
    if (mine !== null && (!b.monitorIds?.length || b.monitorIds.some((m: number) => !mine.includes(m)))) return reply.code(403).send({ error: 'forbidden', message: 'You can only open incidents for monitors you manage' });
    const monitorIds = [...new Set<number>(b.monitorIds ?? [])];
    if (monitorIds.length && (await db.selectFrom('monitors').select('id').where('id', 'in', monitorIds).execute()).length !== monitorIds.length) return reply.code(400).send({ error: 'validation', message: 'Unknown monitor in monitorIds' });
    const startedAt = b.startedAt ? new Date(b.startedAt) : now;
    if (Number.isNaN(startedAt.getTime())) return reply.code(400).send({ error: 'validation', message: 'startedAt is not a valid date' });
    const id = await db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('incidents').values({ title: b.title, severity: b.severity ?? 'major', source: 'manual', started_at: startedAt, public: b.public ? 1 : 0, created_by: req.user!.id, monitor_id: monitorIds[0] ?? null }).executeTakeFirstOrThrow();
      const incidentId = Number(r.insertId);
      if (monitorIds.length) await trx.insertInto('incident_monitors').values(monitorIds.map((m) => ({ incident_id: incidentId, monitor_id: m }))).execute();
      await trx.insertInto('incident_updates').values({ incident_id: incidentId, user_id: req.user!.id, kind: 'status', status: 'open', body: b.body || 'Incident opened' }).execute();
      return incidentId;
    });
    await writeAudit(ctx, req.user, 'incident.created', { type: 'incident', id }, { title: b.title }, req.ip);
    ctx.bus.publish({ type: 'incident', incidentId: id, monitorId: monitorIds[0] ?? null, status: 'open' });
    return { id };
  });

  const bodyPatch = Type.Object({ title: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), severity: Type.Optional(Type.Union([Type.Literal('minor'), Type.Literal('major'), Type.Literal('critical')])), assigneeId: Type.Optional(Type.Union([Type.Null(), Type.Integer()])), public: Type.Optional(Type.Boolean()), postmortem: Type.Optional(Type.Union([Type.String({ maxLength: 50000 }), Type.Null()])) });
  app.patch('/api/incidents/:id', { ...writer, schema: { tags: ['incidents'], params: Id, body: bodyPatch } }, async (req, reply) => {
    const id = (req.params as any).id; const b = req.body as any;
    const row = await db.selectFrom('incidents').select(['id', 'assignee_id', 'postmortem']).where('id', '=', id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayChange(req, reply, id))) return;
    const set: Record<string, unknown> = {};
    if (b.title !== undefined) set.title = b.title; if (b.severity !== undefined) set.severity = b.severity; if (b.public !== undefined) set.public = b.public ? 1 : 0;
    if (b.assigneeId !== undefined) set.assignee_id = b.assigneeId; if (b.postmortem !== undefined) set.postmortem = b.postmortem;
    if (Object.keys(set).length) await db.updateTable('incidents').set(set).where('id', '=', id).execute();
    if (b.assigneeId !== undefined && b.assigneeId !== row.assignee_id) {
      const u = b.assigneeId ? await db.selectFrom('users').select('display_name').where('id', '=', b.assigneeId).executeTakeFirst() : null;
      await db.insertInto('incident_updates').values({ incident_id: id, user_id: req.user!.id, kind: 'assign', body: u ? `Assigned to ${u.display_name}` : 'Unassigned' }).execute();
    }
    if (b.postmortem !== undefined && b.postmortem !== row.postmortem) await db.insertInto('incident_updates').values({ incident_id: id, user_id: req.user!.id, kind: 'postmortem', body: 'Post-mortem updated' }).execute();
    ctx.bus.publish({ type: 'incident', incidentId: id, monitorId: null, status: 'updated' });
    return { ok: true };
  });

  app.post('/api/incidents/:id/ack', { ...writer, schema: { tags: ['incidents'], params: Id } }, async (req, reply) => {
    const id = (req.params as any).id;
    const row = await db.selectFrom('incidents').select('status').where('id', '=', id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayChange(req, reply, id))) return;
    if (row.status !== 'open') return reply.code(409).send({ error: 'conflict', message: `Incident is already ${row.status}` });
    await changeStatus(req, id, 'acknowledged');
    return { ok: true };
  });

  app.post('/api/incidents/:id/resolve', { ...writer, schema: { tags: ['incidents'], params: Id } }, async (req, reply) => {
    const id = (req.params as any).id;
    const row = await db.selectFrom('incidents').select('status').where('id', '=', id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayChange(req, reply, id))) return;
    if (row.status === 'resolved') return reply.code(409).send({ error: 'conflict', message: 'Incident is already resolved' });
    await changeStatus(req, id, 'resolved', 'Resolved manually');
    return { ok: true };
  });

  /** Any status to any other (including reopening), optionally with a message for the timeline and the public page. */
  app.post('/api/incidents/:id/status', { ...writer, schema: { tags: ['incidents'], summary: 'Set the incident status and post an update', params: Id, body: Type.Object({ status: StatusT, message: Type.Optional(Type.String({ maxLength: 10000 })) }) } }, async (req, reply) => {
    const id = (req.params as any).id; const b = req.body as { status: IncidentStatus; message?: string };
    if (!(await db.selectFrom('incidents').select('id').where('id', '=', id).executeTakeFirst())) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayChange(req, reply, id))) return;
    const r = await changeStatus(req, id, b.status, b.message);
    if (r === 'same') return reply.code(409).send({ error: 'conflict', message: `Incident is already ${b.status}` });
    return { ok: true };
  });

  app.post('/api/incidents/:id/notes', { ...writer, schema: { tags: ['incidents'], params: Id, body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 10000 }), status: Type.Optional(StatusT), public: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const id = (req.params as any).id; const b = req.body as { body: string; status?: IncidentStatus; public?: boolean };
    const row = await db.selectFrom('incidents').select('status').where('id', '=', id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayChange(req, reply, id))) return;
    // a note with a new status is one timeline entry that does both
    if (b.status && b.status !== row.status && (await changeStatus(req, id, b.status, b.body)) === 'ok') return { ok: true };
    // a plain note is internal; with `public` it becomes an update on the status page under the current phase
    await db.insertInto('incident_updates').values({ incident_id: id, user_id: req.user!.id, kind: b.public ? 'status' : 'note', status: b.public ? row.status : null, body: b.body }).execute();
    ctx.bus.publish({ type: 'incident', incidentId: id, monitorId: null, status: 'updated' });
    return { ok: true };
  });

  app.delete('/api/incidents/:id', { preHandler: app.requireRole('admin'), schema: { tags: ['incidents'], params: Id } }, async (req) => {
    await db.deleteFrom('incidents').where('id', '=', (req.params as any).id).execute();
    await writeAudit(ctx, req.user, 'incident.deleted', { type: 'incident', id: (req.params as any).id }, undefined, req.ip);
    return { ok: true };
  });
  void sql;
}
