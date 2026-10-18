import { Cron } from 'croner';
import type { Ctx } from '../context';
import { bool } from '../db';

export interface ActiveWindow { id: number; name: string; description: string | null; announce: boolean; endsAt: Date; monitorIds: Set<number> }

/** Keeps an in-memory view of which monitors are inside a maintenance window right now. */
export class Maintenance {
  private active = new Set<number>();
  private windows: ActiveWindow[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private ctx: Pick<Ctx, 'db' | 'bus' | 'log'>) {}

  isActive(monitorId: number): boolean { return this.active.has(monitorId); }
  activeWindows(): ActiveWindow[] { return this.windows; }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch((e) => this.ctx.log.warn({ err: e }, 'maintenance refresh failed')), 10_000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  /** Window occurrence containing `now`, or null. For cron windows the cron marks the start and duration_min the length. */
  static current(w: { kind: string; starts_at: Date | null; ends_at: Date | null; cron_expr: string | null; duration_min: number | null; timezone: string }, now: Date): { start: Date; end: Date } | null {
    if (w.kind === 'once') {
      return w.starts_at && w.ends_at && w.starts_at <= now && now < w.ends_at ? { start: w.starts_at, end: w.ends_at } : null;
    }
    if (!w.cron_expr || !w.duration_min) return null;
    const prev = new Cron(w.cron_expr, { timezone: w.timezone }).previousRuns(1, now)[0];
    if (!prev) return null;
    const end = new Date(prev.getTime() + w.duration_min * 60_000);
    return end > now ? { start: prev, end } : null;
  }

  /** Next start of a window after `now` (for display). */
  static next(w: { kind: string; starts_at: Date | null; cron_expr: string | null; timezone: string }, now: Date): Date | null {
    if (w.kind === 'once') return w.starts_at && w.starts_at > now ? w.starts_at : null;
    return w.cron_expr ? new Cron(w.cron_expr, { timezone: w.timezone }).nextRun(now) : null;
  }

  async refresh(): Promise<void> {
    const { db } = this.ctx;
    const now = new Date();
    const wins = await db.selectFrom('maintenance_windows').selectAll().where('active', '=', 1).execute();
    const live: ActiveWindow[] = [];
    for (const w of wins) {
      let cur: { start: Date; end: Date } | null = null;
      try { cur = Maintenance.current(w, now); } catch (e) { this.ctx.log.warn({ err: e, window: w.id }, 'invalid maintenance schedule'); }
      if (!cur) continue;
      live.push({ id: w.id, name: w.name, description: w.description, announce: bool(w.announce), endsAt: cur.end, monitorIds: await this.expand(w.id) });
    }
    const next = new Set<number>();
    for (const w of live) for (const id of w.monitorIds) next.add(id);
    const changed = next.size !== this.active.size || [...next].some((id) => !this.active.has(id));
    const started = [...next].filter((id) => !this.active.has(id));
    const ended = [...this.active].filter((id) => !next.has(id));
    this.active = next;
    this.windows = live;
    if (changed) {
      const rows = [...started.map((id) => ({ id, type: 'maintenance_start' })), ...ended.map((id) => ({ id, type: 'maintenance_end' }))];
      if (rows.length) await db.insertInto('events').values(rows.map((r) => ({ monitor_id: r.id, ts: now, type: r.type, from_status: null, to_status: null, error_kind: null, message: null, details: null }))).execute();
      this.ctx.bus.publish({ type: 'maintenance' });
    }
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
