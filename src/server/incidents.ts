import type { CheckResult } from '../core';
import type { Ctx } from './context';
import type { Monitor } from './monitors/model';

export interface IncidentRef { id: number; started: boolean }

export class IncidentService {
  constructor(private ctx: Pick<Ctx, 'db' | 'bus' | 'settings'>) {}

  /** Open an automatic incident for a monitor that went down (idempotent). */
  async openFor(m: Monitor, r: CheckResult): Promise<IncidentRef> {
    const { db } = this.ctx;
    const existing = await db.selectFrom('incidents').select(['id', 'status']).where('monitor_id', '=', m.id).where('source', '=', 'auto').where('status', '!=', 'resolved').executeTakeFirst();
    if (existing) {
      // the monitor failed again while a person was watching it: back to "open" so it is visible, escalates and tells subscribers again
      if (existing.status === 'monitoring') {
        const moved = await db.updateTable('incidents').set({ status: 'open' }).where('id', '=', existing.id).where('status', '=', 'monitoring').executeTakeFirst();
        if (Number(moved.numUpdatedRows)) {
          await db.insertInto('incident_updates').values({ incident_id: existing.id, kind: 'auto', status: 'open', body: r.message ?? 'Monitor failed again' }).execute();
          this.ctx.bus.publish({ type: 'incident', incidentId: existing.id, monitorId: m.id, status: 'open' });
        }
      }
      return { id: existing.id, started: false };
    }
    const now = new Date();
    // nothing reaches a status page (or its subscribers) unless an admin chose to publish detected incidents
    const pub = (await this.ctx.settings.get('incidents.autoPublish', false)) ? 1 : 0;
    const res = await db.insertInto('incidents').values({ title: `${m.name} is down`, severity: 'major', source: 'auto', monitor_id: m.id, started_at: now, public: pub }).executeTakeFirstOrThrow();
    const id = Number(res.insertId);
    await db.insertInto('incident_monitors').values({ incident_id: id, monitor_id: m.id }).execute();
    await db.insertInto('incident_updates').values({ incident_id: id, kind: 'auto', status: 'open', body: r.message ?? 'Monitor went down', ts: now }).execute();
    this.ctx.bus.publish({ type: 'incident', incidentId: id, monitorId: m.id, status: 'open' });
    return { id, started: true };
  }

  /** Resolve open automatic incidents of a recovered monitor. Returns the resolved ids. An incident a person moved to "monitoring" stays open until they close it. */
  async resolveFor(m: Monitor): Promise<number[]> {
    const { db } = this.ctx;
    const open = await db.selectFrom('incidents').select(['id', 'started_at']).where('monitor_id', '=', m.id).where('source', '=', 'auto').where('status', 'not in', ['resolved', 'monitoring']).execute();
    const now = new Date();
    const done: number[] = [];
    for (const i of open) {
      // a person may have moved it to "monitoring" or resolved it since the read: only touch the row if it is still in the state we saw
      const moved = await db.updateTable('incidents').set({ status: 'resolved', resolved_at: now }).where('id', '=', i.id).where('status', 'not in', ['resolved', 'monitoring']).executeTakeFirst();
      if (!Number(moved.numUpdatedRows)) continue;
      done.push(i.id);
      const mins = Math.max(1, Math.round((now.getTime() - i.started_at.getTime()) / 60000));
      await db.insertInto('incident_updates').values({ incident_id: i.id, kind: 'resolve', status: 'resolved', body: `Monitor recovered after ${mins} min`, ts: now, public: 1 }).execute();
      this.ctx.bus.publish({ type: 'incident', incidentId: i.id, monitorId: m.id, status: 'resolved' });
    }
    return done;
  }

  /** Cancel pending escalations once somebody takes care of the incident or it is over. */
  async stopEscalation(incidentId: number): Promise<void> {
    await this.ctx.db.updateTable('escalation_runs').set({ active: 0 }).where('incident_id', '=', incidentId).execute();
  }
}
