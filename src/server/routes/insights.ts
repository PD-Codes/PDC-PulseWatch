import { Type } from '@sinclair/typebox';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { accessibleMonitorIds } from '../auth/access';
import { parseJson } from '../db';

const DAY = 86_400_000;
const hostOf = (cfg: Record<string, any>): string | null => {
  try { return cfg.host ? String(cfg.host).toLowerCase() : cfg.url ? new URL(cfg.url).hostname.toLowerCase() : null; } catch { return null; }
};

export async function insightRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };

  /** Calendar heatmap: one value per day, from the daily rollups. */
  app.get('/api/insights/heatmap', { ...auth, schema: { tags: ['insights'], querystring: Type.Object({ monitorId: Type.Optional(Type.Integer()), days: Type.Optional(Type.Integer({ minimum: 7, maximum: 730 })) }) } }, async (req, reply) => {
    const q = req.query as { monitorId?: number; days?: number };
    const days = q.days ?? 365;
    const allowed = await accessibleMonitorIds(ctx, req.user!);
    if (q.monitorId && allowed && !allowed.includes(q.monitorId)) return reply.code(404).send({ error: 'not_found' });
    const ids = q.monitorId ? [q.monitorId] : allowed;
    if (ids && !ids.length) return { days: [] };
    const since = new Date(Math.floor(Date.now() / DAY) * DAY - (days - 1) * DAY);
    const rows = await sql<any>`SELECT bucket, SUM(up_n) u, SUM(down_n) d, SUM(maint_n) m FROM rollups WHERE res = 'day' AND bucket >= ${since} ${ids ? sql`AND monitor_id IN (${sql.join(ids)})` : sql``} GROUP BY bucket ORDER BY bucket`.execute(db);
    const by = new Map<string, { u: number; d: number; m: number }>(rows.rows.map((r: any) => [new Date(r.bucket).toISOString().slice(0, 10), { u: Number(r.u), d: Number(r.d), m: Number(r.m) }]));
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
      const v = by.get(date);
      out.push({ date, uptime: v && v.u + v.d ? Math.round((v.u / (v.u + v.d)) * 10000) / 100 : null, down: v?.d ?? 0, total: v ? v.u + v.d : 0, maintenance: v?.m ?? 0 });
    }
    return { days: out };
  });

  /**
   * "What changed?": everything that went wrong or changed around an incident (or a timestamp), correlated by time,
   * group, dependency, shared host and shared error kind.
   */
  app.get('/api/insights/changes', { ...auth, schema: { tags: ['insights'], querystring: Type.Object({ incidentId: Type.Optional(Type.Integer()), at: Type.Optional(Type.String({ format: 'date-time' })), monitorId: Type.Optional(Type.Integer()), windowMin: Type.Optional(Type.Integer({ minimum: 1, maximum: 240 })) }) } }, async (req, reply) => {
    const q = req.query as { incidentId?: number; at?: string; monitorId?: number; windowMin?: number };
    let anchorAt = q.at ? new Date(q.at) : new Date();
    let anchorMonitor = q.monitorId ?? null;
    let title: string | null = null;
    if (q.incidentId) {
      const inc = await db.selectFrom('incidents').select(['title', 'started_at', 'monitor_id']).where('id', '=', q.incidentId).executeTakeFirst();
      if (!inc) return reply.code(404).send({ error: 'not_found' });
      anchorAt = inc.started_at; anchorMonitor = inc.monitor_id; title = inc.title;
    }
    const win = (q.windowMin ?? 15) * 60_000;
    const allowed = await accessibleMonitorIds(ctx, req.user!);
    if (anchorMonitor && allowed && !allowed.includes(anchorMonitor)) return reply.code(404).send({ error: 'not_found' });
    if (q.incidentId && allowed) { // an incident is visible when it touches a monitor the user can see; manual ones without monitors are not
      const touched = await db.selectFrom('incident_monitors').select('monitor_id').where('incident_id', '=', q.incidentId).where('monitor_id', 'in', allowed.concat(0)).executeTakeFirst();
      if (!touched) return reply.code(404).send({ error: 'not_found' });
    }

    let ev = db.selectFrom('events as e').innerJoin('monitors as m', 'm.id', 'e.monitor_id')
      .select(['e.id', 'e.monitor_id', 'e.ts', 'e.type', 'e.from_status', 'e.to_status', 'e.error_kind', 'e.message', 'm.name', 'm.group_id', 'm.config'])
      .where('e.ts', '>=', new Date(anchorAt.getTime() - win)).where('e.ts', '<=', new Date(anchorAt.getTime() + win)).orderBy('e.ts').limit(300);
    if (allowed) ev = ev.where('e.monitor_id', 'in', allowed.length ? allowed : [0]);
    const events = await ev.execute();

    const anchor = anchorMonitor ? await db.selectFrom('monitors').select(['id', 'group_id', 'config']).where('id', '=', anchorMonitor).executeTakeFirst() : undefined;
    const anchorHost = anchor ? hostOf(parseJson(anchor.config, {})) : null;
    const deps = anchorMonitor ? await db.selectFrom('monitor_dependencies').selectAll().where((eb) => eb.or([eb('monitor_id', '=', anchorMonitor!), eb('depends_on_id', '=', anchorMonitor!)])).execute() : [];
    const related = new Set(deps.map((d) => (d.monitor_id === anchorMonitor ? d.depends_on_id : d.monitor_id)));

    const items = events.map((e) => {
      const mid = e.monitor_id as number; // inner join guarantees a monitor
      const host = hostOf(parseJson(e.config, {}));
      const relation = mid === anchorMonitor ? 'self' : related.has(mid) ? 'dependency' : anchorHost && host === anchorHost ? 'same_host' : anchor?.group_id && e.group_id === anchor.group_id ? 'same_group' : 'unrelated';
      return { id: e.id, ts: e.ts, monitorId: mid, monitor: e.name, type: e.type, from: e.from_status, to: e.to_status, errorKind: e.error_kind, message: e.message, relation, offsetSec: Math.round((e.ts.getTime() - anchorAt.getTime()) / 1000) };
    });

    const downs = items.filter((i) => i.type === 'status_change' && i.to === 'down');
    const hints: string[] = [];
    const first = downs[0];
    if (first && first.monitorId !== anchorMonitor && downs.some((d) => d.monitorId === anchorMonitor)) hints.push(`"${first.monitor}" failed first (${Math.abs(first.offsetSec)}s ${first.offsetSec < 0 ? 'before' : 'after'} the incident). It may be the root cause.`);
    const kinds = new Map<string, Set<string>>();
    for (const d of downs) if (d.errorKind) (kinds.get(d.errorKind) ?? kinds.set(d.errorKind, new Set()).get(d.errorKind)!).add(d.monitor);
    for (const [k, set] of kinds) if (set.size >= 2) hints.push(`${set.size} monitors failed with the same error kind "${k}" (${[...set].slice(0, 4).join(', ')}).`);
    const sameHost = items.filter((i) => i.relation === 'same_host' && i.to === 'down');
    if (sameHost.length) hints.push(`${sameHost.length} other monitor(s) on the same host went down at the same time.`);
    const maint = items.filter((i) => i.type.startsWith('maintenance'));
    if (maint.length) hints.push('A maintenance window started or ended nearby.');
    const certs = items.filter((i) => i.errorKind === 'tls' || i.type.startsWith('cert'));
    if (certs.length) hints.push('TLS or certificate events happened nearby.');
    if (downs.length >= 5) hints.push(`${downs.length} monitors went down within ±${Math.round(win / 60000)} min: this looks like a shared infrastructure problem rather than a single service.`);
    if (!hints.length) hints.push('No correlated changes found in the time window.');

    return { anchor: { at: anchorAt, monitorId: anchorMonitor, incidentId: q.incidentId ?? null, title }, windowMin: win / 60000, hints, events: items };
  });
}
