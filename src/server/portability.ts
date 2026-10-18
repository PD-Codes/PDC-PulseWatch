import { getRunner, maskSecrets, restoreSecrets, SECRET_MASK, secretFields, validateConfig } from '../core';
import type { Ctx } from './context';
import { decryptJson, encryptJson } from './crypto';
import { bool, parseJson } from './db';
import { parseMonitor } from './monitors/model';
import { saveMonitor, ValidationError } from './monitors/service';
import { channelRunner, channelTypes } from './notify/channels';
import type { SsrfSettings } from './guard-sync';

/** Portable configuration document. Everything references other entities by name, never by database id. */
export interface ConfigDoc {
  version: 1; exportedAt?: string;
  groups?: { path: string; description?: string | null }[];
  tags?: { name: string; color?: string }[];
  templates?: { name: string; subject: string; body: string }[];
  channels?: { name: string; type: string; config: Record<string, any>; active?: boolean; isDefault?: boolean; quietHours?: unknown }[];
  policies?: { name: string; steps: { delayMin: number; channels: string[] }[]; repeatEveryMin?: number | null }[];
  monitors?: Record<string, any>[];
  maintenance?: Record<string, any>[];
  statusPages?: Record<string, any>[];
  settings?: { ssrf?: SsrfSettings };
}

export interface ImportReport {
  dryRun: boolean;
  counts: Record<string, { created: number; updated: number }>;
  warnings: string[];
  errors: string[];
}

const SECTIONS = ['groups', 'tags', 'templates', 'channels', 'policies', 'monitors', 'maintenance', 'statusPages'] as const;

/* --------------------------------- export --------------------------------- */

export async function exportConfig(ctx: Ctx, includeSecrets: boolean): Promise<ConfigDoc> {
  const { db } = ctx;
  const [groups, tags, templates, channels, policies, monitors, mtags, deps, notes, probes, windows, targets, pages, sections, comps] = await Promise.all([
    db.selectFrom('monitor_groups').selectAll().execute(), db.selectFrom('tags').selectAll().orderBy('name').execute(), db.selectFrom('notification_templates').selectAll().orderBy('name').execute(),
    db.selectFrom('notification_channels').selectAll().orderBy('name').execute(), db.selectFrom('escalation_policies').selectAll().orderBy('name').execute(), db.selectFrom('monitors').selectAll().orderBy('id').execute(),
    db.selectFrom('monitor_tags').selectAll().execute(), db.selectFrom('monitor_dependencies').selectAll().execute(), db.selectFrom('monitor_notifications').selectAll().execute(), db.selectFrom('probes').select(['id', 'name']).execute(),
    db.selectFrom('maintenance_windows').selectAll().orderBy('id').execute(), db.selectFrom('maintenance_targets').selectAll().execute(),
    db.selectFrom('status_pages').selectAll().orderBy('id').execute(), db.selectFrom('status_page_sections').selectAll().orderBy('sort').execute(), db.selectFrom('status_page_components').selectAll().orderBy('sort').execute(),
  ]);
  const gname = new Map<number, string>();
  const gpath = (id: number): string => {
    if (gname.has(id)) return gname.get(id)!;
    const g = groups.find((x) => x.id === id)!;
    const p = (g.parent_id && g.parent_id !== id ? `${gpath(g.parent_id)}/` : '') + g.name.replace(/\//g, '-');
    gname.set(id, p);
    return p;
  };
  const mname = new Map(monitors.map((m) => [m.id, m.name]));
  const tname = new Map(tags.map((t) => [t.id, t.name]));
  const cname = new Map(channels.map((c) => [c.id, c.name]));
  const pname = new Map(policies.map((p) => [p.id, p.name]));
  const prname = new Map(probes.map((p) => [p.id, p.name]));

  const maskCfg = (type: string, runner: any, cfg: Record<string, any>) => (includeSecrets ? cfg : maskSecrets(runner, cfg));

  const doc: ConfigDoc = {
    version: 1, exportedAt: new Date().toISOString(),
    groups: groups.map((g) => ({ path: gpath(g.id), description: g.description })).sort((a, b) => a.path.localeCompare(b.path)),
    tags: tags.map((t) => ({ name: t.name, color: t.color })),
    templates: templates.map((t) => ({ name: t.name, subject: t.subject, body: t.body })),
    channels: channels.map((c) => {
      let cfg: Record<string, any> = {};
      try { cfg = maskCfg(c.type, channelTypes.has(c.type) ? channelRunner(c.type) : undefined, decryptJson(c.config_enc)); } catch { /* key mismatch: export without config */ }
      return { name: c.name, type: c.type, config: cfg, active: bool(c.active), isDefault: bool(c.is_default), quietHours: parseJson(c.quiet_hours, null) };
    }),
    policies: policies.map((p) => { const v = parseJson<any>(p.steps, { steps: [] }); return { name: p.name, steps: v.steps.map((s: any) => ({ delayMin: s.delayMin, channels: (s.channelIds as number[]).map((i) => cname.get(i)).filter(Boolean) })), repeatEveryMin: v.repeatEveryMin ?? null }; }),
    monitors: monitors.map((row) => {
      const m = parseMonitor(row);
      const runner = getRunner(m.type);
      return {
        name: m.name, type: m.type, group: m.groupId ? gpath(m.groupId) : null, description: m.description, config: runner ? maskCfg(m.type, runner, m.config) : m.config,
        intervalS: m.intervalS, timeoutS: m.timeoutS, retries: m.retries, retryIntervalS: m.retryIntervalS, upThreshold: m.upThreshold, downThreshold: m.downThreshold, flapWindow: m.flapWindow, flapThreshold: m.flapThreshold,
        active: m.active, publicBadge: m.publicBadge, quorum: m.quorum, locations: m.locations?.map((l) => (l === 'local' ? 'local' : prname.get(l))).filter(Boolean) ?? null,
        tags: mtags.filter((t) => t.monitor_id === m.id).map((t) => tname.get(t.tag_id)).filter(Boolean),
        dependsOn: deps.filter((d) => d.monitor_id === m.id).map((d) => mname.get(d.depends_on_id)).filter(Boolean),
        notifications: notes.filter((n) => n.monitor_id === m.id).map((n) => ({ channel: n.channel_id ? cname.get(n.channel_id) : null, policy: n.policy_id ? pname.get(n.policy_id) : null, events: n.events.split(',') })),
      };
    }),
    maintenance: windows.map((w) => ({
      name: w.name, description: w.description, kind: w.kind, startsAt: w.starts_at?.toISOString() ?? null, endsAt: w.ends_at?.toISOString() ?? null, cronExpr: w.cron_expr, durationMin: w.duration_min, timezone: w.timezone, active: bool(w.active), announce: bool(w.announce),
      targets: targets.filter((t) => t.window_id === w.id).map((t) => ({ type: t.target_type, name: t.target_type === 'monitor' ? mname.get(t.target_id) : t.target_type === 'group' ? (groups.some((g) => g.id === t.target_id) ? gpath(t.target_id) : undefined) : tname.get(t.target_id) })).filter((t) => t.name),
    })),
    statusPages: pages.map((p) => ({
      slug: p.slug, title: p.title, description: p.description, domain: p.domain, isPublic: bool(p.is_public), ssoRequired: bool(p.sso_required), branding: parseJson(p.branding, {}), customCss: p.custom_css, showHistory: bool(p.show_history),
      sections: sections.filter((s) => s.page_id === p.id).map((s) => ({ name: s.name, components: comps.filter((c) => c.section_id === s.id).map((c) => ({ monitor: mname.get(c.monitor_id), displayName: c.display_name })).filter((c) => c.monitor) })),
      components: comps.filter((c) => c.page_id === p.id && !c.section_id).map((c) => ({ monitor: mname.get(c.monitor_id), displayName: c.display_name })).filter((c) => c.monitor),
    })),
  };
  const ssrf = await ctx.settings.get<SsrfSettings | null>('ssrf', null);
  if (ssrf) doc.settings = { ssrf };
  return doc;
}

/* --------------------------------- import --------------------------------- */

/** Drop masked placeholders so a masked export can be imported without overwriting or inventing secrets. */
function stripMasked(runner: any, cfg: Record<string, any>): Record<string, any> {
  const out = { ...cfg };
  for (const f of secretFields(runner)) {
    if (f.kind === 'secret' && out[f.key] === SECRET_MASK) delete out[f.key];
    if (f.kind === 'kv' && out[f.key] && typeof out[f.key] === 'object') out[f.key] = Object.fromEntries(Object.entries(out[f.key]).filter(([, v]) => v !== SECRET_MASK));
  }
  return out;
}

export async function importConfig(ctx: Ctx, doc: ConfigDoc, userId: number | null, dryRun: boolean): Promise<ImportReport> {
  const { db } = ctx;
  const rep: ImportReport = { dryRun, counts: Object.fromEntries(SECTIONS.map((s) => [s, { created: 0, updated: 0 }])), warnings: [], errors: [] };
  if (!doc || typeof doc !== 'object' || doc.version !== 1) { rep.errors.push('Unsupported document: expected an object with "version: 1"'); return rep; }
  const count = (k: typeof SECTIONS[number], existed: boolean) => { rep.counts[k][existed ? 'updated' : 'created']++; };
  const err = (what: string, e: unknown) => rep.errors.push(`${what}: ${e instanceof ValidationError ? e.errors.join('; ') : (e as Error).message}`);
  const w = async <T>(fn: () => Promise<T>): Promise<T | undefined> => (dryRun ? undefined : fn());

  // --- groups (parents first because paths sort that way)
  const groupIds = new Map<string, number>();
  const allGroups = await db.selectFrom('monitor_groups').select(['id', 'parent_id', 'name']).execute();
  const pathOf = (id: number): string => { const g = allGroups.find((x) => x.id === id)!; return (g.parent_id && g.parent_id !== id ? `${pathOf(g.parent_id)}/` : '') + g.name; };
  for (const g of allGroups) groupIds.set(pathOf(g.id), g.id);
  const ensureGroup = async (path: string, description?: string | null): Promise<number | undefined> => {
    if (groupIds.has(path)) return groupIds.get(path);
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) return undefined;
    const parentId = parts.length ? await ensureGroup(parts.join('/')) : null;
    count('groups', false);
    const id = (await w(async () => Number((await db.insertInto('monitor_groups').values({ parent_id: parentId ?? null, name, description: description ?? null }).executeTakeFirstOrThrow()).insertId))) ?? -1;
    groupIds.set(path, id);
    return id;
  };
  for (const g of [...(doc.groups ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    try { const existed = groupIds.has(g.path); await ensureGroup(g.path, g.description); if (existed && g.description !== undefined) { count('groups', true); await w(() => db.updateTable('monitor_groups').set({ description: g.description ?? null }).where('id', '=', groupIds.get(g.path)!).execute()); } } catch (e) { err(`group ${g.path}`, e); }
  }

  // --- tags
  const tagIds = new Map((await db.selectFrom('tags').select(['id', 'name']).execute()).map((t) => [t.name, t.id]));
  const ensureTag = async (name: string, color?: string) => {
    if (tagIds.has(name)) return tagIds.get(name)!;
    count('tags', false);
    const id = (await w(async () => Number((await db.insertInto('tags').values({ name: name.slice(0, 64), ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}) }).executeTakeFirstOrThrow()).insertId))) ?? -1;
    tagIds.set(name, id);
    return id;
  };
  for (const t of doc.tags ?? []) try { const existed = tagIds.has(t.name); await ensureTag(t.name, t.color); if (existed) { count('tags', true); if (t.color && /^#[0-9a-f]{6}$/i.test(t.color)) await w(() => db.updateTable('tags').set({ color: t.color! }).where('id', '=', tagIds.get(t.name)!).execute()); } } catch (e) { err(`tag ${t.name}`, e); }

  // --- templates
  const templateIds = new Map((await db.selectFrom('notification_templates').select(['id', 'name']).execute()).map((t) => [t.name, t.id]));
  for (const t of doc.templates ?? []) try {
    const id = templateIds.get(t.name); count('templates', !!id);
    await w(async () => { if (id) await db.updateTable('notification_templates').set({ subject: t.subject, body: t.body }).where('id', '=', id).execute(); else templateIds.set(t.name, Number((await db.insertInto('notification_templates').values({ name: t.name, subject: t.subject, body: t.body }).executeTakeFirstOrThrow()).insertId)); });
  } catch (e) { err(`template ${t.name}`, e); }

  // --- channels
  const channelIds = new Map((await db.selectFrom('notification_channels').select(['id', 'name']).execute()).map((c) => [c.name, c.id]));
  for (const c of doc.channels ?? []) try {
    if (!channelTypes.has(c.type)) { rep.warnings.push(`channel ${c.name}: unknown type ${c.type}, skipped`); continue; }
    const runner = channelRunner(c.type);
    const old = channelIds.get(c.name) ? await db.selectFrom('notification_channels').select('config_enc').where('id', '=', channelIds.get(c.name)!).executeTakeFirst() : undefined;
    let cfg = stripMasked(runner, c.config ?? {});
    if (old) cfg = restoreSecrets(runner, c.config ?? {}, decryptJson(old.config_enc));
    const v = validateConfig(runner, cfg);
    if (v.errors.length) { rep.errors.push(`channel ${c.name}: ${v.errors.join('; ')}`); continue; }
    count('channels', !!old);
    const values = { name: c.name, type: c.type, config_enc: encryptJson(v.config), active: c.active === false ? 0 : 1, is_default: c.isDefault ? 1 : 0, quiet_hours: c.quietHours ? JSON.stringify(c.quietHours) : null };
    await w(async () => { if (old) await db.updateTable('notification_channels').set(values).where('id', '=', channelIds.get(c.name)!).execute(); else channelIds.set(c.name, Number((await db.insertInto('notification_channels').values({ ...values, created_by: userId }).executeTakeFirstOrThrow()).insertId)); });
    if (dryRun && !old) channelIds.set(c.name, -1);
  } catch (e) { err(`channel ${c.name}`, e); }

  // --- escalation policies
  const policyIds = new Map((await db.selectFrom('escalation_policies').select(['id', 'name']).execute()).map((p) => [p.name, p.id]));
  for (const p of doc.policies ?? []) try {
    const steps = p.steps.map((s) => ({ delayMin: s.delayMin, channelIds: s.channels.map((n) => channelIds.get(n)).filter((i): i is number => !!i) }));
    if (steps.some((s) => !s.channelIds.length)) { rep.errors.push(`policy ${p.name}: a step references no known channel`); continue; }
    const id = policyIds.get(p.name); count('policies', !!id);
    const steps_json = JSON.stringify({ steps, repeatEveryMin: p.repeatEveryMin ?? undefined });
    await w(async () => { if (id) await db.updateTable('escalation_policies').set({ steps: steps_json }).where('id', '=', id).execute(); else policyIds.set(p.name, Number((await db.insertInto('escalation_policies').values({ name: p.name, steps: steps_json }).executeTakeFirstOrThrow()).insertId)); });
    if (dryRun && !id) policyIds.set(p.name, -1);
  } catch (e) { err(`policy ${p.name}`, e); }

  // --- monitors (pass 1: everything except dependencies, which may point forward)
  const monitorRows = await db.selectFrom('monitors').select(['id', 'name', 'type']).execute();
  const monitorIds = new Map(monitorRows.map((m) => [m.name, m.id]));
  const pending: { id: number; name: string; dependsOn: string[] }[] = [];
  const probeIds = new Map((await db.selectFrom('probes').select(['id', 'name']).execute()).map((p) => [p.name, p.id]));
  for (const m of doc.monitors ?? []) try {
    const runner = getRunner(m.type);
    if (!runner) { rep.warnings.push(`monitor ${m.name}: unknown type ${m.type}, skipped`); continue; }
    const row = monitorIds.has(m.name) ? monitorRows.find((r) => r.name === m.name)! : undefined;
    if (row && row.type !== m.type) { rep.errors.push(`monitor ${m.name}: exists with type ${row.type}, cannot import as ${m.type}`); continue; }
    const existing = row ? parseMonitor((await db.selectFrom('monitors').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow())) : undefined;
    const groupId = m.group ? await ensureGroup(m.group) ?? null : null;
    const tagIdList = await Promise.all((m.tags ?? []).map((t: string) => ensureTag(t)));
    const locations = m.locations ? (m.locations as string[]).map((l) => (l === 'local' ? 'local' : probeIds.get(l))).filter((l) => l !== undefined) : null;
    if (m.locations && locations!.length !== m.locations.length) rep.warnings.push(`monitor ${m.name}: some probe locations do not exist here and were dropped`);
    const notifications = (m.notifications ?? []).map((n: any) => ({ channelId: n.channel ? channelIds.get(n.channel) : null, policyId: n.policy ? policyIds.get(n.policy) : null, events: n.events })).filter((n: any) => n.channelId || n.policyId);
    const input = {
      name: m.name, type: m.type, groupId, description: m.description ?? null, config: existing ? m.config ?? {} : stripMasked(runner, m.config ?? {}), intervalS: m.intervalS, timeoutS: m.timeoutS, retries: m.retries, retryIntervalS: m.retryIntervalS,
      upThreshold: m.upThreshold, downThreshold: m.downThreshold, flapWindow: m.flapWindow, flapThreshold: m.flapThreshold, active: m.active, publicBadge: m.publicBadge, quorum: locations?.length ? m.quorum : 1,
      locations: locations as (number | 'local')[] | null, tagIds: tagIdList.filter((t) => t > 0), notifications: notifications.filter((n: any) => (n.channelId ?? 1) > 0 && (n.policyId ?? 1) > 0),
    };
    if (dryRun) {
      // validate without writing
      const cfg = existing ? restoreSecrets(runner, input.config, existing.config) : input.config;
      const v = validateConfig(runner, cfg);
      if (v.errors.length) rep.errors.push(`monitor ${m.name}: ${v.errors.join('; ')}`);
      count('monitors', !!existing);
      continue;
    }
    const id = await saveMonitor(ctx, input, userId, existing);
    monitorIds.set(m.name, id);
    count('monitors', !!existing);
    if (m.dependsOn?.length) pending.push({ id, name: m.name, dependsOn: m.dependsOn });
  } catch (e) { err(`monitor ${m.name}`, e); }
  for (const p of pending) try {
    const ids = p.dependsOn.map((n) => monitorIds.get(n)).filter((i): i is number => !!i);
    if (ids.length !== p.dependsOn.length) rep.warnings.push(`monitor ${p.name}: some dependencies do not exist and were dropped`);
    const existing = parseMonitor(await db.selectFrom('monitors').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow());
    await saveMonitor(ctx, { dependsOn: ids }, userId, existing);
  } catch (e) { err(`dependencies of ${p.name}`, e); }

  // --- maintenance windows
  const windowIds = new Map((await db.selectFrom('maintenance_windows').select(['id', 'name']).execute()).map((x) => [x.name, x.id]));
  for (const mw of doc.maintenance ?? []) try {
    const targets: { target_type: 'monitor' | 'group' | 'tag'; target_id: number }[] = [];
    for (const t of mw.targets ?? []) {
      const id = t.type === 'monitor' ? monitorIds.get(t.name) : t.type === 'group' ? groupIds.get(t.name) : tagIds.get(t.name);
      if (id) targets.push({ target_type: t.type, target_id: id }); else rep.warnings.push(`maintenance ${mw.name}: ${t.type} "${t.name}" not found`);
    }
    if (!targets.length) { rep.errors.push(`maintenance ${mw.name}: no valid targets`); continue; }
    const id = windowIds.get(mw.name); count('maintenance', !!id);
    const values = { name: mw.name, description: mw.description ?? null, kind: mw.kind, starts_at: mw.startsAt ? new Date(mw.startsAt) : null, ends_at: mw.endsAt ? new Date(mw.endsAt) : null, cron_expr: mw.cronExpr ?? null, duration_min: mw.durationMin ?? null, timezone: mw.timezone ?? 'UTC', active: mw.active === false ? 0 : 1, announce: mw.announce ? 1 : 0 };
    await w(() => db.transaction().execute(async (trx) => {
      let wid = id;
      if (wid) { await trx.updateTable('maintenance_windows').set(values).where('id', '=', wid).execute(); await trx.deleteFrom('maintenance_targets').where('window_id', '=', wid).execute(); }
      else wid = Number((await trx.insertInto('maintenance_windows').values({ ...values, created_by: userId }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('maintenance_targets').values(targets.map((t) => ({ window_id: wid!, ...t }))).ignore().execute();
    }));
  } catch (e) { err(`maintenance ${mw.name}`, e); }
  if (!dryRun) await ctx.maintenance.refresh().catch(() => {});

  // --- status pages (passwords are never exported, an existing password is kept)
  const pageIds = new Map((await db.selectFrom('status_pages').select(['id', 'slug']).execute()).map((p) => [p.slug, p.id]));
  for (const p of doc.statusPages ?? []) try {
    const id = pageIds.get(p.slug); count('statusPages', !!id);
    const values = { slug: p.slug, title: p.title, description: p.description ?? null, domain: p.domain ?? null, is_public: p.isPublic === false ? 0 : 1, sso_required: p.ssoRequired ? 1 : 0, branding: JSON.stringify(p.branding ?? {}), custom_css: p.customCss ?? null, show_history: p.showHistory === false ? 0 : 1 };
    const comp = (c: any) => { const mid = monitorIds.get(c.monitor); if (!mid) rep.warnings.push(`status page ${p.slug}: monitor "${c.monitor}" not found`); return mid ? { monitor_id: mid, display_name: c.displayName ?? null } : null; };
    await w(() => db.transaction().execute(async (trx) => {
      let pid = id;
      if (pid) { await trx.updateTable('status_pages').set(values).where('id', '=', pid).execute(); await trx.deleteFrom('status_page_components').where('page_id', '=', pid).execute(); await trx.deleteFrom('status_page_sections').where('page_id', '=', pid).execute(); }
      else pid = Number((await trx.insertInto('status_pages').values(values).executeTakeFirstOrThrow()).insertId);
      let sort = 0;
      for (const [i, s] of (p.sections ?? []).entries()) {
        const sid = Number((await trx.insertInto('status_page_sections').values({ page_id: pid!, name: s.name, sort: i }).executeTakeFirstOrThrow()).insertId);
        for (const c of s.components ?? []) { const x = comp(c); if (x) await trx.insertInto('status_page_components').values({ page_id: pid!, section_id: sid, sort: sort++, ...x }).execute(); }
      }
      for (const c of p.components ?? []) { const x = comp(c); if (x) await trx.insertInto('status_page_components').values({ page_id: pid!, section_id: null, sort: sort++, ...x }).execute(); }
    }));
  } catch (e) { err(`status page ${p.slug}`, e); }

  if (doc.settings?.ssrf && !dryRun) await ctx.settings.set('ssrf', doc.settings.ssrf);
  if (!dryRun) ctx.bus.publish({ type: 'config', entity: 'import' });
  return rep;
}

/* ------------------------------ Uptime Kuma ------------------------------ */

const KUMA_TYPES: Record<string, string> = { http: 'http', keyword: 'keyword', 'json-query': 'json', port: 'tcp', ping: 'ping', dns: 'dns', push: 'push', docker: 'docker', mqtt: 'mqtt', mysql: 'mysql', postgres: 'postgres', mongodb: 'mongodb', redis: 'redis', sqlserver: 'mssql' };
const asObj = (v: unknown): Record<string, any> => (typeof v === 'string' ? parseJson(v, {}) : v && typeof v === 'object' ? (v as Record<string, any>) : {});
const list = (v: unknown): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const clamp = (n: unknown, lo: number, hi: number, def: number) => { const x = Math.ceil(Number(n)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def; };

function kumaChannel(n: any, warnings: string[]): ConfigDoc['channels'] extends (infer T)[] | undefined ? T | null : never {
  const c = asObj(n.config);
  const base = { name: String(n.name ?? c.name ?? `kuma-${n.id}`), active: n.active !== false && n.active !== 0, isDefault: !!(n.isDefault ?? c.isDefault) };
  const t = String(c.type ?? '').toLowerCase();
  const pick = (type: string, config: Record<string, any>) => ({ ...base, type, config: Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== null && v !== '')) });
  switch (t) {
    case 'telegram': return pick('telegram', { botToken: c.telegramBotToken, chatId: c.telegramChatID });
    case 'discord': return pick('discord', { webhookUrl: c.discordWebhookUrl });
    case 'slack': return pick('slack', { webhookUrl: c.slackwebhookURL });
    case 'teams': return pick('teams', { webhookUrl: c.webhookUrl });
    case 'ntfy': return pick('ntfy', { server: c.ntfyserverurl, topic: c.ntfytopic, token: c.ntfyaccesstoken, priority: c.ntfyPriority });
    case 'gotify': return pick('gotify', { server: c.gotifyserverurl, token: c.gotifyapplicationToken, priority: c.gotifyPriority });
    case 'pushover': return pick('pushover', { appToken: c.pushoverapptoken, userKey: c.pushoveruserkey, priority: c.pushoverpriority });
    case 'webhook': warnings.push(`notification "${base.name}": webhook payloads differ, review the body template`); return pick('webhook', { url: c.webhookURL, method: 'POST' });
    case 'smtp': return pick('email', { host: c.smtpHost, port: c.smtpPort, security: c.smtpSecure ? 'ssl' : 'starttls', username: c.smtpUsername, password: c.smtpPassword, from: c.smtpFrom, to: c.smtpTo });
    default: warnings.push(`notification "${base.name}": type "${t}" is not supported, skipped`); return null;
  }
}

/** Parses scheme://user:pass@host:port/db style strings into runner fields. */
function connFields(s: string | undefined): Record<string, any> | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return { host: u.hostname, port: u.port ? Number(u.port) : undefined, database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
  } catch { return null; }
}

/** Converts an Uptime Kuma 1.x backup (Settings > Backup JSON) into the portable configuration document. */
export function convertKuma(raw: unknown): { doc: ConfigDoc; warnings: string[] } {
  const warnings: string[] = [];
  const src = asObj(raw);
  const mons = list(src.monitorList);
  const notes = list(src.notificationList);
  if (!mons.length && !notes.length) warnings.push('The file contains no monitors or notifications. Expected an Uptime Kuma 1.x backup JSON.');

  const channels: NonNullable<ConfigDoc['channels']> = [];
  const chName = new Map<string, string>();
  for (const n of notes) { const c = kumaChannel(n, warnings); if (c) { channels.push(c); chName.set(String(n.id), c.name); } }

  const byId = new Map(mons.map((m) => [m.id, m]));
  const groupPath = (id: number | null | undefined, seen = new Set<number>()): string | null => {
    const g = id ? byId.get(id) : undefined;
    if (!g || seen.has(g.id)) return null;
    seen.add(g.id);
    const parent = groupPath(g.parent, seen);
    return (parent ? `${parent}/` : '') + String(g.name).replace(/\//g, '-');
  };
  const groups: NonNullable<ConfigDoc['groups']> = mons.filter((m) => m.type === 'group').map((m) => ({ path: groupPath(m.id)!, description: m.description ?? null })).filter((g) => g.path);

  const tags = new Map<string, string | undefined>();
  const monitors: Record<string, any>[] = [];
  for (const m of mons) {
    if (m.type === 'group') continue;
    let type = KUMA_TYPES[m.type];
    if ((m.type === 'gamedig' || m.type === 'steam') && String(m.game ?? '').includes('minecraft')) type = 'minecraft';
    if (!type) { warnings.push(`monitor "${m.name}": type "${m.type}" is not supported, skipped`); continue; }
    if (m.upsideDown) warnings.push(`monitor "${m.name}": "upside down mode" is not supported and was ignored`);
    let config: Record<string, any> = {};
    const hostname = m.hostname ?? undefined;
    switch (type) {
      case 'http': case 'keyword': case 'json': {
        const status = list(m.accepted_statuscodes ?? (typeof m.accepted_statuscodes_json === 'string' ? parseJson(m.accepted_statuscodes_json, []) : [])).join(',') || '200-299';
        const redirects = Number(m.maxredirects ?? 10);
        config = {
          url: m.url, method: m.method ?? 'GET', expectedStatus: status, headers: asObj(m.headers), body: m.body ?? undefined, verifyTls: !m.ignoreTls, followRedirects: redirects > 0, maxRedirects: Math.max(redirects, 1), tlsExpiryDays: m.expiryNotification ? 14 : 0,
          ...(m.authMethod === 'basic' ? { authType: 'basic', basicUser: m.basic_auth_user, basicPass: m.basic_auth_pass } : {}),
          ...(type === 'keyword' ? { keyword: m.keyword, invert: !!m.invertKeyword, caseSensitive: false } : {}),
          ...(type === 'json' ? { jsonPath: String(m.jsonPath ?? '$'), jsonOp: m.jsonPathOperator === '!=' ? 'ne' : m.jsonPathOperator === '>' ? 'gt' : m.jsonPathOperator === '<' ? 'lt' : m.jsonPathOperator === 'contains' ? 'contains' : 'eq', jsonExpected: m.expectedValue != null ? String(m.expectedValue) : undefined } : {}),
        };
        if (m.authMethod && !['basic', 'none', null].includes(m.authMethod)) warnings.push(`monitor "${m.name}": auth method "${m.authMethod}" is not supported, credentials were dropped`);
        break;
      }
      case 'tcp': config = { host: hostname, port: m.port }; break;
      case 'ping': config = { host: hostname }; break;
      case 'dns': config = { host: hostname, recordType: m.dns_resolve_type ?? 'A', resolver: m.dns_resolve_server && m.dns_resolve_server !== '1.1.1.1' ? m.dns_resolve_server : undefined }; break;
      case 'push': config = { graceSeconds: 60 }; break;
      case 'docker': config = { container: m.docker_container, endpoint: '/var/run/docker.sock' }; warnings.push(`monitor "${m.name}": docker host settings are not imported, the default socket is used`); break;
      case 'mqtt': config = { host: hostname, port: m.port ?? 1883, topic: m.mqttTopic, expect: m.mqttSuccessMessage, username: m.mqttUsername, password: m.mqttPassword }; break;
      case 'minecraft': config = { host: hostname, port: m.port ?? 25565 }; break;
      default: {
        const f = connFields(m.databaseConnectionString);
        if (!f) { warnings.push(`monitor "${m.name}": connection string could not be converted, fill in host and credentials after the import`); config = { host: 'localhost' }; }
        else config = { ...f, ...(m.databaseQuery ? { query: m.databaseQuery } : {}) };
        if (type === 'redis') delete (config as any).database;
      }
    }
    for (const t of list(m.tags)) tags.set(String(t.name), /^#[0-9a-f]{6}$/i.test(t.color ?? '') ? t.color : undefined);
    monitors.push({
      name: String(m.name), type, group: groupPath(m.parent), description: m.description ?? null, config: Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== null && v !== '')),
      intervalS: clamp(m.interval, 5, 86400, 60), timeoutS: clamp(m.timeout, 1, 300, 10), retries: clamp(m.maxretries, 0, 20, 0), retryIntervalS: clamp(m.retryInterval, 5, 3600, 60), active: m.active !== false && m.active !== 0,
      tags: list(m.tags).map((t) => String(t.name)),
      notifications: Object.entries(asObj(m.notificationIDList)).filter(([, on]) => on).map(([id]) => chName.get(id)).filter(Boolean).map((channel) => ({ channel, events: ['down', 'up'] })),
    });
  }
  if (list(src.maintenanceList).length) warnings.push('Maintenance windows are not part of Uptime Kuma backups and were not imported.');
  return { doc: { version: 1, groups, tags: [...tags].map(([name, color]) => ({ name, color })), channels, monitors }, warnings };
}
