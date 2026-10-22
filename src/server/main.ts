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
  if (app) await app.listen({ host: config.host, port: config.port });
  else await new Promise(() => {});

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, 'shutting down');
    try {
      stopGuardSync(); stopCaSync(); deadman.stop(); tailer?.stop(); housekeeping?.stop(); reportJobs?.stop(); ctx.notifier.stop(); ctx.maintenance.stop(); stopSubscribers();
      await app?.close();
      await scheduler?.stop();
      await stopTracing();
      await ctx.db.destroy();
    } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => { console.error(e); process.exit(1); });
