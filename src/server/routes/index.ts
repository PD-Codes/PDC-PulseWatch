import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { registerDemoRoutes } from '../demo';
import { adminRoutes } from './admin';
import { caCertRoutes } from './ca-certs';
import { configRoutes } from './config';
import { authExtRoutes } from './auth-ext';
import { insightRoutes } from './insights';
import { incidentRoutes } from './incidents';
import { maintenanceRoutes } from './maintenance';
import { notificationRoutes } from './notifications';
import { probeRoutes } from './probes';
import { reportRoutes } from './reports';
import { startSubscriberNotifications, statusPageRoutes } from './status-pages';

/** Registers the route modules that are not part of the core bootstrap. */
export async function registerAllRoutes(app: FastifyInstance): Promise<void> {
  await authExtRoutes(app);
  await incidentRoutes(app);
  await maintenanceRoutes(app);
  await notificationRoutes(app);
  await probeRoutes(app);
  await statusPageRoutes(app);
  await adminRoutes(app);
  await configRoutes(app);
  await caCertRoutes(app);
  await reportRoutes(app);
  await insightRoutes(app);
  if (config.demo) registerDemoRoutes(app);
  const stop = startSubscriberNotifications(app.ctx);
  app.addHook('onClose', async () => stop());
}
