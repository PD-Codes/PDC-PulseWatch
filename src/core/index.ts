import type { Runner } from './types';
import { dbRunners } from './runners/db';
import { httpRunners } from './runners/http';
import { mailRunners } from './runners/mail';
import { netRunners } from './runners/net';
import { protoRunners } from './runners/proto';
import { pushRunner } from './runners/push';

export * from './types';
export * from './fields';
export { NetGuard, DEFAULT_DENY, type GuardConfig } from './guard';

const all: Runner[] = [...httpRunners, ...netRunners, ...mailRunners, ...protoRunners, ...dbRunners, pushRunner];
const registry = new Map(all.map((r) => [r.type, r]));

export const runners = registry;
export const getRunner = (type: string) => registry.get(type);

/** Register an additional runner (plugin interface for new monitor types). */
export function registerRunner(r: Runner) {
  registry.set(r.type, r);
}
