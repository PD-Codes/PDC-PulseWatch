import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import YAML from 'yaml';
import { writeAudit } from '../auth/access';
import { config } from '../config';
import { KumaLoginError, kumaFromApi, kumaFromSqlite } from '../kuma-source';
import { convertKuma, describeImport, exportConfig, filterConfigDoc, importConfig, noteWarnings, type ConfigDoc, type ImportReport, type ImportSelection } from '../portability';

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

  app.post('/api/import/kuma', { ...admin, bodyLimit: 20 * 1024 * 1024, schema: { tags: ['config'], summary: 'Import an Uptime Kuma 1.x backup JSON (2.x: see /api/import/kuma-db and /api/import/kuma-api)', body: Type.Object({ content: Type.String({ maxLength: 20_000_000 }), dryRun: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const b = req.body as { content: string; dryRun?: boolean };
    let raw: unknown;
    try { raw = JSON.parse(b.content); } catch { return reply.code(400).send({ error: 'validation', message: 'The file is not valid JSON' }); }
    const { doc, warnings } = convertKuma(raw);
    const report = await importConfig(ctx, doc, req.user!.id, !!b.dryRun);
    report.warnings.unshift(...warnings, ...noteWarnings(doc));
    if (!b.dryRun) await writeAudit(ctx, req.user, 'config.kuma_imported', { type: 'config' }, { counts: report.counts, errors: report.errors.length }, req.ip);
    return report;
  });
  /* Kuma 2.x: both sources convert to a document, keep it for a few minutes and let the admin apply exactly that preview (optionally only a selection). */
  const previews = new Map<string, { doc: ConfigDoc; userId: number; expires: number }>();
  const preview = async (raw: Parameters<typeof convertKuma>[0], userId: number, extraWarnings: string[] = []) => {
    const { doc, warnings } = convertKuma(raw);
    const report = await importConfig(ctx, doc, userId, true);
    report.warnings.unshift(...extraWarnings, ...warnings);
    for (const [k, v] of previews) if (v.expires < Date.now()) previews.delete(k);
    if (previews.size >= 5) previews.delete(previews.keys().next().value!); // shortcut: in-memory and per process, a restart or another instance forgets the preview and the admin simply repeats it
    const previewId = randomUUID();
    previews.set(previewId, { doc, userId, expires: Date.now() + 15 * 60_000 });
    return { ...report, previewId, items: await describeImport(ctx, doc) };
  };

  // The apply step runs in the background so a big instance does not hit a request timeout, and reports its progress for polling.
  interface ImportJob { state: 'running' | 'done' | 'error'; phase: string; done: number; total: number; userId: number; report?: ImportReport; error?: string; expires: number }
  const jobs = new Map<string, ImportJob>();
  const selectionSchema = Type.Object({ groups: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50_000 })), tags: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50_000 })), channels: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50_000 })), monitors: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50_000 })), maintenance: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50_000 })), statusPages: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50_000 })) });

  const tmpDir = path.join(config.dataDir, 'import-tmp');
  const MAX_DB = 4 * 1024 ** 3;
  // leftovers of an interrupted upload
  try { for (const f of fs.readdirSync(tmpDir)) if (fs.statSync(path.join(tmpDir, f)).mtimeMs < Date.now() - 3_600_000) fs.rmSync(path.join(tmpDir, f), { force: true }); } catch { /* no upload dir yet */ }

  // The raw-body parser lives in its own plugin: it must only exist for this admin-only route, and the admin check runs before a single byte is stored.
  await app.register(async (up) => {
    up.addHook('onRequest', async (req, reply) => {
      await admin.preHandler(req, reply);
      if (reply.sent) return;
      if (Number(req.headers['content-length'] ?? 0) > MAX_DB) return reply.code(413).send({ error: 'too_large', message: 'The file is too large' });
    });
    // The database is streamed to disk (it can be gigabytes of heartbeats) and opened read-only.
    up.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
      fs.mkdirSync(tmpDir, { recursive: true });
      const file = path.join(tmpDir, `kuma-${randomUUID()}.db`);
      let size = 0;
      payload.on('data', (c: Buffer) => { size += c.length; if (size > MAX_DB) payload.destroy(new Error('The file is too large')); });
      pipeline(payload, fs.createWriteStream(file)).then(() => done(null, file), (e) => { fs.rm(file, { force: true }, () => {}); done(e); });
    });
    // whatever happens after the upload (CSRF refusal, bad file), the file does not stay
    up.addHook('onResponse', async (req) => { if (typeof req.body === 'string') fs.rm(req.body, { force: true }, () => {}); });

    up.post('/api/import/kuma-db', { bodyLimit: MAX_DB, config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags: ['config'], summary: 'Preview an import from an Uptime Kuma 1.x/2.x SQLite file (raw body)' } }, async (req, reply) => {
      const file = req.body as string;
      try { return await preview(await kumaFromSqlite(file), req.user!.id); }
      catch (e) { return reply.code(400).send({ error: 'validation', message: `Could not read the database: ${(e as Error).message}` }); }
      finally { fs.rm(file, { force: true }, () => {}); }
    });
  });

  app.post('/api/import/kuma-api', {
    ...admin, config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['config'], summary: 'Preview an import from a running Uptime Kuma (Socket.IO login)', body: Type.Object({ url: Type.String({ maxLength: 2000 }), username: Type.String({ minLength: 1, maxLength: 200 }), password: Type.String({ minLength: 1, maxLength: 500 }), token: Type.Optional(Type.String({ maxLength: 20 })) }) },
  }, async (req, reply) => {
    try { const { fetchWarnings, ...raw } = await kumaFromApi(req.body as any, ctx.guard); return await preview(raw, req.user!.id, fetchWarnings); }
    catch (e) {
      if (e instanceof KumaLoginError) return reply.code(e.tokenRequired ? 401 : 400).send({ error: e.tokenRequired ? 'token_required' : 'validation', message: e.message });
      return reply.code(400).send({ error: 'validation', message: (e as Error).message });
    }
  });

  app.post('/api/import/kuma-apply', { ...admin, schema: { tags: ['config'], summary: 'Start applying a previously previewed Kuma import in the background; poll /api/import/jobs/{id}', body: Type.Object({ previewId: Type.String({ maxLength: 64 }), selection: Type.Optional(selectionSchema) }) } }, async (req, reply) => {
    const b = req.body as { previewId: string; selection?: ImportSelection };
    const p = previews.get(b.previewId);
    if (!p || p.userId !== req.user!.id || p.expires < Date.now()) return reply.code(404).send({ error: 'not_found', message: 'The preview expired. Run it again.' });
    if ([...jobs.values()].some((j) => j.state === 'running')) return reply.code(409).send({ error: 'busy', message: 'Another import is still running.' });
    previews.delete(b.previewId);
    for (const [k, v] of jobs) if (v.expires < Date.now()) jobs.delete(k);
    const doc = b.selection ? filterConfigDoc(p.doc, b.selection) : p.doc;
    const jobId = randomUUID();
    const job: ImportJob = { state: 'running', phase: 'starting', done: 0, total: 0, userId: req.user!.id, expires: Number.MAX_SAFE_INTEGER };
    jobs.set(jobId, job);
    const { user, ip } = { user: req.user, ip: req.ip };
    void (async () => {
      try {
        job.report = await importConfig(ctx, doc, job.userId, false, (pr) => Object.assign(job, pr));
        await writeAudit(ctx, user, 'config.kuma_imported', { type: 'config' }, { counts: job.report.counts, errors: job.report.errors.length }, ip);
        job.state = 'done';
      } catch (e) { job.state = 'error'; job.error = (e as Error).message; app.log.error({ err: e }, 'kuma import failed'); }
      finally { job.expires = Date.now() + 30 * 60_000; }
    })();
    return { jobId };
  });

  app.get('/api/import/jobs/:id', { ...admin, schema: { tags: ['config'], summary: 'Progress and result of a background import', params: Type.Object({ id: Type.String({ maxLength: 64 }) }) } }, async (req, reply) => {
    const j = jobs.get((req.params as { id: string }).id);
    if (!j || j.userId !== req.user!.id) return reply.code(404).send({ error: 'not_found', message: 'Unknown import job' });
    const { userId: _u, expires: _e, ...out } = j;
    return out;
  });
}
