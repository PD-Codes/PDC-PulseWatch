// Scheduler load test: N TCP monitors against a local listener, measured for DURATION seconds.
// Usage: PW_TEST_DB_PASSWORD=dev npx tsx test/load/scheduler.ts [monitors=2000] [intervalS=30] [durationS=60]
// Reports achieved checks/s versus the ideal rate, scheduler lag, heartbeat writes and process memory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';

const [N, INTERVAL, DURATION] = [Number(process.argv[2] ?? 2000), Number(process.argv[3] ?? 30), Number(process.argv[4] ?? 60)];
const admin = { host: process.env.PW_TEST_DB_HOST ?? '127.0.0.1', port: Number(process.env.PW_TEST_DB_PORT ?? 3306), user: process.env.PW_TEST_DB_USER ?? 'root', password: process.env.PW_TEST_DB_PASSWORD ?? 'dev' };
const dbName = `pw_load_${crypto.randomBytes(3).toString('hex')}`;
const root = await mysql.createConnection(admin);
await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
Object.assign(process.env, {
  PW_DB_HOST: admin.host, PW_DB_PORT: String(admin.port), PW_DB_USER: admin.user, PW_DB_PASSWORD: admin.password, PW_DB_NAME: dbName,
  PW_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pw-load-')), PW_SECRET_KEY: 'load-test-key', PW_LOG_LEVEL: 'silent', PW_MIGRATIONS_DIR: path.resolve(import.meta.dirname, '../../migrations'),
});
const { createServices } = await import('../../src/server/services');
const { migrate } = await import('../../src/server/db/migrate');
const { Scheduler } = await import('../../src/server/engine/scheduler');
const { ensurePartitions } = await import('../../src/server/jobs/housekeeping');

const server = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as net.AddressInfo).port;

const ctx = createServices();
await migrate(process.env.PW_MIGRATIONS_DIR, () => {});
await ensurePartitions(ctx.db, 3);
const cfg = JSON.stringify({ host: '127.0.0.1', port });
for (let i = 0; i < N; i += 500) {
  await ctx.db.insertInto('monitors').values(Array.from({ length: Math.min(500, N - i) }, (_, k) => ({ name: `load-${i + k}`, type: 'tcp', config: cfg, interval_s: INTERVAL, timeout_s: 5 }) as any)).execute();
}
const scheduler = new Scheduler(ctx);
await scheduler.start();
const t0 = Date.now();
let maxLag = 0; let maxRss = 0;
const probe = setInterval(() => { maxLag = Math.max(maxLag, scheduler.lagMs); maxRss = Math.max(maxRss, process.memoryUsage().rss); }, 500);
await new Promise((r) => setTimeout(r, DURATION * 1000));
clearInterval(probe);
const secs = (Date.now() - t0) / 1000;
const { checksRun } = scheduler.stats();
const ideal = (N / INTERVAL) * secs;
const hb = await ctx.db.selectFrom('heartbeats').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
console.log(JSON.stringify({ monitors: N, intervalS: INTERVAL, seconds: Math.round(secs), checksRun, idealChecks: Math.round(ideal), achievedPct: Math.round((checksRun / ideal) * 100), checksPerSec: +(checksRun / secs).toFixed(1), heartbeats: Number(hb?.n), maxLagMs: Math.round(maxLag), peakRssMB: Math.round(maxRss / 1048576), cpuSec: +(process.cpuUsage().user / 1e6 + process.cpuUsage().system / 1e6).toFixed(1) }, null, 2));
await scheduler.stop(); server.close(); await ctx.db.destroy();
await root.query(`DROP DATABASE \`${dbName}\``); await root.end();
