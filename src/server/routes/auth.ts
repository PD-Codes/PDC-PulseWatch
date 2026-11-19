import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { config } from '../config';
import { createSession, COOKIE, csrfFor } from '../auth/plugin';
import { fallbackStatusPath, writeAudit } from '../auth/access';
import { acceptTotp, clearFailures, clientKey, failureWait, loginSubject, reauthError, recordFailure, waitMessage } from '../auth/reauth';
import type { Ctx } from '../context';
import { encrypt, hashPassword, newTotpSecret, randomToken, safeEqual, sha256, verifyPassword } from '../crypto';
import { bool, parseJson } from '../db';
import { ldapLogin, NO_GROUP } from '../auth/external';
import { isThemeId, ThemeSchema } from '../themes';

const DUMMY_HASH = 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export const pwSchema = Type.String({ minLength: 10, maxLength: 200 });
/** Password (and authenticator code) of the signed-in user for actions that hand out lasting access. */
export const reauthFields = { password: Type.Optional(Type.String({ maxLength: 1000 })), code: Type.Optional(Type.String({ maxLength: 32 })) };
/** Failure counter key for re-authentication: the session, so a hijacked session gains nothing by switching addresses; API tokens count per address. */
export const reauthClient = (req: import('fastify').FastifyRequest) => (req.user?.sessionId ? `s:${req.user.sessionId}` : `t:${clientKey(req.ip)}`);

const SETUP_KEY = 'setupToken.';
/** A generated setup token expires after a day; the instance that logged it keeps its entry fresh while it runs (and accepts its own token anyway). */
export const SETUP_TTL_MS = 24 * 3_600_000;
const SETUP_REFRESH_MS = 3_600_000;
interface SetupEntry { h: string; exp: number }
/** Hashes of the setup tokens this process generated (normally one per app). */
const ownSetupHashes = new Set<string>();
/**
 * While there is no user, POST /api/setup needs a setup token, so whoever reaches a fresh installation first cannot claim it. The token comes from
 * PW_SETUP_TOKEN or is generated here and logged once; only its hash is stored (one entry per instance, with an expiry), so every API instance accepts
 * every token a running instance logged. Expired entries of earlier starts are removed. Returns the stored hash, or null when nothing was issued.
 */
export async function issueSetupToken(ctx: Ctx): Promise<string | null> {
  if (config.demo) return null; // the demo seed creates its own admin
  const n = await ctx.db.selectFrom('users').select(sql<number>`COUNT(*)`.as('n')).executeTakeFirst();
  if (Number(n?.n ?? 0) > 0) return null;
  for (const [k, v] of Object.entries(await ctx.settings.all(SETUP_KEY))) if (!((v as SetupEntry | null)?.exp! > Date.now())) await ctx.settings.delete(k);
  const token = config.setupToken ?? randomToken(24);
  const h = sha256(token);
  if (!config.setupToken) ownSetupHashes.add(h);
  await ctx.settings.set(`${SETUP_KEY}${ctx.instanceId}`, { h, exp: Date.now() + SETUP_TTL_MS } satisfies SetupEntry);
  if (config.setupToken) ctx.log.warn('No administrator yet: the setup token is the value of PW_SETUP_TOKEN – enter it on the setup page to create the first administrator');
  else ctx.log.warn(`Setup token: ${token} – enter it on the setup page to create the first administrator (valid for 24 hours or until this instance stops)`);
  return h;
}
async function setupTokenOk(ctx: Ctx, given: string | undefined): Promise<boolean> {
  if (!given) return false;
  const h = sha256(given.trim());
  const now = Date.now();
  const stored = Object.values(await ctx.settings.all(SETUP_KEY)).filter((v): v is SetupEntry => !!v && typeof (v as SetupEntry).h === 'string' && (v as SetupEntry).exp > now).map((v) => v.h);
  stored.push(...ownSetupHashes);
  if (config.setupToken) stored.push(sha256(config.setupToken));
  let ok = false;
  for (const x of stored) ok = safeEqual(h, x) || ok; // no early exit
  return ok;
}
const publicUser = (u: any, csrf?: string) => ({
  id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role, locale: u.locale, theme: u.theme, uiTheme: isThemeId(u.uiTheme) ? u.uiTheme : null, totpEnabled: u.totpEnabled,
  authSource: u.authSource, scopeRestricted: u.scopeRestricted, csrf,
});

export async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/api/setup/status', { schema: { tags: ['auth'], summary: 'Is first-run setup required?' } }, async () => {
    const n = await db.selectFrom('users').select(sql<number>`COUNT(*)`.as('n')).executeTakeFirst();
    const needsSetup = Number(n?.n ?? 0) === 0;
    return { needsSetup, setupTokenRequired: needsSetup, brand: config.brand };
  });
  const issued = await issueSetupToken(ctx);
  if (issued) {
    // keep this instance's entry valid while it runs, so other instances keep accepting the token it logged
    const key = `${SETUP_KEY}${ctx.instanceId}`;
    const timer = setInterval(() => {
      void (async () => {
        if (!(await ctx.settings.get<SetupEntry | null>(key, null))) { clearInterval(timer); return; } // setup done (entries deleted)
        await ctx.settings.set(key, { h: issued, exp: Date.now() + SETUP_TTL_MS } satisfies SetupEntry);
      })().catch((e) => ctx.log.warn({ err: e }, 'setup token refresh failed'));
    }, SETUP_REFRESH_MS);
    timer.unref();
    app.addHook('onClose', async () => { clearInterval(timer); ownSetupHashes.delete(issued); });
  }

  app.post('/api/setup', {
    schema: { tags: ['auth'], summary: 'Create the first administrator', body: Type.Object({ username: Type.String({ minLength: 3, maxLength: 64, pattern: '^[A-Za-z0-9._@-]+$' }), password: pwSchema, email: Type.Optional(Type.String({ format: 'email' })), displayName: Type.Optional(Type.String({ maxLength: 128 })), setupToken: Type.Optional(Type.String({ maxLength: 500 })) }) },
    config: { rateLimit: { max: 5, timeWindow: '1 minute' }, skipCsrf: true },
  }, async (req, reply) => {
    const b = req.body as { username: string; password: string; email?: string; displayName?: string; setupToken?: string };
    const users = await db.selectFrom('users').select(sql<number>`COUNT(*)`.as('n')).executeTakeFirst();
    if (Number(users?.n ?? 0) > 0) return reply.code(409).send({ error: 'already_setup', message: 'Setup was already completed' });
    if (!(await setupTokenOk(ctx, b.setupToken))) {
      await writeAudit(ctx, null, 'setup.denied', { type: 'user', id: b.username }, { why: b.setupToken ? 'wrong setup token' : 'no setup token' }, req.ip);
      return reply.code(403).send({ error: 'invalid_setup_token', message: 'The setup token is missing or wrong. It is printed in the server log at start (or set with PW_SETUP_TOKEN).' });
    }
    const created = await db.transaction().execute(async (trx) => {
      const n = await trx.selectFrom('users').select(sql<number>`COUNT(*)`.as('n')).forUpdate().executeTakeFirst();
      if (Number(n?.n ?? 0) > 0) return null;
      const r = await trx.insertInto('users').values({ username: b.username, email: b.email ?? null, display_name: b.displayName || b.username, password_hash: await hashPassword(b.password), role: 'admin' }).executeTakeFirstOrThrow();
      return Number(r.insertId);
    });
    if (!created) return reply.code(409).send({ error: 'already_setup', message: 'Setup was already completed' });
    for (const k of Object.keys(await ctx.settings.all(SETUP_KEY))) await ctx.settings.delete(k);
    ownSetupHashes.clear();
    await writeAudit(ctx, { id: created, username: b.username }, 'setup.admin_created', { type: 'user', id: created }, undefined, req.ip);
    const token = await createSession(ctx, created, req, reply);
    return { ok: true, csrf: csrfFor(token) };
  });

  app.post('/api/auth/login', {
    schema: { tags: ['auth'], summary: 'Log in with a local account', body: Type.Object({ username: Type.String({ maxLength: 255 }), password: Type.String({ maxLength: 500 }), totp: Type.Optional(Type.String({ maxLength: 32 })) }) },
    config: { rateLimit: { max: config.rateLimit.loginMax, timeWindow: '1 minute' }, skipCsrf: true },
  }, async (req, reply) => {
    const b = req.body as { username: string; password: string; totp?: string };
    // failures count per (name, client address) with growing delays, plus an account-wide limit; local and LDAP names share the counter
    const subject = loginSubject(b.username);
    const wait = await failureWait(ctx, 'login', subject, req.ip);
    if (wait) return reply.code(429).header('Retry-After', String(Math.ceil(wait / 1000))).send({ error: 'locked', message: waitMessage(wait), retryAfter: Math.ceil(wait / 1000) });
    const any = await db.selectFrom('users').select(['id', 'auth_source']).where('username', '=', b.username).executeTakeFirst();
    if (!any || any.auth_source === 'ldap') {
      // directory accounts: bind against the configured LDAP servers (undefined = none configured, fall through to the local failure path)
      const uid = await ldapLogin(ctx, b.username, b.password);
      if (uid === NO_GROUP) {
        await writeAudit(ctx, null, 'login.denied', { type: 'user', id: b.username }, { why: 'no allowed group', via: 'ldap' }, req.ip);
        return reply.code(403).send({ error: 'no_access', message: 'Your account is not in a group that may use this application.', redirect: await fallbackStatusPath(ctx) });
      }
      if (uid) {
        await clearFailures(ctx, 'login', subject, req.ip);
        const token = await createSession(ctx, uid, req, reply);
        await writeAudit(ctx, { id: uid, username: b.username }, 'login.success', { type: 'user', id: uid }, { via: 'ldap' }, req.ip);
        return { ok: true, csrf: csrfFor(token) };
      }
    }
    const u = await db.selectFrom('users').selectAll().where('username', '=', b.username).where('auth_source', '=', 'local').executeTakeFirst();
    const valid = await verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH);
    const fail = async (why: string) => {
      // unknown names count too, so a delay does not tell which names exist; the account-wide lock is mirrored to the user row for the admin view
      await recordFailure(ctx, 'login', subject, req.ip, { onAccountLock: (until) => db.updateTable('users').set({ locked_until: until }).where('username', '=', b.username).execute() });
      await writeAudit(ctx, null, 'login.failed', { type: 'user', id: b.username }, { why }, req.ip);
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid username or password' });
    };
    if (!u || !bool(u.is_active)) return fail('unknown or disabled');
    if (u.locked_until && u.locked_until > new Date()) return reply.code(429).send({ error: 'locked', message: 'Account is temporarily locked after too many failed attempts' });
    if (!valid) return fail('bad password');
    if (bool(u.totp_enabled)) {
      if (!b.totp) return reply.code(401).send({ error: 'totp_required', message: 'Enter the code from your authenticator app' });
      let okCode = await acceptTotp(ctx, u.id, u.totp_secret_enc, b.totp);
      if (!okCode) {
        const codes = parseJson<string[]>(u.totp_recovery, []);
        const h = sha256(b.totp.trim().toLowerCase());
        if (codes.includes(h)) { okCode = true; await db.updateTable('users').set({ totp_recovery: JSON.stringify(codes.filter((c) => c !== h)) }).where('id', '=', u.id).execute(); }
      }
      if (!okCode) return fail('bad totp');
    }
    await clearFailures(ctx, 'login', subject, req.ip);
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
    schema: { tags: ['auth'], body: Type.Object({ displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), email: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])), locale: Type.Optional(Type.Union([Type.Literal('en'), Type.Literal('de'), Type.Null()])), theme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark'), Type.Literal('system')])), uiTheme: Type.Optional(Type.Union([ThemeSchema, Type.Null()])) }) },
  }, async (req) => {
    const b = req.body as any;
    const set: Record<string, unknown> = {};
    if (b.displayName !== undefined) set.display_name = b.displayName;
    if (b.email !== undefined) set.email = b.email;
    if (b.locale !== undefined) set.locale = b.locale;
    if (b.theme !== undefined) set.theme = b.theme;
    if (b.uiTheme !== undefined) set.ui_theme = b.uiTheme;
    if (Object.keys(set).length) await db.updateTable('users').set(set).where('id', '=', req.user!.id).execute();
    return { ok: true };
  });

  app.post('/api/auth/password', {
    preHandler: app.requireSession,
    schema: { tags: ['auth'], body: Type.Object({ current: Type.String(), next: pwSchema }) },
  }, async (req, reply) => {
    const b = req.body as { current: string; next: string };
    const u = await db.selectFrom('users').select(['password_hash', 'auth_source', 'locked_until']).where('id', '=', req.user!.id).executeTakeFirst();
    if (!u?.password_hash) return reply.code(400).send({ error: 'not_supported', message: 'This account has no local password, it is managed by its sign-in provider' });
    // a hijacked session must not get unlimited guesses at the current password: same counter as the other re-authentication checks
    if (u.locked_until && u.locked_until > new Date()) return reply.code(429).send({ error: 'locked', message: 'Account is temporarily locked after too many failed attempts' });
    const subject = `u:${req.user!.id}`, client = reauthClient(req);
    const wait = await failureWait(ctx, 'reauth', subject, client);
    if (wait) return reply.code(429).header('Retry-After', String(Math.ceil(wait / 1000))).send({ error: 'locked', message: waitMessage(wait), retryAfter: Math.ceil(wait / 1000) });
    if (!(await verifyPassword(b.current, u.password_hash))) {
      await recordFailure(ctx, 'reauth', subject, client, { onAccountLock: (until) => db.updateTable('users').set({ locked_until: until }).where('id', '=', req.user!.id).execute() });
      return reply.code(400).send({ error: 'invalid_password', message: 'Current password is wrong' });
    }
    await clearFailures(ctx, 'reauth', subject, client);
    await db.updateTable('users').set({ password_hash: await hashPassword(b.next) }).where('id', '=', req.user!.id).execute();
    // API tokens are lasting access as well: whoever changes the password after a leak must not leave a planted token behind
    const revoked = await db.deleteFrom('api_tokens').where('user_id', '=', req.user!.id).executeTakeFirst();
    // end all other sessions
    let q = db.deleteFrom('sessions').where('user_id', '=', req.user!.id);
    if (req.user!.sessionId) q = q.where('id', '!=', req.user!.sessionId);
    await q.execute();
    const revokedTokens = Number(revoked.numDeletedRows ?? 0);
    await writeAudit(ctx, req.user, 'password.changed', { type: 'user', id: req.user!.id }, { revokedTokens }, req.ip);
    return { ok: true, revokedTokens };
  });

  app.get('/api/auth/sessions', { preHandler: app.requireAuth, schema: { tags: ['auth'] } }, async (req) => {
    const rows = await db.selectFrom('sessions').select(['id', 'created_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent']).where('user_id', '=', req.user!.id).where('expires_at', '>', new Date()).orderBy('last_seen_at', 'desc').execute();
    return rows.map((r) => ({ ...r, current: r.id === req.user!.sessionId }));
  });

  app.delete('/api/auth/sessions/:id', { preHandler: app.requireSession, schema: { tags: ['auth'], params: Type.Object({ id: Type.Integer() }) } }, async (req) => {
    await db.deleteFrom('sessions').where('id', '=', (req.params as any).id).where('user_id', '=', req.user!.id).execute();
    return { ok: true };
  });

  /* ---- two factor ---- */
  app.post('/api/auth/2fa/setup', { preHandler: app.requireSession, schema: { tags: ['auth'], summary: 'Start TOTP enrollment' } }, async (req, reply) => {
    // starting over would switch 2FA off without a code, so an enrolled account has to disable it first
    if (req.user!.totpEnabled) return reply.code(409).send({ error: 'conflict', message: 'Two-factor authentication is already on. Turn it off first to enroll a new device.' });
    const secret = newTotpSecret();
    await db.updateTable('users').set({ totp_secret_enc: encrypt(secret), totp_enabled: 0 }).where('id', '=', req.user!.id).execute();
    const issuer = encodeURIComponent(config.brand.name);
    return { secret, otpauthUrl: `otpauth://totp/${issuer}:${encodeURIComponent(req.user!.username)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` };
  });

  app.post('/api/auth/2fa/enable', { preHandler: app.requireSession, schema: { tags: ['auth'], body: Type.Object({ code: Type.String() }) } }, async (req, reply) => {
    // enabling again would hand out a fresh set of recovery codes without asking for the password
    if (req.user!.totpEnabled) return reply.code(409).send({ error: 'conflict', message: 'Two-factor authentication is already on' });
    const u = await db.selectFrom('users').select('totp_secret_enc').where('id', '=', req.user!.id).executeTakeFirst();
    if (!u?.totp_secret_enc || !(await acceptTotp(ctx, req.user!.id, u.totp_secret_enc, (req.body as any).code))) return reply.code(400).send({ error: 'invalid_code', message: 'The code is not valid' });
    const codes = Array.from({ length: 8 }, () => randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 10));
    await db.updateTable('users').set({ totp_enabled: 1, totp_recovery: JSON.stringify(codes.map((c) => sha256(c))) }).where('id', '=', req.user!.id).execute();
    await writeAudit(ctx, req.user, '2fa.enabled', { type: 'user', id: req.user!.id }, undefined, req.ip);
    return { ok: true, recoveryCodes: codes };
  });

  app.post('/api/auth/2fa/disable', { preHandler: app.requireSession, schema: { tags: ['auth'], body: Type.Object({ password: Type.String(), code: Type.String() }) } }, async (req, reply) => {
    const b = req.body as { password: string; code: string };
    const bad = await reauthError(ctx, req.user!.id, b.password, b.code, reauthClient(req));
    if (bad) return reply.code(400).send({ error: 'invalid_credentials', message: bad });
    await db.updateTable('users').set({ totp_enabled: 0, totp_secret_enc: null, totp_recovery: null, totp_last_step: null }).where('id', '=', req.user!.id).execute();
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
    schema: { tags: ['tokens'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), scopes: Type.Array(Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('admin')]), { minItems: 1 }), expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })), ...reauthFields }) },
  }, async (req, reply) => {
    const b = req.body as { name: string; scopes: string[]; expiresInDays?: number; password?: string; code?: string };
    if (req.user!.tokenScopes) return reply.code(403).send({ error: 'forbidden', message: 'Tokens cannot create tokens' });
    if (b.scopes.includes('admin') && req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'Only administrators can create admin tokens' });
    if (b.scopes.includes('write') && req.user!.role === 'viewer') return reply.code(403).send({ error: 'forbidden', message: 'Viewers cannot create write tokens' });
    // a token outlives the session, so a hijacked session must not be able to mint one without the password (and code)
    const bad = await reauthError(ctx, req.user!.id, b.password, b.code, reauthClient(req));
    if (bad) return reply.code(400).send({ error: 'invalid_credentials', message: bad });
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
