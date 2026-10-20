import { Cron } from 'croner';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { accessibleMonitorIds, writeAudit } from '../auth/access';
import { mailConfigured, sendSystemMail } from '../mail';
import { buildDigest, buildSla, DIGEST_DEFAULT, sendReport, slaCsv, slaPdf, type DigestSettings } from '../reports';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const Scope = Type.Union([Type.Literal('all'), Type.Literal('group'), Type.Literal('monitor'), Type.Literal('tag')]);

export async function reportRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: app.requireRole('admin') };

  app.get('/api/reports/sla', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags: ['reports'], summary: 'SLA report as JSON, CSV or PDF', querystring: Type.Object({ scope: Type.Optional(Scope), id: Type.Optional(Type.Integer()), days: Type.Optional(Type.Integer({ minimum: 1, maximum: 730 })), format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv'), Type.Literal('pdf')])) }) } }, async (req, reply) => {
    const q = req.query as { scope?: 'all' | 'group' | 'monitor' | 'tag'; id?: number; days?: number; format?: 'json' | 'csv' | 'pdf' };
    if (q.scope && q.scope !== 'all' && !q.id) return reply.code(400).send({ error: 'validation', message: 'id is required for this scope' });
    const rep = await buildSla(ctx, { type: q.scope ?? 'all', id: q.id }, q.days ?? 30, await accessibleMonitorIds(ctx, req.user!));
    const stamp = rep.to.slice(0, 10);
    if (q.format === 'csv') return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="sla-${stamp}.csv"`).send(slaCsv(rep));
    if (q.format === 'pdf') return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="sla-${stamp}.pdf"`).send(await slaPdf(rep));
    return rep;
  });

  /* scheduled reports */
  const body = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 128 }), scopeType: Scope, scopeId: Type.Optional(Type.Union([Type.Null(), Type.Integer()])), rangeDays: Type.Integer({ minimum: 1, maximum: 730 }),
    cronExpr: Type.String({ maxLength: 64 }), timezone: Type.Optional(Type.String({ maxLength: 64 })), recipients: Type.Array(Type.String({ format: 'email' }), { minItems: 1, maxItems: 50 }), format: Type.Union([Type.Literal('pdf'), Type.Literal('csv')]), enabled: Type.Optional(Type.Boolean()),
  });
  const shape = (s: any) => ({ id: s.id, name: s.name, scopeType: s.scope_type, scopeId: s.scope_id, rangeDays: s.range_days, cronExpr: s.cron_expr, timezone: s.timezone, recipients: s.recipients.split(','), format: s.format, enabled: !!s.enabled, lastRunAt: s.last_run_at });
  const check = (b: any): string | null => {
    if (b.scopeType !== 'all' && !b.scopeId) return 'scopeId is required for this scope';
    try { new Cron(b.cronExpr, { timezone: b.timezone ?? 'UTC' }); } catch (e) { return `Invalid cron expression or time zone: ${(e as Error).message}`; }
    return null;
  };
  const values = (b: any) => ({ name: b.name, scope_type: b.scopeType, scope_id: b.scopeType === 'all' ? null : b.scopeId, range_days: b.rangeDays, cron_expr: b.cronExpr, timezone: b.timezone ?? 'UTC', recipients: b.recipients.join(','), format: b.format, enabled: b.enabled === false ? 0 : 1 });

  app.get('/api/report-schedules', { ...admin, schema: { tags: ['reports'] } }, async () => (await db.selectFrom('report_schedules').selectAll().orderBy('name').execute()).map(shape));
  app.post('/api/report-schedules', { ...admin, schema: { tags: ['reports'], body } }, async (req, reply) => {
    const err = check(req.body); if (err) return reply.code(400).send({ error: 'validation', message: err });
    const r = await db.insertInto('report_schedules').values({ ...values(req.body), created_by: req.user!.id }).executeTakeFirstOrThrow();
    await writeAudit(ctx, req.user, 'report_schedule.created', { type: 'report_schedule', id: Number(r.insertId) }, undefined, req.ip);
    return { id: Number(r.insertId) };
  });
  app.put('/api/report-schedules/:id', { ...admin, schema: { tags: ['reports'], params: Id, body } }, async (req, reply) => {
    const err = check(req.body); if (err) return reply.code(400).send({ error: 'validation', message: err });
    await db.updateTable('report_schedules').set(values(req.body)).where('id', '=', (req.params as any).id).execute();
    return { ok: true };
  });
  app.delete('/api/report-schedules/:id', { ...admin, schema: { tags: ['reports'], params: Id } }, async (req) => { await db.deleteFrom('report_schedules').where('id', '=', (req.params as any).id).execute(); return { ok: true }; });
  app.post('/api/report-schedules/:id/run', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['reports'], summary: 'Send now', params: Id } }, async (req, reply) => {
    if (!mailConfigured()) return reply.code(400).send({ error: 'unavailable', message: 'SMTP is not configured (PW_SMTP_HOST)' });
    const s = await db.selectFrom('report_schedules').selectAll().where('id', '=', (req.params as any).id).executeTakeFirst();
    if (!s) return reply.code(404).send({ error: 'not_found' });
    try { await sendReport(ctx, s); } catch (e) { return reply.code(502).send({ error: 'send_failed', message: (e as Error).message }); }
    return { ok: true };
  });

  /* daily digest */
  app.get('/api/settings/digest', { ...admin, schema: { tags: ['reports'] } }, async () => ({ ...(await ctx.settings.get<DigestSettings>('digest', DIGEST_DEFAULT)), smtpConfigured: mailConfigured() }));
  app.put('/api/settings/digest', { ...admin, schema: { tags: ['reports'], body: Type.Object({ enabled: Type.Boolean(), hour: Type.Integer({ minimum: 0, maximum: 23 }), timezone: Type.String({ maxLength: 64 }), recipients: Type.Array(Type.String({ format: 'email' }), { maxItems: 50 }) }) } }, async (req, reply) => {
    const b = req.body as DigestSettings;
    try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { return reply.code(400).send({ error: 'validation', message: 'Unknown time zone' }); }
    await ctx.settings.set('digest', b);
    await writeAudit(ctx, req.user, 'settings.digest_changed', { type: 'settings' }, { enabled: b.enabled }, req.ip);
    return { ok: true };
  });
  app.post('/api/settings/digest/preview', { ...admin, schema: { tags: ['reports'], summary: 'Render the digest (and optionally email it to the caller)', body: Type.Object({ send: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const m = await buildDigest(ctx);
    if ((req.body as any).send) {
      if (!mailConfigured()) return reply.code(400).send({ error: 'unavailable', message: 'SMTP is not configured (PW_SMTP_HOST)' });
      if (!req.user!.email) return reply.code(400).send({ error: 'validation', message: 'Your account has no email address' });
      try { await sendSystemMail({ to: req.user!.email, ...m }); } catch (e) { return reply.code(502).send({ error: 'send_failed', message: (e as Error).message }); }
    }
    return m;
  });
}
