import { sql } from 'kysely';
import { config } from '../config';
import type { Ctx } from '../context';
import { parseMonitor } from '../monitors/model';

/**
 * Lease based check scheduler.
 *  - due monitors are claimed with SELECT ... FOR UPDATE SKIP LOCKED, so several workers never run the same check
 *  - a lease outlives the check timeout; after a crash it simply expires and the monitor is picked up again
 *  - next_run_at is persisted, so a restart neither loses nor duplicates scheduled rounds
 */
export class Scheduler {
  private running = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private ticking = false;
  lastTickAt = Date.now();
  lagMs = 0;
  checksRun = 0;

  constructor(private ctx: Ctx) {}

  async start(): Promise<void> {
    await this.initSchedule();
    this.timer = setInterval(() => void this.tick(), config.scheduler.tickMs);
    this.ctx.log.info({ maxConcurrency: config.scheduler.maxConcurrency }, 'scheduler started');
  }

  /** Spread monitors that have no schedule yet over their interval (no thundering herd after import or first start). */
  async initSchedule(): Promise<void> {
    await this.ctx.db.updateTable('monitors')
      .set({ next_run_at: sql`DATE_ADD(NOW(3), INTERVAL FLOOR(RAND() * LEAST(interval_s, 30) * 1000000) MICROSECOND)` as any })
      .where('active', '=', 1).where('next_run_at', 'is', null).execute();
    // leases held by a previous run of this very process id cannot be live
    await this.ctx.db.updateTable('monitors').set({ lease_owner: null, lease_until: null }).where('lease_owner', 'like', `${this.ctx.instanceId}%`).execute();
  }

  stats() { return { running: this.running.size, lagMs: this.lagMs, lastTickAt: this.lastTickAt, checksRun: this.checksRun }; }

  async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      this.lastTickAt = Date.now();
      const free = config.scheduler.maxConcurrency - this.running.size;
      if (free <= 0) return;
      const rows = await this.claim(Math.min(free, 500));
      for (const row of rows) {
        const p = this.runOne(row).finally(() => this.running.delete(p));
        this.running.add(p);
      }
      if (rows.length) this.lagMs = Math.max(0, Date.now() - Math.min(...rows.map((r) => r.next_run_at?.getTime() ?? Date.now())));
      else this.lagMs = 0;
    } catch (e) {
      this.ctx.log.error({ err: e }, 'scheduler tick failed');
    } finally { this.ticking = false; }
  }

  private async claim(limit: number) {
    const { db, instanceId } = this.ctx;
    return db.transaction().execute(async (trx) => {
      const ids = await trx.selectFrom('monitors').select('id')
        .where('active', '=', 1).where('next_run_at', '<=', sql<Date>`NOW(3)`)
        .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', sql<Date>`NOW(3)`)]))
        .orderBy('next_run_at').limit(limit).forUpdate().skipLocked().execute();
      if (!ids.length) return [];
      const list = ids.map((i) => i.id);
      await trx.updateTable('monitors').set({ lease_owner: instanceId, lease_until: sql<Date>`DATE_ADD(NOW(3), INTERVAL timeout_s + 30 SECOND)` }).where('id', 'in', list).execute();
      return trx.selectFrom('monitors').selectAll().where('id', 'in', list).execute();
    });
  }

  private async runOne(row: Awaited<ReturnType<Scheduler['claim']>>[number]): Promise<void> {
    const scheduledFor = row.next_run_at ?? new Date();
    try {
      const m = parseMonitor(row);
      await this.ctx.engine.runRound(m, { advance: true, scheduledFor });
      this.checksRun++;
    } catch (e) {
      this.ctx.log.error({ err: e, monitor: row.id }, 'check round failed');
      // never leave the monitor stuck on a lease: retry on the next interval
      await this.ctx.db.updateTable('monitors').set({ next_run_at: new Date(Date.now() + row.interval_s * 1000), lease_owner: null, lease_until: null }).where('id', '=', row.id).execute().catch(() => {});
    }
  }

  /** Stop claiming, wait for running checks, release leases that are still ours. */
  async stop(graceMs = 15_000): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.race([Promise.allSettled([...this.running]), new Promise((r) => setTimeout(r, graceMs))]);
    await this.ctx.db.updateTable('monitors').set({ lease_owner: null, lease_until: null }).where('lease_owner', '=', this.ctx.instanceId).execute().catch(() => {});
  }
}
