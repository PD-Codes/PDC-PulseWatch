import { sql } from 'kysely';
import type { Ctx } from '../context';
import { parseJson } from '../db';

export interface TailOpts { pageSize?: number; maxPages?: number; overlapMs?: number; idOverlap?: number }

/**
 * In split deployments the API process has no scheduler; it follows what the worker writes so SSE clients stay live.
 * monitor_state is read by an (updated_at, monitor_id) watermark taken from the database itself. updated_at is set when the
 * statement runs but only becomes visible at commit, so every poll re-reads a window behind the watermark and drops what it
 * has already published. incident_updates and events are append-only and followed by id the same way.
 */
export class Tailer {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private started = false;
  /** monitor_state watermark and what was published per monitor (updated_at in ms). */
  private stateWm = new Date(0);
  private resume?: { t: Date; id: number };
  private seenState = new Map<number, number>();
  private updWm = 0;
  private seenUpd = new Set<number>();
  private evWm = 0;
  private seenEv = new Set<number>();
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly overlapMs: number;
  private readonly idOverlap: number;

  constructor(private ctx: Pick<Ctx, 'db' | 'bus' | 'log'>, opts: TailOpts = {}) {
    this.pageSize = opts.pageSize ?? 500;
    this.maxPages = opts.maxPages ?? 40;
    // a commit can lag behind its updated_at (e.g. queued behind a partition ALTER, which gives up after 5 s): re-read 30 s
    this.overlapMs = opts.overlapMs ?? 30_000;
    this.idOverlap = opts.idOverlap ?? 200;
  }

  start() {
    this.timer = setInterval(() => void this.poll(), 1000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  /** Start from what exists now: history is not replayed. */
  async init(): Promise<void> {
    const { db } = this.ctx;
    const s = await db.selectFrom('monitor_state').select(sql<Date | null>`MAX(updated_at)`.as('t')).executeTakeFirst();
    const u = await db.selectFrom('incident_updates').select(sql<number | null>`MAX(id)`.as('id')).executeTakeFirst();
    const e = await db.selectFrom('events').select(sql<number | null>`MAX(id)`.as('id')).executeTakeFirst();
    this.stateWm = s?.t ? new Date(s.t) : new Date(0);
    this.updWm = Number(u?.id ?? 0);
    this.evWm = Number(e?.id ?? 0);
    // rows inside the overlap window were current before we started: remember them as published
    for (const r of await db.selectFrom('monitor_state').select(['monitor_id', 'updated_at']).where('updated_at', '>', new Date(this.stateWm.getTime() - this.overlapMs)).execute()) this.seenState.set(r.monitor_id, r.updated_at.getTime());
    for (const r of await db.selectFrom('incident_updates').select('id').where('id', '>', this.updWm - this.idOverlap).execute()) this.seenUpd.add(r.id);
    for (const r of await db.selectFrom('events').select('id').where('id', '>', this.evWm - this.idOverlap).execute()) this.seenEv.add(Number(r.id));
    this.started = true;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.started) await this.init();
      await this.pollState();
      await this.pollIncidents();
      await this.pollMaintenance();
    } catch (e) { this.ctx.log.warn({ err: e }, 'state tail failed'); } finally { this.busy = false; }
  }

  private async pollState() {
    const { db, bus, log } = this.ctx;
    // a backlog bigger than one poll continues where the last poll stopped; otherwise re-read the overlap window
    let cur = this.resume ?? { t: new Date(this.stateWm.getTime() - this.overlapMs), id: 0 };
    this.resume = undefined;
    for (let page = 0; ; page++) {
      if (page >= this.maxPages) {
        this.resume = cur;
        log.warn({ pages: page, pageSize: this.pageSize }, 'state tail: backlog larger than one poll, continuing next round');
        break;
      }
      const c = cur;
      // the keyset page only touches idx_state_updated; full rows are read for changes not published yet
      const keys = await db.selectFrom('monitor_state').select(['monitor_id', 'updated_at'])
        .where((eb) => eb.or([eb('updated_at', '>', c.t), eb.and([eb('updated_at', '=', c.t), eb('monitor_id', '>', c.id)])]))
        .orderBy('updated_at').orderBy('monitor_id').limit(this.pageSize).execute();
      const changed = keys.filter((k) => (this.seenState.get(k.monitor_id) ?? -1) < k.updated_at.getTime()).map((k) => k.monitor_id);
      const rows = changed.length ? await db.selectFrom('monitor_state').selectAll().where('monitor_id', 'in', changed).orderBy('updated_at').execute() : [];
      for (const r of rows) {
        const at = r.updated_at.getTime();
        if ((this.seenState.get(r.monitor_id) ?? -1) >= at) continue;
        this.seenState.set(r.monitor_id, at);
        const recent = parseJson<[number, number, number | null][]>(r.recent, []);
        bus.publish({ type: 'monitor', monitorId: r.monitor_id, data: { id: r.monitor_id, status: r.status, overlay: r.overlay, latencyMs: r.last_latency_ms, errorKind: r.last_error_kind, message: r.last_message, ts: r.last_check_at?.toISOString(), beat: recent[recent.length - 1] ?? null, flapping: !!r.flapping, statusSince: r.status_since?.toISOString(), anomalyFlagged: !!parseJson<{ flagged?: boolean }>(r.anomaly, {}).flagged } });
      }
      const last = keys[keys.length - 1];
      if (last && last.updated_at > this.stateWm) this.stateWm = last.updated_at;
      if (keys.length < this.pageSize) break;
      cur = { t: last.updated_at, id: last.monitor_id };
    }
    // entries older than the re-read window can no longer come back
    const keep = this.stateWm.getTime() - 2 * this.overlapMs;
    if (this.seenState.size > 10_000) for (const [id, at] of this.seenState) if (at < keep) this.seenState.delete(id);
  }

  /** Incident changes made by the worker (automatic open/resolve). Changes by people are published by the API route itself. */
  private async pollIncidents() {
    const { db, bus } = this.ctx;
    for (let page = 0; page < this.maxPages; page++) {
      const from = this.updWm - this.idOverlap;
      const rows = await db.selectFrom('incident_updates as u').innerJoin('incidents as i', 'i.id', 'u.incident_id')
        .select(['u.id', 'u.incident_id', 'u.status', 'u.user_id', 'i.monitor_id', 'i.status as istatus'])
        .where('u.id', '>', from).orderBy('u.id').limit(this.pageSize + this.idOverlap).execute();
      let fresh = 0;
      for (const r of rows) {
        if (r.id > this.updWm) this.updWm = r.id;
        if (this.seenUpd.has(r.id)) continue;
        this.seenUpd.add(r.id); fresh++;
        // shortcut: in a deployment with several API processes, changes made by people on another API process are not relayed
        if (r.user_id == null) bus.publish({ type: 'incident', incidentId: r.incident_id, monitorId: r.monitor_id, status: r.status ?? r.istatus });
      }
      for (const id of this.seenUpd) if (id <= this.updWm - this.idOverlap) this.seenUpd.delete(id);
      if (rows.length < this.pageSize + this.idOverlap || !fresh) break;
    }
  }

  /** Maintenance windows starting or ending, as recorded in events by whichever process noticed. */
  private async pollMaintenance() {
    const { db, bus } = this.ctx;
    let any = false;
    for (let page = 0; page < this.maxPages; page++) {
      const from = this.evWm - this.idOverlap;
      const rows = await db.selectFrom('events').select(['id', 'type']).where('id', '>', from).orderBy('id').limit(this.pageSize + this.idOverlap).execute();
      let fresh = 0;
      for (const r of rows) {
        const id = Number(r.id);
        if (id > this.evWm) this.evWm = id;
        if (this.seenEv.has(id)) continue;
        this.seenEv.add(id); fresh++;
        if (r.type === 'maintenance_start' || r.type === 'maintenance_end') any = true;
      }
      for (const id of this.seenEv) if (id <= this.evWm - this.idOverlap) this.seenEv.delete(id);
      if (rows.length < this.pageSize + this.idOverlap || !fresh) break;
    }
    if (any) bus.publish({ type: 'maintenance' }); // one refresh per poll is enough, clients refetch
  }
}
