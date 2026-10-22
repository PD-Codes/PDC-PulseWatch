import { Cron } from 'croner';
import { getRunner, maskSecrets, restoreSecrets, SECRET_MASK, secretFields, validateConfig } from '../core';
import type { Ctx } from './context';
import { decryptJson, encryptJson } from './crypto';
import { bool, parseJson } from './db';
import { parseMonitor } from './monitors/model';
import { saveMonitor, ValidationError } from './monitors/service';
import { channelRunner, channelTypes } from './notify/channels';
import type { SsrfSettings } from './guard-sync';

/** Something in a foreign system (Uptime Kuma) that has no equivalent here; the import preview lists it so nothing disappears silently. */
export interface Unsupported { kind: string; name: string; reason: string }

/** A tag reference inside a monitor: a plain name, or a name with a value. */
export type TagRef = string | { name: string; value?: string };
export const tagRef = (t: unknown): { name: string; value: string } =>
  typeof t === 'string' ? { name: t, value: '' } : { name: String((t as { name?: unknown } | null)?.name ?? ''), value: String((t as { value?: unknown } | null)?.value ?? '').trim().slice(0, 255) };

/** Portable configuration document. Everything references other entities by name, never by database id. */
export interface ConfigDoc {
  version: 1; exportedAt?: string;
  groups?: { path: string; description?: string | null }[];
  tags?: { name: string; color?: string }[];
  templates?: { name: string; subject: string; body: string }[];
  channels?: { name: string; type: string; config: Record<string, any>; active?: boolean; isDefault?: boolean; quietHours?: unknown; notes?: string[] }[];
  policies?: { name: string; steps: { delayMin: number; channels: string[] }[]; repeatEveryMin?: number | null }[];
  monitors?: Record<string, any>[];
  maintenance?: Record<string, any>[];
  statusPages?: Record<string, any>[];
  settings?: { ssrf?: SsrfSettings };
  /** Set by converters of other systems: existing monitors keep the group, tags and notification rules the source says nothing about. */
  merge?: boolean;
  /** Set by converters of other systems: what could not be converted (informational, never imported). Monitors, channels, maintenance windows and status pages may carry `notes` for details that were lost. */
  unsupported?: Unsupported[];
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
        // a plain tag is exported as its name, a name + value tag as { name, value }
        tags: mtags.filter((t) => t.monitor_id === m.id && tname.has(t.tag_id)).map((t) => (t.value ? { name: tname.get(t.tag_id)!, value: t.value } : tname.get(t.tag_id)!)),
        dependsOn: deps.filter((d) => d.monitor_id === m.id).map((d) => mname.get(d.depends_on_id)).filter(Boolean),
        notifications: notes.filter((n) => n.monitor_id === m.id).map((n) => ({ channel: n.channel_id ? cname.get(n.channel_id) : null, policy: n.policy_id ? pname.get(n.policy_id) : null, events: n.events.split(',') })),
      };
    }),
    maintenance: windows.map((w) => ({
      name: w.name, description: w.description, kind: w.kind, startsAt: w.starts_at?.toISOString() ?? null, endsAt: w.ends_at?.toISOString() ?? null, cronExpr: w.cron_expr, durationMin: w.duration_min, timezone: w.timezone, active: bool(w.active), announce: bool(w.announce),
      targets: targets.filter((t) => t.window_id === w.id).map((t) => ({ type: t.target_type, name: t.target_type === 'monitor' ? mname.get(t.target_id) : t.target_type === 'group' ? (groups.some((g) => g.id === t.target_id) ? gpath(t.target_id) : undefined) : tname.get(t.target_id) })).filter((t) => t.name),
    })),
    statusPages: pages.map((p) => ({
      slug: p.slug, title: p.title, description: p.description, domain: p.domain, isPublic: bool(p.is_public), ssoRequired: bool(p.sso_required), branding: parseJson(p.branding, {}), customCss: p.custom_css, showHistory: bool(p.show_history), historyDays: p.history_days, isDefault: bool(p.is_default), incidentDays: p.incident_days, incidentPageSize: p.incident_page_size, language: p.language, serverInfo: p.server_info,
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

export interface ImportProgress { phase: string; done: number; total: number }

export async function importConfig(ctx: Ctx, doc: ConfigDoc, userId: number | null, dryRun: boolean, onProgress?: (p: ImportProgress) => void): Promise<ImportReport> {
  const { db } = ctx;
  const rep: ImportReport = { dryRun, counts: Object.fromEntries(SECTIONS.map((s) => [s, { created: 0, updated: 0 }])), warnings: [], errors: [] };
  if (!doc || typeof doc !== 'object' || doc.version !== 1) { rep.errors.push('Unsupported document: expected an object with "version: 1"'); return rep; }
  const total = (doc.channels?.length ?? 0) + (doc.monitors?.length ?? 0) + (doc.maintenance?.length ?? 0) + (doc.statusPages?.length ?? 0);
  let done = 0;
  const step = (phase: string) => onProgress?.({ phase, done: done++, total });
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
    step('channels');
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
  const tagsByMonitor = new Map<number, { tagId: number; value: string }[]>();
  if (doc.merge) for (const r of await db.selectFrom('monitor_tags').select(['monitor_id', 'tag_id', 'value']).execute()) tagsByMonitor.set(r.monitor_id, [...(tagsByMonitor.get(r.monitor_id) ?? []), { tagId: r.tag_id, value: r.value }]);
  const probeIds = new Map((await db.selectFrom('probes').select(['id', 'name']).execute()).map((p) => [p.name, p.id]));
  for (const m of doc.monitors ?? []) try {
    step('monitors');
    const runner = getRunner(m.type);
    if (!runner) { rep.warnings.push(`monitor ${m.name}: unknown type ${m.type}, skipped`); continue; }
    const row = monitorIds.has(m.name) ? monitorRows.find((r) => r.name === m.name)! : undefined;
    if (row && row.type !== m.type) { rep.errors.push(`monitor ${m.name}: exists with type ${row.type}, cannot import as ${m.type}`); continue; }
    const existing = row ? parseMonitor((await db.selectFrom('monitors').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow())) : undefined;
    const keepGroup = !!existing && (m.group === undefined || (doc.merge && !m.group));
    const groupId = m.group ? await ensureGroup(m.group) ?? null : keepGroup ? undefined : null;
    // one after the other: two values of a new tag must not both try to create it
    const importedTags: { tagId: number; value: string }[] = [];
    for (const ref of ((m.tags ?? []) as TagRef[]).map(tagRef)) if (ref.name) { const tagId = await ensureTag(ref.name); if (tagId > 0) importedTags.push({ tagId, value: ref.value }); }
    const allTags = existing && doc.merge ? [...(tagsByMonitor.get(existing.id) ?? []), ...importedTags] : importedTags;
    const locations = m.locations ? (m.locations as string[]).map((l) => (l === 'local' ? 'local' : probeIds.get(l))).filter((l) => l !== undefined) : null;
    if (m.locations && locations!.length !== m.locations.length) rep.warnings.push(`monitor ${m.name}: some probe locations do not exist here and were dropped`);
    const notifications = (m.notifications ?? []).map((n: any) => ({ channelId: n.channel ? channelIds.get(n.channel) : null, policyId: n.policy ? policyIds.get(n.policy) : null, events: n.events })).filter((n: any) => n.channelId || n.policyId);
    const input = {
      name: m.name, type: m.type, groupId, description: m.description ?? null, config: existing ? m.config ?? {} : stripMasked(runner, m.config ?? {}), intervalS: m.intervalS, timeoutS: m.timeoutS, retries: m.retries, retryIntervalS: m.retryIntervalS,
      upThreshold: m.upThreshold, downThreshold: m.downThreshold, flapWindow: m.flapWindow, flapThreshold: m.flapThreshold, active: m.active, publicBadge: m.publicBadge, quorum: locations?.length ? m.quorum : 1,
      locations: locations as (number | 'local')[] | null, tagIds: [...new Set(allTags.filter((t) => !t.value).map((t) => t.tagId))], tagValues: allTags.filter((t) => t.value), notifications: existing && doc.merge && !notifications.length ? undefined : notifications.filter((n: any) => (n.channelId ?? 1) > 0 && (n.policyId ?? 1) > 0),
    };
    if (dryRun) {
      // validate without writing
      const cfg = existing ? restoreSecrets(runner, input.config, existing.config) : input.config;
      const v = validateConfig(runner, cfg);
      if (v.errors.length) rep.errors.push(`monitor ${m.name}: ${v.errors.join('; ')}`);
      count('monitors', !!existing);
      monitorIds.set(m.name, existing?.id ?? -1); // a monitor that would be created still counts as a target for maintenance windows below
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
    step('maintenance');
    const targets: { target_type: 'monitor' | 'group' | 'tag'; target_id: number }[] = [];
    for (const t of mw.targets ?? []) {
      const id = t.type === 'monitor' ? monitorIds.get(t.name) : t.type === 'group' ? groupIds.get(t.name) : tagIds.get(t.name);
      if (id) targets.push({ target_type: t.type, target_id: id }); else rep.warnings.push(`maintenance ${mw.name}: ${t.type} "${t.name}" not found`);
    }
    if (!targets.length) {
      // a converted document whose monitors were de-selected simply has nothing to attach to; for a hand-written one it is a mistake
      if (doc.merge) rep.warnings.push(`maintenance ${mw.name}: none of its monitors or groups exists here, skipped`); else rep.errors.push(`maintenance ${mw.name}: no valid targets`);
      continue;
    }
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
    step('statusPages');
    const id = pageIds.get(p.slug); count('statusPages', !!id);
    const values = { slug: p.slug, title: p.title, description: p.description ?? null, domain: p.domain ?? null, is_public: p.isPublic === false ? 0 : 1, sso_required: p.ssoRequired ? 1 : 0, branding: JSON.stringify(p.branding ?? {}), custom_css: p.customCss ?? null, show_history: p.showHistory === false ? 0 : 1, history_days: [14, 30, 60, 90, 120, 150, 180].includes(p.historyDays as number) ? (p.historyDays as number) : 90, ...(p.isDefault === true ? { is_default: 1 } : {}), ...(Number.isInteger(p.incidentDays) && p.incidentDays >= 0 && p.incidentDays <= 365 ? { incident_days: p.incidentDays as number } : {}), ...(Number.isInteger(p.incidentPageSize) && p.incidentPageSize >= 5 && p.incidentPageSize <= 50 ? { incident_page_size: p.incidentPageSize as number } : {}), ...(p.language === 'en' || p.language === 'de' ? { language: p.language } : p.language === null ? { language: null } : {}), ...(Number.isInteger(p.serverInfo) && p.serverInfo >= 0 && p.serverInfo <= 2 ? { server_info: p.serverInfo } : {}) };
    const comp = (c: any) => { const mid = monitorIds.get(c.monitor); if (!mid) rep.warnings.push(`status page ${p.slug}: monitor "${c.monitor}" not found`); return mid ? { monitor_id: mid, display_name: c.displayName ?? null } : null; };
    await w(() => db.transaction().execute(async (trx) => {
      let pid = id;
      if (values.is_default === 1) await trx.updateTable('status_pages').set({ is_default: 0 }).execute(); // only one home page; the update below or the insert sets this one
      if (pid) {
        const { is_public, sso_required, ...rest } = values; // a source that says nothing about access must not open a private page
        await trx.updateTable('status_pages').set({ ...rest, ...(p.isPublic !== undefined ? { is_public } : {}), ...(p.ssoRequired !== undefined ? { sso_required } : {}) }).where('id', '=', pid).execute(); await trx.deleteFrom('status_page_components').where('page_id', '=', pid).execute(); await trx.deleteFrom('status_page_sections').where('page_id', '=', pid).execute();
      } else pid = Number((await trx.insertInto('status_pages').values(values).executeTakeFirstOrThrow()).insertId);
      let sort = 0;
      for (const [i, s] of (p.sections ?? []).entries()) {
        const sid = Number((await trx.insertInto('status_page_sections').values({ page_id: pid!, name: s.name, sort: i }).executeTakeFirstOrThrow()).insertId);
        for (const c of s.components ?? []) { const x = comp(c); if (x) await trx.insertInto('status_page_components').values({ page_id: pid!, section_id: sid, sort: sort++, ...x }).execute(); }
      }
      for (const c of p.components ?? []) { const x = comp(c); if (x) await trx.insertInto('status_page_components').values({ page_id: pid!, section_id: null, sort: sort++, ...x }).execute(); }
      // announcements (pinned incidents of other systems) are added once: the same title and kind on this page is not added again
      for (const a of p.announcements ?? []) {
        const kind = ['info', 'maintenance', 'incident'].includes(a.kind) ? a.kind : 'info';
        const title = String(a.title ?? '').slice(0, 255);
        if (!title) continue;
        if (id && await trx.selectFrom('status_page_announcements').select('id').where('page_id', '=', pid!).where('title', '=', title).where('kind', '=', kind).executeTakeFirst()) continue;
        const from = a.startsAt ? new Date(a.startsAt) : new Date();
        const until = a.endsAt ? new Date(a.endsAt) : null;
        await trx.insertInto('status_page_announcements').values({ page_id: pid!, kind, title, body: a.body ? String(a.body).slice(0, 5000) : null, starts_at: Number.isNaN(from.getTime()) ? new Date() : from, ends_at: until && !Number.isNaN(until.getTime()) ? until : null }).execute();
      }
    }));
  } catch (e) { err(`status page ${p.slug}`, e); }

  onProgress?.({ phase: 'finishing', done: total, total });
  if (doc.settings?.ssrf && !dryRun) await ctx.settings.set('ssrf', doc.settings.ssrf);
  if (!dryRun) ctx.bus.publish({ type: 'config', entity: 'import' });
  return rep;
}

/* ------------------------- selective import (Kuma) ------------------------- */

/** Which parts of a converted document to import; a missing key means "all of it". */
export interface ImportSelection { groups?: string[]; tags?: string[]; channels?: string[]; monitors?: string[]; maintenance?: string[]; statusPages?: string[] }

/** `notes` list what was lost or changed while converting that one item (they are shown next to it, not as errors). */
export interface ImportItems {
  groups: { path: string; exists: boolean }[]; tags: { name: string; exists: boolean }[]; channels: { name: string; type: string; exists: boolean; notes?: string[] }[];
  monitors: { name: string; type: string; group: string | null; exists: boolean; notes?: string[] }[];
  maintenance: { name: string; kind: string; targets: number; exists: boolean; notes?: string[] }[];
  statusPages: { slug: string; title: string; components: number; exists: boolean; notes?: string[] }[];
  unsupported: Unsupported[];
}

const ancestors = (path: string) => path.split('/').filter(Boolean).map((_, i, a) => a.slice(0, i + 1).join('/'));

/** What a document would touch, with a flag for everything that already exists here (and would be updated instead of created). */
export async function describeImport(ctx: Ctx, doc: ConfigDoc): Promise<ImportItems> {
  const { db } = ctx;
  const [mons, chans, tagRows, pages, groups, windows] = await Promise.all([
    db.selectFrom('monitors').select('name').execute(), db.selectFrom('notification_channels').select('name').execute(), db.selectFrom('tags').select('name').execute(),
    db.selectFrom('status_pages').select('slug').execute(), db.selectFrom('monitor_groups').select(['id', 'parent_id', 'name']).execute(), db.selectFrom('maintenance_windows').select('name').execute(),
  ]);
  const have = (rows: { name?: string; slug?: string }[]) => new Set(rows.map((r) => r.name ?? r.slug));
  const monExists = have(mons), chExists = have(chans), tagExists = have(tagRows), pageExists = have(pages), windowExists = have(windows);
  const withNotes = (n: unknown) => (Array.isArray(n) && n.length ? { notes: n.map(String) } : {});
  const gpath = (id: number, seen = new Set<number>()): string => { const g = groups.find((x) => x.id === id); if (!g || seen.has(id)) return ''; seen.add(id); return (g.parent_id ? `${gpath(g.parent_id, seen)}/` : '') + g.name.replace(/\//g, '-'); };
  const groupExists = new Set(groups.map((g) => gpath(g.id)));
  const groupPaths = new Set([...(doc.groups ?? []).map((g) => g.path), ...(doc.monitors ?? []).map((m) => m.group).filter(Boolean) as string[]].flatMap(ancestors));
  const tagNames = new Set([...(doc.tags ?? []).map((t) => t.name), ...(doc.monitors ?? []).flatMap((m) => ((m.tags ?? []) as TagRef[]).map((t) => tagRef(t).name))]);
  return {
    groups: [...groupPaths].sort().map((path) => ({ path, exists: groupExists.has(path) })),
    tags: [...tagNames].sort().map((name) => ({ name, exists: tagExists.has(name) })),
    channels: (doc.channels ?? []).map((c) => ({ name: c.name, type: c.type, exists: chExists.has(c.name), ...withNotes(c.notes) })),
    monitors: (doc.monitors ?? []).map((m) => ({ name: m.name, type: m.type, group: m.group ?? null, exists: monExists.has(m.name), ...withNotes(m.notes) })),
    maintenance: (doc.maintenance ?? []).map((m) => ({ name: m.name, kind: m.kind, targets: (m.targets ?? []).length, exists: windowExists.has(m.name), ...withNotes(m.notes) })),
    statusPages: (doc.statusPages ?? []).map((p) => ({ slug: p.slug, title: p.title, components: (p.sections ?? []).reduce((n: number, s: any) => n + s.components.length, 0) + (p.components ?? []).length, exists: pageExists.has(p.slug), ...withNotes(p.notes) })),
    unsupported: doc.unsupported ?? [],
  };
}

/**
 * Narrows a document to the selection. Groups and tags are created implicitly by the monitors that use them, so de-selecting one detaches it from the
 * monitors instead (they land in the nearest selected parent group, or ungrouped). Notification channels stay referenced: names that exist here still link up.
 */
export function filterConfigDoc(doc: ConfigDoc, sel: ImportSelection): ConfigDoc {
  const only = <T>(items: T[] | undefined, names: string[] | undefined, key: (t: T) => string) => { if (!names) return items; const set = new Set(names); return items?.filter((i) => set.has(key(i))); };
  const groupSet = sel.groups ? new Set(sel.groups) : null;
  const tagSet = sel.tags ? new Set(sel.tags) : null;
  const nearest = (path: string | null | undefined) => { if (!path || !groupSet) return path ?? null; return ancestors(path).reverse().find((p) => groupSet.has(p)); }; // undefined: no selected group is left, so an existing monitor stays where it is
  const monitors = only(doc.monitors, sel.monitors, (m) => m.name)?.map((m) => ({ ...m, group: nearest(m.group), tags: tagSet ? ((m.tags ?? []) as TagRef[]).filter((t) => tagSet.has(tagRef(t).name)) : m.tags }));
  return { ...doc, groups: only(doc.groups, sel.groups, (g) => g.path), tags: only(doc.tags, sel.tags, (t) => t.name), channels: only(doc.channels, sel.channels, (c) => c.name), monitors, maintenance: only(doc.maintenance, sel.maintenance, (m) => m.name), statusPages: only(doc.statusPages, sel.statusPages, (p) => p.slug) };
}

/* ------------------------------ Uptime Kuma ------------------------------ */

const KUMA_TYPES: Record<string, string> = {
  http: 'http', keyword: 'keyword', 'json-query': 'json', 'real-browser': 'http', port: 'tcp', ping: 'ping', dns: 'dns', push: 'push', docker: 'docker', mqtt: 'mqtt',
  mysql: 'mysql', postgres: 'postgres', mongodb: 'mongodb', redis: 'redis', sqlserver: 'mssql', oracle: 'oracle', oracledb: 'oracle',
  ntp: 'ntp', radius: 'radius', rabbitmq: 'rabbitmq', 'kafka-producer': 'kafka', steam: 'steam', gamedig: 'gamedig', manual: 'manual', pm2: 'pm2', globalping: 'globalping',
  'grpc-keyword': 'grpc', 'websocket-upgrade': 'websocket', sftp: 'sftp', smtp: 'smtp', snmp: 'snmp',
};
/** Why a Kuma monitor type is skipped when the generic "no equivalent" text is not good enough. */
const KUMA_TYPE_REASONS: Record<string, string> = { 'tailscale-ping': 'Tailscale ping needs the Tailscale client on the checking host' };
const asObj = (v: unknown): Record<string, any> => (typeof v === 'string' ? parseJson(v, {}) : v && typeof v === 'object' ? (v as Record<string, any>) : {});
const list = (v: unknown): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
/** Like `list`, but also reads JSON text such as '["a","b"]' (how Kuma's database stores arrays). */
const jlist = (v: unknown): any[] => (typeof v === 'string' ? list(parseJson(v, [])) : list(v));
const clamp = (n: unknown, lo: number, hi: number, def: number) => { const x = n === null || n === '' ? NaN : Math.ceil(Number(n)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def; }; // a missing column is the default, not 0
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
const present = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== false && v !== 0;

type ChannelDoc = NonNullable<ConfigDoc['channels']>[number];

function kumaChannel(n: any, warnings: string[], unsupported: Unsupported[]): ChannelDoc | null {
  const c = asObj(n.config);
  const base = { name: String(n.name ?? c.name ?? `kuma-${n.id}`), active: n.active !== false && n.active !== 0, isDefault: !!(n.isDefault ?? c.isDefault) };
  const t = String(c.type ?? '').toLowerCase();
  const notes: string[] = [];
  const lost = (what: string, ...keys: string[]) => { if (keys.some((k) => present(c[k]))) notes.push(`${what} is not carried over`); };
  const pick = (type: string, config: Record<string, any>): ChannelDoc => ({ ...base, type, config: Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== null && v !== '')) });
  const out = ((): ChannelDoc | null => {
    switch (t) {
      case 'telegram': lost('The custom Telegram server, thread, silent or protect option', 'telegramServerUrl', 'telegramMessageThreadID', 'telegramSendSilently', 'telegramProtectContent'); return pick('telegram', { botToken: c.telegramBotToken, chatId: c.telegramChatID });
      case 'discord': lost('The Discord username or message prefix', 'discordUsername', 'discordPrefixMessage'); return pick('discord', { webhookUrl: c.discordWebhookUrl });
      case 'slack': lost('The Slack channel, username or icon', 'slackchannel', 'slackusername', 'slackiconemo', 'slackchannelnotify'); return pick('slack', { webhookUrl: c.slackwebhookURL });
      case 'teams': return pick('teams', { webhookUrl: c.webhookUrl });
      case 'ntfy':
        if (c.ntfyAuthenticationMethod === 'usernamePassword') notes.push('Username/password authentication is not supported, add an access token instead');
        return pick('ntfy', { server: c.ntfyserverurl, topic: c.ntfytopic, token: c.ntfyaccesstoken, priority: c.ntfyPriority });
      case 'gotify': return pick('gotify', { server: c.gotifyserverurl, token: c.gotifyapplicationToken, priority: c.gotifyPriority });
      case 'pushover': lost('The Pushover sound, device or title', 'pushoversounds', 'pushoverdevice', 'pushovertitle'); return pick('pushover', { appToken: c.pushoverapptoken, userKey: c.pushoveruserkey, priority: c.pushoverpriority });
      case 'webhook':
        warnings.push(`notification "${base.name}": webhook payloads differ, review the body template`);
        if (c.webhookContentType === 'custom' && present(c.webhookCustomBody)) notes.push('The custom body uses Uptime Kuma placeholders and is not converted, the default JSON payload is sent instead');
        else if (c.webhookContentType === 'form-data') notes.push('Form-data payloads are not supported, JSON is sent instead');
        return pick('webhook', { url: c.webhookURL, method: 'POST', headers: asObj(c.webhookAdditionalHeaders) });
      case 'smtp':
        lost('CC and BCC recipients', 'smtpCC', 'smtpBCC'); lost('Ignoring TLS errors', 'smtpIgnoreTLSError'); lost('DKIM signing', 'smtpDkimDomain');
        return pick('email', { host: c.smtpHost, port: c.smtpPort, security: c.smtpSecure ? 'ssl' : 'starttls', username: c.smtpUsername, password: c.smtpPassword, from: c.smtpFrom, to: c.smtpTo });
      default: return null;
    }
  })();
  if (!out) {
    const kind = String(c.type ?? '') || 'unknown'; // the type as Kuma names it, not lowercased
    warnings.push(`notification "${base.name}": type "${kind}" is not supported, skipped`);
    unsupported.push({ kind: 'notification', name: base.name, reason: `Kuma notification type "${kind}" has no equivalent here` });
    return null;
  }
  if (truthy(c.applyExisting)) notes.push('"Apply on all existing monitors" was a one-time action in Uptime Kuma, check which monitors should use this channel');
  if (notes.length) out.notes = notes;
  return out;
}

/** A wall-clock time in an IANA zone as a UTC date; the zone's offset is looked up twice so that a daylight saving jump in between is covered. */
function zonedToUtc(p: { y: number; mo: number; d: number; h: number; mi: number; s: number }, tz: string): Date {
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const offset = (t: number) => {
    const x = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t)).map((q) => [q.type, q.value]));
    return Date.UTC(+x.year, +x.month - 1, +x.day, +x.hour, +x.minute, +x.second) - Math.floor(t / 1000) * 1000;
  };
  return new Date(wall - offset(wall - offset(wall)));
}
const localParts = (v: unknown) => { const x = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v ?? '').trim()); return x ? { y: +x[1], mo: +x[2], d: +x[3], h: +(x[4] ?? 0), mi: +(x[5] ?? 0), s: +(x[6] ?? 0) } : null; };
/** Minutes since midnight from "HH:mm" (database) or {hours, minutes} (socket). */
const minutesOfDay = (v: unknown): number | null => {
  if (v && typeof v === 'object') { const h = Number((v as any).hours), mi = Number((v as any).minutes); return Number.isFinite(h) && Number.isFinite(mi) ? h * 60 + mi : null; }
  const x = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '')); return x ? Number(x[1]) * 60 + Number(x[2]) : null;
};
const validZone = (tz: unknown): string | null => { try { return typeof tz === 'string' && tz ? (new Intl.DateTimeFormat('en', { timeZone: tz }), tz) : null; } catch { return null; } };

interface MaintenanceCtx { monById: Map<number, any>; nameById: Map<number, string>; groupPath: (id: number) => string | null; serverTz: string; warnings: string[]; unsupported: Unsupported[] }

/**
 * Kuma maintenance windows. Strategies that map exactly become a one-time or cron window (a cron start plus a duration); everything else is listed as unsupported with the reason.
 * Kuma stores `duration` in seconds and builds the cron of weekday / day-of-month windows from the time range, so those are rebuilt here from the fields.
 */
function kumaMaintenance(items: any[], k: MaintenanceCtx): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const used = new Set<string>();
  const now = Date.now();
  for (const m of items) {
    if (!m || typeof m !== 'object') continue;
    const notes: string[] = [];
    const base = String(m.title ?? m.name ?? `maintenance ${m.id}`).slice(0, 240) || `maintenance ${m.id}`;
    let title = base;
    for (let n = 2; used.has(title.toLowerCase()); n++) title = `${base} (${n})`;
    used.add(title.toLowerCase());
    const skip = (reason: string) => { k.unsupported.push({ kind: 'maintenance', name: title, reason }); k.warnings.push(`maintenance "${title}": ${reason}, skipped`); };
    const strategy = String(m.strategy ?? '').toLowerCase();
    if (strategy === 'manual') { skip('it has no schedule, it is switched on and off by hand in Uptime Kuma'); continue; }
    if (!Array.isArray(m.monitorIds)) { skip('the monitors it applies to could not be read from the source'); continue; }

    const targets: { type: 'monitor' | 'group'; name: string }[] = [];
    let missing = 0;
    for (const raw of m.monitorIds) {
      const id = Number(raw);
      const mon = k.monById.get(id);
      const group = mon?.type === 'group' ? k.groupPath(id) : null;
      const name = k.nameById.get(id);
      if (group) targets.push({ type: 'group', name: group }); else if (name) targets.push({ type: 'monitor', name }); else missing++;
    }
    if (!targets.length) { skip(m.monitorIds.length ? `none of its ${m.monitorIds.length} monitor(s) is part of the import` : 'it is not linked to any monitor'); continue; }
    if (missing) notes.push(`${missing} linked monitor(s) are not part of the import`);

    const opt = m.timezoneOption ?? m.timezone;
    const tz = (opt && opt !== 'SAME_AS_SERVER' ? validZone(opt) : null) ?? (m.timezoneOption === 'SAME_AS_SERVER' ? validZone(m.timezone) : null) ?? k.serverTz;
    if (opt && opt !== 'SAME_AS_SERVER' && !validZone(opt)) notes.push(`the time zone "${opt}" is unknown here, ${tz} is used`);

    let kind: 'once' | 'cron' = 'cron';
    let startsAt: string | null = null, endsAt: string | null = null, cronExpr: string | null = null, durationMin: number | null = null;
    const failure = ((): string | null => {
      const ds = m.startDate ?? m.dateRange?.[0], de = m.endDate ?? m.dateRange?.[1];
      if (strategy === 'single') {
        const a = localParts(ds), b = localParts(de);
        if (!a || !b) return 'its start or end date is missing';
        const s = zonedToUtc(a, tz), e = zonedToUtc(b, tz);
        if (!(e > s)) return 'its end is not after its start';
        kind = 'once'; startsAt = s.toISOString(); endsAt = e.toISOString();
        if (e.getTime() < now) notes.push('this window is already over');
        return null;
      }
      if (strategy === 'cron') {
        cronExpr = String(m.cron ?? '').trim();
        const mins = Math.round(Number(m.durationMinutes ?? Number(m.duration) / 60));
        if (!cronExpr || !Number.isFinite(mins) || mins < 1) return 'its cron expression or duration is missing';
        durationMin = Math.min(43200, mins);
        if (mins > 43200) notes.push('the duration was capped at 30 days');
      } else if (strategy.startsWith('recurring-')) {
        const from = minutesOfDay(m.startTime ?? m.timeRange?.[0]), to = minutesOfDay(m.endTime ?? m.timeRange?.[1]);
        if (from === null || to === null || from === to) return 'its start and end time are missing or equal';
        // Kuma's validity range (from/until) has no equivalent: a window that would outlive it, or only start later, is not imported instead of suppressing alerts at the wrong time
        const sd = localParts(ds);
        if (localParts(de)) return 'it is only valid until a given date, which maintenance windows here cannot express';
        if (sd && zonedToUtc(sd, tz).getTime() > now) return 'it only becomes valid on a future date, which maintenance windows here cannot express';
        const at = `${from % 60} ${Math.floor(from / 60)}`;
        durationMin = (to - from + 1440) % 1440;
        if (strategy === 'recurring-interval') {
          if (Number(m.intervalDay ?? 1) !== 1) return `it repeats every ${m.intervalDay} days, which a cron schedule cannot express exactly`;
          cronExpr = `${at} * * *`;
        } else if (strategy === 'recurring-weekday') {
          const days = [...new Set(jlist(m.weekdays).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 7))].sort((a, b) => a - b);
          if (!days.length) return 'no weekday is selected';
          cronExpr = `${at} * * ${days.join(',')}`;
        } else if (strategy === 'recurring-day-of-month') {
          const raw = jlist(m.daysOfMonth);
          const days = raw.map((d) => (d === 'lastDay1' ? 'L' : Number.isInteger(Number(d)) && Number(d) >= 1 && Number(d) <= 31 ? Number(d) : null)).filter((d) => d !== null);
          if (raw.length > days.length) notes.push('days counted from the end of the month other than the last day are not supported and were dropped');
          if (!days.length) return 'no usable day of the month is selected';
          cronExpr = `${at} ${[...new Set(days)].join(',')} * *`;
        } else return `unknown schedule type "${strategy}"`;
      } else return `unknown schedule type "${strategy || 'none'}"`;
      try { new Cron(cronExpr!, { timezone: tz }); } catch (e) { return `its cron expression "${cronExpr}" is not valid here (${(e as Error).message})`; }
      return null;
    })();
    if (failure) { skip(failure); continue; }

    const pages = Array.isArray(m.statusPageIds) ? m.statusPageIds.length : 0;
    if (pages) notes.push(`it is announced on every status page that shows the affected monitors, Uptime Kuma showed it only on ${pages} selected page(s)`);
    out.push({
      name: title, description: m.description ? String(m.description).slice(0, 5000) : null, kind, startsAt, endsAt, cronExpr, durationMin, timezone: tz, active: m.active !== false && m.active !== 0, announce: pages > 0,
      targets, ...(notes.length ? { notes } : {}),
    });
  }
  return out;
}

/** Kuma settings that cannot be taken over, with what to do instead; settings that are mapped (entry page, time zone, certificate warning days) are handled elsewhere. */
const KUMA_SETTINGS: Record<string, { reason: string; secret?: boolean }> = {
  primaryBaseURL: { reason: 'The public address is set with the PW_BASE_URL environment variable' },
  keepDataPeriodDays: { reason: 'Data retention is set with the PW_RETENTION_* environment variables' },
  trustProxy: { reason: 'Reverse proxy trust is set with the PW_TRUST_PROXY environment variable' },
  disableAuth: { reason: 'Authentication cannot be switched off' },
  chromeExecutable: { reason: 'Browser Engine monitors are not supported' },
  steamAPIKey: { reason: 'Not needed, Steam monitors query the game server directly', secret: true },
  searchEngineIndex: { reason: 'No equivalent setting' }, checkUpdate: { reason: 'No equivalent setting' }, nscd: { reason: 'No equivalent setting' }, dnsCache: { reason: 'No equivalent setting' },
};

/** Kuma status pages become portable pages; every Kuma group turns into a section, monitors that were not imported are dropped with a warning. */
function kumaPages(pages: any[], nameById: Map<number, string>, warnings: string[], unsupported: Unsupported[], entrySlug: string | null): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const slugs = new Set<string>();
  let noLayout = 0, incidents = 0, extraDomains = 0;
  for (const p of pages) {
    if (!p || typeof p !== 'object' || !p.slug) continue;
    const slug = String(p.slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 63);
    if (!slug || slugs.has(slug)) {
      warnings.push(`status page "${p.slug}": slug is empty or duplicated after conversion, skipped`);
      unsupported.push({ kind: 'statusPage', name: String(p.title ?? p.slug), reason: 'its address is empty or duplicated after conversion' });
      continue;
    }
    slugs.add(slug);
    const notes: string[] = [];
    const dropped: string[] = [];
    const sections = Array.isArray(p.groups) ? p.groups.map((g: any) => ({
      name: String(g.name || 'Services').slice(0, 255),
      components: list(g.monitors).map((m: any) => { const n = nameById.get(Number(m.id ?? m)); if (!n) dropped.push(String(m.id ?? m)); return n ? { monitor: n, displayName: null } : null; }).filter(Boolean),
    })).filter((s: any) => s.components.length) : [];
    if (!Array.isArray(p.groups)) noLayout++;
    if (dropped.length) {
      warnings.push(`status page "${slug}": ${dropped.length} monitor(s) are not part of the import (unsupported type or missing) and were left out`);
      notes.push(`${dropped.length} monitor(s) are not part of the import and were left out`);
    }
    // a pinned incident becomes an announcement; one without any text cannot
    const announcements = list(p.incidents).filter((i: any) => i && (i.title || i.content)).map((i: any) => {
      const created = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(String(i.createdDate ?? '')) ? new Date(`${String(i.createdDate).replace(' ', 'T').replace(/Z$/, '')}Z`) : null;
      return { kind: i.style === 'warning' || i.style === 'danger' ? 'incident' : 'info', title: String(i.title || 'Incident').slice(0, 255), body: i.content ? String(i.content).slice(0, 5000) : null, ...(created && !Number.isNaN(created.getTime()) ? { startsAt: created.toISOString() } : {}) };
    });
    const bare = (p.incidents ? list(p.incidents).length : p.hasIncident ? 1 : 0) - announcements.length;
    if (bare > 0) { incidents += bare; unsupported.push({ kind: 'incident', name: String(p.title || slug), reason: 'a pinned incident without title or text, there is nothing to carry over' }); }
    if (announcements.length) notes.push(`${announcements.length} pinned incident(s) imported as announcements`);
    const domains = list(p.domainNameList).map(String).filter(Boolean);
    if (domains.length > 1) { extraDomains++; notes.push(`the domains ${domains.slice(1).join(', ')} were not imported, only the first one is kept`); }
    const icon = typeof p.icon === 'string' && /^https?:\/\//i.test(p.icon) ? p.icon : undefined;
    if (p.icon && !icon) notes.push(`the icon "${String(p.icon).slice(0, 100)}" is a path on the Uptime Kuma server and was not imported`);
    if (p.theme && p.theme !== 'auto') notes.push(`the theme "${p.theme}" is not carried over`);
    if (truthy(p.showTags)) notes.push('showing tags on the page is not carried over');
    if (p.showPoweredBy === false || p.showPoweredBy === 0) notes.push('hiding the "powered by" line is not carried over');
    if (truthy(p.showCertificateExpiry)) notes.push('showing certificate expiry is not carried over');
    if (present(p.autoRefreshInterval) && Number(p.autoRefreshInterval) !== 300) notes.push(`the auto refresh interval of ${p.autoRefreshInterval} seconds is not carried over`);
    if (present(p.googleAnalyticsId)) notes.push('the Google Analytics ID is not carried over');
    if (present(p.rssTitle)) notes.push('the RSS feed title is not carried over');
    const isDefault = !!entrySlug && entrySlug === slug;
    if (isDefault) notes.push("it becomes the default (home) page, because it was Uptime Kuma's entry page");
    out.push({
      slug, title: String(p.title || slug).slice(0, 255), description: p.description ? String(p.description).slice(0, 5000) : null, domain: domains[0]?.toLowerCase() ?? null,
      ...(p.published === false || p.published === 0 ? { isPublic: false } : {}), branding: { ...(icon ? { logoUrl: icon } : {}), ...(p.footerText ? { footer: String(p.footerText).slice(0, 500) } : {}) },
      customCss: p.customCSS ?? p.customCss ?? null, showHistory: true, sections, components: [], ...(isDefault ? { isDefault: true } : {}), ...(announcements.length ? { announcements } : {}), ...(notes.length ? { notes } : {}),
    });
  }
  if (noLayout) warnings.push(`${noLayout} status page(s) came without their layout (monitor groups), they are imported empty. Add the components under Status pages.`);
  if (extraDomains) warnings.push(`${extraDomains} status page(s) have several domains in Uptime Kuma, only the first one was kept.`);
  if (incidents) warnings.push(`${incidents} pinned incident(s) on Uptime Kuma status pages were not imported (no title or text to carry over).`);
  return out;
}

/** Parses scheme://user:pass@host:port/db style strings into runner fields. */
function connFields(s: string | undefined): Record<string, any> | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return { host: u.hostname, port: u.port ? Number(u.port) : undefined, database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
  } catch { return null; }
}

/** A Kuma docker host as the endpoint field of the docker monitor: a socket path or the http(s) URL of the remote API. */
function dockerEndpoint(h: { type?: string; daemon?: string }): string | null {
  const d = String(h.daemon ?? '').trim();
  if (!d) return null;
  if (/^tcp:\/\//i.test(d)) return `http://${d.slice(6)}`;
  if (/^unix:\/\//i.test(d)) return d.slice(7) || null;
  return d;
}

/** The per-item `notes` of a converted document as warning lines, for the import path that has no item list to show them next to (the plain 1.x backup upload). */
export function noteWarnings(doc: ConfigDoc): string[] {
  const out: string[] = [];
  const add = (what: string, items: { notes?: string[] }[] | undefined, label: (i: any) => string) => { for (const i of items ?? []) for (const n of i.notes ?? []) out.push(`${what} "${label(i)}": ${n}`); };
  add('channel', doc.channels, (i) => i.name); add('monitor', doc.monitors, (i) => i.name); add('maintenance', doc.maintenance, (i) => i.name); add('status page', doc.statusPages, (i) => i.slug);
  return out;
}

/** Converts an Uptime Kuma backup, database or API snapshot into the portable configuration document; `unsupported` lists everything that has no equivalent here. */
export function convertKuma(raw: unknown): { doc: ConfigDoc; warnings: string[]; unsupported: Unsupported[] } {
  const warnings: string[] = [];
  const unsupported: Unsupported[] = [];
  const src = asObj(raw);
  const mons = list(src.monitorList);
  const notes = list(src.notificationList);
  const settings = asObj(src.settings);
  if (!mons.length && !notes.length) warnings.push('The file contains no monitors or notifications. Expected an Uptime Kuma 1.x backup JSON.');

  const channels: NonNullable<ConfigDoc['channels']> = [];
  const chName = new Map<string, string>();
  const lostChannel = new Map<string, string>();
  for (const n of notes) { const c = kumaChannel(n, warnings, unsupported); if (c) { channels.push(c); chName.set(String(n.id), c.name); } else lostChannel.set(String(n.id), String(n.name ?? asObj(n.config).name ?? `kuma-${n.id}`)); }

  const byId = new Map(mons.map((m) => [m.id, m]));
  const groupPath = (id: number | null | undefined, seen = new Set<number>()): string | null => {
    const g = id ? byId.get(id) : undefined;
    if (!g || seen.has(g.id)) return null;
    seen.add(g.id);
    const parent = groupPath(g.parent, seen);
    return (parent ? `${parent}/` : '') + String(g.name).replace(/\//g, '-');
  };
  const groups: NonNullable<ConfigDoc['groups']> = mons.filter((m) => m.type === 'group').map((m) => ({ path: groupPath(m.id)!, description: m.description ?? null })).filter((g) => g.path);

  const dockerHosts = new Map(list(src.dockerHosts).map((h: any) => [Number(h.id), h]));
  const proxies = new Map(list(src.proxies).map((p: any) => [Number(p.id), p]));
  const proxyUse = new Map<number, number>();
  // Kuma warns at several days before expiry, here is one threshold: the earliest warning
  const expiryDays = list(settings.tlsExpiryNotifyDays).map(Number).filter((d) => Number.isFinite(d) && d > 0);
  const tlsDays = expiryDays.length ? clamp(Math.max(...expiryDays), 1, 365, 14) : 14;
  if (expiryDays.length > 1) warnings.push(`settings: Uptime Kuma warns about expiring certificates ${expiryDays.join(', ')} days before, a single threshold of ${tlsDays} days is used here`);

  const tags = new Map<string, string | undefined>();
  const monitors: Record<string, any>[] = [];
  const nameById = new Map<number, string>();
  const usedNames = new Set<string>();
  for (const m of mons) {
    if (m.type === 'group') continue;
    const mnotes: string[] = [];
    const skip = (reason: string) => { unsupported.push({ kind: 'monitor', name: String(m.name), reason }); warnings.push(`monitor "${m.name}": ${reason}, skipped`); };
    let type = KUMA_TYPES[m.type];
    if ((m.type === 'gamedig' || m.type === 'steam') && String(m.game ?? '').includes('minecraft')) type = 'minecraft';
    if (!type) { unsupported.push({ kind: 'monitor', name: String(m.name), reason: KUMA_TYPE_REASONS[m.type] ?? `Kuma monitor type "${m.type}" has no equivalent here` }); warnings.push(`monitor "${m.name}": type "${m.type}" is not supported, skipped`); continue; }
    const runner = getRunner(type);
    if (!runner) { skip(`the monitor type "${type}" is not available in this version`); continue; }
    if (m.upsideDown) { warnings.push(`monitor "${m.name}": "upside down mode" is not supported and was ignored`); mnotes.push('"Upside down mode" is not supported and was ignored, the monitor checks normally'); }
    let config: Record<string, any> = {};
    const hostname = m.hostname ?? undefined;
    let bad: string | null = null; // set when the monitor cannot be converted
    switch (type) {
      case 'http': case 'keyword': case 'json': {
        const status = list(m.accepted_statuscodes ?? (typeof m.accepted_statuscodes_json === 'string' ? parseJson(m.accepted_statuscodes_json, []) : [])).join(',') || '200-299';
        const redirects = Number(m.maxredirects ?? 10);
        const headers = asObj(m.headers);
        const encoding = String(m.httpBodyEncoding ?? '').toLowerCase();
        if (m.body && (encoding === 'json' || encoding === 'xml') && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = encoding === 'json' ? 'application/json' : 'text/xml';
        config = {
          url: m.url, method: m.method ?? 'GET', expectedStatus: status, headers, body: m.body ?? undefined, verifyTls: !m.ignoreTls, followRedirects: redirects > 0, maxRedirects: Math.max(redirects, 1), tlsExpiryDays: m.expiryNotification ? tlsDays : 0,
          ...(m.authMethod === 'basic' ? { authType: 'basic', basicUser: m.basic_auth_user, basicPass: m.basic_auth_pass } : {}),
          ...(type === 'keyword' ? { keyword: m.keyword, invert: !!m.invertKeyword, caseSensitive: false } : {}),
          ...(type === 'json' ? { jsonPath: String(m.jsonPath ?? '$'), jsonOp: m.jsonPathOperator === '!=' ? 'ne' : m.jsonPathOperator === '>' ? 'gt' : m.jsonPathOperator === '<' ? 'lt' : m.jsonPathOperator === 'contains' ? 'contains' : 'eq', jsonExpected: m.expectedValue != null ? String(m.expectedValue) : undefined } : {}),
        };
        if (m.authMethod && !['basic', 'none', null].includes(m.authMethod)) { warnings.push(`monitor "${m.name}": auth method "${m.authMethod}" is not supported, credentials were dropped`); mnotes.push(`The auth method "${m.authMethod}" is not supported, the credentials were dropped`); }
        if (m.type === 'real-browser') mnotes.push('Checked with a plain HTTP request, not a real browser');
        break;
      }
      case 'tcp': config = { host: hostname, port: m.port }; break;
      case 'ping': config = { host: hostname }; break;
      case 'dns': config = { host: hostname, recordType: m.dns_resolve_type ?? 'A', resolver: m.dns_resolve_server && m.dns_resolve_server !== '1.1.1.1' ? m.dns_resolve_server : undefined }; break;
      case 'push': config = { graceSeconds: 60 }; mnotes.push('It gets a new push URL, update whatever sends the heartbeat'); break;
      case 'docker': {
        const hostId = m.dockerHost ?? m.docker_host;
        const known = hostId != null && hostId !== '' ? dockerHosts.get(Number(hostId)) : undefined;
        const endpoint = known ? dockerEndpoint(known) : null;
        if (hostId != null && hostId !== '' && !endpoint) mnotes.push(`The docker host #${hostId} was not found, the default socket /var/run/docker.sock is used`);
        config = { container: m.dockerContainer ?? m.docker_container, endpoint: endpoint ?? '/var/run/docker.sock' };
        break;
      }
      case 'mqtt': config = { host: hostname, port: m.port ?? 1883, topic: m.mqttTopic, expect: m.mqttSuccessMessage, username: m.mqttUsername, password: m.mqttPassword }; break;
      case 'minecraft': config = { host: hostname, port: m.port ?? 25565 }; break;
      case 'ntp': config = { host: hostname, port: m.port ?? 123 }; break;
      case 'radius': config = { host: hostname, port: m.port ?? 1812, secret: m.radiusSecret, username: m.radiusUsername, password: m.radiusPassword, calledStationId: m.radiusCalledStationId, callingStationId: m.radiusCallingStationId }; break;
      case 'rabbitmq': {
        const nodes = jlist(m.rabbitmqNodes).map((x) => String(x).trim()).filter(Boolean);
        if (!nodes.length) { bad = 'no RabbitMQ node is configured'; break; }
        if (nodes.length > 1) mnotes.push(`Only the first of ${nodes.length} nodes is checked`);
        config = { url: /^https?:\/\//i.test(nodes[0]) ? nodes[0] : `http://${nodes[0]}`, username: m.rabbitmqUsername, password: m.rabbitmqPassword, verifyTls: !m.ignoreTls };
        break;
      }
      case 'kafka': {
        const brokers = jlist(m.kafkaProducerBrokers).map((x) => String(x).trim()).filter(Boolean);
        if (!brokers.length) { bad = 'no Kafka broker is configured'; break; }
        config = { brokers: brokers.join(','), topic: m.kafkaProducerTopic, tls: truthy(m.kafkaProducerSsl), verifyTls: !m.ignoreTls };
        mnotes.push('The broker is queried for its metadata, no message is produced');
        const sasl = asObj(m.kafkaProducerSaslOptions);
        if (present(sasl.mechanism) && String(sasl.mechanism).toLowerCase() !== 'none') mnotes.push('SASL authentication is not carried over');
        break;
      }
      case 'steam': config = { host: hostname, port: m.port ?? 27015 }; mnotes.push('Checked with the game server query protocol, not the Steam web API'); break;
      case 'gamedig': if (!m.game) { bad = 'no game is selected'; break; } config = { game: m.game, host: hostname, port: m.port }; break;
      case 'manual': config = { state: Number(m.manualStatus) === 0 || String(m.manualStatus).toLowerCase() === 'down' ? 'down' : 'up' }; break;
      case 'pm2': { const name = m.pm2ProcessName ?? m.processName; if (!name) { bad = 'no PM2 process name is set'; break; } config = { processName: name }; break; }
      case 'oracle': {
        const f = connFields(m.databaseConnectionString);
        if (!f) { bad = 'the connection string could not be read'; break; }
        config = { host: f.host, port: f.port ?? 1521, serviceName: f.database, username: f.username, password: f.password, ...(m.databaseQuery ? { query: m.databaseQuery } : {}) };
        break;
      }
      case 'globalping': {
        const measurement = String(m.subtype ?? m.globalpingType ?? 'ping').toLowerCase();
        if (measurement !== 'ping' && measurement !== 'http') { bad = `the Globalping measurement "${measurement}" is not supported (ping and http are)`; break; }
        config = { measurement, target: measurement === 'http' ? m.url ?? hostname : hostname ?? m.url, location: m.location ?? m.globalpingLocation, token: m.globalpingToken ?? m.token }; // the http measurement takes a full URL
        mnotes.push('Check the measurement location and API token');
        break;
      }
      case 'grpc': {
        const addr = String(m.grpcUrl ?? '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
        const i = addr.lastIndexOf(':');
        const host = (i > 0 ? addr.slice(0, i) : addr) || hostname;
        if (!host) { bad = 'no gRPC address is set'; break; }
        config = { host, port: (i > 0 ? Number(addr.slice(i + 1)) : undefined) || m.port || 443, service: m.grpcServiceName, useTls: truthy(m.grpcEnableTls), verifyTls: !m.ignoreTls };
        mnotes.push('Only the standard gRPC health check is run, the keyword, method and request body are not used');
        break;
      }
      case 'websocket': config = { url: m.url, verifyTls: !m.ignoreTls }; if (present(m.wsSubprotocol)) mnotes.push('The WebSocket subprotocol is not carried over'); break;
      case 'sftp': config = { host: hostname, port: m.port ?? 22, username: m.basic_auth_user, authMethod: 'password', password: m.basic_auth_pass }; break;
      case 'smtp': config = { host: hostname, port: m.port ?? 25, security: m.smtpSecurity === 'secure' ? 'implicit' : m.smtpSecurity === 'starttls' ? 'starttls' : 'none', verifyTls: !m.ignoreTls }; break;
      case 'snmp': {
        const ops: Record<string, string> = { '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', contains: 'contains' };
        const op = m.jsonPathOperator && present(m.expectedValue) ? ops[String(m.jsonPathOperator)] : undefined;
        if (m.jsonPathOperator && present(m.expectedValue) && !op) mnotes.push(`The condition "${m.jsonPathOperator}" is not supported, the check only requires a value`);
        const version = String(m.snmpVersion ?? '2c');
        if (version !== '2c' && version !== '2') mnotes.push(version === '3' ? 'SNMP v3 users and keys are not carried over, the check uses the community string (v2c)' : `SNMP v${version} is checked as v2c`);
        config = { host: hostname, port: m.port ?? 161, community: m.radiusPassword ?? 'public', oid: m.snmpOid, op: op ?? 'exists', ...(op ? { expected: String(m.expectedValue) } : {}) };
        break;
      }
      default: {
        const f = connFields(m.databaseConnectionString);
        if (!f) { warnings.push(`monitor "${m.name}": connection string could not be converted, fill in host and credentials after the import`); mnotes.push('The connection string could not be converted, fill in host and credentials'); config = { host: 'localhost' }; }
        else config = { ...f, ...(m.databaseQuery ? { query: m.databaseQuery } : {}) };
        if (type === 'redis') delete (config as any).database;
      }
    }
    if (bad) { skip(bad); continue; }
    const cfg = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    // a monitor that would fail validation is listed instead of blocking the whole import
    const invalid = validateConfig(runner, cfg).errors;
    if (invalid.length) { skip(`incomplete after conversion (${invalid.join('; ')})`); continue; }

    for (const t of list(m.tags)) tags.set(String(t.name), /^#[0-9a-f]{6}$/i.test(t.color ?? '') ? t.color : undefined);
    if (Number(m.resendInterval) > 0) mnotes.push(`"Resend notification every ${m.resendInterval} checks" is not carried over, use an escalation policy to repeat alerts`);
    const proxy = m.proxyId != null ? proxies.get(Number(m.proxyId)) : undefined;
    if (m.proxyId != null && m.proxyId !== '') { proxyUse.set(Number(m.proxyId), (proxyUse.get(Number(m.proxyId)) ?? 0) + 1); mnotes.push(`It used the proxy ${proxy?.name ? `"${proxy.name}"` : `#${m.proxyId}`}, which is not supported: requests go out directly`); }
    const linked = Object.entries(asObj(m.notificationIDList)).filter(([, on]) => on);
    const lostNames = linked.map(([id]) => lostChannel.get(id)).filter(Boolean);
    if (lostNames.length) mnotes.push(`The notification channel(s) ${lostNames.map((n) => `"${n}"`).join(', ')} could not be imported, so this monitor does not use them`);
    // Kuma allows equal names but names are the key here: equal ones would overwrite each other
    let name = String(m.name).slice(0, 255);
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${String(m.name).slice(0, 240)} (${n})`;
    if (name !== String(m.name)) warnings.push(`monitor "${m.name}": the name is used twice in Uptime Kuma, imported as "${name}"`);
    usedNames.add(name.toLowerCase());
    nameById.set(Number(m.id), name);
    monitors.push({
      name, type, group: groupPath(m.parent), description: m.description ?? null, config: cfg,
      intervalS: clamp(m.interval, 5, 86400, 60), timeoutS: clamp(m.timeout, 1, 300, 10), retries: clamp(m.maxretries, 0, 20, 0), retryIntervalS: clamp(m.retryInterval, 5, 3600, 60), active: m.active !== false && m.active !== 0,
      tags: list(m.tags).map((t) => (present(t.value) ? { name: String(t.name), value: String(t.value).trim().slice(0, 255) } : String(t.name))),
      notifications: linked.map(([id]) => chName.get(id)).filter(Boolean).map((channel) => ({ channel, events: ['down', 'up'] })),
      ...(mnotes.length ? { notes: mnotes } : {}),
    });
  }

  // maintenance windows, then everything that is only reported
  const serverTz = validZone(settings.serverTimezone) ?? 'UTC';
  const monById = new Map(mons.map((m) => [Number(m.id), m]));
  const maintenance = kumaMaintenance(list(src.maintenanceList), { monById, nameById, groupPath: (id) => groupPath(id), serverTz, warnings, unsupported });
  for (const [key, def] of Object.entries(KUMA_SETTINGS)) {
    if (!present(settings[key])) continue;
    unsupported.push({ kind: 'setting', name: key, reason: `${def.reason}${def.secret || typeof settings[key] === 'object' ? '' : ` (Uptime Kuma value: ${String(settings[key]).slice(0, 80)})`}` });
  }
  for (const p of list(src.proxies)) unsupported.push({ kind: 'proxy', name: String(p.name ?? p.detail ?? `proxy ${p.id}`), reason: `Proxies are not supported, monitors check directly${proxyUse.get(Number(p.id)) ? ` (${proxyUse.get(Number(p.id))} monitor(s) used it)` : ''}` });
  for (const k of list(src.apiKeys)) unsupported.push({ kind: 'apiKey', name: String(k.name ?? `key ${k.id}`), reason: 'API keys cannot be carried over, create a new API token here instead' });
  for (const b of list(src.remoteBrowsers)) unsupported.push({ kind: 'browser', name: String(b.name ?? `browser ${b.id}`), reason: 'Remote browsers are not supported, Browser Engine monitors are checked with a plain HTTP request' });
  const entry = typeof settings.entryPage === 'string' && settings.entryPage.startsWith('statusPage-') ? settings.entryPage.slice(11).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 63) : null;
  const statusPages = kumaPages(list(src.statusPageList), nameById, warnings, unsupported, entry);
  return {
    doc: { version: 1, merge: true, groups, tags: [...tags].map(([name, color]) => ({ name, color })), channels, monitors, ...(maintenance.length ? { maintenance } : {}), ...(statusPages.length ? { statusPages } : {}), unsupported },
    warnings, unsupported,
  };
}
