import type { CheckResult } from '../core';
import type { Ctx } from './context';
import type { Monitor } from './monitors/model';

export interface IncidentRef { id: number; started: boolean }

export class IncidentService {
  constructor(private ctx: Pick<Ctx, 'db' | 'bus'>) {}

  /** Open an automatic incident for a monitor that went down (idempotent). */
  async openFor(m: Monitor, r: CheckResult): Promise<IncidentRef> {
    const { db } = this.ctx;
    const existing = await db.selectFrom('incidents').select('id').where('monitor_id', '=', m.id).where('source', '=', 'auto').where('status', '!=', 'resolved').executeTakeFirst();
    if (existing) return { id: existing.id, started: false };
    const now = new Date();
    const res = await db.insertInto('incidents').values({ title: `${m.name} is down`, severity: 'major', source: 'auto', monitor_id: m.id, started_at: now }).executeTakeFirstOrThrow();
    const id = Number(res.insertId);
    await db.insertInto('incident_monitors').values({ incident_id: id, monitor_id: m.id }).execute();
    await db.insertInto('incident_updates').values({ incident_id: id, kind: 'auto', body: r.message ?? 'Monitor went down', ts: now }).execute();
    this.ctx.bus.publish({ type: 'incident', incidentId: id, monitorId: m.id, status: 'open' });
    return { id, started: true };
  }

  /** Resolve open automatic incidents of a recovered monitor. Returns the resolved ids. */
  async resolveFor(m: Monitor): Promise<number[]> {
    const { db } = this.ctx;
    const open = await db.selectFrom('incidents').select(['id', 'started_at']).where('monitor_id', '=', m.id).where('source', '=', 'auto').where('status', '!=', 'resolved').execute();
    const now = new Date();
    for (const i of open) {
      await db.updateTable('incidents').set({ status: 'resolved', resolved_at: now }).where('id', '=', i.id).execute();
      const mins = Math.max(1, Math.round((now.getTime() - i.started_at.getTime()) / 60000));
      await db.insertInto('incident_updates').values({ incident_id: i.id, kind: 'resolve', body: `Monitor recovered after ${mins} min`, ts: now }).execute();
      this.ctx.bus.publish({ type: 'incident', incidentId: i.id, monitorId: m.id, status: 'resolved' });
    }
    return open.map((i) => i.id);
  }

  /** Cancel pending escalations once somebody takes care of the incident or it is over. */
  async stopEscalation(incidentId: number): Promise<void> {
    await this.ctx.db.updateTable('escalation_runs').set({ active: 0 }).where('incident_id', '=', incidentId).execute();
  }
}
