import type { MonitorX } from './monitorExtras';
import { snoozeActive, sloViolated } from './monitorExtras';
import { DISPLAYS, type Display } from '../../../src/core/kiosk';

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

/* ------------------------------ display (view) choice ------------------------------ */

/** Address: ?display=<view>&grouped=1|0. This device: `pw.dash.display` and `pw.dash.grouped` (JSON per display). */
export const DISPLAY_KEY = 'pw.dash.display';
export const GROUPED_KEY = 'pw.dash.grouped';
/** Before the five views there was only grid or list. */
export const LEGACY_VIEW_KEY = 'pw.dash.view';
export { DISPLAYS, type Display };

/** Grouped unless the person chose otherwise. The group overview is always grouped. */
export const GROUPED_DEFAULT: Readonly<Record<Display, boolean>> = { cards: true, groups: true, table: false, wall: true, heatmap: false };
export const isDisplay = (v: unknown): v is Display => typeof v === 'string' && (DISPLAYS as readonly string[]).includes(v);

export interface StoredView { display: Display | null; grouped: Partial<Record<Display, boolean>> }
export interface ViewChoice { display: Display; grouped: boolean }

/** What this device remembers. The old grid/list choice counts only while no display is stored. */
export function readStoredView(display: string | null, grouped: string | null, legacy: string | null = null): StoredView {
  const d = isDisplay(display) ? display : legacy === 'grid' ? 'cards' : legacy === 'list' ? 'table' : null;
  const g: Partial<Record<Display, boolean>> = {};
  try {
    const raw: unknown = JSON.parse(grouped ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const k of DISPLAYS) { const v = (raw as Record<string, unknown>)[k]; if (typeof v === 'boolean') g[k] = v; }
  } catch { /* broken value: defaults */ }
  return { display: d, grouped: g };
}

const groupedFor = (d: Display, stored: StoredView) => (d === 'groups' ? true : stored.grouped[d] ?? GROUPED_DEFAULT[d]);

/** The address wins (shared links), then this device; without either the table from 12 monitors on, else cards. */
export function resolveView(p: URLSearchParams, stored: StoredView, count: number): ViewChoice {
  const q = p.get('display');
  const display: Display = isDisplay(q) ? q : stored.display ?? (count >= 12 ? 'table' : 'cards');
  const g = p.get('grouped');
  return { display, grouped: display === 'groups' ? true : g === '1' ? true : g === '0' ? false : groupedFor(display, stored) };
}

/** Switching to another view brings back how it was grouped on this device. */
export const switchView = (d: Display, stored: StoredView): ViewChoice => ({ display: d, grouped: groupedFor(d, stored) });

/** Writes the view into `base` (other parameters are kept); both are always written, so a copied link shows the same. */
export function viewToParams(v: ViewChoice, base?: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(base);
  p.set('display', v.display);
  if (v.display === 'groups') p.delete('grouped'); else p.set('grouped', v.grouped ? '1' : '0');
  return p;
}

/** The device memory after a choice. */
export const rememberView = (s: StoredView, v: ViewChoice): StoredView => ({ display: v.display, grouped: v.display === 'groups' ? s.grouped : { ...s.grouped, [v.display]: v.grouped } });

/** View stored in a saved view's filters; null for views saved before there were several (they keep the current view). */
export function savedViewChoice(filters: unknown, stored: StoredView): ViewChoice | null {
  if (!filters || typeof filters !== 'object') return null;
  const f = filters as { display?: unknown; grouped?: unknown };
  if (!isDisplay(f.display)) return null;
  return { display: f.display, grouped: f.display === 'groups' ? true : typeof f.grouped === 'boolean' ? f.grouped : groupedFor(f.display, stored) };
}

/* ------------------------------ grouped pages ------------------------------ */

export interface PagedSection<T> { key: string; items: readonly T[] }
export type PageEntry<T, S extends PagedSection<T> = PagedSection<T>> = { kind: 'head'; section: S; continued: boolean } | { kind: 'row'; item: T };

/**
 * One page of a grouped list: the monitors in section order, with a heading before the first row of every section on the page.
 * A section that began on an earlier page repeats its heading as continued. Headings do not count towards the page size.
 * A page size below 1 means everything on one page.
 */
export function pageEntries<T, S extends PagedSection<T>>(sections: readonly S[], page: number, pageSize: number): PageEntry<T, S>[] {
  const from = pageSize < 1 ? 0 : (Math.max(1, page) - 1) * pageSize;
  const to = pageSize < 1 ? Infinity : from + pageSize;
  const out: PageEntry<T, S>[] = [];
  let start = 0;
  for (const s of sections) {
    const end = start + s.items.length;
    if (end > from && start < to) {
      out.push({ kind: 'head', section: s, continued: start < from });
      for (let i = Math.max(start, from); i < Math.min(end, to); i++) out.push({ kind: 'row', item: s.items[i - start]! });
    }
    start = end;
    if (start >= to) break;
  }
  return out;
}
