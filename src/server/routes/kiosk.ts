import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { inKioskScope, KIOSK_KEY_PREFIX, kioskConfigDiff, NAME_MAX, normalizeKioskConfig, SLUG_MAX, SLUG_RE, type KioskConfig } from '../../core/kiosk';
import { accessibleGroupIds, accessibleMonitorIds, writeAudit } from '../auth/access';
import { randomToken, sha256 } from '../crypto';
import { parseJson } from '../db';
import type { ServerInfo } from '../monitors/info';
import { listMonitors } from '../monitors/service';
import { THEME_IDS } from '../themes';
import { sseWriter } from './system';

const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const Slug = Type.String({ minLength: 1, maxLength: SLUG_MAX, pattern: SLUG_RE.source });
const Name = Type.String({ maxLength: NAME_MAX * 4 }); // trimmed and checked by hand, so surrounding blanks do not count
const Sort = Type.Integer({ minimum: -100_000, maximum: 100_000 });
const Config = Type.Object({}, { additionalProperties: true });
const HoursQuery = Type.Object({ hours: Type.Optional(Type.Integer({ minimum: 6, maximum: 48 })) });
const DEFAULT_KEY = 'kiosk.defaultPreset';
const MAX_KEYS = 50;
const HOUR = 3_600_000;
/** Kiosk screens poll from one place (often one address for many screens), so the limit is per route, like the badges. */
const pub = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
/** Open streams per key and per client address; more would only be a way to tie up the server. */
const STREAMS_PER_KEY = 10, STREAMS_PER_IP = 30;

export type HistoryCell = [number, number, number, number] | null;
export interface HistoryResponse { from: string; hours: number; bucketS: number; monitors: Record<string, HistoryCell[]> }

/** Never trust a stored or sent config beyond normalizing it; only the difference to the defaults is stored. */
const readConfig = (json: string): KioskConfig => normalizeKioskConfig(parseJson(json, {}), THEME_IDS);
const storeConfig = (raw: unknown): string => JSON.stringify(kioskConfigDiff(normalizeKioskConfig(raw, THEME_IDS)));
const SCOPE_KEYS = ['groups', 'monitors', 'tags'] as const;
/**
 * True when a scope list that was sent (or stored) loses entries on normalizing. Dropping them silently would widen the scope,
 * up to every monitor for a list that loses all of its entries.
 */
const scopeDropped = (raw: unknown): boolean => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  const norm = normalizeKioskConfig(r, THEME_IDS);
  return SCOPE_KEYS.some((k) => {
    const v = r[k];
    if (v === undefined || v === null) return false;
    if (!Array.isArray(v)) return true;
    return norm[k].length !== new Set(v).size;
  });
};
/** The stored config for key screens; `broken` (unreadable or a scope that would widen) means: show nothing. */
const readStored = (json: string): { cfg: KioskConfig; broken: boolean } => {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { cfg: normalizeKioskConfig({}, THEME_IDS), broken: true }; }
  const broken = !raw || typeof raw !== 'object' || Array.isArray(raw) || scopeDropped(raw);
  return { cfg: normalizeKioskConfig(raw, THEME_IDS), broken };
};
const trimName = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length >= 1 && s.length <= NAME_MAX ? s : null;
};
const infoOf = (i: ServerInfo | null): { players?: number; maxPlayers?: number } | null => {
  if (!i) return null;
  const out: { players?: number; maxPlayers?: number } = {};
  if (typeof i.players === 'number') out.players = i.players;
  if (typeof i.maxPlayers === 'number') out.maxPlayers = i.maxPlayers;
  return Object.keys(out).length ? out : null;
};

interface KeyRow { kid: number; last_used_at: Date | null; preset_id: number; slug: string; name: string; config: string; updated_at: Date }

export async function kioskRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: app.requireRole('admin') };
  // open kiosk streams never end on their own: close them on shutdown, so app.close() does not wait for them
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const end of [...streams]) end(); });

  const presetExists = async (id: number) => !!(await db.selectFrom('kiosk_presets').select('id').where('id', '=', id).executeTakeFirst());
  const slugTaken = async (slug: string, except?: number) => {
    let q = db.selectFrom('kiosk_presets').select('id').where('slug', '=', slug);
    if (except) q = q.where('id', '!=', except);
    return !!(await q.executeTakeFirst());
  };
  const taken = (reply: FastifyReply) => reply.code(409).send({ error: 'slug_taken', message: 'Another preset already uses this slug' });
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'Preset not found' });
  const badScope = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_scope', message: 'Groups and monitors must be lists of ids, tags a list of names' });

  // Changes that can alter what a screen shows bump the version; it is part of the cache keys below, so a screen that refetches
  // after an event never gets the state from before it.
  let dataVersion = 0;
  const unsubVersion = ctx.bus.subscribe((e) => { if (e.type !== 'monitor') dataVersion++; });
  app.addHook('onClose', async () => unsubVersion());

  /* ------------------------------- presets ------------------------------- */
  app.get('/api/kiosk/presets', { ...auth, schema: { tags: ['kiosk'], summary: 'Wall display presets' } }, async (req) => {
    const rows = await db.selectFrom('kiosk_presets').select(['id', 'slug', 'name', 'config', 'sort', 'updated_at']).orderBy('sort').orderBy('slug').execute();
    const isAdmin = req.user!.role === 'admin';
    const counts = new Map<number, number>();
    if (isAdmin) {
      const c = await db.selectFrom('kiosk_keys').select(['preset_id', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('preset_id').execute();
      for (const r of c) counts.set(r.preset_id, Number(r.n));
    }
    const def = await ctx.settings.get<number | null>(DEFAULT_KEY, null);
    let items = rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, config: readConfig(r.config), sort: r.sort, updatedAt: r.updated_at, ...(isAdmin ? { keys: counts.get(r.id) ?? 0 } : {}) }));
    // a restricted user does not learn the ids of groups and monitors outside their grants through someone else's preset
    const groups = await accessibleGroupIds(ctx, req.user!);
    if (groups) {
      const mons = new Set(await accessibleMonitorIds(ctx, req.user!) ?? []);
      items = items.filter((p) => p.config.groups.every((g) => groups.has(g)) && p.config.monitors.every((m) => mons.has(m)));
    }
    return { items, defaultId: items.some((r) => r.id === def) ? def : null };
  });

  app.post('/api/kiosk/presets', { ...admin, schema: { tags: ['kiosk'], body: Type.Object({ slug: Slug, name: Name, config: Config, sort: Type.Optional(Sort) }) } }, async (req, reply) => {
    const b = req.body as { slug: string; name: string; config: unknown; sort?: number };
    if (!SLUG_RE.test(b.slug)) return reply.code(400).send({ error: 'validation', message: 'Invalid slug' });
    const name = trimName(b.name);
    if (name === null) return reply.code(400).send({ error: 'validation', message: `Name is required (max ${NAME_MAX} characters)` });
    if (scopeDropped(b.config)) return badScope(reply);
    if (await slugTaken(b.slug)) return taken(reply);
    let id: number;
    try {
      id = Number((await db.insertInto('kiosk_presets').values({ slug: b.slug, name, config: storeConfig(b.config), sort: b.sort ?? 0, created_by: req.user!.id }).executeTakeFirstOrThrow()).insertId);
    } catch (e: any) { if (e?.code === 'ER_DUP_ENTRY') return taken(reply); throw e; }
    await writeAudit(ctx, req.user, 'kiosk.preset.created', { type: 'kiosk_preset', id }, { slug: b.slug, name }, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'kiosk_preset', id });
    return reply.code(201).send({ id });
  });

  app.patch('/api/kiosk/presets/:id', { ...admin, schema: { tags: ['kiosk'], params: Id, body: Type.Object({ slug: Type.Optional(Slug), name: Type.Optional(Name), config: Type.Optional(Config), sort: Type.Optional(Sort) }) } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const b = req.body as { slug?: string; name?: string; config?: unknown; sort?: number };
    const row = await db.selectFrom('kiosk_presets').select(['slug', 'name']).where('id', '=', id).executeTakeFirst();
    if (!row) return notFound(reply);
    const set: { slug?: string; name?: string; config?: string; sort?: number } = {};
    if (b.slug !== undefined) {
      if (!SLUG_RE.test(b.slug)) return reply.code(400).send({ error: 'validation', message: 'Invalid slug' });
      if (b.slug !== row.slug) {
        if (await slugTaken(b.slug, id)) return taken(reply);
        set.slug = b.slug;
      }
    }
    // a built-in preset keeps its empty (translated) name when a form sends it back unchanged
    if (b.name !== undefined && b.name.trim() !== row.name) {
      const name = trimName(b.name);
      if (name === null) return reply.code(400).send({ error: 'validation', message: `Name is required (max ${NAME_MAX} characters)` });
      set.name = name;
    }
    if (b.config !== undefined) {
      if (scopeDropped(b.config)) return badScope(reply);
      set.config = storeConfig(b.config);
    }
    if (b.sort !== undefined) set.sort = b.sort;
    if (Object.keys(set).length) {
      try { await db.updateTable('kiosk_presets').set(set).where('id', '=', id).execute(); } catch (e: any) { if (e?.code === 'ER_DUP_ENTRY') return taken(reply); throw e; }
      await writeAudit(ctx, req.user, 'kiosk.preset.updated', { type: 'kiosk_preset', id }, { slug: set.slug ?? row.slug, fields: Object.keys(set) }, req.ip);
      ctx.bus.publish({ type: 'config', entity: 'kiosk_preset', id });
    }
    return { ok: true };
  });

  app.delete('/api/kiosk/presets/:id', { ...admin, schema: { tags: ['kiosk'], params: Id } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const row = await db.selectFrom('kiosk_presets').select(['slug', 'name']).where('id', '=', id).executeTakeFirst();
    if (!row) return notFound(reply);
    await db.deleteFrom('kiosk_presets').where('id', '=', id).execute(); // its keys go with it (ON DELETE CASCADE)
    if ((await ctx.settings.get<number | null>(DEFAULT_KEY, null)) === id) await ctx.settings.delete(DEFAULT_KEY);
    await writeAudit(ctx, req.user, 'kiosk.preset.deleted', { type: 'kiosk_preset', id }, { slug: row.slug, name: row.name }, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'kiosk_preset', id });
    return { ok: true };
  });

  app.get('/api/settings/kiosk', { ...admin, schema: { tags: ['settings'], summary: 'Default wall display preset' } }, async () => {
    const def = await ctx.settings.get<number | null>(DEFAULT_KEY, null);
    return { defaultPreset: def !== null && (await presetExists(def)) ? def : null };
  });

  // a type list instead of a union: with coerceTypes a union would turn null into 0 on the way through the integer branch
  const DefaultBody = Type.Object({ defaultPreset: Type.Unsafe<number | null>({ type: ['integer', 'null'], minimum: 1 }) });
  app.put('/api/settings/kiosk', { ...admin, schema: { tags: ['settings'], body: DefaultBody } }, async (req, reply) => {
    const { defaultPreset } = req.body as { defaultPreset: number | null };
    if (defaultPreset !== null && !(await presetExists(defaultPreset))) return reply.code(400).send({ error: 'validation', message: 'Preset not found' });
    const before = await ctx.settings.get<number | null>(DEFAULT_KEY, null);
    if (defaultPreset === null) await ctx.settings.delete(DEFAULT_KEY); else await ctx.settings.set(DEFAULT_KEY, defaultPreset);
    await writeAudit(ctx, req.user, 'kiosk.default.changed', { type: 'settings' }, { from: before, to: defaultPreset }, req.ip);
    return { ok: true };
  });

  /* --------------------------------- keys -------------------------------- */
  app.get('/api/kiosk/presets/:id/keys', { ...admin, schema: { tags: ['kiosk'], params: Id } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    if (!(await presetExists(id))) return notFound(reply);
    const rows = await db.selectFrom('kiosk_keys as k').leftJoin('users as u', 'u.id', 'k.created_by')
      .select(['k.id', 'k.name', 'k.token_prefix', 'k.created_at', 'u.username', 'k.last_used_at', 'k.last_ip'])
      .where('k.preset_id', '=', id).orderBy('k.created_at', 'desc').orderBy('k.id', 'desc').execute();
    return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.token_prefix, createdAt: r.created_at, createdBy: r.username ?? null, lastUsedAt: r.last_used_at, lastIp: r.last_ip }));
  });

  app.post('/api/kiosk/presets/:id/keys', { ...admin, schema: { tags: ['kiosk'], params: Id, body: Type.Object({ name: Name }) } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const name = trimName((req.body as { name: string }).name);
    if (name === null) return reply.code(400).send({ error: 'validation', message: `Name is required (max ${NAME_MAX} characters)` });
    if (!(await presetExists(id))) return notFound(reply);
    const n = await db.selectFrom('kiosk_keys').select((eb) => eb.fn.countAll<number>().as('n')).where('preset_id', '=', id).executeTakeFirst();
    if (Number(n?.n ?? 0) >= MAX_KEYS) return reply.code(400).send({ error: 'too_many_keys', message: `A preset can have at most ${MAX_KEYS} keys` });
    const key = KIOSK_KEY_PREFIX + randomToken(32); // base64url: safe in a URL fragment
    const prefix = key.slice(0, 12);
    const kid = Number((await db.insertInto('kiosk_keys').values({ preset_id: id, name, token_hash: sha256(key), token_prefix: prefix, created_by: req.user!.id }).executeTakeFirstOrThrow()).insertId);
    await writeAudit(ctx, req.user, 'kiosk.key.created', { type: 'kiosk_key', id: kid }, { presetId: id, name, prefix }, req.ip);
    return reply.code(201).send({ id: kid, key });
  });

  app.delete('/api/kiosk/keys/:id', { ...admin, schema: { tags: ['kiosk'], params: Id } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const row = await db.selectFrom('kiosk_keys').select(['preset_id', 'name', 'token_prefix']).where('id', '=', id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'Key not found' });
    await db.deleteFrom('kiosk_keys').where('id', '=', id).execute();
    await writeAudit(ctx, req.user, 'kiosk.key.revoked', { type: 'kiosk_key', id }, { presetId: row.preset_id, name: row.name, prefix: row.token_prefix }, req.ip);
    ctx.bus.publish({ type: 'config', entity: 'kiosk_key', id });
    return { ok: true };
  });

  /* ------------------------------- history ------------------------------- */
  /** Hourly cells per monitor, oldest first; `ids` null means every monitor. */
  const history = async (ids: number[] | null, hours: number): Promise<HistoryResponse> => {
    const startMs = Math.floor(Date.now() / HOUR) * HOUR - (hours - 1) * HOUR;
    const start = new Date(startMs);
    const monitors: Record<string, HistoryCell[]> = {};
    if (!ids || ids.length) {
      // Dates go in and come back like in uptimeFor: the pool runs in UTC, so the bucket times line up with `start`
      let q = db.selectFrom('rollups').select(['monitor_id', 'bucket', 'total', 'up_n', 'down_n', 'maint_n']).where('res', '=', 'hour').where('bucket', '>=', start);
      if (ids) q = q.where('monitor_id', 'in', ids);
      for (const r of await q.execute()) {
        const i = Math.floor((r.bucket.getTime() - startMs) / HOUR);
        if (i < 0 || i >= hours) continue;
        (monitors[r.monitor_id] ??= new Array<HistoryCell>(hours).fill(null))[i] = [Number(r.total), Number(r.up_n), Number(r.down_n), Number(r.maint_n)];
      }
    }
    return { from: start.toISOString(), hours, bucketS: HOUR / 1000, monitors };
  };

  app.get('/api/monitors/history', { ...auth, schema: { tags: ['monitors'], summary: 'Hourly availability of the visible monitors', querystring: HoursQuery } }, async (req) =>
    history(await accessibleMonitorIds(ctx, req.user!), (req.query as { hours?: number }).hours ?? 24));

  /* -------------------------- screens with a key -------------------------- */
  const groupRows = () => db.selectFrom('monitor_groups').select(['id', 'parent_id', 'name']).orderBy('sort').orderBy('name').execute();

  /** Active monitors inside the preset's scope; the same rule the web app applies (inKioskScope). */
  const computeScope = async (cfg: KioskConfig): Promise<number[]> => {
    const [mons, tagRows, groups] = await Promise.all([
      db.selectFrom('monitors').select(['id', 'group_id', 'active']).execute(),
      cfg.tags.length ? db.selectFrom('monitor_tags as mt').innerJoin('tags as t', 't.id', 'mt.tag_id').select(['mt.monitor_id', 't.name']).where('t.name', 'in', cfg.tags).execute() : [],
      groupRows(),
    ]);
    const tags = new Map<number, { name: string }[]>();
    for (const t of tagRows) tags.set(t.monitor_id, [...(tags.get(t.monitor_id) ?? []), { name: t.name }]);
    const list = mons.map((m) => ({ id: m.id, groupId: m.group_id, active: !!m.active, tags: tags.get(m.id) ?? [] }));
    return inKioskScope(list, groups.map((g) => ({ id: g.id, parentId: g.parent_id })), cfg).map((m) => m.id);
  };

  /** A small cache: entries expire after `ttl`, and the oldest go first once `max` is reached. Failed computations are not kept. */
  const memo = <T>(ttl: number, max: number) => {
    const m = new Map<string, { exp: number; v: Promise<T> }>();
    return (key: string, make: () => Promise<T>): Promise<T> => {
      const now = Date.now();
      const hit = m.get(key);
      if (hit && hit.exp > now) return hit.v;
      if (m.size >= max) for (const [k2, e] of m) if (e.exp <= now || m.size >= max) m.delete(k2);
      const v = make();
      m.set(key, { exp: now + ttl, v });
      v.catch(() => m.delete(key));
      return v;
    };
  };
  interface PresetState { preset_id: number; config: string; updated_at: Date }
  // One scope per preset, shared by the view, the history and every stream of the preset. The key carries the preset's
  // updated_at and the data version, so edits apply at once; the TTL catches changes that publish no event (other processes).
  const scopes = memo<{ cfg: KioskConfig; ids: number[]; has: Set<number> }>(60_000, 200);
  const scopeOf = (p: PresetState) => scopes(`${p.preset_id}:${p.updated_at.getTime()}:${dataVersion}`, async () => {
    const { cfg, broken } = readStored(p.config);
    if (broken) { ctx.log.warn({ preset: p.preset_id }, 'kiosk preset has an unreadable config: its key screens show no monitors'); return { cfg, ids: [], has: new Set<number>() }; }
    const ids = await computeScope(cfg);
    return { cfg, ids, has: new Set(ids) };
  });

  const denyKey = (reply: FastifyReply) => reply.code(401).send({ error: 'kiosk_key', message: 'A valid kiosk key is required' });
  /** The key from the x-kiosk-key header with its preset, or null after sending 401. Malformed values never reach the database. */
  const checkKey = async (req: FastifyRequest, reply: FastifyReply): Promise<KeyRow | null> => {
    reply.header('Cache-Control', 'no-store');
    const raw = req.headers['x-kiosk-key'];
    if (typeof raw !== 'string' || !raw.startsWith(KIOSK_KEY_PREFIX) || raw.length > 128) { denyKey(reply); return null; }
    const row = await db.selectFrom('kiosk_keys as k').innerJoin('kiosk_presets as p', 'p.id', 'k.preset_id')
      .select(['k.id as kid', 'k.last_used_at', 'p.id as preset_id', 'p.slug', 'p.name', 'p.config', 'p.updated_at'])
      .where('k.token_hash', '=', sha256(raw)).executeTakeFirst();
    if (!row) { denyKey(reply); return null; }
    // like API tokens: at most one write a minute per key, and a failed write does not fail the request
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000)
      void db.updateTable('kiosk_keys').set({ last_used_at: new Date(), last_ip: (req.ip ?? '').slice(0, 64) || null }).where('id', '=', row.kid).execute().catch(() => {});
    return row;
  };

  const computeView = async (k: KeyRow) => {
    const { cfg, ids } = await scopeOf(k);
    const [list, groups] = await Promise.all([listMonitors(ctx, ids), groupRows()]);
    const monitors = list.map((m) => ({
      id: m.id, name: m.name, groupId: m.groupId, active: m.active, status: m.status, overlay: m.overlay, statusSince: m.statusSince, lastCheckAt: m.lastCheckAt,
      latencyMs: m.latencyMs, errorKind: cfg.messages ? m.errorKind : null, message: cfg.messages ? m.message : null, recent: m.recent,
      uptime: { h24: m.uptime.h24, d30: m.uptime.d30 }, info: infoOf(m.info),
    }));
    // only the groups a screen needs to draw headings and paths: those with a shown monitor and their ancestors
    const parent = new Map(groups.map((g) => [g.id, g.parent_id]));
    const used = new Set<number>();
    for (const m of monitors) for (let g = m.groupId, hops = 0; g != null && !used.has(g) && hops < 1000; g = parent.get(g) ?? null, hops++) used.add(g);
    const incidents = cfg.incidents && ids.length
      ? (await db.selectFrom('incidents as i').innerJoin('incident_monitors as im', 'im.incident_id', 'i.id')
        .select(['i.id', 'i.title', 'i.status', 'i.severity', 'i.started_at']).distinct()
        .where('im.monitor_id', 'in', ids).where('i.status', '!=', 'resolved').orderBy('i.started_at', 'desc').orderBy('i.id', 'desc').limit(4).execute())
        .map((i) => ({ id: i.id, title: i.title, status: i.status, severity: i.severity, startedAt: i.started_at }))
      : [];
    return {
      preset: { id: k.preset_id, slug: k.slug, name: k.name, config: cfg },
      monitors,
      groups: groups.filter((g) => used.has(g.id)).map((g) => ({ id: g.id, parentId: g.parent_id, name: g.name, description: null })),
      incidents,
    };
  };

  // many screens on one preset cost one computation every few seconds; slug and name are part of the key, they come from the key row
  const views = memo<Awaited<ReturnType<typeof computeView>>>(5_000, 100);
  const cachedView = (k: KeyRow) => views(`${k.preset_id}:${k.updated_at.getTime()}:${dataVersion}`, () => computeView(k));

  app.get('/api/public/kiosk/view', { ...pub, schema: { tags: ['public'], summary: 'What a wall display with a kiosk key draws (header x-kiosk-key)' } }, async (req, reply) => {
    const k = await checkKey(req, reply);
    if (!k) return reply;
    return { ...(await cachedView(k)), serverTime: new Date().toISOString() };
  });

  app.get('/api/public/kiosk/history', { ...pub, schema: { tags: ['public'], summary: 'Hourly availability of the monitors of a kiosk key', querystring: HoursQuery } }, async (req, reply) => {
    const k = await checkKey(req, reply);
    if (!k) return reply;
    return history((await scopeOf(k)).ids, (req.query as { hours?: number }).hours ?? 24);
  });

  const perKey = new Map<number, number>(), perIp = new Map<string, number>();
  const count = <K>(m: Map<K, number>, k: K, d: number) => { const n = (m.get(k) ?? 0) + d; if (n > 0) m.set(k, n); else m.delete(k); };

  app.get('/api/public/kiosk/stream', { ...pub, schema: { tags: ['public'], summary: 'Server-sent events for a wall display with a kiosk key' } }, async (req, reply) => {
    const k = await checkKey(req, reply);
    if (!k) return reply;
    let scope = await scopeOf(k);
    let updated = k.updated_at.getTime();
    const ip = req.ip ?? '';
    if ((perKey.get(k.kid) ?? 0) >= STREAMS_PER_KEY || (perIp.get(ip) ?? 0) >= STREAMS_PER_IP)
      return reply.code(429).send({ error: 'too_many_streams', message: 'Too many open streams for this key or address' });
    reply.hijack();
    const raw = reply.raw;
    // the client may have left during the awaits above: then there is nothing to subscribe for
    if (req.raw.destroyed || raw.destroyed || raw.socket?.destroyed) { raw.destroy(); return; }
    count(perKey, k.kid, 1); count(perIp, ip, 1);
    raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let cleanup = () => {};
    const out = sseWriter(raw, { onClose: () => cleanup() });
    const send = (event: string, data: unknown) => out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { ts: Date.now() });
    let seq = 0;
    /** Ends the stream once the key is revoked; follows changes of the preset and of the monitors in scope. */
    const refresh = async (announce: boolean) => {
      const mine = ++seq;
      try {
        const row = await db.selectFrom('kiosk_keys as k').innerJoin('kiosk_presets as p', 'p.id', 'k.preset_id').select(['p.id as preset_id', 'p.config', 'p.updated_at']).where('k.id', '=', k.kid).executeTakeFirst();
        if (!row) { out.close(); return; }
        const next = await scopeOf(row);
        if (mine !== seq || out.closed) return; // a newer round has started, its result wins
        const changed = row.updated_at.getTime() !== updated;
        scope = next; updated = row.updated_at.getTime();
        if (announce || changed) send('config', { ts: Date.now() });
      } catch { /* keep the previous state until the next round */ }
    };
    let soon: NodeJS.Timeout | undefined, announce = false;
    const later = (tell: boolean) => {
      announce ||= tell;
      if (!soon) soon = setTimeout(() => { soon = undefined; const a = announce; announce = false; void refresh(a); }, 2_000);
    };
    const unsub = ctx.bus.subscribe((e) => {
      const { cfg, has } = scope;
      if (e.type === 'monitor') { if (has.has(e.monitorId)) send('monitor', cfg.messages ? e.data : { ...e.data, message: null, errorKind: null }); }
      else if (e.type === 'incident') { if (cfg.incidents && e.monitorId != null && has.has(e.monitorId)) send('incident', { id: e.incidentId }); }
      // this key revoked: end at once; another key: nothing to do here (the minute round still checks, for other processes)
      else if (e.type === 'config' && e.entity === 'kiosk_key') { if (e.id === k.kid) out.close(); }
      else if (e.type === 'config' && e.entity === 'kiosk_preset') {
        // the own preset changed (or went, taking the key with it): no event may pass under the old scope, so no debounce
        if (e.id === undefined || e.id === k.preset_id) void refresh(true);
      }
      else later(true); // other config and maintenance: one refetch for a burst of changes
    });
    const ping = setInterval(() => out.write(': ping\n\n'), 15_000);
    const round = setInterval(() => void refresh(false), 60_000);
    let done = false;
    cleanup = () => {
      if (done) return;
      done = true; unsub(); clearInterval(ping); clearInterval(round); clearTimeout(soon); streams.delete(out.close);
      count(perKey, k.kid, -1); count(perIp, ip, -1);
    };
    streams.add(out.close);
    if (out.closed) cleanup(); // the client was gone before the subscriptions were made
    req.raw.on('close', () => { cleanup(); out.close(); });
  });
}
