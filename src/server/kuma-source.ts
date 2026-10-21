import { io, type Socket } from 'socket.io-client';
import type { NetGuard } from '../core/guard';

/** A pinned incident of a Kuma status page. */
export interface KumaIncident { title?: string; content?: string; style?: string; createdDate?: string }
/** One Kuma status page as `convertKuma` reads it; `groups` is absent when the source could not provide the page layout. */
export interface KumaPage {
  id?: number; slug: string; title?: string; description?: string | null; icon?: string | null; published?: boolean | number; footerText?: string | null; customCSS?: string | null;
  domainNameList?: string[]; groups?: { name: string; monitors: { id: number }[] }[]; hasIncident?: boolean; incidents?: KumaIncident[];
  theme?: string | null; showTags?: boolean | number; showPoweredBy?: boolean | number; showCertificateExpiry?: boolean | number; autoRefreshInterval?: number | null; googleAnalyticsId?: string | null; rssTitle?: string | null;
}
/** Non-secret parts of the other Kuma objects that cannot be imported; they are only listed. Secrets (proxy passwords, API keys) are never read into memory beyond the mapping. */
export interface KumaDockerHost { id: number; name?: string; type?: string; daemon?: string }
export interface KumaListed { id?: number; name?: string; detail?: string }
/** Raw Uptime Kuma data in the shape `convertKuma` reads (the same fields the 1.x backup JSON and Kuma's own monitor JSON carry). `maintenanceList` entries carry `monitorIds` / `statusPageIds` when the source could provide the links. */
export interface KumaRaw {
  monitorList: Record<string, any>[]; notificationList: Record<string, any>[]; maintenanceList?: unknown[]; statusPageList?: KumaPage[] | unknown[];
  settings?: Record<string, unknown>; dockerHosts?: KumaDockerHost[]; proxies?: KumaListed[]; apiKeys?: KumaListed[]; remoteBrowsers?: KumaListed[];
}

// Kuma's database uses snake_case columns, its JSON uses camelCase; the converter reads the camelCase names (the snake_case ones stay available too).
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const withAliases = (row: Record<string, any>) => ({ ...row, ...Object.fromEntries(Object.keys(row).filter((k) => k.includes('_') && !(camel(k) in row)).map((k) => [camel(k), row[k]])) });
const tryJson = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
/** Maps the objects Kuma lists (docker hosts, proxies, API keys, remote browsers) to their non-secret parts; both the database and the socket shape are accepted. */
const asDocker = (r: any): KumaDockerHost => ({ id: Number(r.id), name: r.name, type: r.dockerType ?? r.docker_type, daemon: r.dockerDaemon ?? r.docker_daemon });
const asProxy = (r: any): KumaListed => ({ id: Number(r.id), name: r.name, detail: `${r.protocol ?? 'http'}://${r.host ?? '?'}${r.port ? `:${r.port}` : ''}` });
const asKey = (r: any): KumaListed => ({ id: Number(r.id), name: String(r.name ?? `key ${r.id}`) });
const asBrowser = (r: any): KumaListed => ({ id: Number(r.id), name: String(r.name ?? `browser ${r.id}`) });
const rowsOf = (v: unknown): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

/** Reads monitors, tags and notifications from a Kuma 1.x/2.x SQLite file (data/kuma.db). Heartbeats and everything else are ignored. */
export async function kumaFromSqlite(file: string): Promise<KumaRaw> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const all = (sql: string): any[] => db.prepare(sql).all() as any[];
    if (!all("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor'").length) throw new Error('This is not an Uptime Kuma database (no "monitor" table).');
    const has = (t: string) => all(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`).length > 0;
    const by = <T extends Record<string, any>>(rows: T[], key: keyof T) => { const m = new Map<unknown, T[]>(); for (const r of rows) { const l = m.get(r[key]); if (l) l.push(r); else m.set(r[key], [r]); } return m; };
    const tags = by(has('monitor_tag') && has('tag') ? all('SELECT mt.monitor_id, t.name, t.color, mt.value FROM monitor_tag mt JOIN tag t ON t.id = mt.tag_id') : [], 'monitor_id');
    const links = by(has('monitor_notification') ? all('SELECT monitor_id, notification_id FROM monitor_notification') : [], 'monitor_id');
    const monitorList = all('SELECT * FROM monitor').map((m) => ({
      ...withAliases(m),
      tags: (tags.get(m.id) ?? []).map((t) => ({ name: t.name, color: t.color, value: t.value })),
      notificationIDList: Object.fromEntries((links.get(m.id) ?? []).map((l) => [String(l.notification_id), true])),
    }));
    const notificationList = has('notification') ? all('SELECT * FROM notification').map(withAliases) : [];
    // Maintenance windows come with the monitors and status pages they are linked to; when a link table is missing the links stay unknown (undefined), which is not the same as "none".
    const mMonitors = has('monitor_maintenance') ? by(all('SELECT maintenance_id, monitor_id FROM monitor_maintenance'), 'maintenance_id') : null;
    const mPages = has('maintenance_status_page') ? by(all('SELECT maintenance_id, status_page_id FROM maintenance_status_page'), 'maintenance_id') : null;
    const maintenanceList = has('maintenance') ? all('SELECT * FROM maintenance').map((m) => ({
      ...withAliases(m),
      ...(mMonitors ? { monitorIds: (mMonitors.get(m.id) ?? []).map((l) => Number(l.monitor_id)) } : {}),
      ...(mPages ? { statusPageIds: (mPages.get(m.id) ?? []).map((l) => Number(l.status_page_id)) } : {}),
    })) : [];
    // Only the non-secret parts of these tables are kept (SELECT * tolerates the columns that differ between Kuma versions).
    const settings = has('setting') ? Object.fromEntries(all('SELECT * FROM setting').map((r) => [String(r.key), tryJson(r.value)])) : undefined;
    return {
      monitorList, notificationList, maintenanceList, statusPageList: readPages(all, has), ...(settings ? { settings } : {}),
      dockerHosts: has('docker_host') ? all('SELECT * FROM docker_host').map(asDocker) : [], proxies: has('proxy') ? all('SELECT * FROM proxy').map(asProxy) : [],
      apiKeys: has('api_key') ? all('SELECT * FROM api_key').map(asKey) : [], remoteBrowsers: has('remote_browser') ? all('SELECT * FROM remote_browser').map(asBrowser) : [],
    };
  } finally {
    db.close();
  }
}

/** Status pages with their groups and monitor lists ("group" is a reserved word, hence the quotes). Unknown columns are tolerated across Kuma versions. */
function readPages(all: (sql: string) => any[], has: (t: string) => boolean): KumaPage[] {
  if (!has('status_page')) return [];
  const domains = has('status_page_cname') ? all('SELECT status_page_id, domain FROM status_page_cname') : [];
  const groups = has('group') ? all('SELECT id, name, status_page_id FROM "group" WHERE status_page_id IS NOT NULL ORDER BY weight, id') : [];
  const members = has('monitor_group') ? all('SELECT group_id, monitor_id FROM monitor_group ORDER BY weight, id') : [];
  const incidents = has('incident') ? all('SELECT * FROM incident WHERE pin = 1 ORDER BY id') : [];
  return all('SELECT * FROM status_page ORDER BY id').map((p) => {
    const pinned = incidents.filter((i) => i.status_page_id === p.id).map((i): KumaIncident => ({ title: i.title, content: i.content, style: i.style, createdDate: i.created_date }));
    return {
      id: p.id, slug: p.slug, title: p.title, description: p.description, icon: p.icon, published: p.published, footerText: p.footer_text, customCSS: p.custom_css,
      domainNameList: domains.filter((d) => d.status_page_id === p.id).map((d) => d.domain),
      groups: groups.filter((g) => g.status_page_id === p.id).map((g) => ({ name: g.name, monitors: members.filter((m) => m.group_id === g.id).map((m) => ({ id: m.monitor_id })) })),
      hasIncident: pinned.length > 0, incidents: pinned,
      theme: p.theme, showTags: p.show_tags, showPoweredBy: p.show_powered_by, showCertificateExpiry: p.show_certificate_expiry, autoRefreshInterval: p.auto_refresh_interval,
      googleAnalyticsId: p.google_analytics_tag_id ?? p.analytics_id, rssTitle: p.rss_title,
    };
  });
}

/**
 * Accepts what people paste from the address bar: surrounding blanks, trailing slashes, a Kuma page such as /dashboard or /status/x, or a reverse-proxy sub-path.
 * shortcut: only the well-known Kuma routes are cut off; a proxy sub-path that is itself called e.g. "status" must be entered with a trailing page like /status/dashboard.
 */
export function normalizeKumaUrl(input: string): { origin: string; basePath: string; socketPath: string } {
  let raw = input.trim();
  if (!raw) throw new Error('Enter the address of your Uptime Kuma');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('The address is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The URL must start with http:// or https://');
  const basePath = u.pathname.replace(/\/{2,}/g, '/').replace(/\/(dashboard|status|settings|manage-status-page|add|list|maintenance|setup|socket\.io)(\/.*)?$/i, '').replace(/\/+$/, '');
  return { origin: u.origin, basePath, socketPath: `${basePath}/socket.io/` };
}

export class KumaLoginError extends Error {
  constructor(message: string, public tokenRequired = false) { super(message); }
}

const hint = (detail: string) => (/\b(400|403|404|502|503)\b/.test(detail)
  ? ' Check that the address is only where Kuma itself runs (for example https://kuma.example.com or https://example.com/kuma), that your reverse proxy forwards WebSocket upgrades, and that Kuma is not set to reject foreign origins (UPTIME_KUMA_WS_ORIGIN_CHECK).'
  : '');

/** Websocket-only first (what Kuma's own UI uses); some proxies only cope with the polling handshake, so that is the fallback. */
async function connectKuma(origin: string, socketPath: string, base: string): Promise<Socket> {
  let last: unknown;
  for (const transports of [['websocket'], ['polling', 'websocket']]) {
    const socket = io(origin, { path: socketPath, transports, reconnection: false, timeout: 10_000, extraHeaders: { Origin: origin } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
      return socket;
    } catch (e) { socket.close(); last = e; }
  }
  const err = last as Error & { description?: { message?: string } | string };
  const detail = typeof err.description === 'string' ? err.description : err.description?.message ?? '';
  throw new Error(`Could not connect to ${base}: ${err.message}${detail ? ` (${detail})` : ''}.${hint(`${err.message} ${detail}`)}`);
}

/** Status page layouts are only available over Kuma's public HTTP API, not over the socket. */
async function fetchPageLayouts(base: string, pages: KumaPage[], guard: NetGuard): Promise<string[]> {
  const warnings: string[] = [];
  let next = 0;
  const worker = async () => {
    for (let p = pages[next++]; p; p = pages[next++]) {
      try {
        const res = await fetch(`${base}/api/status-page/${encodeURIComponent(p.slug)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: any = await res.json();
        p.groups = (j.publicGroupList ?? []).map((g: any) => ({ name: String(g.name ?? ''), monitors: (g.monitorList ?? []).map((m: any) => ({ id: Number(m.id) })) }));
        p.hasIncident = !!j.incident;
        p.incidents = j.incident ? [{ title: j.incident.title, content: j.incident.content, style: j.incident.style, createdDate: j.incident.createdDate }] : [];
      } catch (e) { warnings.push(`status page "${p.slug}": layout could not be read (${(e as Error).message}), the page is imported without components`); }
    }
  };
  await guard.resolve(new URL(base).hostname);
  await Promise.all([worker(), worker(), worker(), worker()]);
  return warnings;
}

/**
 * Logs in to a running Kuma over its Socket.IO API and collects the lists it pushes after login.
 * shortcut: the SSRF guard checks the DNS answers before connecting, not at connect time; fine for an admin-only action, upgrade if this is exposed to lower roles.
 */
export async function kumaFromApi(o: { url: string; username: string; password: string; token?: string }, guard: NetGuard, timeoutMs = 90_000): Promise<KumaRaw & { fetchWarnings: string[] }> {
  const { origin, basePath, socketPath } = normalizeKumaUrl(o.url);
  await guard.resolve(new URL(origin).hostname);
  const socket = await connectKuma(origin, socketPath, origin + basePath);
  const monitors = new Map<string, Record<string, any>>();
  let notes: Record<string, any>[] | null = null;
  let gotMonitors = false;
  let lastEvent = Date.now();
  const touch = () => { lastEvent = Date.now(); };
  const addMonitors = (m: unknown) => { touch(); if (m && typeof m === 'object') for (const [id, v] of Object.entries(m as Record<string, any>)) monitors.set(id, v); };
  socket.on('monitorList', (m) => { addMonitors(m); gotMonitors = true; });
  socket.on('updateMonitorIntoList', addMonitors);
  let maint: unknown[] = [];
  let pages: KumaPage[] = [];
  socket.on('maintenanceList', (m) => { touch(); maint = Object.values(m ?? {}); });
  socket.on('statusPageList', (m) => { touch(); pages = Object.values(m ?? {}) as KumaPage[]; });
  socket.on('notificationList', (n) => { touch(); notes = Array.isArray(n) ? n : Object.values(n ?? {}); });
  // lists Kuma pushes after login that can only be reported, never imported
  let dockerHosts: KumaDockerHost[] = [], proxies: KumaListed[] = [], apiKeys: KumaListed[] = [], remoteBrowsers: KumaListed[] = [];
  socket.on('dockerHostList', (m) => { touch(); dockerHosts = rowsOf(m).map(asDocker); });
  socket.on('proxyList', (m) => { touch(); proxies = rowsOf(m).map(asProxy); });
  socket.on('apiKeyList', (m) => { touch(); apiKeys = rowsOf(m).map(asKey); });
  socket.on('remoteBrowserList', (m) => { touch(); remoteBrowsers = rowsOf(m).map(asBrowser); });
  /** One request/answer call with a deadline; a Kuma version without the event never answers, so it must not hang the import. */
  const ask = (event: string, ...args: unknown[]) => new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer')), 10_000);
    socket.emit(event, ...args, (r: unknown) => { clearTimeout(t); resolve(r); });
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const res: any = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Kuma did not answer the login')), 90_000);
      socket.emit('login', { username: o.username, password: o.password, token: o.token ?? '' }, (r: unknown) => { clearTimeout(t); resolve(r); });
    });
    if (res?.tokenRequired) throw new KumaLoginError('Two-factor code required', true);
    if (!res?.ok) throw new KumaLoginError(String(res?.msg ?? 'Login failed'));
    const deadline = Date.now() + timeoutMs;
    while ((!gotMonitors || notes === null) && Date.now() < deadline) await wait(100);
    if (!gotMonitors) throw new Error('Kuma sent no monitor list after login');
    // a big instance trickles in updates after the full list: wait for a quiet moment instead of a fixed delay
    while (Date.now() - lastEvent < 700 && Date.now() < deadline) await wait(100);
    const fetchWarnings = pages.length ? await fetchPageLayouts(origin + basePath, pages, guard) : [];
    // the maintenance list does not say which monitors and pages a window belongs to: ask per window; links that cannot be read stay unknown
    const maintenance = maint as Record<string, any>[];
    let next = 0;
    const linkWorker = async () => {
      for (let m = maintenance[next++]; m; m = maintenance[next++]) {
        try {
          const [mon, pg] = await Promise.all([ask('getMonitorMaintenance', m.id), ask('getMaintenanceStatusPage', m.id)]);
          if (mon?.ok) m.monitorIds = rowsOf(mon.monitors).map((x) => Number(x.id));
          if (pg?.ok) m.statusPageIds = rowsOf(pg.statusPages).map((x) => Number(x.id));
        } catch { fetchWarnings.push(`maintenance "${m.title ?? m.id}": the linked monitors could not be read`); }
      }
    };
    await Promise.all([linkWorker(), linkWorker(), linkWorker(), linkWorker()]);
    let settings: Record<string, unknown> | undefined;
    try { const r = await ask('getSettings'); if (r?.ok && r.data && typeof r.data === 'object') settings = r.data; } catch { fetchWarnings.push('the Uptime Kuma settings could not be read'); }
    return { monitorList: [...monitors.values()], notificationList: notes ?? [], maintenanceList: maintenance, statusPageList: pages, ...(settings ? { settings } : {}), dockerHosts, proxies, apiKeys, remoteBrowsers, fetchWarnings };
  } finally {
    socket.close();
  }
}
