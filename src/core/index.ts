import type { Runner } from './types';
import { dbRunners } from './runners/db';
import { httpRunners } from './runners/http';
import { mailRunners } from './runners/mail';
import { netRunners } from './runners/net';
import { protoRunners } from './runners/proto';
import { pushRunner } from './runners/push';
import { withTlsDetail } from './tlsdetail';

export * from './types';
export * from './fields';
export { NetGuard, DEFAULT_DENY, type GuardConfig } from './guard';
export { setExtraCa, extraCaCount, trustOptions } from './trust';
export { certNotice, describeTarget, tlsMessage, certFacts, targetFromConfig, probeCertificate, type TlsFacts, type TlsTarget } from './tlsdetail';

const all: Runner[] = [...httpRunners, ...netRunners, ...mailRunners, ...protoRunners, ...dbRunners, pushRunner];
const registry = new Map(all.map((r) => [r.type, withTlsDetail(r)]));

export const runners = registry;
export const getRunner = (type: string) => registry.get(type);

/** Register an additional runner (plugin interface for new monitor types). */
export function registerRunner(r: Runner) {
  registry.set(r.type, withTlsDetail(r));
}
