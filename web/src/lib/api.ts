import type { KioskConfig } from '../../../src/core/kiosk';
import { ts } from './tr';

/** Thin fetch wrapper: JSON in/out, CSRF header for cookie sessions, typed errors. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: any) { super(message); }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

export interface ApiOptions {
  /** Aborts the request (e.g. TanStack Query's signal); the abort error is passed through untouched. */
  signal?: AbortSignal;
  /** Overall limit in ms. Default 30 s for JSON requests, none for uploads (FormData / Blob bodies). 0 disables it. */
  timeoutMs?: number;
  /** Extra request headers, e.g. the kiosk key of a wall display. */
  headers?: Record<string, string>;
}
const DEFAULT_TIMEOUT = 30_000;

/** One round trip including reading the body, bounded by the timeout; network failures become ApiError(0, ...). */
async function send(method: string, path: string, body: unknown, opts: ApiOptions): Promise<{ res: Response; text: string }> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob; // sent as is (streamed from disk by the browser)
  const limit = opts.timeoutMs ?? (isForm || isBlob ? 0 : DEFAULT_TIMEOUT);
  const ctl = new AbortController();
  let timedOut = false;
  const timer = limit > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, limit) : undefined;
  const ext = opts.signal;
  const onAbort = () => ctl.abort(ext?.reason);
  if (ext) { if (ext.aborted) ctl.abort(ext.reason); else ext.addEventListener('abort', onAbort, { once: true }); }
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', signal: ctl.signal,
      headers: { ...opts.headers, ...(isBlob ? { 'content-type': 'application/octet-stream' } : body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}) },
      body: body === undefined ? undefined : isForm || isBlob ? (body as FormData | Blob) : JSON.stringify(body),
    });
    return { res, text: await res.text() };
  } catch (e) {
    if (ext?.aborted) throw e; // the caller cancelled: not an error to report
    if (timedOut) throw new ApiError(0, 'timeout', ts('shell.api.timeout'));
    throw new ApiError(0, 'network', ts('shell.api.network'));
  } finally {
    clearTimeout(timer);
    ext?.removeEventListener('abort', onAbort);
  }
}

const parse = (res: Response, text: string): any => {
  if (!(res.headers.get('content-type') ?? '').includes('json')) return text;
  try { return text ? JSON.parse(text) : null; } catch { return text; }
};

export async function api<T = any>(method: string, path: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  let { res, text } = await send(method, path, body, opts);
  let data = parse(res, text);
  // the CSRF token belongs to the session: after a server restart or a login in another tab it can be stale. Reload it once and retry.
  if (res.status === 403 && data?.error === 'csrf' && method !== 'GET' && await reloadCsrf()) {
    ({ res, text } = await send(method, path, body, opts));
    data = parse(res, text);
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/public/')) window.dispatchEvent(new Event('pw:unauthorized'));
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText ?? 'Request failed', data);
  }
  return data as T;
}

/** Fetch the current session's CSRF token; false when there is no session (or the server is unreachable). */
async function reloadCsrf(): Promise<boolean> {
  try {
    const { res, text } = await send('GET', '/api/auth/me', undefined, { timeoutMs: 10_000 });
    const me = parse(res, text);
    if (!res.ok || !me?.csrf) return false;
    csrf = me.csrf;
    return true;
  } catch { return false; }
}

/** POST a file as the raw body and report upload progress (fetch cannot). Errors look like those of api(). */
export function upload<T = any>(path: string, file: Blob, onProgress: (loaded: number, total: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', path);
    x.setRequestHeader('content-type', 'application/octet-stream');
    if (csrf) x.setRequestHeader('x-csrf-token', csrf);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    x.onerror = () => reject(new ApiError(0, 'network', ts('shell.api.uploadInterrupted')));
    x.onload = () => {
      let data: any = x.responseText;
      try { data = data ? JSON.parse(data) : null; } catch { /* keep text */ }
      if (x.status >= 200 && x.status < 300) return resolve(data as T);
      if (x.status === 401) window.dispatchEvent(new Event('pw:unauthorized'));
      reject(new ApiError(x.status, data?.error ?? 'error', data?.message ?? x.statusText ?? 'Request failed', data));
    };
    x.send(file);
  });
}

export const get = <T = any>(path: string, opts?: ApiOptions) => api<T>('GET', path, undefined, opts);
export const post = <T = any>(path: string, body?: unknown, opts?: ApiOptions) => api<T>('POST', path, body ?? {}, opts);
export const put = <T = any>(path: string, body?: unknown, opts?: ApiOptions) => api<T>('PUT', path, body ?? {}, opts);
export const patch = <T = any>(path: string, body?: unknown, opts?: ApiOptions) => api<T>('PATCH', path, body ?? {}, opts);
export const del = <T = any>(path: string, opts?: ApiOptions) => api<T>('DELETE', path, undefined, opts);

/** Query string from an object, skipping empty values. */
export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Download a file from an API endpoint through the browser. */
export function download(path: string) { const a = document.createElement('a'); a.href = path; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }

/* ---- shared response types ---- */
export type Status = 'up' | 'down' | 'pending' | 'unknown';
export type Overlay = 'none' | 'maintenance' | 'suppressed';
/** [epoch seconds, heartbeat status (0 down, 1 up, 2 pending, 3 maintenance, 4 suppressed), latency ms] */
export type Beat = [number, number, number | null];
export interface Uptime { h24: number | null; d7: number | null; d30: number | null; d90: number | null; d365: number | null }
export interface Tag { id: number; name: string; color: string }
/** A tag as attached to a monitor: value is '' for a plain tag. */
export interface TagAssignment extends Tag { value: string }
/** A tag with its usage: how many monitors carry it and which values are in use. */
export interface TagInfo extends Tag { monitors: number; values: { value: string; count: number }[] }
export interface MonitorItem {
  id: number; name: string; type: string; groupId: number | null; active: boolean; intervalS: number; description: string | null;
  status: Status; overlay: Overlay; statusSince: string | null; lastCheckAt: string | null; latencyMs: number | null; errorKind: string | null; message: string | null;
  flapping: boolean; recent: Beat[]; certExpiresAt: string | null; anomaly: boolean; publicBadge: boolean; locations: (number | 'local')[] | null; pushToken: string | null;
  tags: TagAssignment[]; dependsOn: number[]; uptime: Uptime; info: ServerInfo | null;
}
/** What a game server check reports: players online, version and so on. */
export interface ServerInfo { players?: number; maxPlayers?: number; names?: string[]; version?: string; motd?: string; map?: string; name?: string; state?: string }
export interface Group { id: number; parentId: number | null; name: string; description: string | null }
export type Role = 'admin' | 'editor' | 'viewer';
export interface Me { id: number; username: string; displayName: string; email: string | null; role: Role; locale: 'en' | 'de' | null; theme: 'light' | 'dark' | 'system'; totpEnabled: boolean; authSource: string; scopeRestricted: boolean; csrf?: string }
export interface Meta { brand: { name: string; vendor?: string; [k: string]: unknown }; version: string; build?: string; smtp: boolean; baseUrl: string; demo: boolean; role: string; languages: 'both' | 'en' | 'de' }

/* ---- wall display presets, kiosk keys and the hourly history ---- */
/** A wall display preset (GET /api/kiosk/presets). An empty name of a built-in preset means: show the translated default name. `keys` is only sent to admins. */
export interface KioskPreset { id: number; slug: string; name: string; config: KioskConfig; sort: number; updatedAt: string; keys?: number }
export interface KioskPresetList { items: KioskPreset[]; defaultId: number | null }
/** A read-only access key of a preset; the key itself is only shown once, when it is created. */
export interface KioskKey { id: number; name: string; prefix: string; createdAt: string; createdBy: string | null; lastUsedAt: string | null; lastIp: string | null }
/** One hour of one monitor: [checks, up, down, maintenance]; null when the hour has no checks. */
export type HistoryCell = [number, number, number, number] | null;
/** Hourly availability (GET /api/monitors/history, /api/public/kiosk/history): per monitor id `hours` cells, oldest first, starting at `from`. Monitors without any data are left out. */
export interface HistoryResponse { from: string; hours: number; bucketS: number; monitors: Record<string, HistoryCell[]> }
/** A monitor as a screen with a kiosk key receives it: only what the wall display draws. */
export interface KioskMonitor {
  id: number; name: string; groupId: number | null; active: boolean; status: Status; overlay: Overlay; statusSince: string | null; lastCheckAt: string | null;
  latencyMs: number | null; errorKind: string | null; message: string | null; recent: Beat[]; uptime: { h24: number | null; d30: number | null };
  info: Pick<ServerInfo, 'players' | 'maxPlayers'> | null;
}
export interface KioskIncident { id: number; title: string; status: string; severity: 'minor' | 'major' | 'critical'; startedAt: string }
/** Everything a screen with a kiosk key draws (GET /api/public/kiosk/view, header x-kiosk-key). */
export interface KioskView { preset: { id: number; slug: string; name: string; config: KioskConfig }; monitors: KioskMonitor[]; groups: Group[]; incidents: KioskIncident[]; serverTime: string }
