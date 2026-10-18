import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { NetGuard, DEFAULT_DENY } from '../core';
import { Bus } from './bus';
import { config } from './config';
import { createDb, type Database } from './db';
import { Settings } from './settings';
import type { Engine } from './engine/engine';
import type { Maintenance } from './engine/maintenance';
import type { IncidentService } from './incidents';
import type { Notifier } from './notify/notifier';

export interface Ctx {
  db: Database;
  log: Logger;
  bus: Bus;
  settings: Settings;
  guard: NetGuard;
  instanceId: string;
  engine: Engine;
  maintenance: Maintenance;
  incidents: IncidentService;
  notifier: Notifier;
}

export function createGuard(): NetGuard {
  return new NetGuard({ mode: config.ssrf.mode, allow: config.ssrf.allow, deny: [...DEFAULT_DENY, ...config.ssrf.deny] });
}

/** Base context; services are attached by createServices() to avoid import cycles. */
export function createBaseContext(db: Database = createDb(), log: Logger = pino({ level: config.logLevel })): Omit<Ctx, 'engine' | 'maintenance' | 'incidents' | 'notifier'> {
  return { db, log, bus: new Bus(), settings: new Settings(db), guard: createGuard(), instanceId: `${process.pid}-${randomUUID().slice(0, 8)}` };
}
