import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { config } from '../config';
import { createSession, COOKIE, csrfFor } from '../auth/plugin';
import { writeAudit } from '../auth/access';
import { decrypt, encrypt, hashPassword, newTotpSecret, randomToken, sha256, verifyPassword, verifyTotp } from '../crypto';
import { bool, parseJson } from '../db';
import { ldapLogin } from '../auth/external';

const DUMMY_HASH = 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const MAX_FAILS = 8;

export const pwSchema = Type.String({ minLength: 10, maxLength: 200 });
const publicUser = (u: any, csrf?: string) => ({
  id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role, locale: u.locale, theme: u.theme, totpEnabled: u.totpEnabled,
  authSource: u.authSource, scopeRestricted: u.scopeRestricted, csrf,
});

export async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/api/setup/status', { schema: { tags: ['auth'], summary: 'Is first-run setup required?' } }, async () => {
    const n = await db.selectFrom('users').select(sql<number>`COUNT(*)`.as('n')).executeTakeFirst();
    return { needsSetup: Number(n?.n ?? 0) === 0, brand: config.brand };
  });

  app.post('/api/setup', {
    schema: { tags: ['auth'], summary: 'Create the first administrator', body: Type.Object({ username: Type.String({ minLength: 3, maxLength: 64, pattern: '^[A-Za-z0-9._@-]+$' }), password: pwSchema, email: Type.Optional(Type.String({ format: 'email' })), displayName: Type.Optional(Type.String({ maxLength: 128 })) }) },
    config: { rateLimit: { max: 5, timeWindow: '1 minute' }, skipCsrf: true },
  }, async (req, reply) => {
    const b = req.body as { username: string; password: string; email?: string; displayName?: string };
    const created = await db.transaction().execute(async (trx) => {
      const n = await trx.selectFrom('users').select(sql<number>`COUNT(*)`.as('n')).forUpdate().executeTakeFirst();
      if (Number(n?.n ?? 0) > 0) return null;
      const r = await trx.insertInto('users').values({ username: b.username, email: b.email ?? null, display_name: b.displayName || b.username, password_hash: await hashPassword(b.password), role: 'admin' }).executeTakeFirstOrThrow();
      return Number(r.insertId);
    });
    if (!created) return reply.code(409).send({ error: 'already_setup', message: 'Setup was already completed' });
    await writeAudit(ctx, { id: created, username: b.username }, 'setup.admin_created', { type: 'user', id: created }, undefined, req.ip);
    const token = await createSession(ctx, created, req, reply);
    return { ok: true, csrf: csrfFor(token) };
  });

  app.post('/api/auth/login', {
    schema: { tags: ['auth'], summary: 'Log in with a local account', body: Type.Object({ username: Type.String({ maxLength: 255 }), password: Type.String({ maxLength: 500 }), totp: Type.Optional(Type.String({ maxLength: 32 })) }) },
    config: { rateLimit: { max: config.rateLimit.loginMax, timeWindow: '1 minute' }, skipCsrf: true },
  }, async (req, reply) => {
    const b = req.body as { username: string; password: string; totp?: string };
    const any = await db.selectFrom('users').select(['id', 'auth_source']).where('username', '=', b.username).executeTakeFirst();
    if (!any || any.auth_source === 'ldap') {
      // directory accounts: bind against the configured LDAP servers (undefined = none configured, fall through to the local failure path)
      const uid = await ldapLogin(ctx, b.username, b.password);
      if (uid) {
        const token = await createSession(ctx, uid, req, reply);
        await writeAudit(ctx, { id: uid, username: b.username }, 'login.success', { type: 'user', id: uid }, { via: 'ldap' }, req.ip);
        return { ok: true, csrf: csrfFor(token) };
      }
    }
    const u = await db.selectFrom('users').selectAll().where('username', '=', b.username).where('auth_source', '=', 'local').executeTakeFirst();
    const valid = await verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH);
    const fail = async (why: string) => { await writeAudit(ctx, null, 'login.failed', { type: 'user', id: b.username }, { why }, req.ip); return reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid username or password' }); };
    if (!u || !bool(u.is_active)) return fail('unknown or disabled');
    if (u.locked_until && u.locked_until > new Date()) return reply.code(429).send({ error: 'locked', message: 'Account is temporarily locked after too many failed attempts' });
    if (!valid) {
      const fails = u.failed_logins + 1;
      await db.updateTable('users').set(fails >= MAX_FAILS ? { failed_logins: 0, locked_until: new Date(Date.now() + 15 * 60_000) } : { failed_logins: fails }).where('id', '=', u.id).execute();
      return fail('bad password');
    }
    if (bool(u.totp_enabled)) {
      if (!b.totp) return reply.code(401).send({ error: 'totp_required', message: 'Enter the code from your authenticator app' });
      const secret = decrypt(u.totp_secret_enc!);
      let okCode = verifyTotp(secret, b.totp);
      if (!okCode) {
        const codes = parseJson<string[]>(u.totp_recovery, []);
        const h = sha256(b.totp.trim().toLowerCase());
        if (codes.includes(h)) { okCode = true; await db.updateTable('users').set({ totp_recovery: JSON.stringify(codes.filter((c) => c !== h)) }).where('id', '=', u.id).execute(); }
      }
      if (!okCode) return fail('bad totp');
    }
    await db.updateTable('users').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', u.id).execute();
    const token = await createSession(ctx, u.id, req, reply);
    await writeAudit(ctx, { id: u.id, username: u.username }, 'login.success', { type: 'user', id: u.id }, undefined, req.ip);
    return { ok: true, csrf: csrfFor(token) };
  });

  app.post('/api/auth/logout', { preHandler: app.requireAuth, schema: { tags: ['auth'] } }, async (req, reply) => {
    if (req.sessionToken) await db.deleteFrom('sessions').where('token_hash', '=', sha256(req.sessionToken)).execute();
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { schema: { tags: ['auth'], summary: 'Current user' } }, async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    return publicUser(req.user, req.user.csrf);
  });

  app.patch('/api/auth/me', {
    preHandler: app.requireAuth,
    schema: { tags: ['auth'], body: Type.Object({ displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), email: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])), locale: Type.Optional(Type.Union([Type.Literal('en'), Type.Literal('de'), Type.Null()])), theme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark'), Type.Literal('system')])) }) },
  }, async (req) => {
    const b = req.body as any;
    const set: Record<string, unknown> = {};
    if (b.displayName !== undefined) set.display_name = b.displayName;
    if (b.email !== undefined) set.email = b.email;
    if (b.locale !== undefined) set.locale = b.locale;
    if (b.theme !== undefined) set.theme = b.theme;
    if (Object.keys(set).length) await db.updateTable('users').set(set).where('id', '=', req.user!.id).execute();
    return { ok: true };
  });

  app.post('/api/auth/password', {
    preHandler: app.requireAuth,
    schema: { tags: ['auth'], body: Type.Object({ current: Type.String(), next: pwSchema }) },
  }, async (req, reply) => {
    const b = req.body as { current: string; next: string };
    const u = await db.selectFrom('users').select(['password_hash', 'auth_source']).where('id', '=', req.user!.id).executeTakeFirst();
    if (!u?.password_hash || !(await verifyPassword(b.current, u.password_hash))) return reply.code(400).send({ error: 'invalid_password', message: 'Current password is wrong' });
    await db.updateTable('users').set({ password_hash: await hashPassword(b.next) }).where('id', '=', req.user!.id).execute();
    // end all other sessions
    let q = db.deleteFrom('sessions').where('user_id', '=', req.user!.id);
    if (req.user!.sessionId) q = q.where('id', '!=', req.user!.sessionId);
    await q.execute();
    await writeAudit(ctx, req.user, 'password.changed', { type: 'user', id: req.user!.id }, undefined, req.ip);
    return { ok: true };
  });

  app.get('/api/auth/sessions', { preHandler: app.requireAuth, schema: { tags: ['auth'] } }, async (req) => {
    const rows = await db.selectFrom('sessions').select(['id', 'created_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent']).where('user_id', '=', req.user!.id).where('expires_at', '>', new Date()).orderBy('last_seen_at', 'desc').execute();
    return rows.map((r) => ({ ...r, current: r.id === req.user!.sessionId }));
  });

  app.delete('/api/auth/sessions/:id', { preHandler: app.requireAuth, schema: { tags: ['auth'], params: Type.Object({ id: Type.Integer() }) } }, async (req) => {
    await db.deleteFrom('sessions').where('id', '=', (req.params as any).id).where('user_id', '=', req.user!.id).execute();
    return { ok: true };
  });

  /* ---- two factor ---- */
  app.post('/api/auth/2fa/setup', { preHandler: app.requireAuth, schema: { tags: ['auth'], summary: 'Start TOTP enrollment' } }, async (req) => {
    const secret = newTotpSecret();
    await db.updateTable('users').set({ totp_secret_enc: encrypt(secret), totp_enabled: 0 }).where('id', '=', req.user!.id).execute();
    const issuer = encodeURIComponent(config.brand.name);
    return { secret, otpauthUrl: `otpauth://totp/${issuer}:${encodeURIComponent(req.user!.username)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` };
  });

  app.post('/api/auth/2fa/enable', { preHandler: app.requireAuth, schema: { tags: ['auth'], body: Type.Object({ code: Type.String() }) } }, async (req, reply) => {
    const u = await db.selectFrom('users').select('totp_secret_enc').where('id', '=', req.user!.id).executeTakeFirst();
    if (!u?.totp_secret_enc || !verifyTotp(decrypt(u.totp_secret_enc), (req.body as any).code)) return reply.code(400).send({ error: 'invalid_code', message: 'The code is not valid' });
    const codes = Array.from({ length: 8 }, () => randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 10));
    await db.updateTable('users').set({ totp_enabled: 1, totp_recovery: JSON.stringify(codes.map((c) => sha256(c))) }).where('id', '=', req.user!.id).execute();
    await writeAudit(ctx, req.user, '2fa.enabled', { type: 'user', id: req.user!.id }, undefined, req.ip);
    return { ok: true, recoveryCodes: codes };
  });

  app.post('/api/auth/2fa/disable', { preHandler: app.requireAuth, schema: { tags: ['auth'], body: Type.Object({ password: Type.String(), code: Type.String() }) } }, async (req, reply) => {
    const b = req.body as { password: string; code: string };
    const u = await db.selectFrom('users').select(['password_hash', 'totp_secret_enc']).where('id', '=', req.user!.id).executeTakeFirst();
    if (!u?.password_hash || !(await verifyPassword(b.password, u.password_hash)) || !u.totp_secret_enc || !verifyTotp(decrypt(u.totp_secret_enc), b.code)) return reply.code(400).send({ error: 'invalid_credentials', message: 'Password or code is wrong' });
    await db.updateTable('users').set({ totp_enabled: 0, totp_secret_enc: null, totp_recovery: null }).where('id', '=', req.user!.id).execute();
    await writeAudit(ctx, req.user, '2fa.disabled', { type: 'user', id: req.user!.id }, undefined, req.ip);
    return { ok: true };
  });

  /* ---- API tokens ---- */
  app.get('/api/tokens', { preHandler: app.requireAuth, schema: { tags: ['tokens'] } }, async (req) => {
    let q = db.selectFrom('api_tokens as t').innerJoin('users as u', 'u.id', 't.user_id').select(['t.id', 't.name', 't.token_prefix', 't.scopes', 't.created_at', 't.last_used_at', 't.expires_at', 'u.username']).orderBy('t.id', 'desc');
    if (req.user!.role !== 'admin' || !(req.query as any).all) q = q.where('t.user_id', '=', req.user!.id);
    return (await q.execute()).map((t) => ({ ...t, scopes: t.scopes.split(',') }));
  });

  app.post('/api/tokens', {
    preHandler: app.requireAuth,
    schema: { tags: ['tokens'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), scopes: Type.Array(Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('admin')]), { minItems: 1 }), expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })) }) },
  }, async (req, reply) => {
    const b = req.body as { name: string; scopes: string[]; expiresInDays?: number };
    if (req.user!.tokenScopes) return reply.code(403).send({ error: 'forbidden', message: 'Tokens cannot create tokens' });
    if (b.scopes.includes('admin') && req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'Only administrators can create admin tokens' });
    if (b.scopes.includes('write') && req.user!.role === 'viewer') return reply.code(403).send({ error: 'forbidden', message: 'Viewers cannot create write tokens' });
    const raw = `pw_${randomToken(32)}`;
    const r = await db.insertInto('api_tokens').values({ user_id: req.user!.id, name: b.name, token_hash: sha256(raw), token_prefix: raw.slice(0, 10), scopes: b.scopes.join(','), expires_at: b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 86_400_000) : null }).executeTakeFirstOrThrow();
    await writeAudit(ctx, req.user, 'token.created', { type: 'token', id: Number(r.insertId) }, { name: b.name, scopes: b.scopes }, req.ip);
    return { id: Number(r.insertId), token: raw };
  });

  app.delete('/api/tokens/:id', { preHandler: app.requireAuth, schema: { tags: ['tokens'], params: Type.Object({ id: Type.Integer() }) } }, async (req) => {
    let q = db.deleteFrom('api_tokens').where('id', '=', (req.params as any).id);
    if (req.user!.role !== 'admin') q = q.where('user_id', '=', req.user!.id);
    await q.execute();
    await writeAudit(ctx, req.user, 'token.deleted', { type: 'token', id: (req.params as any).id }, undefined, req.ip);
    return { ok: true };
  });
}
