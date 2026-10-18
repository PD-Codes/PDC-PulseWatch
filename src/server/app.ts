import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import { config } from './config';
import authPlugin from './auth/plugin';
import type { Ctx } from './context';
import type { Scheduler } from './engine/scheduler';
import { authRoutes } from './routes/auth';
import { monitorRoutes } from './routes/monitors';
import { systemRoutes } from './routes/system';
import { VERSION } from './version';

export interface AppDeps { scheduler?: Scheduler; extraRoutes?: ((app: import('fastify').FastifyInstance) => Promise<void> | void)[] }

export async function buildApp(ctx: Ctx, deps: AppDeps = {}) {
  const app = Fastify({ loggerInstance: ctx.log as import('fastify').FastifyBaseLogger, trustProxy: config.trustProxy, logController: new LogController({ disableRequestLogging: (req) => /^\/(health|ready|metrics|demo\/|assets\/)/.test(req.url) }), bodyLimit: 8 * 1024 * 1024, ajv: { customOptions: { coerceTypes: 'array', removeAdditional: true } } });
  app.decorate('ctx', ctx);

  await app.register(cookie);
  // Only the API is rate limited; static assets and /health, /ready are never limited.
  await app.register(rateLimit, { global: true, max: config.rateLimit.max, timeWindow: '1 minute', allowList: (req) => !req.url.startsWith('/api/') && !req.url.startsWith('/metrics') });
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } },
    crossOriginEmbedderPolicy: false, hsts: config.session.cookieSecure,
  });
  await app.register(swagger, {
    openapi: {
      info: { title: `${config.brand.name} API`, version: VERSION, description: 'Authenticate with a session cookie or an API token (Authorization: Bearer pw_...).' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs', staticCSP: true, transformStaticCSP: (h) => h });
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  await app.register(authPlugin);
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
      return reply.header('Cache-Control', 'no-cache').type('text/html').send(fs.readFileSync(index));
    });
  } else {
    app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Not found (web UI is not built)' }));
  }
  return app;
}
