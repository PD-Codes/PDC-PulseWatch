import '@fastify/rate-limit';
import '@fastify/cookie';
import '@fastify/swagger';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sql } from 'kysely';
import { config } from '../config';
import type { Ctx } from '../context';
import { hmac, randomToken, safeEqual, sha256 } from '../crypto';
import { bool } from '../db';

export interface AuthUser {
  id: number; username: string; displayName: string; email: string | null; role: 'admin' | 'editor' | 'viewer';
  scopeRestricted: boolean; locale: string | null; theme: string; totpEnabled: boolean; authSource: string;
  /** Present when authenticated with an API token. */
  tokenScopes?: string[];
  sessionId?: number;
  csrf?: string;
}

declare module 'fastify' {
  interface FastifyRequest { user: AuthUser | null; sessionToken?: string }
  interface FastifyInstance { ctx: Ctx; requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>; requireRole: (...roles: AuthUser['role'][]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
}

export const COOKIE = 'pw_session';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const csrfFor = (sessionToken: string) => hmac(`csrf:${sessionToken}`);

export async function createSession(ctx: Ctx, userId: number, req: FastifyRequest, reply: FastifyReply): Promise<string> {
  const token = randomToken();
  const expires = new Date(Date.now() + config.session.ttlHours * 3_600_000);
  await ctx.db.insertInto('sessions').values({ user_id: userId, token_hash: sha256(token), expires_at: expires, ip: req.ip, user_agent: String(req.headers['user-agent'] ?? '').slice(0, 250) }).execute();
  reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.session.cookieSecure, path: '/', expires });
  return token;
}

const toUser = (u: any): AuthUser => ({
  id: u.id, username: u.username, displayName: u.display_name, email: u.email, role: u.role, scopeRestricted: bool(u.scope_restricted),
  locale: u.locale, theme: u.theme, totpEnabled: bool(u.totp_enabled), authSource: u.auth_source,
});

/** Resolve the caller from an API token or a session cookie. */
export default fp(async function authPlugin(app: FastifyInstance) {
  const ctx = app.ctx;
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', undefined);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const raw = header.slice(7).trim();
      const tok = await ctx.db.selectFrom('api_tokens as t').innerJoin('users as u', 'u.id', 't.user_id').select(['t.id as tid', 't.scopes', 't.expires_at', 't.last_used_at', 'u.id', 'u.username', 'u.display_name', 'u.email', 'u.role', 'u.scope_restricted', 'u.locale', 'u.theme', 'u.totp_enabled', 'u.auth_source', 'u.is_active'])
        .where('t.token_hash', '=', sha256(raw)).executeTakeFirst();
      if (tok && bool(tok.is_active) && (!tok.expires_at || tok.expires_at > new Date())) {
        req.user = { ...toUser(tok), tokenScopes: tok.scopes.split(',').map((s) => s.trim()) };
        if (!tok.last_used_at || Date.now() - tok.last_used_at.getTime() > 60_000) void ctx.db.updateTable('api_tokens').set({ last_used_at: new Date() }).where('id', '=', tok.tid).execute().catch(() => {});
      }
      return;
    }
    const cookie = req.cookies[COOKIE];
    if (!cookie) return;
    const row = await ctx.db.selectFrom('sessions as s').innerJoin('users as u', 'u.id', 's.user_id')
      .select(['s.id as sid', 's.expires_at', 's.last_seen_at', 'u.id', 'u.username', 'u.display_name', 'u.email', 'u.role', 'u.scope_restricted', 'u.locale', 'u.theme', 'u.totp_enabled', 'u.auth_source', 'u.is_active'])
      .where('s.token_hash', '=', sha256(cookie)).executeTakeFirst();
    if (!row || !bool(row.is_active) || row.expires_at < new Date()) return;
    if (Date.now() - row.last_seen_at.getTime() > 60_000) void ctx.db.updateTable('sessions').set({ last_seen_at: sql<Date>`NOW(3)` }).where('id', '=', row.sid).execute().catch(() => {});
    req.user = { ...toUser(row), sessionId: row.sid, csrf: csrfFor(cookie) };
    req.sessionToken = cookie;
  });

  // CSRF: cookie-authenticated mutations must echo the per-session token. Bearer tokens are not ambient credentials.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user || req.user.tokenScopes || !UNSAFE.has(req.method)) return;
    if (req.routeOptions.config && (req.routeOptions.config as any).skipCsrf) return;
    const sent = String(req.headers['x-csrf-token'] ?? '');
    if (!sent || !safeEqual(sent, req.user.csrf!)) return reply.code(403).send({ error: 'csrf', message: 'Missing or invalid CSRF token' });
  });

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
    const scopes = req.user.tokenScopes;
    if (scopes) {
      const need = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
      const ok = scopes.includes('admin') || scopes.includes(need) || (need === 'read' && scopes.includes('write'));
      if (!ok) return reply.code(403).send({ error: 'forbidden', message: `API token lacks the "${need}" scope` });
    }
  });

  app.decorate('requireRole', (...roles: AuthUser['role'][]) => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (reply.sent) return;
    if (!roles.includes(req.user!.role)) return reply.code(403).send({ error: 'forbidden', message: 'Insufficient permissions' });
    if (req.user!.tokenScopes && roles.length === 1 && roles[0] === 'admin' && !req.user!.tokenScopes.includes('admin')) return reply.code(403).send({ error: 'forbidden', message: 'API token lacks the "admin" scope' });
  });
});
