import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { accessibleMonitorIds } from '../auth/access';
import { config } from '../config';
import { safeEqual } from '../crypto';
import { uptimeFor } from '../monitors/service';
import type { Scheduler } from '../engine/scheduler';
import { mailConfigured } from '../mail';
import { VERSION } from '../version';

export interface SystemDeps { scheduler?: Scheduler }

const COLORS = { up: '#16a34a', down: '#dc2626', pending: '#d97706', unknown: '#6b7280', maintenance: '#2563eb' } as const;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Flat two-part badge, similar to the usual README badges. */
export function badge(label: string, value: string, color: string): string {
  const w = (t: string) => Math.max(30, t.length * 6.6 + 14);
  const lw = w(label), vw = w(value), total = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

export async function systemRoutes(app: FastifyInstance, deps: SystemDeps) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/health', { schema: { tags: ['system'], summary: 'Liveness probe' } }, async () => ({ status: 'ok' }));

  const dbOk = async () => { try { await sql`SELECT 1`.execute(db); return true; } catch { return false; } };
  const schedulerOk = () => !deps.scheduler || Date.now() - deps.scheduler.lastTickAt < Math.max(30_000, config.scheduler.tickMs * 10);

  app.get('/ready', { schema: { tags: ['system'], summary: 'Readiness probe (database and scheduler)' } }, async (_req, reply) => {
    const d = await dbOk();
    const s = schedulerOk();
    return reply.code(d && s ? 200 : 503).send({ status: d && s ? 'ready' : 'not_ready', database: d, scheduler: s });
  });

  /** Dead-man's switch endpoint: poll this from an external monitoring service. It only answers 200 while the scheduler is alive. */
  app.get('/heartbeat', { schema: { tags: ['system'], summary: "PulseWatch's own heartbeat for external dead-man's-switch checks" } }, async (_req, reply) => {
    const ok = (await dbOk()) && schedulerOk();
    return reply.code(ok ? 200 : 503).send({ ok, ts: new Date().toISOString() });
  });

  app.get('/api/meta', { schema: { tags: ['system'] } }, async () => ({ brand: config.brand, version: VERSION, smtp: mailConfigured(), baseUrl: config.baseUrl, demo: config.demo, role: config.role }));

  /* ------------------------------ Prometheus ------------------------------ */
  app.get('/metrics', { schema: { tags: ['system'], summary: 'Prometheus metrics (Bearer token)' } }, async (req, reply) => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const tokenOk = !!config.metricsToken && !!bearer && safeEqual(bearer, config.metricsToken);
    if (!tokenOk && !(req.user && req.user.role === 'admin')) return reply.code(config.metricsToken ? 401 : 404).send('unauthorized\n');
    const rows = await db.selectFrom('monitors as m').leftJoin('monitor_state as s', 's.monitor_id', 'm.id').select(['m.id', 'm.name', 'm.type', 'm.active', 's.status', 's.overlay', 's.last_latency_ms', 's.cert_expires_at']).execute();
    const lbl = (r: (typeof rows)[number]) => `monitor="${r.name.replace(/["\\\n]/g, '_')}",id="${r.id}",type="${r.type}"`;
    const code = (r: (typeof rows)[number]) => (!r.active ? 4 : r.overlay === 'maintenance' ? 3 : r.status === 'up' ? 1 : r.status === 'down' ? 0 : r.status === 'pending' ? 2 : -1);
    const out: string[] = [
      '# HELP pulsewatch_monitor_status 1 up, 0 down, 2 pending, 3 maintenance, 4 paused, -1 unknown', '# TYPE pulsewatch_monitor_status gauge',
      ...rows.map((r) => `pulsewatch_monitor_status{${lbl(r)}} ${code(r)}`),
      '# HELP pulsewatch_monitor_up 1 when the monitor is up', '# TYPE pulsewatch_monitor_up gauge',
      ...rows.filter((r) => r.active).map((r) => `pulsewatch_monitor_up{${lbl(r)}} ${r.status === 'down' ? 0 : 1}`),
      '# HELP pulsewatch_monitor_response_ms Last response time in milliseconds', '# TYPE pulsewatch_monitor_response_ms gauge',
      ...rows.filter((r) => r.last_latency_ms != null).map((r) => `pulsewatch_monitor_response_ms{${lbl(r)}} ${r.last_latency_ms}`),
      '# HELP pulsewatch_monitor_cert_days_left Days until the TLS certificate expires', '# TYPE pulsewatch_monitor_cert_days_left gauge',
      ...rows.filter((r) => r.cert_expires_at).map((r) => `pulsewatch_monitor_cert_days_left{${lbl(r)}} ${Math.floor((r.cert_expires_at!.getTime() - Date.now()) / 86_400_000)}`),
    ];
    const open = await db.selectFrom('incidents').select(sql<number>`COUNT(*)`.as('n')).where('status', '!=', 'resolved').executeTakeFirst();
    out.push('# TYPE pulsewatch_incidents_open gauge', `pulsewatch_incidents_open ${Number(open?.n ?? 0)}`);
    if (deps.scheduler) {
      const s = deps.scheduler.stats();
      out.push('# TYPE pulsewatch_scheduler_running gauge', `pulsewatch_scheduler_running ${s.running}`, '# TYPE pulsewatch_scheduler_lag_ms gauge', `pulsewatch_scheduler_lag_ms ${s.lagMs}`, '# TYPE pulsewatch_checks_total counter', `pulsewatch_checks_total ${s.checksRun}`);
    }
    const failed = await db.selectFrom('notification_deliveries').select(sql<number>`COUNT(*)`.as('n')).where('status', '=', 'failed').executeTakeFirst();
    out.push('# TYPE pulsewatch_notifications_failed gauge', `pulsewatch_notifications_failed ${Number(failed?.n ?? 0)}`);
    return reply.type('text/plain; version=0.0.4').send(out.join('\n') + '\n');
  });

  /* ------------------------------- realtime ------------------------------- */
  app.get('/api/stream', { preHandler: app.requireAuth, schema: { tags: ['system'], summary: 'Server-sent events with live monitor updates' } }, async (req, reply) => {
    const user = req.user!;
    let visible = await accessibleMonitorIds(ctx, user).then((v) => (v ? new Set(v) : null));
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { ts: Date.now() });
    const unsub = ctx.bus.subscribe((e) => {
      if (e.type === 'monitor') { if (visible && !visible.has(e.monitorId)) return; send('monitor', e.data); }
      else if (e.type === 'incident') { if (visible && e.monitorId && !visible.has(e.monitorId)) return; send('incident', { id: e.incidentId, status: e.status, monitorId: e.monitorId }); }
      else send(e.type, e);
    });
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
    const refresh = setInterval(async () => { visible = await accessibleMonitorIds(ctx, user).then((v) => (v ? new Set(v) : null)).catch(() => visible); }, 60_000);
    req.raw.on('close', () => { unsub(); clearInterval(ping); clearInterval(refresh); });
  });

  /* -------------------------------- badges -------------------------------- */
  app.get('/badge/:id/:kind', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags: ['badges'], summary: 'Uptime badge for READMEs (only for monitors with public badge enabled)', params: { type: 'object', properties: { id: { type: 'integer' }, kind: { type: 'string' } } } } }, async (req, reply) => {
    const { id, kind } = req.params as { id: number; kind: string };
    const q = req.query as { label?: string; range?: string };
    const row = await db.selectFrom('monitors as m').leftJoin('monitor_state as s', 's.monitor_id', 'm.id').select(['m.name', 'm.public_badge', 's.status', 's.overlay', 's.last_latency_ms']).where('m.id', '=', id).executeTakeFirst();
    reply.header('Cache-Control', 'max-age=60, s-maxage=60').type('image/svg+xml');
    if (!row || !row.public_badge) return reply.code(404).send(badge('badge', 'not found', COLORS.unknown));
    const name = (q.label ?? row.name).slice(0, 40);
    if (kind === 'status.svg') {
      const st = row.overlay === 'maintenance' ? 'maintenance' : (row.status ?? 'unknown');
      return badge(name, st, COLORS[st as keyof typeof COLORS] ?? COLORS.unknown);
    }
    if (kind === 'ping.svg') return badge(`${name} response`, row.last_latency_ms != null ? `${row.last_latency_ms} ms` : 'n/a', row.last_latency_ms != null ? COLORS.up : COLORS.unknown);
    const m = /^uptime(?:-(24h|7d|30d|90d|365d))?\.svg$/.exec(kind);
    if (m) {
      const key = ({ '24h': 'h24', '7d': 'd7', '30d': 'd30', '90d': 'd90', '365d': 'd365' } as const)[(m[1] ?? q.range ?? '30d') as '24h'] ?? 'd30';
      const u = (await uptimeFor(ctx, [id])).get(id)?.[key];
      return badge(`${name} uptime`, u == null ? 'n/a' : `${u}%`, u == null ? COLORS.unknown : u >= 99.5 ? COLORS.up : u >= 97 ? COLORS.pending : COLORS.down);
    }
    return reply.code(404).send(badge('badge', 'unknown kind', COLORS.unknown));
  });
}
