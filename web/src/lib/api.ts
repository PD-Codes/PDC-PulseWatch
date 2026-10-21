/** Thin fetch wrapper: JSON in/out, CSRF header for cookie sessions, typed errors. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: any) { super(message); }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob; // sent as is (streamed from disk by the browser)
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(isBlob ? { 'content-type': 'application/octet-stream' } : body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}) },
    body: body === undefined ? undefined : isForm || isBlob ? (body as FormData | Blob) : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  if ((res.headers.get('content-type') ?? '').includes('json')) { try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ } }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/public/')) window.dispatchEvent(new Event('pw:unauthorized'));
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText ?? 'Request failed', data);
  }
  return data as T;
}

/** POST a file as the raw body and report upload progress (fetch cannot). Errors look like those of api(). */
export function upload<T = any>(path: string, file: Blob, onProgress: (loaded: number, total: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', path);
    x.setRequestHeader('content-type', 'application/octet-stream');
    if (csrf) x.setRequestHeader('x-csrf-token', csrf);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    x.onerror = () => reject(new ApiError(0, 'network', 'The upload was interrupted'));
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

export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T = any>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const patch = <T = any>(path: string, body?: unknown) => api<T>('PATCH', path, body ?? {});
export const del = <T = any>(path: string) => api<T>('DELETE', path);

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
/** [epoch seconds, heartbeat status (1 up, 0 down, 3 maintenance), latency ms] */
export type Beat = [number, number, number | null];
export interface Uptime { h24: number | null; d7: number | null; d30: number | null; d90: number | null; d365: number | null }
export interface Tag { id: number; name: string; color: string }
export interface MonitorItem {
  id: number; name: string; type: string; groupId: number | null; active: boolean; intervalS: number; description: string | null;
  status: Status; overlay: Overlay; statusSince: string | null; lastCheckAt: string | null; latencyMs: number | null; errorKind: string | null; message: string | null;
  flapping: boolean; recent: Beat[]; certExpiresAt: string | null; anomaly: boolean; publicBadge: boolean; locations: (number | 'local')[] | null; pushToken: string | null;
  tags: Tag[]; dependsOn: number[]; uptime: Uptime;
}
export interface Group { id: number; parentId: number | null; name: string; description: string | null }
export type Role = 'admin' | 'editor' | 'viewer';
export interface Me { id: number; username: string; displayName: string; email: string | null; role: Role; locale: 'en' | 'de' | null; theme: 'light' | 'dark' | 'system'; totpEnabled: boolean; authSource: string; scopeRestricted: boolean; csrf?: string }
export interface Meta { brand: { name: string; vendor?: string; [k: string]: unknown }; version: string; smtp: boolean; baseUrl: string; demo: boolean; role: string }
