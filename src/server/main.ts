import { installCrashBackstop } from '../core/survive';
import { config } from './config';
import { buildApp } from './app';
import { migrate } from './db/migrate';
import { Scheduler } from './engine/scheduler';
import { DeadMan } from './jobs/deadman';
import { Housekeeping } from './jobs/housekeeping';
import { Tailer } from './jobs/tail';
import { startCaSync } from './ca-store';
import { startGuardSync } from './guard-sync';
import { ReportJobs } from './reports';
import { startSubscriberNotifications } from './routes/status-pages';
import { createServices } from './services';
import { stopTracing } from './telemetry';
import { VERSION } from './version';

async function main() {
  const ctx = createServices();
  const { log } = ctx;
  installCrashBackstop((kind, e) => log.error({ err: e }, kind));
  log.info({ version: VERSION, role: config.role }, `${config.brand.name} starting`);
  config.secretKey; // fail fast when the key cannot be loaded
  await migrate(config.migrationsDir, (m) => log.info(m));

  const runsWork = config.role !== 'api';
  const servesApi = config.role !== 'worker';
  await ctx.maintenance.start();
  const stopGuardSync = startGuardSync(ctx);
  const stopCaSync = startCaSync(ctx);
  ctx.notifier.start();
  ctx.engine.start();
  // incidents are opened by whichever process runs the checks, so each role tells subscribers about the events on its own bus
  const stopSubscribers = startSubscriberNotifications(ctx);
  const scheduler = runsWork ? new Scheduler(ctx) : undefined;
  const housekeeping = runsWork ? new Housekeeping(ctx) : undefined;
  const reportJobs = runsWork ? new ReportJobs(ctx) : undefined;
  const tailer = config.role === 'api' ? new Tailer(ctx) : undefined;
  const deadman = new DeadMan(ctx, () => !scheduler || Date.now() - scheduler.lastTickAt < 30_000);

  const extra = [];
  const { registerAllRoutes } = await import('./routes');
  extra.push(registerAllRoutes);
  const app = servesApi ? await buildApp(ctx, { scheduler, extraRoutes: extra }) : undefined;

  if (config.demo) { const { seedDemo, startDemoGameServer } = await import('./demo'); if (runsWork) startDemoGameServer(); await seedDemo(ctx); }
  await scheduler?.start();
  await housekeeping?.start();
  reportJobs?.start();
  tailer?.start();
  deadman.start();
  let stopping = false;
  /**
   * Order matters: no new checks -> running checks finish (bounded) -> own leases released (another worker takes over at once)
   * -> in-flight deliveries finish -> HTTP closes (routes/system.ts ends SSE streams in a preClose hook) -> DB closes.
   * Everything has to fit into PW_SHUTDOWN_GRACE_MS, below the orchestrator's kill timeout.
   */
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    const grace = config.shutdownGraceMs;
    const deadline = Date.now() + grace;
    const left = (reserve = 0) => Math.max(0, deadline - Date.now() - reserve);
    const bounded = async (p: Promise<unknown> | undefined, ms: number) => { let t: NodeJS.Timeout | undefined; await Promise.race([p, new Promise((r) => { t = setTimeout(r, ms); })]); clearTimeout(t); };
    setTimeout(() => { log.warn('shutdown grace exceeded, exiting'); process.exit(0); }, grace + 500).unref();
    log.info({ sig, graceMs: grace }, 'shutting down');
    try {
      scheduler?.stopClaiming();
      stopGuardSync(); stopCaSync(); deadman.stop(); tailer?.stop(); housekeeping?.stop(); reportJobs?.stop(); ctx.maintenance.stop(); stopSubscribers();
      // the reserve keeps time for releasing leases, closing HTTP and the pool
      await scheduler?.stop(left(Math.min(5_000, grace / 4)));
      await Promise.all([ctx.notifier.stop(left(Math.min(3_000, grace / 5))), ctx.engine.stop(left(Math.min(3_000, grace / 5)))]);
      await bounded(app?.close(), left(1_000));
      await bounded(stopTracing(), Math.min(1_000, left(500)));
      await bounded(ctx.db.destroy(), left());
    } catch (e) { log.error({ err: e }, 'shutdown failed'); } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // a worker has no listener; its scheduler and housekeeping timers keep the process alive
  if (app) await app.listen({ host: config.host, port: config.port });
}

main().catch((e) => { console.error(e); process.exit(1); });
