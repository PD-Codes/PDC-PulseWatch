import { Cron } from 'croner';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { accessibleGroupIds, accessibleMonitorIds, writeAudit } from '../auth/access';
import { Maintenance } from '../engine/maintenance';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const body = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }), description: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
  kind: Type.Union([Type.Literal('once'), Type.Literal('cron')]), startsAt: Type.Optional(Type.Union([Type.String(), Type.Null()])), endsAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cronExpr: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])), durationMin: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 43200 }), Type.Null()])),
  timezone: Type.Optional(Type.String({ maxLength: 64 })), active: Type.Optional(Type.Boolean()), announce: Type.Optional(Type.Boolean()),
  targets: Type.Array(Type.Object({ type: Type.Union([Type.Literal('monitor'), Type.Literal('group'), Type.Literal('tag')]), id: Type.Integer() }), { minItems: 1 }),
});

function validate(b: any): string | null {
  try { new Intl.DateTimeFormat('en', { timeZone: b.timezone ?? 'UTC' }); } catch { return 'Unknown time zone'; }
  if (b.kind === 'once') {
    if (!b.startsAt || !b.endsAt) return 'A one-time window needs start and end';
    if (new Date(b.startsAt) >= new Date(b.endsAt)) return 'End must be after start';
  } else {
    if (!b.cronExpr || !b.durationMin) return 'A recurring window needs a cron expression and a duration';
    try { new Cron(b.cronExpr, { timezone: b.timezone ?? 'UTC' }); } catch (e) { return `Invalid cron expression: ${(e as Error).message}`; }
  }
  return null;
}

export async function maintenanceRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const writer = { preHandler: app.requireRole('admin', 'editor') };

  const shape = async (rows: any[]) => {
    const now = new Date();
    const ids = rows.map((r) => r.id);
    const targets = ids.length ? await db.selectFrom('maintenance_targets').selectAll().where('window_id', 'in', ids).execute() : [];
    return rows.map((w) => {
      let cur = null, next = null;
      try { cur = Maintenance.current(w, now); next = Maintenance.next(w, now); } catch { /* invalid schedule is shown as inactive */ }
      return {
        id: w.id, name: w.name, description: w.description, kind: w.kind, startsAt: w.starts_at, endsAt: w.ends_at, cronExpr: w.cron_expr, durationMin: w.duration_min, timezone: w.timezone,
        active: !!w.active, announce: !!w.announce, targets: targets.filter((t) => t.window_id === w.id).map((t) => ({ type: t.target_type, id: t.target_id })),
        state: !w.active ? 'disabled' : cur ? 'running' : next ? 'scheduled' : 'finished', currentEnd: cur?.end ?? null, nextStart: next,
      };
    });
  };

  type Target = { type: 'monitor' | 'group' | 'tag'; id: number };
  /** Which of these targets lie inside the user's scope. Unrestricted users own everything; a tag counts only when every monitor carrying it is in scope. */
  async function inScope(user: any, targets: Target[], level: 'view' | 'manage'): Promise<boolean[] | null> {
    const [mons, groups] = await Promise.all([accessibleMonitorIds(ctx, user, level), accessibleGroupIds(ctx, user, level)]);
    if (mons === null || groups === null) return null;
    const tagIds = targets.filter((t) => t.type === 'tag').map((t) => t.id);
    const tagged = tagIds.length ? await db.selectFrom('monitor_tags').select(['tag_id', 'monitor_id']).where('tag_id', 'in', tagIds).execute() : [];
    return targets.map((t) => t.type === 'monitor' ? mons.includes(t.id) : t.type === 'group' ? groups.has(t.id) : tagged.filter((x) => x.tag_id === t.id).every((x) => mons.includes(x.monitor_id)));
  }
  const targetsOf = async (id: number): Promise<Target[]> => (await db.selectFrom('maintenance_targets').select(['target_type', 'target_id']).where('window_id', '=', id).execute()).map((t) => ({ type: t.target_type as Target['type'], id: t.target_id }));
  /** A scope-restricted editor may only change windows whose targets they all manage. */
  async function mayEdit(req: any, reply: any, id: number): Promise<boolean> {
    const ok = await inScope(req.user, await targetsOf(id), 'manage');
    if (ok === null || (ok.length && ok.every(Boolean))) return true;
    reply.code(403).send({ error: 'forbidden', message: 'This maintenance window involves monitors outside your scope' });
    return false;
  }

  app.get('/api/maintenance', { ...auth, schema: { tags: ['maintenance'] } }, async (req) => {
    const rows = await db.selectFrom('maintenance_windows').selectAll().orderBy('id', 'desc').execute();
    if (!rows.length || !req.user!.scopeRestricted || req.user!.role === 'admin') return shape(rows);
    const shaped = await shape(rows);
    const seen = await Promise.all(shaped.map(async (w) => (await inScope(req.user, w.targets as Target[], 'view'))?.some(Boolean) ?? true));
    return shaped.filter((_, i) => seen[i]);
  });

  const save = async (req: any, reply: any, id?: number) => {
    const b = req.body;
    const err = validate(b);
    if (err) return reply.code(400).send({ error: 'validation', message: err });
    if (id && !(await db.selectFrom('maintenance_windows').select('id').where('id', '=', id).executeTakeFirst())) return reply.code(404).send({ error: 'not_found' });
    if (id && !(await mayEdit(req, reply, id))) return;
    const fits = await inScope(req.user, b.targets, 'manage');
    if (fits && !fits.every(Boolean)) return reply.code(403).send({ error: 'forbidden', message: 'You can only schedule maintenance for monitors you manage' });
    const values = { name: b.name, description: b.description ?? null, kind: b.kind, starts_at: b.kind === 'once' ? new Date(b.startsAt) : null, ends_at: b.kind === 'once' ? new Date(b.endsAt) : null, cron_expr: b.kind === 'cron' ? b.cronExpr : null, duration_min: b.kind === 'cron' ? b.durationMin : null, timezone: b.timezone ?? 'UTC', active: b.active === false ? 0 : 1, announce: b.announce ? 1 : 0 };
    const wid = await db.transaction().execute(async (trx) => {
      let wid = id!;
      if (id) { await trx.updateTable('maintenance_windows').set(values).where('id', '=', id).execute(); await trx.deleteFrom('maintenance_targets').where('window_id', '=', id).execute(); }
      else wid = Number((await trx.insertInto('maintenance_windows').values({ ...values, created_by: req.user.id }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('maintenance_targets').values(b.targets.map((t: any) => ({ window_id: wid, target_type: t.type, target_id: t.id }))).ignore().execute();
      return wid;
    });
    await writeAudit(ctx, req.user, id ? 'maintenance.updated' : 'maintenance.created', { type: 'maintenance', id: wid }, { name: b.name }, req.ip);
    await ctx.maintenance.refresh();
    return (await shape(await db.selectFrom('maintenance_windows').selectAll().where('id', '=', wid).execute()))[0];
  };
  app.post('/api/maintenance', { ...writer, schema: { tags: ['maintenance'], body } }, (req, reply) => save(req, reply));
  app.put('/api/maintenance/:id', { ...writer, schema: { tags: ['maintenance'], params: Id, body } }, (req, reply) => save(req, reply, (req.params as any).id));
  app.delete('/api/maintenance/:id', { ...writer, schema: { tags: ['maintenance'], params: Id } }, async (req, reply) => {
    if (!(await mayEdit(req, reply, (req.params as any).id))) return;
    await db.deleteFrom('maintenance_windows').where('id', '=', (req.params as any).id).execute();
    await writeAudit(ctx, req.user, 'maintenance.deleted', { type: 'maintenance', id: (req.params as any).id }, undefined, req.ip);
    await ctx.maintenance.refresh();
    return { ok: true };
  });
}
