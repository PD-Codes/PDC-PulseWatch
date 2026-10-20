import { io } from 'socket.io-client';
import type { NetGuard } from '../core/guard';

/** Raw Uptime Kuma data in the shape `convertKuma` reads (the same fields the 1.x backup JSON and Kuma's own monitor JSON carry). */
export interface KumaRaw { monitorList: Record<string, any>[]; notificationList: Record<string, any>[]; maintenanceList?: unknown[]; statusPageList?: unknown[] }

// Kuma's database uses snake_case columns, its JSON uses camelCase for these; the converter reads the camelCase names.
const ALIASES: Record<string, string> = {
  ignore_tls: 'ignoreTls', upside_down: 'upsideDown', retry_interval: 'retryInterval', expiry_notification: 'expiryNotification', invert_keyword: 'invertKeyword',
  json_path: 'jsonPath', json_path_operator: 'jsonPathOperator', expected_value: 'expectedValue', auth_method: 'authMethod', mqtt_topic: 'mqttTopic',
  mqtt_success_message: 'mqttSuccessMessage', mqtt_username: 'mqttUsername', mqtt_password: 'mqttPassword', database_connection_string: 'databaseConnectionString',
  database_query: 'databaseQuery', is_default: 'isDefault',
};
const withAliases = (row: Record<string, any>) => ({ ...row, ...Object.fromEntries(Object.entries(ALIASES).filter(([k]) => k in row).map(([k, v]) => [v, row[k]])) });

/** Reads monitors, tags and notifications from a Kuma 1.x/2.x SQLite file (data/kuma.db). Heartbeats and everything else are ignored. */
export async function kumaFromSqlite(file: string): Promise<KumaRaw> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const all = (sql: string): any[] => db.prepare(sql).all() as any[];
    if (!all("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor'").length) throw new Error('This is not an Uptime Kuma database (no "monitor" table).');
    const has = (t: string) => all(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`).length > 0;
    const tags = has('monitor_tag') && has('tag') ? all('SELECT mt.monitor_id, t.name, t.color, mt.value FROM monitor_tag mt JOIN tag t ON t.id = mt.tag_id') : [];
    const links = has('monitor_notification') ? all('SELECT monitor_id, notification_id FROM monitor_notification') : [];
    const monitorList = all('SELECT * FROM monitor').map((m) => ({
      ...withAliases(m),
      tags: tags.filter((t) => t.monitor_id === m.id).map((t) => ({ name: t.name, color: t.color, value: t.value })),
      notificationIDList: Object.fromEntries(links.filter((l) => l.monitor_id === m.id).map((l) => [String(l.notification_id), true])),
    }));
    const notificationList = has('notification') ? all('SELECT * FROM notification').map(withAliases) : [];
    return { monitorList, notificationList, maintenanceList: has('maintenance') ? all('SELECT id FROM maintenance') : [], statusPageList: has('status_page') ? all('SELECT id FROM status_page') : [] };
  } finally {
    db.close();
  }
}

export class KumaLoginError extends Error {
  constructor(message: string, public tokenRequired = false) { super(message); }
}

/**
 * Logs in to a running Kuma over its Socket.IO API and collects the lists it pushes after login.
 * shortcut: the SSRF guard checks the DNS answers before connecting, not at connect time; fine for an admin-only action, upgrade if this is exposed to lower roles.
 */
export async function kumaFromApi(o: { url: string; username: string; password: string; token?: string }, guard: NetGuard, timeoutMs = 20_000): Promise<KumaRaw> {
  const u = new URL(o.url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The URL must start with http:// or https://');
  await guard.resolve(u.hostname);
  const socket = io(u.origin, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  const monitors = new Map<string, Record<string, any>>();
  let notes: Record<string, any>[] | null = null;
  const addMonitors = (m: unknown) => { if (m && typeof m === 'object') for (const [id, v] of Object.entries(m as Record<string, any>)) monitors.set(id, v); };
  socket.on('monitorList', (m) => { addMonitors(m); gotMonitors = true; });
  socket.on('updateMonitorIntoList', addMonitors);
  let maint: unknown[] = [];
  let pages: unknown[] = [];
  socket.on('maintenanceList', (m) => { maint = Object.values(m ?? {}); });
  socket.on('statusPageList', (m) => { pages = Object.values(m ?? {}); });
  socket.on('notificationList', (n) => { notes = Array.isArray(n) ? n : Object.values(n ?? {}); });
  let gotMonitors = false;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', (e) => reject(new Error(`Could not connect: ${e.message}`))); });
    const res: any = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Kuma did not answer the login')), 15_000);
      socket.emit('login', { username: o.username, password: o.password, token: o.token ?? '' }, (r: unknown) => { clearTimeout(t); resolve(r); });
    });
    if (res?.tokenRequired) throw new KumaLoginError('Two-factor code required', true);
    if (!res?.ok) throw new KumaLoginError(String(res?.msg ?? 'Login failed'));
    const deadline = Date.now() + timeoutMs;
    while ((!gotMonitors || notes === null) && Date.now() < deadline) await wait(100);
    if (!gotMonitors) throw new Error('Kuma sent no monitor list after login');
    await wait(500); // incremental updates that trail the full list
    return { monitorList: [...monitors.values()], notificationList: notes ?? [], maintenanceList: maint, statusPageList: pages };
  } finally {
    socket.close();
  }
}
