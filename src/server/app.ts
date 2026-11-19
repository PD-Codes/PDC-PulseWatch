import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import { SecretTargetError } from '../core';
import { config } from './config';
import authPlugin from './auth/plugin';
import type { Ctx } from './context';
import type { Scheduler } from './engine/scheduler';
import { authRoutes } from './routes/auth';
import { monitorRoutes } from './routes/monitors';
import { systemRoutes } from './routes/system';
import { VERSION } from './version';

/** Query parameters whose values are credentials (push/subscription tokens, OIDC code/state, keys); they never reach the request log. */
const SECRET_PARAM = /^(token|access_token|id_token|refresh_token|api_?key|key|secret|password|pass|pwd|auth|code|state|ticket|signature|sig|session|samlresponse|relaystate)$/i;
/** Masks secrets in a request URL for the log: the push token in /api/push/<token> and credential-like query values. */
export function redactUrl(url: string): string {
  const out = url.replace(/^(\/api\/push\/)[^/?#]+/, '$1***');
  const q = out.indexOf('?');
  if (q < 0) return out;
  const name = (k: string) => { try { return decodeURIComponent(k); } catch { return k; } };
  return out.slice(0, q) + out.slice(q).replace(/([?&;])([^=&#;]*)=([^&#;]*)/g, (m, sep: string, k: string) => (SECRET_PARAM.test(name(k)) ? `${sep}${k}=***` : m));
}
const reqSerializer = (req: import('fastify').FastifyRequest) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort });
/** Fastify options that put the redacting request serializer on every request logger. */
export const requestLogOptions: Pick<import('fastify').FastifyServerOptions, 'childLoggerFactory'> = {
  childLoggerFactory: (logger, bindings, opts) => logger.child(bindings, { ...opts, serializers: { ...opts.serializers, req: reqSerializer } }),
};

/** Paths that name a file (built assets, source maps, icons, fonts): a miss is a real 404, not the single page app. */
const FILE_EXT = /\.(?:js|mjs|css|map|png|jpe?g|svg|ico|webp|woff2?|json|txt|webmanifest)$/i;
export const isAssetPath = (url: string) => { const p = url.split(/[?#]/)[0]!; return p.startsWith('/assets/') || FILE_EXT.test(p); };

/** A hop count as Fastify's trustProxy function: trust the n closest proxies (what proxy-addr does for a number). */
const hops = (n: number) => (_addr: string, i: number) => i < n;

export interface AppDeps { scheduler?: Scheduler; extraRoutes?: ((app: import('fastify').FastifyInstance) => Promise<void> | void)[] }

export async function buildApp(ctx: Ctx, deps: AppDeps = {}) {
  const app = Fastify({ loggerInstance: ctx.log as import('fastify').FastifyBaseLogger, trustProxy: typeof config.trustProxy === 'number' ? hops(config.trustProxy) : config.trustProxy, ...requestLogOptions, logController: new LogController({ disableRequestLogging: (req) => /^\/(health|ready|metrics|demo\/|assets\/)/.test(req.url) }), bodyLimit: 8 * 1024 * 1024, ajv: { customOptions: { coerceTypes: 'array', removeAdditional: true } } });
  app.decorate('ctx', ctx);
  if (config.trustProxy === true) ctx.log.warn('PW_TRUST_PROXY=true trusts every hop: clients can forge X-Forwarded-For and with it their address (rate limits, lockouts, audit log). Set the number of proxies in front of the app (e.g. 1) or their addresses/CIDRs instead.');
  // database constraint errors are the caller's mistake; any other 500 is logged but its message (SQL, schema names) stays on the server
  app.setErrorHandler((err: import('fastify').FastifyError, req, reply) => {
    if (err.code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'conflict', message: 'An entry with this value already exists' });
    if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_NO_REFERENCED_ROW') return reply.code(400).send({ error: 'validation', message: 'A referenced item does not exist' });
    if ((err as unknown) instanceof SecretTargetError) return reply.code(400).send({ error: 'validation', message: err.message, errors: (err as unknown as SecretTargetError).errors });
    if (err.statusCode && err.statusCode < 500) return reply.send(err);
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal', message: 'Internal server error' });
  });

  await app.register(cookie);
  // Only the API is rate limited; static assets and /health, /ready are never limited.
  await app.register(rateLimit, { global: true, max: config.rateLimit.max, timeWindow: '1 minute', allowList: (req) => !req.url.startsWith('/api/') && !req.url.startsWith('/metrics') });
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:', 'https:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } },
    crossOriginEmbedderPolicy: false, hsts: config.session.cookieSecure,
  });
  // the API description lists every route and parameter: only for signed-in users (session or API token)
  await app.register(authPlugin);
  await app.register(swagger, {
    openapi: {
      info: { title: `${config.brand.name} API`, version: VERSION, description: 'Authenticate with a session cookie or an API token (Authorization: Bearer pw_...).' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs', staticCSP: true, transformStaticCSP: (h) => h, uiHooks: { onRequest: (req, reply, done) => { if (req.user) return done(); void reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' }); } } });
  app.get('/api/openapi.json', { preHandler: app.requireAuth, schema: { hide: true } }, async () => app.swagger());

  await authRoutes(app);
  await monitorRoutes(app);
  await systemRoutes(app, { scheduler: deps.scheduler });
  for (const r of deps.extraRoutes ?? []) await r(app);

  // Single page app
  const index = path.join(config.webDir, 'index.html');
  if (fs.existsSync(index)) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, index: false, cacheControl: false });
    app.addHook('onSend', async (req, reply) => {
      if (reply.hasHeader('cache-control') || reply.statusCode !== 200) return;
      if (req.url.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      else if (!req.url.startsWith('/api/') && !req.url.startsWith('/badge/')) reply.header('Cache-Control', 'no-cache');
    });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/badge/') || req.method !== 'GET') return reply.code(404).send({ error: 'not_found', message: 'Not found' });
      // a missing script or stylesheet answered with index.html breaks with a confusing MIME error (and gets cached as the asset)
      if (isAssetPath(req.url)) return reply.code(404).header('Cache-Control', 'no-cache').type('text/plain; charset=utf-8').send('Not found\n');
      return reply.header('Cache-Control', 'no-cache').type('text/html').send(fs.readFileSync(index));
    });
  } else {
    app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Not found (web UI is not built)' }));
  }
  return app;
}
