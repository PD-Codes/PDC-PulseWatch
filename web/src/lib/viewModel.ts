// Shared rules of the monitor views on the dashboard and the wall display: status order, sections per group with their summary,
// and the cells of the 24-hour heatmap. No React in here, so the rules can be unit tested.
import type { Beat, HistoryCell, HistoryResponse, Overlay, Status } from './api';

export type ViewStatus = 'up' | 'down' | 'pending' | 'unknown' | 'maintenance' | 'suppressed' | 'paused';

/** What every view needs of a monitor. MonitorItem (dashboard, signed-in kiosk) and KioskMonitor (kiosk key) both have it. */
export interface ViewMonitor {
  id: number; name: string; groupId: number | null; active: boolean; status: Status; overlay: Overlay;
  statusSince: string | null; latencyMs: number | null; recent: Beat[]; uptime: { h24: number | null; d30?: number | null };
}

/** Same rule as displayStatus in components/status: paused wins, then the overlay, then the check result. */
export const viewStatus = (m: Pick<ViewMonitor, 'status' | 'overlay' | 'active'>): ViewStatus => (!m.active ? 'paused' : m.overlay !== 'none' ? m.overlay : m.status);

/** Most urgent first. */
export const VIEW_RANK: Record<ViewStatus, number> = { down: 0, pending: 1, suppressed: 2, maintenance: 3, unknown: 4, up: 5, paused: 6 };

/** Someone should look: down, failing again before it counts as down, or down but held back by a dependency. */
export const needsAttention = (s: ViewStatus): boolean => s === 'down' || s === 'pending' || s === 'suppressed';

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Problems first, the longest-lasting problem first; everything else by name. For Array.prototype.sort. */
export function byUrgency(a: ViewMonitor, b: ViewMonitor): number {
  const sa = viewStatus(a), sb = viewStatus(b);
  const d = VIEW_RANK[sa] - VIEW_RANK[sb];
  if (d) return d;
  if (needsAttention(sa)) {
    const ta = a.statusSince ? Date.parse(a.statusSince) : Infinity, tb = b.statusSince ? Date.parse(b.statusSince) : Infinity;
    if (ta !== tb) return ta - tb;
  }
  return byName(a, b);
}

export interface Summary {
  total: number; up: number; down: number;
  /** pending and suppressed */
  attention: number;
  maintenance: number;
  /** unknown and paused */
  other: number;
  /** Most urgent status in the set; null for an empty set. */
  worst: ViewStatus | null;
  /** Mean of the known 24-hour availabilities in percent; null when none is known. */
  uptime24: number | null;
}

export function summarize(items: readonly ViewMonitor[]): Summary {
  const s: Summary = { total: items.length, up: 0, down: 0, attention: 0, maintenance: 0, other: 0, worst: null, uptime24: null };
  let sum = 0, n = 0;
  for (const m of items) {
    const st = viewStatus(m);
    if (st === 'up') s.up++; else if (st === 'down') s.down++; else if (st === 'pending' || st === 'suppressed') s.attention++; else if (st === 'maintenance') s.maintenance++; else s.other++;
    if (s.worst === null || VIEW_RANK[st] < VIEW_RANK[s.worst]) s.worst = st;
    if (m.uptime.h24 != null) { sum += m.uptime.h24; n++; }
  }
  s.uptime24 = n ? sum / n : null;
  return s;
}

export interface GroupLike { id: number; parentId: number | null; name: string }
export interface ViewSection<T> {
  /** Stable key: the group id, or 'none' for monitors without a group. */
  key: string;
  group: GroupLike | null;
  /** Names from the top-level group down: "Servers / Linux". Empty for monitors without a group. */
  path: string;
  depth: number;
  /** The monitors directly in this group, in the order of the input. */
  items: T[];
  summary: Summary;
}

export interface SectionOptions {
  /** 'tree': groups in tree order (siblings in the order of `groups`), like a map that stays in place. 'problems': the worst section first, then by path. */
  order: 'tree' | 'problems';
  /** Where monitors without a (known) group go. */
  ungrouped: 'first' | 'last';
}

/**
 * Monitors split by group. Only groups with monitors of their own get a section; a subgroup is named by its path, so leaving out a
 * parent without monitors loses nothing. Monitors keep the order of `list` inside their section (sort before calling).
 */
export function groupSections<T extends ViewMonitor>(list: readonly T[], groups: readonly GroupLike[], opts: SectionOptions = { order: 'tree', ungrouped: 'last' }): ViewSection<T>[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const buckets = new Map<number | null, T[]>();
  for (const m of list) {
    const k = m.groupId != null && byId.has(m.groupId) ? m.groupId : null;
    const b = buckets.get(k);
    if (b) b.push(m); else buckets.set(k, [m]);
  }
  const children = new Map<number | null, GroupLike[]>();
  for (const g of groups) {
    const p = g.parentId != null && g.parentId !== g.id && byId.has(g.parentId) ? g.parentId : null;
    const c = children.get(p);
    if (c) c.push(g); else children.set(p, [g]);
  }
  const ordered: { g: GroupLike; depth: number; path: string }[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number, prefix: string) => {
    for (const g of children.get(parent) ?? []) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const path = prefix ? `${prefix} / ${g.name}` : g.name;
      ordered.push({ g, depth, path });
      walk(g.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  // groups caught in a parent cycle are never reached from the top level: list them there
  for (const g of groups) if (!seen.has(g.id)) { seen.add(g.id); ordered.push({ g, depth: 0, path: g.name }); walk(g.id, 1, g.name); }

  const out: ViewSection<T>[] = [];
  for (const o of ordered) {
    const items = buckets.get(o.g.id);
    if (items?.length) out.push({ key: String(o.g.id), group: o.g, path: o.path, depth: o.depth, items, summary: summarize(items) });
  }
  if (opts.order === 'problems') {
    const rank = (s: ViewSection<T>) => (s.summary.worst ? VIEW_RANK[s.summary.worst] : 9);
    out.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  }
  const none = buckets.get(null);
  if (none?.length) {
    const sec: ViewSection<T> = { key: 'none', group: null, path: '', depth: 0, items: none, summary: summarize(none) };
    if (opts.ungrouped === 'first') out.unshift(sec); else out.push(sec);
  }
  return out;
}

/* ------------------------------ 24-hour heatmap ------------------------------ */

export type HeatLevel = 'none' | 'maintenance' | 'full' | 'high' | 'mid' | 'low' | 'bad';
export const HEAT_LEVELS: readonly HeatLevel[] = ['full', 'high', 'mid', 'low', 'bad', 'maintenance', 'none'];

/** Availability of one hour in percent from its up and down checks; null when it has neither. */
export function cellUptime(c: HistoryCell): number | null {
  if (!c) return null;
  const up = c[1], down = c[2];
  return up + down === 0 ? null : (up / (up + down)) * 100;
}

/** Color step of one hour: no checks; only maintenance; 100 %; at least 99 %; 95 %; 80 %; below 80 %. */
export function heatLevel(c: HistoryCell): HeatLevel {
  if (!c || c[0] === 0) return 'none';
  const u = cellUptime(c);
  if (u == null) return c[3] > 0 ? 'maintenance' : 'none';
  return u >= 100 ? 'full' : u >= 99 ? 'high' : u >= 95 ? 'mid' : u >= 80 ? 'low' : 'bad';
}

// Like the heartbeat bars, the steps differ in form as well as color: bad has a dark foot, maintenance is hatched, no data is an outline.
const HATCH = 'repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 4px)';
/** Look of a heatmap cell per step. Colors are theme colors (CSS variables), so every theme recolors them. */
export const HEAT_LOOK: Record<HeatLevel, { cls: string; style?: { backgroundImage?: string; boxShadow?: string } }> = {
  full: { cls: 'bg-emerald-500' },
  high: { cls: 'bg-emerald-300 dark:bg-emerald-700' },
  mid: { cls: 'bg-amber-400' },
  low: { cls: 'bg-orange-500' },
  bad: { cls: 'bg-red-600', style: { boxShadow: 'inset 0 -3px 0 rgb(0 0 0 / 0.35)' } },
  maintenance: { cls: 'bg-sky-500/20 text-sky-500', style: { backgroundImage: HATCH } },
  none: { cls: 'border border-dashed border-slate-300 bg-transparent dark:border-slate-600' },
};

/** Start of every hour column, oldest first. */
export const hourStarts = (h: Pick<HistoryResponse, 'from' | 'hours' | 'bucketS'>): Date[] =>
  Array.from({ length: h.hours }, (_, i) => new Date(Date.parse(h.from) + i * h.bucketS * 1000));

/** The cells of one monitor, always `hours` long; a monitor without data gets empty hours. Empty without a response. */
export function cellsOf(h: HistoryResponse | undefined, id: number): HistoryCell[] {
  if (!h) return [];
  const c = h.monitors[String(id)];
  return Array.from({ length: h.hours }, (_, i) => c?.[i] ?? null);
}

/** Availability over the whole window in percent, weighted by checks; null without up or down checks. */
export function rowUptime(cells: readonly HistoryCell[]): number | null {
  let up = 0, down = 0;
  for (const c of cells) if (c) { up += c[1]; down += c[2]; }
  return up + down === 0 ? null : (up / (up + down)) * 100;
}
