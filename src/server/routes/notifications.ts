import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { maskSecrets, restoreSecrets, validateConfig } from '../../core';
import { writeAudit } from '../auth/access';
import { decryptJson, encryptJson } from '../crypto';
import { parseJson } from '../db';
import { parseMonitor } from '../monitors/model';
import { channelRunner as asRunner, channelTypes } from '../notify/channels';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });

const quiet = Type.Optional(Type.Union([Type.Null(), Type.Object({ start: Type.String({ pattern: '^\\d{2}:\\d{2}$' }), end: Type.String({ pattern: '^\\d{2}:\\d{2}$' }), timezone: Type.Optional(Type.String()), days: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }))), mode: Type.Optional(Type.Union([Type.Literal('defer'), Type.Literal('drop')])), bypassDown: Type.Optional(Type.Boolean()) })]));

export async function notificationRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: app.requireRole('admin') };

  app.get('/api/notification-types', { ...auth, schema: { tags: ['notifications'] } }, async () => [...channelTypes.values()].map((c) => ({ type: c.type, label: c.label, fields: c.fields })));

  const shape = (c: any) => {
    const type = channelTypes.get(c.type);
    let config: Record<string, any> = {};
    try { config = type ? maskSecrets(asRunner(c.type), decryptJson(c.config_enc)) : {}; } catch { /* undecryptable (key changed) */ }
    return { id: c.id, name: c.name, type: c.type, config, active: !!c.active, isDefault: !!c.is_default, quietHours: parseJson(c.quiet_hours, null), templateId: c.template_id };
  };

  app.get('/api/notification-channels', { ...auth, schema: { tags: ['notifications'] } }, async (req) => {
    const rows = await db.selectFrom('notification_channels').selectAll().orderBy('name').execute();
    // viewers only need names to read rules; never the config
    return req.user!.role === 'admin' ? rows.map(shape) : rows.map((c) => ({ id: c.id, name: c.name, type: c.type, active: !!c.active, isDefault: !!c.is_default }));
  });

  const channelBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), type: Type.String(), config: Type.Object({}, { additionalProperties: true }), active: Type.Optional(Type.Boolean()), isDefault: Type.Optional(Type.Boolean()), quietHours: quiet, templateId: Type.Optional(Type.Union([Type.Null(), Type.Integer()])) });
  const saveChannel = async (req: any, reply: any, id?: number) => {
    const b = req.body;
    if (!channelTypes.has(b.type)) return reply.code(400).send({ error: 'validation', message: `Unknown channel type ${b.type}` });
    let cfg = b.config;
    if (id) {
      const old = await db.selectFrom('notification_channels').select('config_enc').where('id', '=', id).executeTakeFirst();
      if (!old) return reply.code(404).send({ error: 'not_found' });
      cfg = restoreSecrets(asRunner(b.type), cfg, decryptJson(old.config_enc));
    }
    const v = validateConfig(asRunner(b.type), cfg);
    if (v.errors.length) return reply.code(400).send({ error: 'validation', message: v.errors.join('; '), errors: v.errors });
    const values = { name: b.name, type: b.type, config_enc: encryptJson(v.config), active: b.active === false ? 0 : 1, is_default: b.isDefault ? 1 : 0, quiet_hours: b.quietHours ? JSON.stringify(b.quietHours) : null, template_id: b.templateId ?? null };
    try {
      if (id) await db.updateTable('notification_channels').set(values).where('id', '=', id).execute();
      else id = Number((await db.insertInto('notification_channels').values({ ...values, created_by: req.user.id }).executeTakeFirstOrThrow()).insertId);
    } catch (e: any) { if (e.code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'conflict', message: 'A channel with this name already exists' }); throw e; }
    await writeAudit(ctx, req.user, 'channel.saved', { type: 'channel', id }, { name: b.name, type: b.type }, req.ip);
    return shape(await db.selectFrom('notification_channels').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  };
  app.post('/api/notification-channels', { ...admin, schema: { tags: ['notifications'], body: channelBody } }, (req, reply) => saveChannel(req, reply));
  app.put('/api/notification-channels/:id', { ...admin, schema: { tags: ['notifications'], params: Id, body: channelBody } }, (req, reply) => saveChannel(req, reply, (req.params as any).id));
  app.delete('/api/notification-channels/:id', { ...admin, schema: { tags: ['notifications'], params: Id } }, async (req) => {
    await db.deleteFrom('notification_channels').where('id', '=', (req.params as any).id).execute();
    await writeAudit(ctx, req.user, 'channel.deleted', { type: 'channel', id: (req.params as any).id }, undefined, req.ip);
    return { ok: true };
  });

  app.post('/api/notification-channels/:id/test', { ...admin, schema: { tags: ['notifications'], summary: 'Send a test message', params: Id }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = (req.params as any).id;
    const ch = await db.selectFrom('notification_channels').select('id').where('id', '=', id).executeTakeFirst();
    if (!ch) return reply.code(404).send({ error: 'not_found' });
    const sample = parseMonitor({ id: 0, name: 'Test monitor', type: 'http', config: '{}', group_id: null, description: null, interval_s: 60, timeout_s: 10, retries: 0, retry_interval_s: 20, up_threshold: 1, down_threshold: 1, flap_window: 10, flap_threshold: 6, active: 1, locations: null, quorum: 1, push_token: null, public_badge: 0, next_run_at: null, lease_owner: null, lease_until: null, attempt: 0, created_by: null, created_at: new Date(), updated_at: new Date() });
    return ctx.notifier.test(id, sample);
  });

  /* templates */
  const tplBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), subject: Type.String({ minLength: 1, maxLength: 255 }), body: Type.String({ minLength: 1, maxLength: 5000 }) });
  app.get('/api/notification-templates', { ...auth, schema: { tags: ['notifications'] } }, async () => db.selectFrom('notification_templates').select(['id', 'name', 'subject', 'body']).orderBy('name').execute());
  app.post('/api/notification-templates', { ...admin, schema: { tags: ['notifications'], body: tplBody } }, async (req) => ({ id: Number((await db.insertInto('notification_templates').values(req.body as any).executeTakeFirstOrThrow()).insertId) }));
  app.put('/api/notification-templates/:id', { ...admin, schema: { tags: ['notifications'], params: Id, body: tplBody } }, async (req) => { await db.updateTable('notification_templates').set(req.body as any).where('id', '=', (req.params as any).id).execute(); return { ok: true }; });
  app.delete('/api/notification-templates/:id', { ...admin, schema: { tags: ['notifications'], params: Id } }, async (req) => { await db.deleteFrom('notification_templates').where('id', '=', (req.params as any).id).execute(); return { ok: true }; });

  /* escalation policies */
  const polBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), steps: Type.Array(Type.Object({ delayMin: Type.Integer({ minimum: 0, maximum: 10080 }), channelIds: Type.Array(Type.Integer(), { minItems: 1 }) }), { minItems: 1, maxItems: 10 }), repeatEveryMin: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080 })) });
  const shapePol = (p: any) => { const v = parseJson<any>(p.steps, { steps: [] }); return { id: p.id, name: p.name, steps: v.steps, repeatEveryMin: v.repeatEveryMin ?? null }; };
  app.get('/api/escalation-policies', { ...auth, schema: { tags: ['notifications'] } }, async () => (await db.selectFrom('escalation_policies').selectAll().orderBy('name').execute()).map(shapePol));
  const savePol = async (req: any, id?: number) => {
    const b = req.body;
    const v = { name: b.name, steps: JSON.stringify({ steps: b.steps, repeatEveryMin: b.repeatEveryMin }) };
    if (id) await db.updateTable('escalation_policies').set(v).where('id', '=', id).execute(); else id = Number((await db.insertInto('escalation_policies').values(v).executeTakeFirstOrThrow()).insertId);
    return { id };
  };
  app.post('/api/escalation-policies', { ...admin, schema: { tags: ['notifications'], body: polBody } }, (req) => savePol(req));
  app.put('/api/escalation-policies/:id', { ...admin, schema: { tags: ['notifications'], params: Id, body: polBody } }, (req) => savePol(req, (req.params as any).id));
  app.delete('/api/escalation-policies/:id', { ...admin, schema: { tags: ['notifications'], params: Id } }, async (req) => { await db.deleteFrom('escalation_policies').where('id', '=', (req.params as any).id).execute(); return { ok: true }; });

  /* delivery log */
  app.get('/api/notification-deliveries', { ...auth, schema: { tags: ['notifications'], querystring: Type.Object({ status: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })), before: Type.Optional(Type.Integer()) }) } }, async (req) => {
    const q = req.query as any;
    let s = db.selectFrom('notification_deliveries as d').leftJoin('notification_channels as c', 'c.id', 'd.channel_id').leftJoin('monitors as m', 'm.id', 'd.monitor_id')
      .select(['d.id', 'd.ts', 'd.event', 'd.status', 'd.attempts', 'd.next_attempt_at', 'd.last_error', 'd.subject', 'd.monitor_id', 'd.incident_id', 'c.name as channel', 'c.type as channelType', 'm.name as monitor']).orderBy('d.id', 'desc').limit(q.limit ?? 100);
    if (q.status) s = s.where('d.status', '=', q.status);
    if (q.before) s = s.where('d.id', '<', q.before);
    return (await s.execute()).map((d) => ({ id: d.id, ts: d.ts, event: d.event, status: d.status, attempts: d.attempts, nextAttemptAt: d.next_attempt_at, error: d.last_error, subject: d.subject, monitorId: d.monitor_id, monitor: d.monitor, incidentId: d.incident_id, channel: d.channel, channelType: d.channelType }));
  });
  app.post('/api/notification-deliveries/:id/retry', { ...admin, schema: { tags: ['notifications'], params: Id } }, async (req) => {
    await db.updateTable('notification_deliveries').set({ status: 'pending', attempts: 0, next_attempt_at: new Date(), last_error: null }).where('id', '=', (req.params as any).id).where('status', 'in', ['failed', 'skipped']).execute();
    setImmediate(() => void ctx.notifier.process());
    return { ok: true };
  });
}
