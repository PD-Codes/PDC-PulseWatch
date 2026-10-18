import { getRunner, type CheckResult } from '../../core';
import { fail, toCheckError } from '../../core/util';
import { config } from '../config';
import type { Ctx } from '../context';
import { bool, parseJson } from '../db';
import { recordSpan } from '../telemetry';
import { isMultiLocation, LOCAL_LOCATION_ID, parseMonitor, type Monitor } from '../monitors/model';
import { aggregate, anomalyStep, initialState, step, type AnomalyState, type LocationResult, type Overlay } from './machine';

export interface RecordOpts {
  /** Move next_run_at forward (scheduler rounds). Manual checks leave the schedule alone. */
  advance: boolean;
  scheduledFor?: Date;
}

const CERT_THRESHOLDS = [0, 1, 3, 7, 14, 30];
const RECENT_MAX = 60;

export class Engine {
  constructor(private ctx: Ctx) {}

  /** Run the monitor's check from this server (no state change). */
  async runLocal(m: Monitor): Promise<CheckResult> {
    const runner = getRunner(m.type);
    if (!runner) return fail('config', `Unknown monitor type "${m.type}"`);
    const timeoutMs = m.timeoutS * 1000;
    let hard: NodeJS.Timeout | undefined;
    try {
      const run = runner.run({ config: m.config, timeoutMs, signal: AbortSignal.timeout(timeoutMs), guard: this.ctx.guard, monitor: { id: m.id, name: m.name } });
      const guardTimer = new Promise<CheckResult>((resolve) => { hard = setTimeout(() => resolve(fail('timeout', 'Check exceeded its timeout', { details: { phase: 'hard' } })), timeoutMs + 2000); });
      return await Promise.race([run, guardTimer]);
    } catch (e) {
      const ce = toCheckError(e);
      return fail(ce.kind, ce.message, { details: ce.details });
    } finally { clearTimeout(hard); }
  }

  /** One scheduling round: run local check / evaluate push / aggregate probe results, then record the verdict. */
  async runRound(m: Monitor, opts: RecordOpts): Promise<CheckResult | null> {
    const start = Date.now();
    let verdict: CheckResult | null;
    if (m.type === 'push') verdict = await this.pushVerdict(m);
    else if (isMultiLocation(m)) {
      const local = m.locations!.includes('local') ? await this.runLocal(m) : null;
      if (local) await this.storeLocation(m.id, LOCAL_LOCATION_ID, local);
      verdict = await this.aggregateLocations(m);
    } else verdict = await this.runLocal(m);
    if (verdict) recordSpan({ name: 'monitor.check', start, end: Date.now(), attrs: { 'monitor.id': m.id, 'monitor.type': m.type, 'check.ok': verdict.ok, ...(verdict.latencyMs != null ? { 'check.latency_ms': verdict.latencyMs } : {}) }, error: verdict.ok ? undefined : `${verdict.errorKind ?? 'error'}: ${verdict.message ?? ''}` });
    if (!verdict) {
      if (opts.advance) await this.reschedule(m, opts.scheduledFor);
      return null;
    }
    await this.record(m, verdict, opts);
    return verdict;
  }

  private async pushVerdict(m: Monitor): Promise<CheckResult | null> {
    const st = await this.ctx.db.selectFrom('monitor_state').select('last_push_at').where('monitor_id', '=', m.id).executeTakeFirst();
    const limitMs = m.intervalS * 1000 + (m.config.graceSeconds ?? 60) * 1000;
    const since = st?.last_push_at ?? m.createdAt;
    const age = Date.now() - since.getTime();
    if (!st?.last_push_at && age < limitMs) return null; // never pinged yet, still within the first window
    if (age > limitMs) return fail('missed', `No heartbeat received for ${Math.round(age / 1000)}s (expected every ${m.intervalS}s)`);
    return { ok: true, message: `Last heartbeat ${Math.round(age / 1000)}s ago` };
  }

  /** Persist a single location's raw result and keep its latest state for quorum evaluation. */
  async storeLocation(monitorId: number, locationId: number, r: CheckResult, ts = new Date()): Promise<void> {
    const { db } = this.ctx;
    await db.insertInto('monitor_location_state').values({ monitor_id: monitorId, location_id: locationId, ok: r.ok ? 1 : 0, ts, latency_ms: r.latencyMs ?? null, error_kind: r.errorKind ?? null, message: r.message?.slice(0, 500) ?? null })
      .onDuplicateKeyUpdate({ ok: r.ok ? 1 : 0, ts, latency_ms: r.latencyMs ?? null, error_kind: r.errorKind ?? null, message: r.message?.slice(0, 500) ?? null }).execute();
    await db.insertInto('heartbeats').values({ monitor_id: monitorId, location_id: locationId, ts, status: r.ok ? 1 : 0, latency_ms: r.latencyMs ?? null, error_kind: r.errorKind ?? null, message: r.message?.slice(0, 500) ?? null }).execute();
  }

  private async aggregateLocations(m: Monitor): Promise<CheckResult | null> {
    const { db } = this.ctx;
    const staleBefore = new Date(Date.now() - (m.intervalS * 3 + m.timeoutS) * 1000);
    const rows = await db.selectFrom('monitor_location_state').selectAll().where('monitor_id', '=', m.id).where('ts', '>', staleBefore).execute();
    const wanted = new Set<number>((m.locations ?? []).map((l) => (l === 'local' ? LOCAL_LOCATION_ID : l)));
    const fresh = rows.filter((r) => wanted.has(r.location_id));
    if (!fresh.length) return null;
    const probeIds = fresh.filter((r) => r.location_id !== LOCAL_LOCATION_ID).map((r) => r.location_id);
    const names = new Map<number, string>();
    if (probeIds.length) for (const p of await db.selectFrom('probes').select(['id', 'name']).where('id', 'in', probeIds).execute()) names.set(p.id, p.name);
    const results: LocationResult[] = fresh.map((r) => ({ id: r.location_id, name: r.location_id === LOCAL_LOCATION_ID ? 'Server' : names.get(r.location_id) ?? `Probe ${r.location_id}`, ok: bool(r.ok), latencyMs: r.latency_ms, errorKind: r.error_kind, message: r.message }));
    const agg = aggregate(results, m.quorum);
    return { ok: agg.ok, latencyMs: agg.latencyMs, errorKind: agg.errorKind as CheckResult['errorKind'], message: agg.message, details: { locations: results } };
  }

  /** Is the monitor suppressed by a parent that is down or in maintenance? */
  private async suppressedByParent(monitorId: number): Promise<boolean> {
    const parents = await this.ctx.db.selectFrom('monitor_dependencies as d').innerJoin('monitor_state as s', 's.monitor_id', 'd.depends_on_id')
      .select(['d.depends_on_id', 's.status']).where('d.monitor_id', '=', monitorId).execute();
    return parents.some((p) => p.status === 'down' || this.ctx.maintenance.isActive(p.depends_on_id));
  }

  async reschedule(m: Monitor, scheduledFor?: Date, retry = false): Promise<void> {
    const next = this.nextRun(m, scheduledFor, retry);
    await this.ctx.db.updateTable('monitors').set({ next_run_at: next, lease_owner: null, lease_until: null }).where('id', '=', m.id).execute();
  }

  nextRun(m: Monitor, scheduledFor: Date | undefined, retry: boolean): Date {
    const now = Date.now();
    const base = retry ? m.retryIntervalS * 1000 : m.intervalS * 1000;
    const jitter = (Math.random() - 0.5) * base * (config.scheduler.jitterPct / 100);
    if (retry) return new Date(now + base + jitter);
    const planned = (scheduledFor?.getTime() ?? now) + base;
    // After a long stall do not fire a burst of catch-up checks: restart the cadence from now.
    return new Date(planned > now ? planned + jitter : now + Math.random() * Math.min(base, 5000));
  }

  /** Apply a verdict to the monitor's state, write heartbeat/events, then fire incidents, notifications and realtime updates. */
  async record(m: Monitor, r: CheckResult, opts: RecordOpts): Promise<void> {
    const { db, bus, maintenance } = this.ctx;
    const now = new Date();
    let overlay: Overlay = 'none';
    if (maintenance.isActive(m.id)) overlay = 'maintenance';
    else if (!r.ok && (await this.suppressedByParent(m.id))) overlay = 'suppressed';

    const result = await db.transaction().execute(async (trx) => {
      await trx.insertInto('monitor_state').values({ monitor_id: m.id }).ignore().execute();
      const st = await trx.selectFrom('monitor_state').selectAll().where('monitor_id', '=', m.id).forUpdate().executeTakeFirstOrThrow();
      const prevMachine = { ...initialState(), status: st.status, consecutiveFail: st.consecutive_fail, consecutiveOk: st.consecutive_ok, attempt: m.attempt, outcomes: st.outcomes, flapping: bool(st.flapping) };
      const o = step(prevMachine, { retries: m.retries, upThreshold: m.upThreshold, downThreshold: m.downThreshold, flapWindow: m.flapWindow, flapThreshold: m.flapThreshold, overlay }, r.ok);

      const recent = parseJson<[number, number, number | null][]>(st.recent, []);
      recent.push([Math.floor(now.getTime() / 1000), o.hbStatus, r.latencyMs ?? null]);
      if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);

      let anomaly = parseJson<AnomalyState | null>(st.anomaly, null);
      if (r.ok && r.latencyMs != null && overlay === 'none') anomaly = anomalyStep(anomaly, r.latencyMs);

      // certificate expiry tracking
      let certInfo: string | null = st.cert_info;
      let certExpires: Date | null = st.cert_expires_at;
      let certAlert: number | null = null;
      if (r.cert) {
        const prev = parseJson<{ notified?: number } | null>(st.cert_info, null);
        const days = r.cert.daysLeft;
        const hit = CERT_THRESHOLDS.find((t) => days <= t);
        const prevNotified = prev?.notified ?? 999;
        let notified = days > 30 ? 999 : prevNotified;
        if (hit !== undefined && hit < prevNotified) { notified = hit; certAlert = days; }
        certInfo = JSON.stringify({ ...r.cert, notified });
        certExpires = new Date(r.cert.validTo);
      }

      const statusChanged = o.status !== st.status;
      await trx.updateTable('monitor_state').set({
        status: o.status, overlay, status_since: statusChanged || !st.status_since ? now : st.status_since,
        consecutive_fail: o.consecutiveFail, consecutive_ok: o.consecutiveOk, last_check_at: now, last_latency_ms: r.latencyMs ?? null,
        last_error_kind: r.ok ? null : r.errorKind ?? 'internal', last_message: r.message?.slice(0, 500) ?? null,
        flapping: o.flapping ? 1 : 0, outcomes: o.outcomes, recent: JSON.stringify(recent), cert_expires_at: certExpires, cert_info: certInfo,
        anomaly: anomaly ? JSON.stringify(anomaly) : null,
      }).where('monitor_id', '=', m.id).execute();

      await trx.insertInto('heartbeats').values({ monitor_id: m.id, location_id: 0, ts: now, status: o.hbStatus, latency_ms: r.latencyMs ?? null, error_kind: r.ok ? null : r.errorKind ?? 'internal', message: r.message?.slice(0, 500) ?? null }).execute();

      const events: { type: string; from?: string; to?: string; kind?: string | null; msg?: string | null; details?: unknown }[] = [];
      if (o.transition) events.push({ type: 'status_change', from: o.transition.from, to: o.transition.to, kind: r.ok ? null : r.errorKind, msg: r.message, details: r.details });
      else if (!r.ok && overlay === 'none' && st.last_error_kind !== (r.errorKind ?? 'internal')) events.push({ type: 'check_error', kind: r.errorKind, msg: r.message, details: r.details });
      if (overlay === 'suppressed' && st.overlay !== 'suppressed') events.push({ type: 'suppressed', msg: 'Alerts suppressed: a dependency is down' });
      if (o.flapEvent) events.push({ type: o.flapEvent === 'start' ? 'flap_start' : 'flap_stop', msg: o.flapEvent === 'start' ? 'Monitor is flapping, notifications are muted' : 'Monitor is stable again' });
      if (certAlert !== null) events.push({ type: 'cert_expiry', kind: 'tls_expiry', msg: `Certificate expires in ${certAlert} day(s)` });
      for (const e of events) {
        await trx.insertInto('events').values({ monitor_id: m.id, ts: now, type: e.type, from_status: e.from ?? null, to_status: e.to ?? null, error_kind: e.kind ?? null, message: e.msg?.slice(0, 1000) ?? null, details: e.details ? JSON.stringify(e.details).slice(0, 8000) : null }).execute();
      }

      const patch: Record<string, unknown> = { attempt: o.attempt };
      if (o.retryScheduled) { patch.next_run_at = this.nextRun(m, opts.scheduledFor, true); patch.lease_owner = null; patch.lease_until = null; }
      else if (opts.advance) { patch.next_run_at = this.nextRun(m, opts.scheduledFor, false); patch.lease_owner = null; patch.lease_until = null; }
      await trx.updateTable('monitors').set(patch).where('id', '=', m.id).execute();
      return { o, recent: recent[recent.length - 1], certAlert, anomaly, statusSince: statusChanged || !st.status_since ? now : st.status_since };
    });

    const { o } = result;
    bus.publish({
      type: 'monitor', monitorId: m.id,
      data: { id: m.id, status: o.status, overlay, latencyMs: r.latencyMs ?? null, errorKind: r.ok ? null : r.errorKind ?? null, message: r.message ?? null, ts: now.toISOString(), beat: result.recent, flapping: o.flapping, statusSince: result.statusSince.toISOString(), anomalyFlagged: !!result.anomaly?.flagged },
    });

    // side effects after commit; failures here must never break the check loop
    try { await this.afterCommit(m, r, o, result.certAlert); } catch (e) { this.ctx.log.error({ err: e, monitor: m.id }, 'post-check actions failed'); }
  }

  private async afterCommit(m: Monitor, r: CheckResult, o: ReturnType<typeof step>, certAlert: number | null): Promise<void> {
    const { incidents, notifier } = this.ctx;
    const muted = o.flapping && !o.flapEvent;
    if (o.transition?.to === 'down') {
      const inc = await incidents.openFor(m, r);
      if (!o.flapping) await notifier.notify({ event: 'down', monitor: m, result: r, incidentId: inc.id });
    } else if (o.transition?.to === 'up') {
      const ids = await incidents.resolveFor(m);
      for (const id of ids) await incidents.stopEscalation(id);
      if (!o.flapping) await notifier.notify({ event: 'up', monitor: m, result: r, incidentId: ids[0] });
    }
    if (o.flapEvent === 'start') await notifier.notify({ event: 'flap', monitor: m, result: r });
    if (o.flapEvent === 'stop') await notifier.notify({ event: o.status === 'down' ? 'down' : 'up', monitor: m, result: r });
    if (certAlert !== null && !muted) await notifier.notify({ event: 'cert', monitor: m, result: r });
  }

  /** "Check now": run immediately and record, without touching the schedule. */
  async checkNow(monitorId: number): Promise<CheckResult | null> {
    const row = await this.ctx.db.selectFrom('monitors').selectAll().where('id', '=', monitorId).executeTakeFirst();
    if (!row) return null;
    const m = parseMonitor(row);
    // Same path as a scheduled round, so multi-location monitors still go through the quorum.
    const r = await this.runRound(m, { advance: false });
    return r ?? { ok: true, message: m.type === 'push' ? 'Waiting for the first heartbeat' : 'Waiting for results from the configured locations' };
  }
}
