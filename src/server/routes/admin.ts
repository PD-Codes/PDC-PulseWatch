import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { DEFAULT_DENY } from '../../core';
import { writeAudit } from '../auth/access';
import { hashPassword } from '../crypto';
import { bool } from '../db';
import { applySsrfSettings, isCidr } from '../guard-sync';
import { pwSchema } from './auth';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const Role = Type.Union([Type.Literal('admin'), Type.Literal('editor'), Type.Literal('viewer')]);
const cidr = isCidr;

export async function adminRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const admin = { preHandler: app.requireRole('admin') };

  /* ---------------------------------- users --------------------------------- */
  const shape = (u: any) => ({ id: u.id, username: u.username, displayName: u.display_name, email: u.email, role: u.role, scopeRestricted: bool(u.scope_restricted), authSource: u.auth_source, isActive: bool(u.is_active), totpEnabled: bool(u.totp_enabled), createdAt: u.created_at, lastLoginAt: u.last_login_at, locked: !!u.locked_until && u.locked_until > new Date() });

  /** Names only: used by pickers (incident assignee) for every signed-in user. */
  app.get('/api/users/directory', { preHandler: app.requireAuth, schema: { tags: ['users'] } }, async () =>
    (await db.selectFrom('users').select(['id', 'username', 'display_name']).where('is_active', '=', 1).orderBy('display_name').execute()).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })));

  app.get('/api/users', { ...admin, schema: { tags: ['users'] } }, async () => (await db.selectFrom('users').selectAll().orderBy('username').execute()).map(shape));

  app.post('/api/users', { ...admin, schema: { tags: ['users'], body: Type.Object({ username: Type.String({ minLength: 3, maxLength: 64, pattern: '^[A-Za-z0-9._@-]+$' }), password: pwSchema, displayName: Type.Optional(Type.String({ maxLength: 128 })), email: Type.Optional(Type.String({ format: 'email' })), role: Role, scopeRestricted: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const b = req.body as any;
    try {
      const r = await db.insertInto('users').values({ username: b.username, email: b.email ?? null, display_name: b.displayName || b.username, password_hash: await hashPassword(b.password), role: b.role, scope_restricted: b.scopeRestricted ? 1 : 0 }).executeTakeFirstOrThrow();
      await writeAudit(ctx, req.user, 'user.created', { type: 'user', id: Number(r.insertId) }, { username: b.username, role: b.role }, req.ip);
      return { id: Number(r.insertId) };
    } catch (e: any) { if (e.code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'conflict', message: 'Username or email already exists' }); throw e; }
  });

  /** Refuse changes that would leave the system without an active administrator. */
  const lastAdmin = async (id: number, reply: FastifyReply): Promise<boolean> => {
    const left = await db.selectFrom('users').select('id').where('role', '=', 'admin').where('is_active', '=', 1).where('id', '!=', id).limit(1).executeTakeFirst();
    if (left) return false;
    reply.code(409).send({ error: 'conflict', message: 'At least one active administrator is required' });
    return true;
  };

  app.patch('/api/users/:id', { ...admin, schema: { tags: ['users'], params: Id, body: Type.Object({ displayName: Type.Optional(Type.String({ maxLength: 128 })), email: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])), role: Type.Optional(Role), scopeRestricted: Type.Optional(Type.Boolean()), isActive: Type.Optional(Type.Boolean()), password: Type.Optional(pwSchema), resetTotp: Type.Optional(Type.Boolean()), unlock: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const id = (req.params as any).id; const b = req.body as any;
    const u = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!u) return reply.code(404).send({ error: 'not_found' });
    if (u.role === 'admin' && ((b.role && b.role !== 'admin') || b.isActive === false) && (await lastAdmin(id, reply))) return;
    const set: Record<string, unknown> = {};
    if (b.displayName !== undefined) set.display_name = b.displayName || u.username;
    if (b.email !== undefined) set.email = b.email;
    if (b.role) set.role = b.role;
    if (b.scopeRestricted !== undefined) set.scope_restricted = b.scopeRestricted ? 1 : 0;
    if (b.isActive !== undefined) set.is_active = b.isActive ? 1 : 0;
    if (b.password) { if (u.auth_source !== 'local') return reply.code(400).send({ error: 'validation', message: 'Passwords of external accounts are managed by their provider' }); set.password_hash = await hashPassword(b.password); }
    if (b.resetTotp) { set.totp_enabled = 0; set.totp_secret_enc = null; set.totp_recovery = null; }
    if (b.unlock) { set.failed_logins = 0; set.locked_until = null; }
    try { if (Object.keys(set).length) await db.updateTable('users').set(set).where('id', '=', id).execute(); }
    catch (e: any) { if (e.code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'conflict', message: 'Email already exists' }); throw e; }
    // deactivation, password reset and role change take effect immediately
    if (b.isActive === false || b.password || b.role) await db.deleteFrom('sessions').where('user_id', '=', id).execute();
    if (b.isActive === false || b.password) await db.deleteFrom('api_tokens').where('user_id', '=', id).execute();
    await writeAudit(ctx, req.user, 'user.updated', { type: 'user', id }, { ...b, password: b.password ? '***' : undefined }, req.ip);
    return { ok: true };
  });

  app.delete('/api/users/:id', { ...admin, schema: { tags: ['users'], params: Id } }, async (req, reply) => {
    const id = (req.params as any).id;
    if (id === req.user!.id) return reply.code(400).send({ error: 'validation', message: 'You cannot delete your own account' });
    const u = await db.selectFrom('users').select('role').where('id', '=', id).executeTakeFirst();
    if (!u) return reply.code(404).send({ error: 'not_found' });
    if (u.role === 'admin' && (await lastAdmin(id, reply))) return;
    await db.deleteFrom('users').where('id', '=', id).execute();
    await writeAudit(ctx, req.user, 'user.deleted', { type: 'user', id }, undefined, req.ip);
    return { ok: true };
  });

  app.get('/api/users/:id/grants', { ...admin, schema: { tags: ['users'], params: Id } }, async (req) =>
    (await db.selectFrom('permission_grants').select(['resource_type', 'resource_id', 'level']).where('user_id', '=', (req.params as any).id).execute()).map((g) => ({ type: g.resource_type, id: g.resource_id, level: g.level })));

  app.put('/api/users/:id/grants', { ...admin, schema: { tags: ['users'], params: Id, body: Type.Object({ grants: Type.Array(Type.Object({ type: Type.Union([Type.Literal('monitor_group'), Type.Literal('status_page')]), id: Type.Integer(), level: Type.Union([Type.Literal('view'), Type.Literal('manage')]) }), { maxItems: 500 }) }) } }, async (req, reply) => {
    const id = (req.params as any).id; const grants = (req.body as any).grants as { type: any; id: number; level: any }[];
    if (!(await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst())) return reply.code(404).send({ error: 'not_found' });
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('permission_grants').where('user_id', '=', id).execute();
      const unique = [...new Map(grants.map((g) => [`${g.type}:${g.id}`, g])).values()];
      if (unique.length) await trx.insertInto('permission_grants').values(unique.map((g) => ({ user_id: id, resource_type: g.type, resource_id: g.id, level: g.level }))).execute();
    });
    await writeAudit(ctx, req.user, 'user.grants_changed', { type: 'user', id }, { count: grants.length }, req.ip);
    return { ok: true };
  });

  /* ---------------------------------- audit --------------------------------- */
  app.get('/api/audit', { ...admin, schema: { tags: ['audit'], querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })), before: Type.Optional(Type.Integer()), action: Type.Optional(Type.String()), actor: Type.Optional(Type.String()) }) } }, async (req) => {
    const q = req.query as any;
    let s = db.selectFrom('audit_log').selectAll().orderBy('id', 'desc').limit(q.limit ?? 100);
    if (q.before) s = s.where('id', '<', q.before);
    if (q.action) s = s.where('action', 'like', `${q.action.replace(/[%_]/g, '')}%`);
    if (q.actor) s = s.where('actor', '=', q.actor);
    return (await s.execute()).map((a) => ({ id: a.id, ts: a.ts, actor: a.actor, userId: a.user_id, action: a.action, entityType: a.entity_type, entityId: a.entity_id, ip: a.ip, details: a.details }));
  });

  /* -------------------------------- settings -------------------------------- */
  const ssrfBody = Type.Object({ mode: Type.Union([Type.Literal('allow-private'), Type.Literal('public-only')]), allow: Type.Array(Type.String(), { maxItems: 200 }), deny: Type.Array(Type.String(), { maxItems: 200 }) });
  app.get('/api/settings/ssrf', { ...admin, schema: { tags: ['settings'] } }, async () => {
    const g = ctx.guard.config;
    return { mode: g.mode, allow: g.allow, deny: g.deny.filter((d: string) => !DEFAULT_DENY_SET.has(d)), builtinDeny: [...DEFAULT_DENY_SET], source: (await ctx.settings.get('ssrf', null)) ? 'ui' : 'environment' };
  });
  app.put('/api/settings/ssrf', { ...admin, schema: { tags: ['settings'], body: ssrfBody } }, async (req, reply) => {
    const b = req.body as { mode: 'allow-private' | 'public-only'; allow: string[]; deny: string[] };
    const bad = [...b.allow, ...b.deny].filter((e) => !cidr(e));
    if (bad.length) return reply.code(400).send({ error: 'validation', message: `Invalid IP or CIDR: ${bad.join(', ')}` });
    await ctx.settings.set('ssrf', b);
    await applySsrfSettings(ctx);
    await writeAudit(ctx, req.user, 'settings.ssrf_changed', { type: 'settings' }, b, req.ip);
    return { ok: true };
  });
  app.delete('/api/settings/ssrf', { ...admin, schema: { tags: ['settings'], summary: 'Fall back to the environment defaults' } }, async (req) => {
    await ctx.settings.delete('ssrf');
    await applySsrfSettings(ctx);
    await writeAudit(ctx, req.user, 'settings.ssrf_reset', { type: 'settings' }, undefined, req.ip);
    return { ok: true };
  });
}

const DEFAULT_DENY_SET = new Set<string>(DEFAULT_DENY);
