import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../auth/access';
import { applyCaStore, parsePemBundle } from '../ca-store';

export async function caCertRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: app.requireRole('admin') };

  app.get('/api/ca-certs', { ...auth, schema: { tags: ['certificates'], summary: 'Imported CA certificates' } }, async () =>
    (await db.selectFrom('ca_certs').select(['id', 'name', 'subject', 'issuer', 'fingerprint256', 'valid_from', 'valid_to', 'created_at']).orderBy('id').execute())
      .map((r) => ({ id: r.id, name: r.name, subject: r.subject, issuer: r.issuer, fingerprint256: r.fingerprint256, validFrom: r.valid_from, validTo: r.valid_to, createdAt: r.created_at, expired: r.valid_to.getTime() < Date.now() })));

  app.post('/api/ca-certs', { ...admin, bodyLimit: 1024 * 1024, schema: { tags: ['certificates'], summary: 'Import one or more PEM CA certificates', body: Type.Object({ pem: Type.String({ minLength: 1, maxLength: 500_000 }), name: Type.Optional(Type.String({ maxLength: 128 })) }) } }, async (req, reply) => {
    const b = req.body as { pem: string; name?: string };
    let certs;
    try { certs = parsePemBundle(b.pem); } catch (e) { return reply.code(400).send({ error: 'validation', message: (e as Error).message }); }
    const added: number[] = []; const skipped: string[] = [];
    const warnings: string[] = [];
    for (const c of certs) {
      if (c.validTo.getTime() < Date.now()) { skipped.push(`${c.subject} (expired on ${c.validTo.toISOString().slice(0, 10)})`); continue; }
      if (!c.isCa) warnings.push(`${c.subject} is not a CA certificate (it is trusted anyway, as a pinned certificate)`);
      const cn = /CN=([^,]+)/.exec(c.subject)?.[1] ?? c.subject;
      try {
        const r = await db.insertInto('ca_certs').values({ name: (certs.length === 1 && b.name ? b.name : cn).slice(0, 128), pem: c.pem, subject: c.subject, issuer: c.issuer, fingerprint256: c.fingerprint256, valid_from: c.validFrom, valid_to: c.validTo, created_by: req.user!.id }).executeTakeFirstOrThrow();
        added.push(Number(r.insertId));
      } catch (e: any) { if (e.code === 'ER_DUP_ENTRY') skipped.push(`${c.subject} (already imported)`); else throw e; }
    }
    if (added.length) { await applyCaStore(ctx); await writeAudit(ctx, req.user, 'ca_cert.imported', { type: 'ca_cert' }, { count: added.length }, req.ip); }
    return { added: added.length, skipped, warnings };
  });

  app.delete('/api/ca-certs/:id', { ...admin, schema: { tags: ['certificates'], params: Type.Object({ id: Type.Integer({ minimum: 1 }) }) } }, async (req, reply) => {
    const id = (req.params as { id: number }).id;
    const r = await db.deleteFrom('ca_certs').where('id', '=', id).executeTakeFirst();
    if (!Number(r.numDeletedRows)) return reply.code(404).send({ error: 'not_found' });
    await applyCaStore(ctx);
    await writeAudit(ctx, req.user, 'ca_cert.deleted', { type: 'ca_cert', id }, undefined, req.ip);
    return { ok: true };
  });
}
