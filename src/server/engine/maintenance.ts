import { Cron } from 'croner';
import type { Selectable } from 'kysely';
import type { Ctx } from '../context';
import { bool } from '../db';
import type { MaintenanceWindowsTable } from '../db/types';

export interface ActiveWindow { id: number; name: string; description: string | null; announce: boolean; endsAt: Date; monitorIds: Set<number> }

type Occurrence = { start: Date; end: Date };
/** A window with its resolved targets and the span [from, until) for which `cur` is known to hold. */
interface Tracked { row: Selectable<MaintenanceWindowsTable>; monitorIds: Set<number>; from: number; until: number; cur: Occurrence | null }

const REFRESH_MS = 10_000;
/** Targets are resolved for windows that run now or start this soon; the refresh period is well below it. */
const EXPAND_AHEAD_MS = 60_000;

/**
 * Knows which monitors are inside a maintenance window. Window definitions and targets are reloaded every 10 s,
 * but whether a window is running is computed for the moment asked, so a window takes effect exactly at its start and end.
 */
export class Maintenance {
  private tracked: Tracked[] = [];
  private byMonitor = new Map<number, Tracked[]>();
  private active = new Set<number>();
  private timer?: NodeJS.Timeout;
  private boundary?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private ctx: Pick<Ctx, 'db' | 'bus' | 'log'>) {}

  /** Is the monitor inside a running window at `at` (default: now)? */
  isActive(monitorId: number, at = new Date()): boolean {
    return !!this.byMonitor.get(monitorId)?.some((w) => this.occurrence(w, at));
  }

  activeWindows(at = new Date()): ActiveWindow[] {
    const out: ActiveWindow[] = [];
    for (const w of this.tracked) {
      const cur = this.occurrence(w, at);
      if (cur) out.push({ id: w.row.id, name: w.row.name, description: w.row.description, announce: bool(w.row.announce), endsAt: cur.end, monitorIds: w.monitorIds });
    }
    return out;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch((e) => this.ctx.log.warn({ err: e }, 'maintenance refresh failed')), REFRESH_MS);
    this.timer.unref();
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.boundary); }

  /** Window occurrence containing `now`, or null. For cron windows the cron marks the start and duration_min the length. */
  static current(w: { kind: string; starts_at: Date | null; ends_at: Date | null; cron_expr: string | null; duration_min: number | null; timezone: string }, now: Date): Occurrence | null {
    if (w.kind === 'once') {
      return w.starts_at && w.ends_at && w.starts_at <= now && now < w.ends_at ? { start: w.starts_at, end: w.ends_at } : null;
    }
    if (!w.cron_expr || !w.duration_min) return null;
    // previousRuns() works in whole seconds and leaves out a run in the current second, and on the day the clocks spring forward
    // it can return a start that is still ahead: ask from one second later and keep only starts up to now
    const prev = new Cron(w.cron_expr, { timezone: w.timezone }).previousRuns(2, new Date(now.getTime() + 1000)).filter((d) => d <= now).sort((a, b) => b.getTime() - a.getTime())[0];
    if (!prev) return null;
    const end = new Date(prev.getTime() + w.duration_min * 60_000);
    return end > now ? { start: prev, end } : null;
  }

  /** Next start of a window after `now` (for display). */
  static next(w: { kind: string; starts_at: Date | null; cron_expr: string | null; timezone: string }, now: Date): Date | null {
    if (w.kind === 'once') return w.starts_at && w.starts_at > now ? w.starts_at : null;
    return w.cron_expr ? new Cron(w.cron_expr, { timezone: w.timezone }).nextRun(now) : null;
  }

  private occurrence(w: Tracked, at: Date): Occurrence | null {
    const t = at.getTime();
    if (t < w.from || t >= w.until) this.evaluate(w, at);
    return w.cur;
  }

  private evaluate(w: Tracked, at: Date): void {
    try {
      const cur = Maintenance.current(w.row, at);
      if (cur) { w.cur = cur; w.from = cur.start.getTime(); w.until = cur.end.getTime(); return; }
      const next = Maintenance.next(w.row, at);
      w.cur = null; w.from = at.getTime(); w.until = next && next > at ? next.getTime() : Number.POSITIVE_INFINITY;
    } catch (e) {
      this.ctx.log.warn({ err: e, window: w.row.id }, 'invalid maintenance schedule');
      w.cur = null; w.from = Number.NEGATIVE_INFINITY; w.until = Number.POSITIVE_INFINITY;
    }
  }

  /** Reload windows and targets, announce starts and ends. Calls are serialized. */
  refresh(): Promise<void> {
    const run = this.chain.then(() => this.doRefresh());
    this.chain = run.catch(() => {});
    return run;
  }

  private async doRefresh(): Promise<void> {
    const { db } = this.ctx;
    const now = new Date();
    const wins = await db.selectFrom('maintenance_windows').selectAll().where('active', '=', 1).execute();
    const tracked: Tracked[] = [];
    for (const row of wins) {
      const w: Tracked = { row, monitorIds: new Set(), from: 0, until: 0, cur: null };
      this.evaluate(w, now);
      if (w.cur || w.until - now.getTime() <= EXPAND_AHEAD_MS) w.monitorIds = await this.expand(row.id);
      tracked.push(w);
    }
    const byMonitor = new Map<number, Tracked[]>();
    for (const w of tracked) for (const id of w.monitorIds) byMonitor.set(id, [...(byMonitor.get(id) ?? []), w]);
    this.tracked = tracked;
    this.byMonitor = byMonitor;

    const next = new Set<number>();
    for (const w of tracked) if (w.cur) for (const id of w.monitorIds) next.add(id);
    const changed = next.size !== this.active.size || [...next].some((id) => !this.active.has(id));
    this.active = next;
    await this.announce(next, now);
    if (changed) this.ctx.bus.publish({ type: 'maintenance' });

    // refresh right at the next start or end, so events and live views do not lag behind by up to one period
    clearTimeout(this.boundary);
    const upcoming = Math.min(...tracked.map((w) => w.until));
    if (!this.stopped && Number.isFinite(upcoming) && upcoming - Date.now() < REFRESH_MS) {
      this.boundary = setTimeout(() => this.refresh().catch((e) => this.ctx.log.warn({ err: e }, 'maintenance refresh failed')), Math.max(0, upcoming - Date.now()) + 5);
      this.boundary.unref();
    }
  }

  /**
   * Write maintenance_start / maintenance_end once per monitor, however many processes watch the windows:
   * the marks table is the compare-and-set, only the process whose insert or delete took effect writes the event.
   */
  private async announce(active: Set<number>, now: Date): Promise<void> {
    const { db } = this.ctx;
    const marked = new Set((await db.selectFrom('maintenance_marks').select('monitor_id').execute()).map((r) => r.monitor_id));
    const rows: { id: number; type: string }[] = [];
    for (const id of active) {
      if (marked.has(id)) continue;
      const r = await db.insertInto('maintenance_marks').values({ monitor_id: id, since: now }).ignore().executeTakeFirst();
      if (Number(r.numInsertedOrUpdatedRows ?? 0) === 1) rows.push({ id, type: 'maintenance_start' });
    }
    for (const id of marked) {
      if (active.has(id)) continue;
      const r = await db.deleteFrom('maintenance_marks').where('monitor_id', '=', id).executeTakeFirst();
      if (Number(r.numDeletedRows) === 1) rows.push({ id, type: 'maintenance_end' });
    }
    if (!rows.length) return;
    const exists = new Set((await db.selectFrom('monitors').select('id').where('id', 'in', rows.map((r) => r.id)).execute()).map((m) => m.id));
    const values = rows.filter((r) => exists.has(r.id)).map((r) => ({ monitor_id: r.id, ts: now, type: r.type, from_status: null, to_status: null, error_kind: null, message: null, details: null }));
    if (values.length) await db.insertInto('events').values(values).execute();
  }

  /** Resolve monitor/group/tag targets of a window to monitor ids. */
  async expand(windowId: number): Promise<Set<number>> {
    const { db } = this.ctx;
    const targets = await db.selectFrom('maintenance_targets').selectAll().where('window_id', '=', windowId).execute();
    const ids = new Set<number>();
    const groupIds = new Set<number>();
    const tagIds: number[] = [];
    for (const t of targets) {
      if (t.target_type === 'monitor') ids.add(t.target_id);
      else if (t.target_type === 'group') groupIds.add(t.target_id);
      else tagIds.push(t.target_id);
    }
    if (groupIds.size) {
      const groups = await db.selectFrom('monitor_groups').select(['id', 'parent_id']).execute();
      const all = new Set(groupIds);
      let grew = true;
      while (grew) { grew = false; for (const g of groups) if (g.parent_id && all.has(g.parent_id) && !all.has(g.id)) { all.add(g.id); grew = true; } }
      for (const m of await db.selectFrom('monitors').select('id').where('group_id', 'in', [...all]).execute()) ids.add(m.id);
    }
    if (tagIds.length) for (const m of await db.selectFrom('monitor_tags').select('monitor_id').where('tag_id', 'in', tagIds).execute()) ids.add(m.monitor_id);
    return ids;
  }
}
