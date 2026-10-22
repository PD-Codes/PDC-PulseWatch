import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpRequest } from '../../core/http';
import { timeoutSignal } from '../../core/util';
import { writeAudit } from '../auth/access';
import { config } from '../config';
import type { Ctx } from '../context';
import { decrypt, encrypt, hashPassword, hmac, randomToken, safeEqual, sha256, verifyPassword } from '../crypto';
import { bool, parseJson } from '../db';
import { mailConfigured, sendSystemMail } from '../mail';
import { publicInfo, type ServerInfo } from '../monitors/info';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const Slug = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 64 }) });
const esc = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const DAY = 86_400_000;

/** Texts the server itself sends (mails, feed, confirmation pages) in the language of the status page; pages without a fixed language use English. */
const SRV = {
  en: {
    incident: 'Incident: {t}', resolved: 'Resolved: {t}', update: 'Update ({p}): {t}', investigating: '{t}. We are investigating.', hasResolved: '{t} has been resolved.', phaseLine: '{t}: {p}.',
    page: 'Status page', unsub: 'Unsubscribe', ongoing: 'Ongoing', done: 'Resolved', confirmSubject: 'Confirm your subscription to {t}',
    confirmBody: 'Confirm to receive status updates for {t}:\n{l}\n\nIf you did not request this, ignore this message.',
    ok: ['Subscription confirmed', 'You will receive status updates by email.'], bad: ['Link invalid', 'This confirmation link is invalid or expired.'], gone: ['Unsubscribed', 'You will no longer receive status updates.'],
    phases: { identified: 'Identified', fixing: 'Fix in progress', monitoring: 'Monitoring' } as Record<string, string>, down: '{n} is down',
  },
  de: {
    incident: 'Störung: {t}', resolved: 'Behoben: {t}', update: 'Update ({p}): {t}', investigating: '{t}. Wir untersuchen die Ursache.', hasResolved: '{t} wurde behoben.', phaseLine: '{t}: {p}.',
    page: 'Statusseite', unsub: 'Abbestellen', ongoing: 'Laufend', done: 'Behoben', confirmSubject: 'Bestätige dein Abonnement von {t}',
    confirmBody: 'Bestätige, um Status-Updates für {t} zu erhalten:\n{l}\n\nWenn du das nicht angefordert hast, ignoriere diese Nachricht.',
    ok: ['Abonnement bestätigt', 'Du erhältst Status-Updates per E-Mail.'], bad: ['Link ungültig', 'Dieser Bestätigungslink ist ungültig oder abgelaufen.'], gone: ['Abbestellt', 'Du erhältst keine Status-Updates mehr.'],
    phases: { identified: 'Ursache gefunden', fixing: 'Wird behoben', monitoring: 'Wird beobachtet' } as Record<string, string>, down: '{n} ist nicht erreichbar',
  },
};
const srv = (lang: string | null | undefined) => (lang === 'de' ? SRV.de : SRV.en);
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w)\}/g, (_, k) => v[k] ?? '');
export const PAGE_LANGUAGES = ['en', 'de'] as const;
export const HISTORY_DAYS = [14, 30, 60, 90, 120, 150, 180] as const;

type Page = { id: number; slug: string; title: string; description: string | null; language: string | null; domain: string | null; is_public: number; password_hash: string | null; sso_required: number; branding: string | null; custom_css: string | null; show_history: number; history_days: number; is_default: number; incident_days: number; incident_page_size: number; server_info: number };
const unlockCookie = (p: Page) => `pw_sp_${p.id}`;
const unlockValue = (p: Page) => hmac(`status-unlock:${p.id}:${p.password_hash}`);

/** Component status shown publicly. */
function publicStatus(state: { status: string; overlay: string } | undefined): 'operational' | 'outage' | 'degraded' | 'maintenance' | 'unknown' {
  if (!state) return 'unknown';
  if (state.overlay === 'maintenance') return 'maintenance';
  if (state.overlay === 'suppressed') return 'degraded';
  return ({ up: 'operational', down: 'outage', pending: 'degraded', unknown: 'unknown' } as const)[state.status as 'up'] ?? 'unknown';
}

export async function statusPageRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const admin = { preHandler: app.requireRole('admin') };

  /* ------------------------------- admin API ------------------------------- */
  const compBody = Type.Object({ monitorId: Type.Integer(), displayName: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])) });
  const pageBody = Type.Object({
    slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$' }), title: Type.String({ minLength: 1, maxLength: 255 }), description: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String({ pattern: '^[a-z0-9.-]{3,255}$' }), Type.Null()])),
    isPublic: Type.Boolean(), password: Type.Optional(Type.Union([Type.String({ minLength: 4, maxLength: 200 }), Type.Null()])), ssoRequired: Type.Optional(Type.Boolean()),
    branding: Type.Optional(Type.Object({ logoUrl: Type.Optional(Type.String({ maxLength: 2000 })), primaryColor: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })), footer: Type.Optional(Type.String({ maxLength: 500 })) })),
    customCss: Type.Optional(Type.Union([Type.String({ maxLength: 50_000 }), Type.Null()])), showHistory: Type.Optional(Type.Boolean()), historyDays: Type.Optional(Type.Union(HISTORY_DAYS.map((d) => Type.Literal(d)))), isDefault: Type.Optional(Type.Boolean()),
    incidentDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })), incidentPageSize: Type.Optional(Type.Integer({ minimum: 5, maximum: 50 })),
    language: Type.Optional(Type.Union([Type.Literal('en'), Type.Literal('de'), Type.Null()])), serverInfo: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
    sections: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), components: Type.Array(compBody) }), { maxItems: 50 }),
    components: Type.Optional(Type.Array(compBody)),
  });

  const loadFull = async (id: number) => {
    const p = await db.selectFrom('status_pages').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) return null;
    const sections = await db.selectFrom('status_page_sections').selectAll().where('page_id', '=', id).orderBy('sort').execute();
    const comps = await db.selectFrom('status_page_components').selectAll().where('page_id', '=', id).orderBy('sort').execute();
    const map = (c: typeof comps[number]) => ({ monitorId: c.monitor_id, displayName: c.display_name });
    return {
      id: p.id, slug: p.slug, title: p.title, description: p.description, domain: p.domain, isPublic: bool(p.is_public), hasPassword: !!p.password_hash, ssoRequired: bool(p.sso_required),
      branding: parseJson(p.branding, {}), customCss: p.custom_css, showHistory: bool(p.show_history), historyDays: p.history_days, isDefault: bool(p.is_default), incidentDays: p.incident_days, incidentPageSize: p.incident_page_size, language: p.language, serverInfo: p.server_info,
      sections: sections.map((s) => ({ id: s.id, name: s.name, components: comps.filter((c) => c.section_id === s.id).map(map) })), components: comps.filter((c) => !c.section_id).map(map),
    };
  };

  /** Page ids the user may see in the admin list. */
  const visibleIds = async (user: NonNullable<FastifyRequest['user']>) => {
    if (user.role === 'admin' || !user.scopeRestricted) return null;
    return (await db.selectFrom('permission_grants').select('resource_id').where('user_id', '=', user.id).where('resource_type', '=', 'status_page').execute()).map((g) => g.resource_id);
  };

  app.get('/api/status-pages', { preHandler: app.requireAuth, schema: { tags: ['status-pages'] } }, async (req) => {
    let q = db.selectFrom('status_pages').select(['id', 'slug', 'title', 'domain', 'is_public', 'password_hash', 'sso_required', 'is_default']).orderBy('title');
    const ids = await visibleIds(req.user!);
    if (ids) q = q.where('id', 'in', ids.length ? ids : [0]);
    return (await q.execute()).map((p) => ({ id: p.id, slug: p.slug, title: p.title, domain: p.domain, isPublic: bool(p.is_public), protected: !!p.password_hash || bool(p.sso_required), isDefault: bool(p.is_default) }));
  });

  app.get('/api/status-pages/:id', { ...admin, schema: { tags: ['status-pages'], params: Id } }, async (req, reply) => (await loadFull((req.params as any).id)) ?? reply.code(404).send({ error: 'not_found' }));

  const save = async (req: FastifyRequest, reply: FastifyReply, id?: number) => {
    const b = req.body as any;
    const monitorIds = [...b.sections.flatMap((s: any) => s.components), ...(b.components ?? [])].map((c: any) => c.monitorId);
    if (new Set(monitorIds).size !== monitorIds.length) return reply.code(400).send({ error: 'validation', message: 'A monitor can appear only once per status page' });
    if (monitorIds.length) {
      const found = new Set((await db.selectFrom('monitors').select('id').where('id', 'in', monitorIds).execute()).map((m) => m.id));
      const missing = monitorIds.filter((m: number) => !found.has(m));
      if (missing.length) return reply.code(400).send({ error: 'validation', message: `Unknown monitor id(s): ${missing.join(', ')}` });
    }
    const values: Record<string, unknown> = {
      slug: b.slug, title: b.title, description: b.description ?? null, domain: b.domain ? String(b.domain).toLowerCase() : null, is_public: b.isPublic ? 1 : 0, sso_required: b.ssoRequired ? 1 : 0,
      branding: JSON.stringify(b.branding ?? {}), custom_css: b.customCss ?? null, show_history: b.showHistory === false ? 0 : 1, history_days: b.historyDays ?? 90,
    };
    if (b.incidentDays !== undefined) values.incident_days = b.incidentDays;
    if (b.incidentPageSize !== undefined) values.incident_page_size = b.incidentPageSize;
    if (b.language !== undefined) values.language = b.language;
    if (b.serverInfo !== undefined) values.server_info = b.serverInfo;
    if (b.isDefault !== undefined) values.is_default = b.isDefault ? 1 : 0;
    if (b.password === null) values.password_hash = null; else if (typeof b.password === 'string') values.password_hash = await hashPassword(b.password);
    try {
      await db.transaction().execute(async (trx) => {
        if (id) await trx.updateTable('status_pages').set(values as any).where('id', '=', id).execute();
        else id = Number((await trx.insertInto('status_pages').values(values as any).executeTakeFirstOrThrow()).insertId);
        if (values.is_default === 1) await trx.updateTable('status_pages').set({ is_default: 0 }).where('id', '!=', id!).execute(); // only one home page
        await trx.deleteFrom('status_page_components').where('page_id', '=', id!).execute();
        await trx.deleteFrom('status_page_sections').where('page_id', '=', id!).execute();
        let sort = 0;
        for (const [i, s] of (b.sections as any[]).entries()) {
          const sid = Number((await trx.insertInto('status_page_sections').values({ page_id: id!, name: s.name, sort: i }).executeTakeFirstOrThrow()).insertId);
          for (const c of s.components) await trx.insertInto('status_page_components').values({ page_id: id!, section_id: sid, monitor_id: c.monitorId, display_name: c.displayName ?? null, sort: sort++ }).execute();
        }
        for (const c of b.components ?? []) await trx.insertInto('status_page_components').values({ page_id: id!, section_id: null, monitor_id: c.monitorId, display_name: c.displayName ?? null, sort: sort++ }).execute();
      });
    } catch (e: any) { if (e.code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'conflict', message: 'Slug or domain is already used by another status page' }); throw e; }
    await writeAudit(ctx, req.user, 'status_page.saved', { type: 'status_page', id }, { slug: b.slug }, req.ip);
    return loadFull(id!);
  };
  app.post('/api/status-pages', { ...admin, schema: { tags: ['status-pages'], body: pageBody } }, (req, reply) => save(req, reply));
  app.put('/api/status-pages/:id', { ...admin, schema: { tags: ['status-pages'], params: Id, body: pageBody } }, (req, reply) => save(req, reply, (req.params as any).id));
  app.put('/api/status-pages/:id/default', { ...admin, schema: { tags: ['status-pages'], summary: 'Use this page as the home page (or stop doing so)', params: Id, body: Type.Object({ isDefault: Type.Boolean() }) } }, async (req, reply) => {
    const id = (req.params as any).id; const on = (req.body as any).isDefault;
    if (!(await db.selectFrom('status_pages').select('id').where('id', '=', id).executeTakeFirst())) return reply.code(404).send({ error: 'not_found' });
    await db.transaction().execute(async (trx) => {
      if (on) await trx.updateTable('status_pages').set({ is_default: 0 }).execute();
      await trx.updateTable('status_pages').set({ is_default: on ? 1 : 0 }).where('id', '=', id).execute();
    });
    await writeAudit(ctx, req.user, on ? 'status_page.default_set' : 'status_page.default_cleared', { type: 'status_page', id }, undefined, req.ip);
    return { ok: true };
  });
  app.delete('/api/status-pages/:id', { ...admin, schema: { tags: ['status-pages'], params: Id } }, async (req) => {
    await db.deleteFrom('status_pages').where('id', '=', (req.params as any).id).execute();
    await writeAudit(ctx, req.user, 'status_page.deleted', { type: 'status_page', id: (req.params as any).id }, undefined, req.ip);
    return { ok: true };
  });

  /* announcements */
  app.get('/api/status-pages/:id/announcements', { ...admin, schema: { tags: ['status-pages'], params: Id } }, async (req) =>
    (await db.selectFrom('status_page_announcements').selectAll().where('page_id', '=', (req.params as any).id).orderBy('starts_at', 'desc').limit(100).execute()).map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, startsAt: a.starts_at, endsAt: a.ends_at })));
  app.post('/api/status-pages/:id/announcements', { ...admin, schema: { tags: ['status-pages'], params: Id, body: Type.Object({ kind: Type.Union([Type.Literal('info'), Type.Literal('maintenance'), Type.Literal('incident')]), title: Type.String({ minLength: 1, maxLength: 255 }), body: Type.Optional(Type.String({ maxLength: 5000 })), startsAt: Type.Optional(Type.String({ format: 'date-time' })), endsAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])), notify: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const b = req.body as any; const pageId = (req.params as any).id;
    if (!(await db.selectFrom('status_pages').select('id').where('id', '=', pageId).executeTakeFirst())) return reply.code(404).send({ error: 'not_found' });
    const r = await db.insertInto('status_page_announcements').values({ page_id: pageId, kind: b.kind, title: b.title, body: b.body ?? null, starts_at: b.startsAt ? new Date(b.startsAt) : new Date(), ends_at: b.endsAt ? new Date(b.endsAt) : null }).executeTakeFirstOrThrow();
    if (b.notify) void notifySubscribers(ctx, pageId, `[${b.kind}] ${b.title}`, b.body ?? b.title).catch((err) => ctx.log.warn({ err }, 'announcement notification failed'));
    return { id: Number(r.insertId) };
  });
  app.delete('/api/status-pages/:id/announcements/:aid', { ...admin, schema: { tags: ['status-pages'], params: Type.Object({ id: Type.Integer(), aid: Type.Integer() }) } }, async (req) => {
    await db.deleteFrom('status_page_announcements').where('id', '=', (req.params as any).aid).where('page_id', '=', (req.params as any).id).execute();
    return { ok: true };
  });

  /* subscribers (webhook subscriptions are admin-only so the server never calls arbitrary URLs on behalf of the public) */
  app.get('/api/status-pages/:id/subscribers', { ...admin, schema: { tags: ['status-pages'], params: Id } }, async (req) =>
    (await db.selectFrom('status_page_subscribers').selectAll().where('page_id', '=', (req.params as any).id).orderBy('id', 'desc').limit(1000).execute()).map((s) => {
      const t = safeDecrypt(s.target_enc);
      return { id: s.id, kind: s.kind, target: s.kind === 'email' ? t : t.replace(/^(https?:\/\/[^/]+).*/, '$1/…'), verified: bool(s.verified), createdAt: s.created_at };
    }));
  app.post('/api/status-pages/:id/subscribers', { ...admin, schema: { tags: ['status-pages'], params: Id, body: Type.Object({ kind: Type.Union([Type.Literal('email'), Type.Literal('webhook')]), target: Type.String({ minLength: 3, maxLength: 1000 }) }) } }, async (req, reply) => {
    const b = req.body as { kind: 'email' | 'webhook'; target: string };
    if (b.kind === 'webhook' && !/^https?:\/\//i.test(b.target)) return reply.code(400).send({ error: 'validation', message: 'Webhook target must be an http(s) URL' });
    const id = await addSubscriber((req.params as any).id, b.kind, b.target, true);
    return id ? { id } : reply.code(409).send({ error: 'conflict', message: 'Already subscribed' });
  });
  app.delete('/api/status-pages/:id/subscribers/:sid', { ...admin, schema: { tags: ['status-pages'], params: Type.Object({ id: Type.Integer(), sid: Type.Integer() }) } }, async (req) => {
    await db.deleteFrom('status_page_subscribers').where('id', '=', (req.params as any).sid).where('page_id', '=', (req.params as any).id).execute();
    return { ok: true };
  });

  async function addSubscriber(pageId: number, kind: 'email' | 'webhook', target: string, verified: boolean): Promise<{ token: string; id: number } | null> {
    const hash = sha256(`${kind}:${target.trim().toLowerCase()}`);
    const token = randomToken(16).slice(0, 32);
    try {
      const r = await db.insertInto('status_page_subscribers').values({ page_id: pageId, kind, target_enc: encrypt(target.trim()), target_hash: hash, token, verified: verified ? 1 : 0 }).executeTakeFirstOrThrow();
      return { token, id: Number(r.insertId) };
    } catch (e: any) { if (e.code === 'ER_DUP_ENTRY') return null; throw e; }
  }

  /* ------------------------------- public API ------------------------------- */
  const findPage = (slug: string, host?: string) => {
    const q = db.selectFrom('status_pages').selectAll();
    return (slug === '_host' ? q.where('domain', '=', (host ?? '').toLowerCase().replace(/:\d+$/, '')) : q.where('slug', '=', slug)).executeTakeFirst() as Promise<Page | undefined>;
  };

  /** Returns null when access is granted, otherwise the reason. */
  const accessDenied = async (req: FastifyRequest, p: Page): Promise<null | 'login_required' | 'password_required' | 'forbidden'> => {
    const u = req.user;
    if (u) {
      if (u.role === 'admin' || !u.scopeRestricted) return null;
      const g = await db.selectFrom('permission_grants').select('id').where('user_id', '=', u.id).where('resource_type', '=', 'status_page').where('resource_id', '=', p.id).executeTakeFirst();
      if (g || (bool(p.is_public) && !p.password_hash && !bool(p.sso_required))) return null;
      return 'forbidden';
    }
    if (bool(p.sso_required)) return 'login_required';
    if (p.password_hash) { const c = req.cookies[unlockCookie(p)]; return c && safeEqual(c, unlockValue(p)) ? null : 'password_required'; }
    return bool(p.is_public) ? null : 'login_required';
  };
  const gate = async (req: FastifyRequest, reply: FastifyReply, slug: string, open = false) => {
    const p = await findPage(slug, req.headers.host);
    if (!p) { reply.code(404).send({ error: 'not_found', message: 'Status page not found' }); return null; }
    const denied = await accessDenied(req, p);
    // feeds and badges cannot authenticate, so they exist for fully open pages only
    if (denied || (open && (!bool(p.is_public) || p.password_hash || bool(p.sso_required)))) { reply.code(denied === 'password_required' ? 401 : denied === 'forbidden' ? 403 : denied ? 401 : 404).send({ error: denied ?? 'not_found', title: denied ? p.title : undefined, language: denied ? p.language : undefined }); return null; }
    return p;
  };
  const pub = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get('/api/public/host-page', { ...pub, schema: { hide: true } }, async (req) => {
    const p = await findPage('_host', req.headers.host);
    return { slug: p?.slug ?? null };
  });

  /** Home page: the status page marked as default replaces the dashboard at "/" (the admin UI stays at /dashboard and /admin). */
  app.get('/api/public/default-page', { ...pub, schema: { hide: true } }, async () => ({ slug: (await db.selectFrom('status_pages').select('slug').where('is_default', '=', 1).where('is_public', '=', 1).executeTakeFirst())?.slug ?? null }));

  app.post('/api/public/status/:slug/unlock', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['public'], params: Slug, body: Type.Object({ password: Type.String({ maxLength: 200 }) }) } }, async (req, reply) => {
    const p = await findPage((req.params as any).slug, req.headers.host);
    if (!p?.password_hash || !(await verifyPassword((req.body as any).password, p.password_hash))) return reply.code(401).send({ error: 'invalid_password', message: 'Wrong password' });
    reply.setCookie(unlockCookie(p), unlockValue(p), { httpOnly: true, sameSite: 'lax', secure: config.session.cookieSecure, path: '/', maxAge: 7 * 86400 });
    return { ok: true };
  });

  /** Daily uptime for the last N days from day rollups (today from hourly). */
  async function dailyUptime(monitorIds: number[], days: number) {
    const since = new Date(Math.floor(Date.now() / DAY) * DAY - (days - 1) * DAY);
    const rows = monitorIds.length ? await db.selectFrom('rollups').select(['monitor_id', 'bucket', 'up_n', 'down_n']).where('monitor_id', 'in', monitorIds).where('res', '=', 'hour').where('bucket', '>=', since).execute() : [];
    const by = new Map<number, Map<string, { up: number; down: number }>>();
    for (const r of rows) {
      const m = by.get(r.monitor_id) ?? by.set(r.monitor_id, new Map()).get(r.monitor_id)!;
      const k = r.bucket.toISOString().slice(0, 10);
      const d = m.get(k) ?? { up: 0, down: 0 };
      d.up += r.up_n; d.down += r.down_n; m.set(k, d);
    }
    return { since, by };
  }

  async function buildPage(p: Page) {
    const sections = await db.selectFrom('status_page_sections').selectAll().where('page_id', '=', p.id).orderBy('sort').execute();
    const comps = await db.selectFrom('status_page_components as c').innerJoin('monitors as m', 'm.id', 'c.monitor_id').leftJoin('monitor_state as s', 's.monitor_id', 'c.monitor_id')
      .select(['c.section_id', 'c.display_name', 'c.monitor_id', 'm.name', 'm.description', 's.status', 's.overlay', 's.status_since', 's.info']).where('c.page_id', '=', p.id).orderBy('c.sort').execute();
    const ids = comps.map((c) => c.monitor_id);
    const history = bool(p.show_history);
    const { since, by } = history ? await dailyUptime(ids, p.history_days) : { since: new Date(), by: new Map() };
    const shape = (c: typeof comps[number]) => {
      const days = by.get(c.monitor_id) ?? new Map();
      let up = 0, down = 0;
      const daily: { date: string; uptime: number | null }[] = [];
      if (history) for (let i = 0; i < p.history_days; i++) {
        const k = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10); const d = days.get(k);
        if (d) { up += d.up; down += d.down; }
        daily.push({ date: k, uptime: d && d.up + d.down ? Math.round((d.up / (d.up + d.down)) * 10000) / 100 : null });
      }
      return { monitorId: c.monitor_id, name: c.display_name || c.name, description: c.description, status: publicStatus(c.status ? { status: c.status, overlay: c.overlay ?? 'none' } : undefined), since: c.status_since, info: publicInfo(parseJson<ServerInfo | null>(c.info, null), p.server_info), uptime: history && up + down ? Math.round((up / (up + down)) * 10000) / 100 : null, daily };
    };
    const now = new Date();
    const announcements = await db.selectFrom('status_page_announcements').select(['id', 'kind', 'title', 'body', 'starts_at', 'ends_at']).where('page_id', '=', p.id).where('starts_at', '<=', now).where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)])).orderBy('starts_at', 'desc').execute();
    const maint = ctx.maintenance.activeWindows().filter((w) => w.announce && ids.some((i) => w.monitorIds.has(i))).map((w) => ({ id: w.id, name: w.name, description: w.description, endsAt: w.endsAt }));
    const incidents = ids.length ? await listIncidents(ids, new Date(now.getTime() - p.incident_days * DAY), new Map(comps.map((c) => [c.monitor_id, c.display_name || c.name])), p.language) : [];
    const all = comps.map((c) => publicStatus(c.status ? { status: c.status, overlay: c.overlay ?? 'none' } : undefined));
    const overall = all.includes('outage') ? (all.every((s) => s === 'outage') ? 'outage' : 'partial') : all.some((s) => s === 'degraded') ? 'degraded' : all.includes('maintenance') ? 'maintenance' : 'operational';
    return {
      slug: p.slug, title: p.title, description: p.description, branding: parseJson(p.branding, {}), customCss: p.custom_css, showHistory: history, historyDays: p.history_days, incidentDays: p.incident_days, incidentPageSize: p.incident_page_size, language: p.language, overall, generatedAt: now,
      sections: sections.map((s) => ({ name: s.name, components: comps.filter((c) => c.section_id === s.id).map(shape) })), components: comps.filter((c) => !c.section_id).map(shape),
      announcements: announcements.map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, startsAt: a.starts_at, endsAt: a.ends_at })), maintenance: maint,
      incidents: incidents.filter((i) => !i.resolvedAt), recentIncidents: incidents.filter((i) => i.resolvedAt),
      subscribe: { email: mailConfigured() },
    };
  }

  /** Monitors on a page with the name the page shows for each. */
  async function pageMonitors(pageId: number) {
    const rows = await db.selectFrom('status_page_components as c').innerJoin('monitors as m', 'm.id', 'c.monitor_id').select(['c.monitor_id', 'c.display_name', 'm.name']).where('c.page_id', '=', pageId).execute();
    return { ids: rows.map((r) => r.monitor_id), names: new Map(rows.map((r) => [r.monitor_id, r.display_name || r.name] as [number, string])) };
  }

  /** Incidents touching these monitors that were marked for status pages, each with the timeline entries marked the same way. */
  async function listIncidents(monitorIds: number[], since: Date, names: Map<number, string>, lang?: string | null) {
    const rows = await db.selectFrom('incidents as i').innerJoin('incident_monitors as im', 'im.incident_id', 'i.id')
      .select(['i.id', 'i.title', 'i.status', 'i.severity', 'i.source', 'i.monitor_id', 'i.started_at', 'i.resolved_at', 'i.public']).distinct()
      .where('im.monitor_id', 'in', monitorIds).where('i.public', '=', 1).where((eb) => eb.or([eb('i.resolved_at', 'is', null), eb('i.resolved_at', '>=', since)])).orderBy('i.started_at', 'desc').limit(100).execute();
    const visible = rows;
    const updates = visible.length ? await db.selectFrom('incident_updates').select(['incident_id', 'ts', 'kind', 'status', 'body', 'user_id', 'edited_at']).where('incident_id', 'in', visible.map((r) => r.id)).where('public', '=', 1).orderBy('ts', 'desc').orderBy('id', 'desc').execute() : [];
    // an automatic incident is titled with the internal monitor name, the page shows the name chosen for it
    return visible.map((r) => ({ id: r.id, title: r.source === 'auto' && r.monitor_id && names.has(r.monitor_id) ? fill(srv(lang).down, { n: names.get(r.monitor_id)! }) : r.title, status: r.status, severity: r.severity, startedAt: r.started_at, resolvedAt: r.resolved_at, updates: updates.filter((u) => u.incident_id === r.id).map((u) => ({ ts: u.ts, kind: u.kind, status: u.status, body: u.user_id == null || u.kind === 'postmortem' ? null : u.body, edited: !!u.edited_at })) })); // system texts and the post-mortem line are English: the page words them itself
  }

  app.get('/api/public/status/:slug', { ...pub, schema: { tags: ['public'], params: Slug } }, async (req, reply) => {
    const p = await gate(req, reply, (req.params as any).slug);
    return p ? buildPage(p) : undefined;
  });

  app.get('/api/public/status/:slug/history', { ...pub, schema: { tags: ['public'], params: Slug, querystring: Type.Object({ days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })) }) } }, async (req, reply) => {
    const p = await gate(req, reply, (req.params as any).slug);
    if (!p) return;
    if (!bool(p.show_history)) return reply.code(404).send({ error: 'not_found' });
    const { ids, names } = await pageMonitors(p.id);
    return { incidents: ids.length ? await listIncidents(ids, new Date(Date.now() - ((req.query as any).days ?? p.history_days) * DAY), names, p.language) : [] };
  });

  app.get('/api/public/status/:slug/rss', { ...pub, schema: { tags: ['public'], params: Slug } }, async (req, reply) => {
    const p = await gate(req, reply, (req.params as any).slug, true);
    if (!p) return;
    const { ids, names } = await pageMonitors(p.id);
    const inc = ids.length ? await listIncidents(ids, new Date(Date.now() - p.incident_days * DAY), names, p.language) : [];
    const link = `${config.baseUrl}/status/${p.slug}`;
    const items = inc.map((i) => `<item><title>${esc(`[${i.resolvedAt ? srv(p.language).done : srv(p.language).ongoing}] ${i.title}`)}</title><link>${esc(link)}</link><guid isPermaLink="false">${esc(`${p.slug}-incident-${i.id}-${i.resolvedAt ? 'r' : 'o'}`)}</guid><pubDate>${new Date(i.resolvedAt ?? i.startedAt).toUTCString()}</pubDate><description>${esc(i.updates[0]?.body ?? i.title)}</description></item>`).join('');
    return reply.type('application/rss+xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(p.title)}</title><link>${esc(link)}</link><description>${esc(p.description ?? `${p.title} · ${srv(p.language).page}`)}</description>${items}</channel></rss>`);
  });

  const html = (title: string, msg: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(msg)}</p><p><a href="/">Back</a></p>`;

  app.post('/api/public/status/:slug/subscribe', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }, schema: { tags: ['public'], params: Slug, body: Type.Object({ email: Type.String({ format: 'email', maxLength: 254 }) }) } }, async (req, reply) => {
    const p = await gate(req, reply, (req.params as any).slug);
    if (!p) return;
    if (!mailConfigured()) return reply.code(400).send({ error: 'unavailable', message: 'Email subscriptions are not enabled on this server' });
    const email = (req.body as any).email as string;
    const sub = await addSubscriber(p.id, 'email', email, false);
    // identical answer for new and known addresses so the endpoint cannot be used to enumerate subscribers
    if (sub) {
      const link = `${config.baseUrl}/api/public/subscriptions/confirm?token=${sub.token}`;
      const L = srv(p.language);
      void sendSystemMail({ to: email, subject: fill(L.confirmSubject, { t: p.title }), text: fill(L.confirmBody, { t: p.title, l: link }) }).catch((e) => ctx.log.warn({ err: e }, 'subscription mail failed'));
    }
    return { ok: true };
  });
  /** Language of the page a subscription belongs to, for the confirmation pages. */
  const subscriberLanguage = async (token: string) => (await db.selectFrom('status_page_subscribers as s').innerJoin('status_pages as p', 'p.id', 's.page_id').select('p.language').where('s.token', '=', token).executeTakeFirst())?.language;
  app.get('/api/public/subscriptions/confirm', { ...pub, schema: { hide: true, querystring: Type.Object({ token: Type.String({ maxLength: 64 }) }) } }, async (req, reply) => {
    const token = (req.query as any).token as string;
    const L = srv(await subscriberLanguage(token));
    const r = await db.updateTable('status_page_subscribers').set({ verified: 1 }).where('token', '=', token).executeTakeFirst();
    return reply.type('text/html').send(Number(r.numUpdatedRows) || Number(r.numChangedRows) ? html(L.ok[0], L.ok[1]) : html(L.bad[0], L.bad[1]));
  });
  app.get('/api/public/subscriptions/unsubscribe', { ...pub, schema: { hide: true, querystring: Type.Object({ token: Type.String({ maxLength: 64 }) }) } }, async (req, reply) => {
    const token = (req.query as any).token as string;
    const L = srv(await subscriberLanguage(token));
    await db.deleteFrom('status_page_subscribers').where('token', '=', token).execute();
    return reply.type('text/html').send(html(L.gone[0], L.gone[1]));
  });
}

const safeDecrypt = (s: string) => { try { return decrypt(s); } catch { return ''; } };

/** Sends a message to all verified subscribers of one page (email and webhook). Failures are logged, not retried. */
export async function notifySubscribers(ctx: Ctx, pageId: number, subject: string, text: string): Promise<void> {
  const page = await ctx.db.selectFrom('status_pages').select(['slug', 'title', 'language']).where('id', '=', pageId).executeTakeFirst();
  if (!page) return;
  const subs = await ctx.db.selectFrom('status_page_subscribers').selectAll().where('page_id', '=', pageId).where('verified', '=', 1).execute();
  for (const s of subs) {
    const target = safeDecrypt(s.target_enc);
    if (!target) continue;
    try {
      if (s.kind === 'email') {
        if (!mailConfigured()) continue;
        const unsub = `${config.baseUrl}/api/public/subscriptions/unsubscribe?token=${s.token}`;
        await sendSystemMail({ to: target, subject: `[${page.title}] ${subject}`, text: `${text}\n\n${srv(page.language).page}: ${config.baseUrl}/status/${page.slug}\n${srv(page.language).unsub}: ${unsub}` });
      } else {
        const res = await httpRequest({ url: target, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: page.slug, subject, text, url: `${config.baseUrl}/status/${page.slug}`, time: new Date().toISOString() }), signal: timeoutSignal(10_000), guard: ctx.guard, followRedirects: false, maxBodyBytes: 16 * 1024 });
        if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) { ctx.log.warn({ err: e, subscriber: s.id }, 'status subscriber delivery failed'); }
  }
}

const PHASES = SRV.en.phases;

/** Notifies subscribers when an incident that is shown on status pages opens, moves to a new phase or resolves. */
export function startSubscriberNotifications(ctx: Ctx): () => void {
  return ctx.bus.subscribe((e) => {
    if (e.type !== 'incident' || (e.status !== 'open' && e.status !== 'resolved' && !PHASES[e.status])) return;
    void (async () => {
      const inc = await ctx.db.selectFrom('incidents').select(['title', 'source', 'public', 'monitor_id']).where('id', '=', e.incidentId).executeTakeFirst();
      if (!inc || !bool(inc.public)) return;
      // the message the operator wrote for this phase, if it was marked for the status page
      const last = PHASES[e.status] ? await ctx.db.selectFrom('incident_updates').select('body').where('incident_id', '=', e.incidentId).where('status', '=', e.status as any).where('public', '=', 1).orderBy('id', 'desc').limit(1).executeTakeFirst() : undefined;
      // every page that shows any monitor of the incident, each told once, with the name that page uses (automatic titles carry the internal monitor name)
      const comps = await ctx.db.selectFrom('status_page_components as c').innerJoin('monitors as m', 'm.id', 'c.monitor_id').select(['c.page_id', 'c.monitor_id', 'c.display_name', 'm.name'])
        .where('c.monitor_id', 'in', ctx.db.selectFrom('incident_monitors').select('monitor_id').where('incident_id', '=', e.incidentId)).execute();
      const pageIds = [...new Set(comps.map((c) => c.page_id))];
      const langs = new Map((pageIds.length ? await ctx.db.selectFrom('status_pages').select(['id', 'language']).where('id', 'in', pageIds).execute() : []).map((r) => [r.id, r.language]));
      for (const pageId of pageIds) {
        const L = srv(langs.get(pageId));
        const own = comps.find((c) => c.page_id === pageId && c.monitor_id === inc.monitor_id);
        const title = inc.source === 'auto' && own ? fill(L.down, { n: own.display_name || own.name }) : inc.title;
        const phase = L.phases[e.status] ?? '';
        const subject = e.status === 'open' ? fill(L.incident, { t: title }) : e.status === 'resolved' ? fill(L.resolved, { t: title }) : fill(L.update, { p: phase, t: title });
        const body = e.status === 'open' ? fill(L.investigating, { t: title }) : e.status === 'resolved' ? fill(L.hasResolved, { t: title }) : `${fill(L.phaseLine, { t: title, p: phase })}${last?.body ? `\n\n${last.body}` : ''}`;
        await notifySubscribers(ctx, pageId, subject, body);
      }
    })().catch((err) => ctx.log.warn({ err }, 'subscriber notification failed'));
  });
}
