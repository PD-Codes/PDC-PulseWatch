import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import YAML from 'yaml';
import { writeAudit } from '../auth/access';
import { convertKuma, exportConfig, importConfig, type ConfigDoc } from '../portability';

export async function configRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const admin = { preHandler: app.requireRole('admin') };

  app.get('/api/config/export', { ...admin, schema: { tags: ['config'], summary: 'Export the configuration as YAML or JSON', querystring: Type.Object({ format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('yaml')])), secrets: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const q = req.query as { format?: 'json' | 'yaml'; secrets?: boolean };
    const doc = await exportConfig(ctx, !!q.secrets);
    await writeAudit(ctx, req.user, q.secrets ? 'config.exported_with_secrets' : 'config.exported', { type: 'config' }, undefined, req.ip);
    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === 'yaml') return reply.type('application/yaml').header('Content-Disposition', `attachment; filename="pulsewatch-config-${stamp}.yaml"`).send(YAML.stringify(doc));
    return reply.type('application/json').header('Content-Disposition', `attachment; filename="pulsewatch-config-${stamp}.json"`).send(JSON.stringify(doc, null, 2));
  });

  app.post('/api/config/import', { ...admin, bodyLimit: 20 * 1024 * 1024, schema: { tags: ['config'], summary: 'Import (merge by name) a YAML or JSON configuration document', body: Type.Object({ content: Type.String({ maxLength: 20_000_000 }), dryRun: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const b = req.body as { content: string; dryRun?: boolean };
    let doc: ConfigDoc;
    try { doc = YAML.parse(b.content, { maxAliasCount: 50 }); } catch (e) { return reply.code(400).send({ error: 'validation', message: `Could not parse the document: ${(e as Error).message}` }); }
    const report = await importConfig(ctx, doc, req.user!.id, !!b.dryRun);
    if (!b.dryRun) await writeAudit(ctx, req.user, 'config.imported', { type: 'config' }, { counts: report.counts, errors: report.errors.length }, req.ip);
    return report;
  });

  app.post('/api/import/kuma', { ...admin, bodyLimit: 20 * 1024 * 1024, schema: { tags: ['config'], summary: 'Import an Uptime Kuma 1.x backup JSON', body: Type.Object({ content: Type.String({ maxLength: 20_000_000 }), dryRun: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const b = req.body as { content: string; dryRun?: boolean };
    let raw: unknown;
    try { raw = JSON.parse(b.content); } catch { return reply.code(400).send({ error: 'validation', message: 'The file is not valid JSON' }); }
    const { doc, warnings } = convertKuma(raw);
    const report = await importConfig(ctx, doc, req.user!.id, !!b.dryRun);
    report.warnings.unshift(...warnings);
    if (!b.dryRun) await writeAudit(ctx, req.user, 'config.kuma_imported', { type: 'config' }, { counts: report.counts, errors: report.errors.length }, req.ip);
    return report;
  });
}
