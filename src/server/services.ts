import type { Logger } from 'pino';
import { createBaseContext, type Ctx } from './context';
import type { Database } from './db';
import { Engine } from './engine/engine';
import { Maintenance } from './engine/maintenance';
import { IncidentService } from './incidents';
import { Notifier } from './notify/notifier';

/** Wire all services into one context (services reference each other through it). */
export function createServices(db?: Database, log?: Logger): Ctx {
  const ctx = createBaseContext(db, log) as Ctx;
  ctx.maintenance = new Maintenance(ctx);
  ctx.incidents = new IncidentService(ctx);
  ctx.notifier = new Notifier(ctx);
  ctx.engine = new Engine(ctx);
  return ctx;
}
