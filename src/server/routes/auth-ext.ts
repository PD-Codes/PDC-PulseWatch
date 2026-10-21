import { Type } from '@sinclair/typebox';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { maskSecrets, restoreSecrets, validateConfig } from '../../core';
import { writeAudit } from '../auth/access';
import { oidcFinish, oidcStart, providerRunner, samlAcsUrl, samlConfigErrors, samlEntityId, samlFinish, samlMetadata, samlStart } from '../auth/external';
import { createSession, csrfFor } from '../auth/plugin';
import { reauthError } from '../auth/reauth';
import { config } from '../config';
import { decryptJson, encryptJson, hmac, safeEqual } from '../crypto';
import { bool, parseJson } from '../db';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });

/** Short-lived signed cookie, so challenges and OIDC state work across several app instances without shared memory. */
// The SAML cookie must survive the IdP's cross-site POST to the ACS URL, which only SameSite=None (and therefore Secure) cookies do.
function setSigned(reply: FastifyReply, name: string, data: unknown, ttlSec = 600, sameSite: 'lax' | 'none' = 'lax') {
  const body = Buffer.from(JSON.stringify({ d: data, e: Date.now() + ttlSec * 1000 })).toString('base64url');
  reply.setCookie(name, `${body}.${hmac(`${name}:${body}`)}`, { httpOnly: true, sameSite, secure: sameSite === 'none' || config.session.cookieSecure, path: '/api/auth', maxAge: ttlSec });
}
function takeSigned<T>(req: FastifyRequest, reply: FastifyReply, name: string, sameSite: 'lax' | 'none' = 'lax'): T | null {
  const raw = req.cookies[name];
  reply.clearCookie(name, { path: '/api/auth', sameSite, secure: sameSite === 'none' || config.session.cookieSecure });
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(`${name}:${body}`))) return null;
  const v = parseJson<{ d: T; e: number } | null>(Buffer.from(body, 'base64url').toString(), null);
  return v && v.e > Date.now() ? v.d : null;
}

export async function authExtRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const admin = { preHandler: app.requireRole('admin') };
  const rpID = new URL(config.baseUrl).hostname, origin = new URL(config.baseUrl).origin;

  /* ----------------------- identity providers (OIDC, SAML, LDAP) ----------------------- */
  app.get('/api/auth/providers/public', { schema: { tags: ['auth'], summary: 'Providers shown on the login page' } }, async () =>
    (await db.selectFrom('auth_providers').select(['id', 'kind', 'name']).where('enabled', '=', 1).orderBy('name').execute()).filter((p) => p.kind === 'oidc' || p.kind === 'saml'));

  const shape = (p: any) => { let cfg = {}; try { cfg = maskSecrets(providerRunner(p.kind), decryptJson(p.config_enc)); } catch { /* key changed */ } return { id: p.id, kind: p.kind, name: p.name, enabled: bool(p.enabled), config: cfg, ...(p.kind === 'saml' ? { urls: { acs: samlAcsUrl(p.id), metadata: `${config.baseUrl}/api/auth/saml/${p.id}/metadata`, entityId: samlEntityId(p.id, (cfg as Record<string, any>)) } } : {}) }; };
  app.get('/api/auth/providers', { ...admin, schema: { tags: ['auth'] } }, async () => ({
    items: (await db.selectFrom('auth_providers').selectAll().orderBy('name').execute()).map(shape), redirectUri: `${config.baseUrl}/api/auth/oidc/callback`,
    fields: { oidc: providerRunner('oidc').fields, ldap: providerRunner('ldap').fields, saml: providerRunner('saml').fields },
  }));
  const body = Type.Object({ kind: Type.Union([Type.Literal('oidc'), Type.Literal('ldap'), Type.Literal('saml')]), name: Type.String({ minLength: 1, maxLength: 128 }), enabled: Type.Boolean(), config: Type.Object({}, { additionalProperties: true }) });
  const save = async (req: FastifyRequest, reply: FastifyReply, id?: number) => {
    const b = req.body as { kind: 'oidc' | 'ldap' | 'saml'; name: string; enabled: boolean; config: Record<string, any> };
    const runner = providerRunner(b.kind);
    let cfg = b.config;
    if (id) {
      const old = await db.selectFrom('auth_providers').select('config_enc').where('id', '=', id).where('kind', '=', b.kind).executeTakeFirst();
      if (!old) return reply.code(404).send({ error: 'not_found' });
      cfg = restoreSecrets(runner, cfg, decryptJson(old.config_enc));
    }
    const v = validateConfig(runner, cfg);
    const errors = [...v.errors, ...(b.kind === 'saml' && !v.errors.length ? samlConfigErrors(v.config) : [])];
    if (errors.length) return reply.code(400).send({ error: 'validation', message: errors.join('; ') });
    const values = { kind: b.kind, name: b.name, enabled: b.enabled ? 1 : 0, config_enc: encryptJson(v.config) };
    if (id) await db.updateTable('auth_providers').set(values).where('id', '=', id).execute(); else id = Number((await db.insertInto('auth_providers').values(values).executeTakeFirstOrThrow()).insertId);
    await writeAudit(ctx, req.user, 'auth_provider.saved', { type: 'auth_provider', id }, { name: b.name, kind: b.kind, enabled: b.enabled }, req.ip);
    return { id };
  };
  app.post('/api/auth/providers', { ...admin, schema: { tags: ['auth'], body } }, (req, reply) => save(req, reply));
  app.put('/api/auth/providers/:id', { ...admin, schema: { tags: ['auth'], params: Id, body } }, (req, reply) => save(req, reply, (req.params as any).id));
  app.delete('/api/auth/providers/:id', { ...admin, schema: { tags: ['auth'], params: Id } }, async (req) => { await db.deleteFrom('auth_providers').where('id', '=', (req.params as any).id).execute(); return { ok: true }; });

  /* ----------------------------------- OIDC ----------------------------------- */
  const loginError = (reply: FastifyReply, code: string) => reply.redirect(`/login?error=${encodeURIComponent(code)}`);
  app.get('/api/auth/oidc/:id/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags: ['auth'], params: Id, hide: true } }, async (req, reply) => {
    try {
      const s = await oidcStart(ctx, (req.params as any).id);
      if (!s) return loginError(reply, 'provider_unavailable');
      setSigned(reply, 'pw_oidc', s.state);
      return reply.redirect(s.url);
    } catch (e) { ctx.log.warn({ err: (e as Error).message }, 'OIDC start failed'); return loginError(reply, 'provider_unreachable'); }
  });
  app.get('/api/auth/oidc/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags: ['auth'], hide: true } }, async (req, reply) => {
    const st = takeSigned<{ s: string; n: string; v: string; p: number }>(req, reply, 'pw_oidc');
    if (!st) return loginError(reply, 'state_expired');
    try {
      const uid = await oidcFinish(ctx, new URL(req.url, config.baseUrl), st);
      if (!uid) { await writeAudit(ctx, null, 'login.failed', { type: 'oidc' }, { why: 'refused' }, req.ip); return loginError(reply, 'not_allowed'); }
      await createSession(ctx, uid, req, reply);
      await writeAudit(ctx, { id: uid, username: `user#${uid}` }, 'login.success', { type: 'user', id: uid }, { via: 'oidc' }, req.ip);
      return reply.redirect('/dashboard');
    } catch (e) { ctx.log.warn({ err: (e as Error).message }, 'OIDC callback failed'); return loginError(reply, 'sso_failed'); }
  });

  /* ----------------------------------- SAML ----------------------------------- */
  // Encapsulated so the form-encoded body parser only exists for the ACS endpoint (IdPs post application/x-www-form-urlencoded).
  await app.register(async (saml) => {
    saml.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 512 * 1024 }, (_req, raw, done) => done(null, Object.fromEntries(new URLSearchParams(raw as string))));
    const rate = { rateLimit: { max: 20, timeWindow: '1 minute' } };
    saml.get('/api/auth/saml/:id/metadata', { schema: { tags: ['auth'], params: Id, summary: 'SAML service provider metadata' } }, async (req, reply) => {
      const xml = await samlMetadata(ctx, (req.params as any).id);
      return xml ? reply.type('application/xml').send(xml) : reply.code(404).send({ error: 'not_found' });
    });
    saml.get('/api/auth/saml/:id/start', { config: rate, schema: { tags: ['auth'], params: Id, hide: true } }, async (req, reply) => {
      try {
        const s = await samlStart(ctx, (req.params as any).id);
        if (!s) return loginError(reply, 'provider_unavailable');
        setSigned(reply, 'pw_saml', s.state, 600, 'none');
        return reply.redirect(s.url);
      } catch (e) { ctx.log.warn({ err: (e as Error).message }, 'SAML start failed'); return loginError(reply, 'provider_unreachable'); }
    });
    saml.post('/api/auth/saml/:id/acs', { config: { ...rate, skipCsrf: true }, bodyLimit: 512 * 1024, schema: { tags: ['auth'], params: Id, hide: true } }, async (req, reply) => {
      const st = takeSigned<{ p: number; id: string; rs: string }>(req, reply, 'pw_saml', 'none');
      if (!st || st.p !== Number((req.params as any).id)) return loginError(reply, 'state_expired');
      try {
        const uid = await samlFinish(ctx, (req.body ?? {}) as Record<string, string>, st);
        if (!uid) { await writeAudit(ctx, null, 'login.failed', { type: 'saml' }, { why: 'refused' }, req.ip); return loginError(reply, 'not_allowed'); }
        await createSession(ctx, uid, req, reply);
        await writeAudit(ctx, { id: uid, username: `user#${uid}` }, 'login.success', { type: 'user', id: uid }, { via: 'saml' }, req.ip);
        return reply.redirect('/dashboard', 303); // 303 turns the IdP's POST into a plain GET of the app
      } catch (e) {
        ctx.log.warn({ err: (e as Error).message }, 'SAML assertion rejected');
        await writeAudit(ctx, null, 'login.failed', { type: 'saml' }, { why: (e as Error).message.slice(0, 200) }, req.ip);
        return loginError(reply, 'sso_failed');
      }
    });
  });

  /* --------------------------------- passkeys --------------------------------- */
  const auth = { preHandler: app.requireSession };
  app.get('/api/auth/passkeys', { ...auth, schema: { tags: ['auth'] } }, async (req) =>
    (await db.selectFrom('passkeys').select(['id', 'name', 'created_at']).where('user_id', '=', req.user!.id).orderBy('id').execute()).map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at })));
  app.delete('/api/auth/passkeys/:id', { ...auth, schema: { tags: ['auth'], params: Id } }, async (req) => {
    await db.deleteFrom('passkeys').where('id', '=', (req.params as any).id).where('user_id', '=', req.user!.id).execute();
    await writeAudit(ctx, req.user, 'passkey.deleted', { type: 'passkey', id: (req.params as any).id }, undefined, req.ip);
    return { ok: true };
  });

  // A passkey signs in without password and authenticator code, so adding one needs both again (a hijacked session must not be able to plant one).
  app.post('/api/auth/passkeys/register/options', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['auth'], body: Type.Object({ password: Type.Optional(Type.String({ maxLength: 1000 })), code: Type.Optional(Type.String({ maxLength: 32 })) }) } }, async (req, reply) => {
    const u = req.user!;
    const b = req.body as { password?: string; code?: string };
    const bad = await reauthError(ctx, u.id, b.password, b.code);
    if (bad) return reply.code(400).send({ error: 'invalid_credentials', message: bad });
    const existing = await db.selectFrom('passkeys').select(['credential_id', 'transports']).where('user_id', '=', u.id).execute();
    const options = await generateRegistrationOptions({
      rpName: config.brand.name, rpID, userName: u.username, userDisplayName: u.displayName, userID: new TextEncoder().encode(String(u.id)), attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: parseJson(c.transports, undefined) })), authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    setSigned(reply, 'pw_wa_reg', { c: options.challenge, u: u.id });
    return options;
  });

  app.post('/api/auth/passkeys/register/verify', { ...auth, schema: { tags: ['auth'], body: Type.Object({ name: Type.Optional(Type.String({ maxLength: 64 })), credential: Type.Any() }) } }, async (req, reply) => {
    const st = takeSigned<{ c: string; u: number }>(req, reply, 'pw_wa_reg');
    if (!st || st.u !== req.user!.id) return reply.code(400).send({ error: 'expired', message: 'The request expired, please try again' });
    const b = req.body as { name?: string; credential: any };
    try {
      const v = await verifyRegistrationResponse({ response: b.credential, expectedChallenge: st.c, expectedOrigin: origin, expectedRPID: rpID });
      if (!v.verified) return reply.code(400).send({ error: 'verification_failed' });
      const c = v.registrationInfo.credential;
      await db.insertInto('passkeys').values({ user_id: req.user!.id, credential_id: c.id, public_key: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: c.transports ? JSON.stringify(c.transports) : null, name: b.name || 'Passkey' }).execute();
      await writeAudit(ctx, req.user, 'passkey.added', { type: 'user', id: req.user!.id }, { name: b.name }, req.ip);
      return { ok: true };
    } catch (e) { return reply.code(400).send({ error: 'verification_failed', message: (e as Error).message }); }
  });

  // Passkey sign-in requires user verification (PIN/biometric), so it counts as two factors and skips the TOTP prompt.
  const login = { config: { rateLimit: { max: config.rateLimit.loginMax, timeWindow: '1 minute' }, skipCsrf: true } };
  app.post('/api/auth/passkeys/login/options', { ...login, schema: { tags: ['auth'] } }, async (_req, reply) => {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    setSigned(reply, 'pw_wa_auth', { c: options.challenge });
    return options;
  });
  app.post('/api/auth/passkeys/login/verify', { ...login, schema: { tags: ['auth'], body: Type.Object({ credential: Type.Any() }) } }, async (req, reply) => {
    const st = takeSigned<{ c: string }>(req, reply, 'pw_wa_auth');
    const resp = (req.body as any).credential;
    const deny = async (why: string) => { await writeAudit(ctx, null, 'login.failed', { type: 'passkey' }, { why }, req.ip); return reply.code(401).send({ error: 'invalid_credentials', message: 'Passkey sign-in failed' }); };
    if (!st || typeof resp?.id !== 'string') return deny('expired');
    const pk = await db.selectFrom('passkeys as p').innerJoin('users as u', 'u.id', 'p.user_id').select(['p.id', 'p.public_key', 'p.counter', 'p.transports', 'p.credential_id', 'u.id as uid', 'u.username', 'u.is_active']).where('p.credential_id', '=', resp.id).executeTakeFirst();
    if (!pk || !bool(pk.is_active)) return deny('unknown credential');
    try {
      const v = await verifyAuthenticationResponse({ response: resp, expectedChallenge: st.c, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, credential: { id: pk.credential_id, publicKey: Buffer.from(pk.public_key, 'base64url'), counter: pk.counter, transports: parseJson(pk.transports, undefined) } });
      if (!v.verified) return deny('not verified');
      await db.updateTable('passkeys').set({ counter: v.authenticationInfo.newCounter }).where('id', '=', pk.id).execute();
    } catch (e) { return deny((e as Error).message); }
    await db.updateTable('users').set({ last_login_at: new Date(), failed_logins: 0, locked_until: null }).where('id', '=', pk.uid).execute();
    const token = await createSession(ctx, pk.uid, req, reply);
    await writeAudit(ctx, { id: pk.uid, username: pk.username }, 'login.success', { type: 'user', id: pk.uid }, { via: 'passkey' }, req.ip);
    return { ok: true, csrf: csrfFor(token) };
  });
}
