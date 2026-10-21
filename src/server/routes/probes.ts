import crypto from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../auth/access';
import { randomToken, sha256 } from '../crypto';
import { parseJson } from '../db';
import { parseMonitor } from '../monitors/model';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });

export async function probeRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: app.requireRole('admin') };

  /* ------------------------------ admin side ------------------------------ */
  app.get('/api/probes', { ...auth, schema: { tags: ['probes'] } }, async (req) =>
    (await db.selectFrom('probes').select(['id', 'name', 'location', 'version', 'last_seen_at', 'last_ip', 'enabled', 'created_at']).orderBy('name').execute())
      .map((p) => ({ id: p.id, name: p.name, location: p.location, version: p.version, lastSeenAt: p.last_seen_at, lastIp: req.user!.role === 'admin' ? p.last_ip : null, enabled: !!p.enabled, createdAt: p.created_at, online: !!p.last_seen_at && Date.now() - p.last_seen_at.getTime() < 120_000 })));

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

  app.patch('/api/probes/:id', { ...admin, schema: { tags: ['probes'], params: Id, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })), location: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()) }) } }, async (req) => {
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

  app.post('/api/probe/v1/results', { ...popts, bodyLimit: 2 * 1024 * 1024, schema: { tags: ['probes'], hide: true, body: Type.Object({ results: Type.Array(Type.Object({ monitorId: Type.Integer(), ts: Type.Optional(Type.String()), ok: Type.Boolean(), latencyMs: Type.Optional(Type.Union([Type.Number(), Type.Null()])), errorKind: Type.Optional(Type.Union([Type.String(), Type.Null()])), message: Type.Optional(Type.Union([Type.String(), Type.Null()])) }), { maxItems: 1000 }) }) } }, async (req: any) => {
    const assigned = new Set((await db.selectFrom('monitors').select(['id', 'locations']).where('locations', 'is not', null).execute()).filter((m) => parseJson<(number | 'local')[]>(m.locations, []).includes(req.probe.id)).map((m) => m.id));
    let accepted = 0;
    for (const r of req.body.results) {
      if (!assigned.has(r.monitorId)) continue;
      const ts = r.ts ? new Date(r.ts) : new Date();
      await ctx.engine.storeLocation(r.monitorId, req.probe.id, { ok: r.ok, latencyMs: r.latencyMs ?? undefined, errorKind: (r.errorKind ?? undefined) as any, message: r.message ?? undefined }, Number.isNaN(ts.getTime()) || Math.abs(ts.getTime() - Date.now()) > 3_600_000 ? new Date() : ts);
      accepted++;
    }
    return { accepted };
  });
}
