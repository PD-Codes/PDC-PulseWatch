import type { MonitorX } from './monitorExtras';
import { snoozeActive, sloViolated } from './monitorExtras';

// Dashboard state that lives in the address (?q=&status=&tag=&group=&sort=), plus sorting. Kept free of React for unit tests.

export type DashStatus = 'up' | 'down' | 'pending' | 'unknown' | 'maintenance' | 'suppressed' | 'paused';
/** Status filter: a display status, or one of the cross-cutting sets. */
export type StatusFilter = '' | DashStatus | 'problems' | 'slo' | 'snoozed';
export type SortKey = 'status' | 'name' | 'latency' | 'uptime';
export interface DashFilters { q: string; status: StatusFilter; tag: string; group: string; sort: SortKey }

export const SORT_KEYS: readonly SortKey[] = ['status', 'name', 'latency', 'uptime'];
const STATUS_FILTERS: readonly StatusFilter[] = ['up', 'down', 'pending', 'unknown', 'maintenance', 'suppressed', 'paused', 'problems', 'slo', 'snoozed'];
export const EMPTY_FILTERS: DashFilters = { q: '', status: '', tag: '', group: '', sort: 'status' };

/** Same rule as components/status displayStatus: paused wins, then the overlay, then the check result. */
export const statusOf = (m: Pick<MonitorX, 'status' | 'overlay' | 'active'>): DashStatus => (!m.active ? 'paused' : m.overlay !== 'none' ? m.overlay : m.status);

/** Problems first: down, then pending, then maintenance, then the rest. */
export const STATUS_RANK: Record<DashStatus, number> = { down: 0, pending: 1, maintenance: 2, suppressed: 3, unknown: 4, up: 5, paused: 6 };
export const isProblem = (s: DashStatus) => s === 'down' || s === 'pending';

export function parseFilters(p: URLSearchParams): DashFilters {
  const status = p.get('status') ?? '';
  const sort = p.get('sort') ?? '';
  return {
    q: p.get('q') ?? '',
    status: (STATUS_FILTERS as readonly string[]).includes(status) ? (status as StatusFilter) : '',
    tag: p.get('tag') ?? '',
    group: /^\d+$/.test(p.get('group') ?? '') ? p.get('group')! : '',
    sort: (SORT_KEYS as readonly string[]).includes(sort) ? (sort as SortKey) : 'status',
  };
}

/** Writes the filters into `base` (other parameters are kept); defaults are left out so links stay short. */
export function filtersToParams(f: DashFilters, base?: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(base);
  const put = (k: string, v: string) => { if (v) p.set(k, v); else p.delete(k); };
  put('q', f.q); put('status', f.status); put('tag', f.tag); put('group', f.group); put('sort', f.sort === 'status' ? '' : f.sort);
  return p;
}

export const filtersActive = (f: DashFilters) => !!(f.q || f.status || f.tag || f.group);

export function matchStatus(m: MonitorX, s: StatusFilter, now = Date.now()): boolean {
  if (!s) return true;
  if (s === 'problems') return isProblem(statusOf(m));
  if (s === 'slo') return sloViolated(m);
  if (s === 'snoozed') return snoozeActive(m, now);
  return statusOf(m) === s;
}

/** Text search over name, type, description and tags (`tagText` renders "name: value"). */
export function matchQuery(m: MonitorX, q: string, tagText: (x: MonitorX['tags'][number]) => string = (x) => x.name): boolean {
  const s = q.trim().toLowerCase();
  return !s || `${m.name} ${m.type} ${m.description ?? ''} ${m.tags.map(tagText).join(' ')}`.toLowerCase().includes(s);
}

const byName = (a: MonitorX, b: MonitorX) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
/** Missing values go last whatever the direction. */
const nullsLast = (a: number | null | undefined, b: number | null | undefined, dir: 1 | -1) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : (a - b) * dir);

/**
 * Sorted copy. status: problems first (down > pending > maintenance > rest), the longest-lasting problem first, then by name.
 * latency: slowest first. uptime: worst 24 h uptime first. Ties fall back to the name.
 */
export function sortMonitors<T extends MonitorX>(list: T[], sort: SortKey): T[] {
  const cmp: Record<SortKey, (a: T, b: T) => number> = {
    status: (a, b) => {
      const sa = statusOf(a), sb = statusOf(b);
      const r = STATUS_RANK[sa] - STATUS_RANK[sb];
      if (r) return r;
      if (isProblem(sa)) { const d = (a.statusSince ?? '').localeCompare(b.statusSince ?? ''); if (d) return d; }
      return byName(a, b);
    },
    name: byName,
    latency: (a, b) => nullsLast(a.latencyMs, b.latencyMs, -1) || byName(a, b),
    uptime: (a, b) => nullsLast(a.uptime.h24, b.uptime.h24, 1) || byName(a, b),
  };
  return [...list].sort(cmp[sort]);
}

/** Layout to start with: what the person chose, else the dense list from 12 monitors on. */
export const initialMode = (stored: string | null, count: number): 'grid' | 'list' => (stored === 'grid' || stored === 'list' ? stored : count >= 12 ? 'list' : 'grid');
