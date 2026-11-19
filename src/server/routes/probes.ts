import crypto from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../auth/access';
import { config } from '../config';
import { randomToken, sha256 } from '../crypto';
import { parseJson } from '../db';
import { parseMonitor } from '../monitors/model';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });

/** Clock differences below this are request transit time rather than a wrong probe clock and are not corrected. */
const CLOCK_TOLERANCE_MS = 2_000;
/** Results more than this far in the future (after correction) are dropped. */
const MAX_FUTURE_MS = 60_000;

/** Per-probe observations of this process, shown in the probe list. shortcut: in memory, reset on restart. */
const probeStats = new Map<number, { clockOffsetMs: number; skippedRuns: number; lastSkippedAt: Date | null; warnedAt: number }>();
const statsOf = (id: number) => { let s = probeStats.get(id); if (!s) probeStats.set(id, (s = { clockOffsetMs: 0, skippedRuns: 0, lastSkippedAt: null, warnedAt: 0 })); return s; };

export interface ProbeResultIn { id?: string; monitorId: number; ts?: string; ok: boolean; latencyMs?: number | null; errorKind?: string | null; message?: string | null }

/**
 * Offset (ms) to add to the timestamps of one result batch. New probes send their clock (`sentAt`); for older probes only a
 * clock that runs ahead can be told apart from a backlog, so their newest result is pulled back to the server's now.
 */
export function clockOffset(now: number, sentAt: string | undefined, results: ProbeResultIn[]): number {
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  if (Number.isFinite(sent)) { const d = now - sent; return Math.abs(d) > CLOCK_TOLERANCE_MS ? d : 0; }
  const newest = Math.max(...results.map((r) => (r.ts ? Date.parse(r.ts) : NaN)).filter(Number.isFinite));
  return Number.isFinite(newest) && newest > now + MAX_FUTURE_MS ? now - newest : 0;
}

export async function probeRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: app.requireRole('admin') };

  /* ------------------------------ admin side ------------------------------ */
  app.get('/api/probes', { ...auth, schema: { tags: ['probes'] } }, async (req) => {
    // how many monitors run on each probe, so nobody deletes or disables one without knowing what depends on it
    const used = new Map<number, number>();
    for (const m of await db.selectFrom('monitors').select('locations').where('locations', 'is not', null).execute()) for (const l of parseJson<(number | 'local')[]>(m.locations, [])) if (typeof l === 'number') used.set(l, (used.get(l) ?? 0) + 1);
    return (await db.selectFrom('probes').select(['id', 'name', 'location', 'version', 'last_seen_at', 'last_ip', 'enabled', 'created_at']).orderBy('name').execute())
      .map((p) => ({ id: p.id, name: p.name, location: p.location, version: p.version, lastSeenAt: p.last_seen_at, lastIp: req.user!.role === 'admin' ? p.last_ip : null, enabled: !!p.enabled, createdAt: p.created_at, online: !!p.last_seen_at && Date.now() - p.last_seen_at.getTime() < 120_000, monitorCount: used.get(p.id) ?? 0, clockOffsetMs: probeStats.get(p.id)?.clockOffsetMs ?? null, skippedRuns: probeStats.get(p.id)?.skippedRuns ?? 0 }));
  });

  app.post('/api/probes', { ...admin, schema: { tags: ['probes'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), location: Type.Optional(Type.String({ maxLength: 128 })) }) } }, async (req, reply) => {
    const b = req.body as { name: string; location?: string };
    const token = `pwp_${randomToken(32)}`;
    try {
      const r = await db.insertInto('probes').values({ name: b.name, location: b.location ?? null, token_hash: sha256(token) }).executeTakeFirstOrThrow();
      await writeAudit(ctx, req.user, 'probe.created', { type: 'probe', id: Number(r.insertId) }, { name: b.name }, req.ip);
      return { id: Number(r.insertId), token };
    } catch (e: any) { if (e.code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'conflict', message: 'A probe with this name already exists' }); throw e; }
  });

  app.post('/api/probes/:id/rotate', { ...admin, schema: { tags: ['probes'], params: Id } }, async (req, reply) => {
    const token = `pwp_${randomToken(32)}`;
    const r = await db.updateTable('probes').set({ token_hash: sha256(token) }).where('id', '=', (req.params as any).id).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) return reply.code(404).send({ error: 'not_found' });
    await writeAudit(ctx, req.user, 'probe.token_rotated', { type: 'probe', id: (req.params as any).id }, undefined, req.ip);
    return { token };
  });

  app.patch('/api/probes/:id', { ...admin, schema: { tags: ['probes'], params: Id, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), location: Type.Optional(Type.String({ maxLength: 128 })), enabled: Type.Optional(Type.Boolean()) }) } }, async (req) => {
    const b = req.body as any; const set: Record<string, unknown> = {};
    if (b.name !== undefined) set.name = b.name; if (b.location !== undefined) set.location = b.location; if (b.enabled !== undefined) set.enabled = b.enabled ? 1 : 0;
    if (Object.keys(set).length) await db.updateTable('probes').set(set).where('id', '=', (req.params as any).id).execute();
    return { ok: true };
  });

  app.delete('/api/probes/:id', { ...admin, schema: { tags: ['probes'], params: Id } }, async (req) => {
    const id = (req.params as any).id;
    await db.deleteFrom('probes').where('id', '=', id).execute();
    await db.deleteFrom('monitor_location_state').where('location_id', '=', id).execute();
    // drop the probe from monitor location lists
    for (const m of await db.selectFrom('monitors').select(['id', 'locations', 'quorum']).where('locations', 'is not', null).execute()) {
      const locs = parseJson<(number | 'local')[]>(m.locations, []);
      if (locs.includes(id)) { const next = locs.filter((l) => l !== id); await db.updateTable('monitors').set({ locations: next.length ? JSON.stringify(next) : null, quorum: Math.min(m.quorum, Math.max(1, next.length)) }).where('id', '=', m.id).execute(); }
    }
    await writeAudit(ctx, req.user, 'probe.deleted', { type: 'probe', id }, undefined, req.ip);
    return { ok: true };
  });

  /* ------------------------------- probe side ------------------------------- */
  const probeAuth = async (req: any, reply: any) => {
    const raw = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const p = raw.startsWith('pwp_') ? await db.selectFrom('probes').selectAll().where('token_hash', '=', sha256(raw)).executeTakeFirst() : undefined;
    if (!p || !p.enabled) return reply.code(401).send({ error: 'unauthorized' });
    req.probe = p;
    await db.updateTable('probes').set({ last_seen_at: new Date(), last_ip: req.ip, version: String(req.headers['x-probe-version'] ?? p.version ?? '').slice(0, 32) || null }).where('id', '=', p.id).execute();
  };
  const popts = { onRequest: probeAuth, config: { skipCsrf: true, rateLimit: { max: 600, timeWindow: '1 minute' } } };

  /** Jobs assigned to this probe. Secrets are sent decrypted: only use HTTPS between probe and server. */
  app.get('/api/probe/v1/jobs', { ...popts, schema: { tags: ['probes'], hide: true } }, async (req: any, reply) => {
    const rows = await db.selectFrom('monitors').selectAll().where('active', '=', 1).where('locations', 'is not', null).execute();
    const jobs = rows.map(parseMonitor).filter((m) => m.locations?.includes(req.probe.id)).map((m) => ({ id: m.id, name: m.name, type: m.type, config: m.config, intervalS: m.intervalS, timeoutS: m.timeoutS }));
    const ca = (await db.selectFrom('ca_certs').select('pem').orderBy('id').execute()).map((r) => r.pem);
    const version = crypto.createHash('sha1').update(JSON.stringify([jobs, ca])).digest('hex');
    if (req.headers['if-none-match'] === version) return reply.code(304).send();
    return reply.header('ETag', version).send({ version, jobs, ca });
  });

  /**
   * Results of a probe. Timestamps are corrected by the probe's clock offset; results older than the location's latest state
   * (a backlog after a network outage, or out of order) are kept as heartbeats with their real time but do not count as fresh.
   * Results carrying an id are stored once even when a batch is sent again.
   */
  const ResultIn = Type.Object({ id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), monitorId: Type.Integer(), ts: Type.Optional(Type.String()), ok: Type.Boolean(), latencyMs: Type.Optional(Type.Union([Type.Number(), Type.Null()])), errorKind: Type.Optional(Type.Union([Type.String(), Type.Null()])), message: Type.Optional(Type.Union([Type.String(), Type.Null()])) });
  app.post('/api/probe/v1/results', { ...popts, bodyLimit: 2 * 1024 * 1024, schema: { tags: ['probes'], hide: true, body: Type.Object({ results: Type.Array(ResultIn, { maxItems: 1000 }), sentAt: Type.Optional(Type.String({ maxLength: 40 })), skipped: Type.Optional(Type.Integer({ minimum: 0 })) }) } }, async (req: any) => {
    const probeId: number = req.probe.id;
    const body = req.body as { results: ProbeResultIn[]; sentAt?: string; skipped?: number };
    const now = Date.now();
    const st = statsOf(probeId);
    const offset = clockOffset(now, body.sentAt, body.results);
    st.clockOffsetMs = offset;
    if (Math.abs(offset) > 30_000 && now - st.warnedAt > 600_000) { st.warnedAt = now; ctx.log.warn({ probe: req.probe.name, offsetMs: offset }, 'probe clock is off; its timestamps are corrected (check NTP on the probe host)'); }
    if (body.skipped) { st.skippedRuns += body.skipped; st.lastSkippedAt = new Date(now); ctx.log.warn({ probe: req.probe.name, skipped: body.skipped }, 'probe skipped checks because it was overloaded (raise PW_PROBE_CONCURRENCY or add a probe)'); }

    const assigned = new Set((await db.selectFrom('monitors').select(['id', 'locations']).where('locations', 'is not', null).execute()).filter((m) => parseJson<(number | 'local')[]>(m.locations, []).includes(probeId)).map((m) => m.id));
    // older probe versions could store a state up to an hour in the future; such a state must not block newer results
    const latest = new Map((await db.selectFrom('monitor_location_state').select(['monitor_id', 'ts']).where('location_id', '=', probeId).execute()).filter((r) => r.ts.getTime() <= now + MAX_FUTURE_MS).map((r) => [r.monitor_id, r.ts.getTime()]));
    const oldest = now - config.retention.rawDays * 86_400_000;
    let accepted = 0, stale = 0, rejected = 0, duplicates = 0;
    for (const r of body.results) {
      if (!assigned.has(r.monitorId)) continue;
      const parsed = r.ts ? Date.parse(r.ts) : NaN;
      const at = Number.isFinite(parsed) ? parsed + offset : now;
      if (at > now + MAX_FUTURE_MS || at < oldest) { rejected++; continue; }
      const ts = new Date(Math.min(at, now));
      if (r.id) {
        const claim = await db.insertInto('probe_results_seen').ignore().values({ probe_id: probeId, result_id: r.id }).executeTakeFirst();
        if (!Number(claim.numInsertedOrUpdatedRows)) { duplicates++; continue; }
      }
      const result = { ok: r.ok, latencyMs: r.latencyMs ?? undefined, errorKind: (r.errorKind ?? undefined) as any, message: r.message ?? undefined };
      try {
        if (ts.getTime() > (latest.get(r.monitorId) ?? -Infinity)) {
          await ctx.engine.storeLocation(r.monitorId, probeId, result, ts);
          latest.set(r.monitorId, ts.getTime());
        } else {
          await db.insertInto('heartbeats').values({ monitor_id: r.monitorId, location_id: probeId, ts, status: r.ok ? 1 : 0, latency_ms: r.latencyMs ?? null, error_kind: r.errorKind ?? null, message: r.message?.slice(0, 500) ?? null }).execute();
          stale++;
        }
      } catch (e) {
        // the probe sends the batch again; the id must not block that
        if (r.id) await db.deleteFrom('probe_results_seen').where('probe_id', '=', probeId).where('result_id', '=', r.id).execute().catch(() => {});
        throw e;
      }
      accepted++;
    }
    return { accepted, stale, duplicates, rejected, clockOffsetMs: offset };
  });
}
