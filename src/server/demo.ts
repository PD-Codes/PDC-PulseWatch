import type { FastifyInstance } from 'fastify';
import { config } from './config';
import type { Ctx } from './context';
import { encryptJson, hashPassword, randomToken } from './crypto';
import { loadMonitor, saveMonitor } from './monitors/service';

/** Deterministic PRNG so every demo installation shows the same history. */
function prng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Local endpoints the demo monitors check, so the demo works without internet access. */
export function registerDemoRoutes(app: FastifyInstance): void {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const o = { config: { rateLimit: false as const }, schema: { hide: true } };
  app.get('/demo/ok', o, async () => { await wait(15 + Math.random() * 60); return { status: 'ok' }; });
  app.get('/demo/slow', o, async () => { await wait(250 + Math.random() * 600); return { status: 'ok' }; });
  app.get('/demo/flaky', o, async (_req, reply) => { await wait(30 + Math.random() * 90); return Math.floor(Date.now() / 60000) % 4 === 0 ? reply.code(503).send({ status: 'degraded' }) : { status: 'ok' }; });
  app.get('/demo/down', o, async (_req, reply) => reply.code(503).send({ status: 'maintenance mode' }));
  app.get('/demo/page', o, async (_req, reply) => { await wait(20 + Math.random() * 40); return reply.type('text/html').send('<html><body><h1>Welcome to the demo shop</h1></body></html>'); });
  app.get('/demo/json', o, async () => ({ data: { queue: { depth: Math.floor(Math.random() * 40) }, healthy: true } }));
  app.post('/demo/hook', o, async () => ({ ok: true }));
}

interface Profile { name: string; group: string; type: string; path?: string; config?: Record<string, any>; base: number; jitter: number; failRate: number; outages: [number, number][]; interval: number; tags: string[]; drift?: number }

/** Creates sample data once. Safe to call on every start. */
export async function seedDemo(ctx: Ctx): Promise<void> {
  const { db, log } = ctx;
  if (await ctx.settings.get<boolean>('demo.seeded', false)) return;
  const rnd = prng(42);
  const now = Date.now();
  const base = `http://127.0.0.1:${config.port}`;

  // admin account
  let adminId = (await db.selectFrom('users').select('id').orderBy('id').executeTakeFirst())?.id;
  if (!adminId) {
    const password = process.env.PW_DEMO_PASSWORD || randomToken(9);
    adminId = Number((await db.insertInto('users').values({ username: 'admin', display_name: 'Demo Admin', email: 'admin@example.com', password_hash: await hashPassword(password), role: 'admin' }).executeTakeFirstOrThrow()).insertId);
    log.warn(`DEMO MODE: created user "admin" with password "${password}" (set PW_DEMO_PASSWORD to choose your own)`);
  }

  const mkGroup = async (name: string, parent: number | null = null) => Number((await db.insertInto('monitor_groups').values({ name, parent_id: parent }).executeTakeFirstOrThrow()).insertId);
  const gWeb = await mkGroup('Web'), gInfra = await mkGroup('Infrastructure'), gData = await mkGroup('Data');
  const gApi = await mkGroup('APIs', gWeb);
  const tag = async (name: string, color: string) => Number((await db.insertInto('tags').values({ name, color }).executeTakeFirstOrThrow()).insertId);
  const tags = { prod: await tag('prod', '#059669'), critical: await tag('critical', '#dc2626'), staging: await tag('staging', '#d97706'), team: await tag('team', '#2563eb') };
  const groups: Record<string, number> = { Web: gWeb, Infrastructure: gInfra, Data: gData, APIs: gApi };

  const hook = Number((await db.insertInto('notification_channels').values({ name: 'Demo webhook', type: 'webhook', config_enc: encryptJson({ url: `${base}/demo/hook`, method: 'POST' }), active: 1, is_default: 0, created_by: adminId }).executeTakeFirstOrThrow()).insertId);

  const profiles: Profile[] = [
    { name: 'Core router', group: 'Infrastructure', type: 'tcp', config: { host: '127.0.0.1', port: config.port }, base: 2, jitter: 2, failRate: 0, outages: [], interval: 30, tags: ['prod', 'critical'] },
    { name: 'Marketing site', group: 'Web', type: 'http', path: '/demo/ok', base: 45, jitter: 25, failRate: 0.0005, outages: [[60 * 40, 25]], interval: 30, tags: ['prod'] },
    { name: 'Shop landing page', group: 'Web', type: 'keyword', path: '/demo/page', config: { keyword: 'Welcome' }, base: 40, jitter: 20, failRate: 0.001, outages: [[60 * 100, 12]], interval: 30, tags: ['prod', 'critical'] },
    { name: 'Public API', group: 'APIs', type: 'json', path: '/demo/json', config: { jsonPath: '$.data.healthy', jsonOp: 'eq', jsonExpected: 'true' }, base: 80, jitter: 40, failRate: 0.001, outages: [[60 * 41, 70]], interval: 30, tags: ['prod', 'critical'], drift: 1.6 },
    { name: 'Report service (slow)', group: 'APIs', type: 'http', path: '/demo/slow', base: 450, jitter: 200, failRate: 0.004, outages: [], interval: 60, tags: ['staging'] },
    { name: 'Checkout (flaky)', group: 'Web', type: 'http', path: '/demo/flaky', base: 70, jitter: 40, failRate: 0.08, outages: [], interval: 30, tags: ['prod'] },
    { name: 'Legacy portal', group: 'Web', type: 'http', path: '/demo/down', base: 0, jitter: 0, failRate: 1, outages: [], interval: 60, tags: ['staging'] },
    { name: 'App database', group: 'Data', type: 'mysql', config: { host: config.db.host, port: config.db.port, database: config.db.database, username: config.db.user, password: config.db.password, query: 'SELECT 1' }, base: 4, jitter: 3, failRate: 0.0002, outages: [[60 * 41 + 10, 55]], interval: 30, tags: ['prod', 'critical'] },
  ];

  const ids = new Map<string, number>();
  for (const p of profiles) {
    const id = await saveMonitor(ctx, {
      name: p.name, type: p.type, groupId: groups[p.group], description: p.type === 'http' && p.path === '/demo/down' ? 'Always returns 503: shows what an outage looks like.' : null,
      config: p.config ? { ...(p.type === 'tcp' || p.type === 'mysql' ? {} : { url: base + p.path }), ...p.config } : { url: base + p.path },
      intervalS: p.interval, timeoutS: 10, retries: p.name.includes('flaky') ? 1 : 0, retryIntervalS: 10, upThreshold: 1, downThreshold: p.name.includes('flaky') ? 2 : 1, publicBadge: true,
      tagIds: p.tags.map((t) => tags[t as keyof typeof tags]), tagValues: [{ tagId: tags.team, value: ({ Web: 'frontend', APIs: 'platform', Data: 'data' } as Record<string, string>)[p.group] ?? 'ops' }], notifications: [{ channelId: hook, events: ['down', 'up'] }],
    }, adminId);
    ids.set(p.name, id);
  }
  // push monitor for a nightly job
  const backup = await saveMonitor(ctx, { name: 'Nightly backup (push)', type: 'push', groupId: gData, config: { graceSeconds: 300 }, intervalS: 86400, tagIds: [tags.prod] }, adminId);
  ids.set('Nightly backup (push)', backup);
  // the nightly job "ran" a moment ago
  const pushToken = (await loadMonitor(ctx, backup))?.pushToken;
  if (pushToken) setTimeout(() => void fetch(`${base}/api/push/${pushToken}?msg=nightly%20backup%20ok`).catch(() => {}), 5000).unref();
  // dependencies: web monitors depend on the router
  for (const n of ['Marketing site', 'Shop landing page', 'Public API', 'Checkout (flaky)']) await saveMonitor(ctx, { dependsOn: [ids.get('Core router')!] }, adminId, (await loadMonitor(ctx, ids.get(n)!))!);

  // 7 days of raw history, one check every 5 minutes. The rollup job builds minute/hour/day aggregates from it on its first run.
  const STEP = 300_000, DAYS = 7;
  const start = Math.floor((now - DAYS * 86_400_000) / STEP) * STEP;
  const hb: any[] = [], evs: any[] = [];
  const kinds = ['timeout', 'status', 'refused', 'network'];
  for (const p of profiles) {
    const id = ids.get(p.name)!;
    let prevOk = true;
    for (let t = start, i = 0; t < now - 120_000; t += STEP, i++) {
      const minsAgo = (now - t) / 60_000;
      const outage = p.outages.find(([ago, dur]) => minsAgo <= ago && minsAgo > ago - dur);
      const progress = (t - start) / (now - start);
      const down = !!outage || rnd() < p.failRate;
      const hour = new Date(t).getUTCHours();
      const diurnal = 1 + 0.25 * Math.sin(((hour - 8) / 24) * Math.PI * 2);
      const drift = p.drift && progress > 0.85 ? 1 + (p.drift - 1) * ((progress - 0.85) / 0.15) : 1;
      const lat = down ? null : Math.max(1, Math.round((p.base + rnd() * p.jitter) * diurnal * drift));
      const kind = down ? (p.base === 0 ? 'status' : kinds[Math.floor(rnd() * kinds.length)]) : null;
      const msg = down ? (kind === 'status' ? 'Unexpected status 503' : kind === 'timeout' ? 'Timed out after 10000 ms' : kind === 'refused' ? 'Connection refused' : 'Connection reset by peer') : null;
      hb.push({ monitor_id: id, location_id: 0, ts: new Date(t), status: down ? 0 : 1, latency_ms: lat, error_kind: kind, message: msg });
      if (down === prevOk && i > 0) evs.push({ monitor_id: id, ts: new Date(t), type: 'status_change', from_status: prevOk ? 'up' : 'down', to_status: down ? 'down' : 'up', error_kind: kind, message: down ? msg : 'Recovered' });
      prevOk = !down;
    }
  }
  for (let i = 0; i < hb.length; i += 1000) await db.insertInto('heartbeats').values(hb.slice(i, i + 1000)).execute();
  for (let i = 0; i < evs.length; i += 500) await db.insertInto('events').values(evs.slice(i, i + 500)).execute();

  // 90 days of daily aggregates beyond the raw window (older days only: the newest 7 days come from the rollup job)
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const dailyRows: any[] = [];
  for (const p of profiles) {
    const id = ids.get(p.name)!;
    for (let d = 90; d > DAYS + 1; d--) {
      const total = 86_400 / p.interval, bad = p.failRate >= 1 ? total : Math.round(total * (p.failRate * (0.5 + rnd()) + (rnd() < 0.03 ? 0.01 + rnd() * 0.03 : 0)));
      const avg = Math.round(p.base + p.jitter / 2), ln = total - bad;
      dailyRows.push({ monitor_id: id, res: 'day', bucket: new Date(dayStart - d * 86_400_000), total, up_n: ln, down_n: bad, maint_n: 0, lat_n: ln, lat_sum: avg * ln, lat_min: Math.max(1, Math.round(p.base)), lat_max: Math.round(p.base + p.jitter * 3), lat_p50: avg, lat_p95: Math.round(avg + p.jitter), lat_p99: Math.round(avg + p.jitter * 2) });
    }
  }
  for (let i = 0; i < dailyRows.length; i += 500) await db.insertInto('rollups').values(dailyRows.slice(i, i + 500)).execute();

  // incidents: two resolved ones with post-mortem, matching the synthetic outages
  const resolved = async (title: string, monitor: string, hoursAgo: number, mins: number, severity: 'minor' | 'major' | 'critical', postmortem?: string) => {
    const startedAt = new Date(now - hoursAgo * 3_600_000), endedAt = new Date(startedAt.getTime() + mins * 60_000);
    const iid = Number((await db.insertInto('incidents').values({ title, status: 'resolved', severity, source: postmortem ? 'manual' : 'auto', monitor_id: ids.get(monitor)!, started_at: startedAt, acknowledged_at: new Date(startedAt.getTime() + 3 * 60_000), acknowledged_by: adminId, resolved_at: endedAt, postmortem: postmortem ?? null, public: postmortem ? 1 : 0, created_by: adminId }).executeTakeFirstOrThrow()).insertId);
    await db.insertInto('incident_monitors').values({ incident_id: iid, monitor_id: ids.get(monitor)! }).execute();
    await db.insertInto('incident_updates').values([
      { incident_id: iid, kind: 'auto', ts: startedAt, body: 'Monitor went down' }, { incident_id: iid, kind: 'ack', ts: new Date(startedAt.getTime() + 3 * 60_000), user_id: adminId, body: 'Looking into it' },
      { incident_id: iid, kind: 'resolve', ts: endedAt, body: `Recovered after ${mins} min` },
    ]).execute();
  };
  await resolved('Public API is down', 'Public API', 41, 70, 'major');
  await resolved('Database failover caused API errors', 'App database', 41, 55, 'critical', 'Root cause: the primary database restarted during a routine update. Applications reconnected automatically after about one hour. Follow-up: add a connection retry with backoff.');

  // status page, maintenance window, saved view
  const page = Number((await db.insertInto('status_pages').values({ slug: 'demo', title: 'Demo Status', description: 'Live status of the demo services.', is_public: 1, branding: JSON.stringify({ primaryColor: '#4f46e5' }), blocks: JSON.stringify([{ type: 'summary' }, { type: 'streak' }, { type: 'heatmap', days: 90 }]) }).executeTakeFirstOrThrow()).insertId);
  const sec = async (name: string, sort: number) => Number((await db.insertInto('status_page_sections').values({ page_id: page, name, sort }).executeTakeFirstOrThrow()).insertId);
  const sWeb = await sec('Websites', 0), sApi = await sec('APIs and data', 1);
  let sort = 0;
  for (const [n, s] of [['Marketing site', sWeb], ['Shop landing page', sWeb], ['Checkout (flaky)', sWeb], ['Public API', sApi], ['App database', sApi]] as const)
    await db.insertInto('status_page_components').values({ page_id: page, section_id: s, monitor_id: ids.get(n)!, sort: sort++ }).execute();
  const mw = Number((await db.insertInto('maintenance_windows').values({ name: 'Weekly database maintenance', description: 'Sunday night patching', kind: 'cron', cron_expr: '0 3 * * 0', duration_min: 30, timezone: 'UTC', active: 1, announce: 1, created_by: adminId }).executeTakeFirstOrThrow()).insertId);
  await db.insertInto('maintenance_targets').values({ window_id: mw, target_type: 'group', target_id: gData }).execute();
  await db.insertInto('saved_views').values({ user_id: adminId, name: 'Critical only', filters: JSON.stringify({ tag: 'critical' }), shared: 1 }).execute();

  await ctx.settings.set('demo.seeded', true);
  log.info({ monitors: ids.size, heartbeats: hb.length }, 'demo data created');
}
