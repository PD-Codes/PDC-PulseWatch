import { sql, type Selectable } from 'kysely';
import { certNotice, getRunner, type CheckResult } from '../../core';
import { fail, toCheckError } from '../../core/util';
import { config } from '../config';
import type { Ctx } from '../context';
import { bool, parseJson } from '../db';
import type { EngineOutboxTable } from '../db/types';
import { recordSpan } from '../telemetry';
import { monitorDefaults } from '../monitors/defaults';
import { pickInfo } from '../monitors/info';
import { isMultiLocation, LOCAL_LOCATION_ID, parseMonitor, type Monitor } from '../monitors/model';
import type { NotifyInput } from '../notify/notifier';
import { notifyLang } from '../notify/texts';
import { aggregate, anomalyStep, initialState, step, type AnomalyState, type LocationResult, type MachineOut, type Overlay, type Status } from './machine';

export interface RecordOpts {
  /** Move next_run_at forward (scheduler rounds). Manual checks leave the schedule alone. */
  advance: boolean;
  /** next_run_at the round was claimed for; a late round whose slot was taken over by another instance is discarded. */
  scheduledFor?: Date;
  /** When the check began; a retry is due retry_interval after it, as in Uptime Kuma (a slow failing attempt does not add its timeout on top). */
  startedAt?: number;
  /** Push monitors: the verdict comes from last_push_at, which is checked again under the row lock (a push may have arrived meanwhile). */
  push?: boolean;
}

/** What a state change still has to do once it is committed: incident, escalation, notifications. One outbox row per change. */
interface OutboxPayload {
  transition: MachineOut['transition'];
  flapping: boolean;
  flapEvent: MachineOut['flapEvent'];
  status: Status;
  cert: boolean;
  result: Pick<CheckResult, 'ok' | 'latencyMs' | 'errorKind' | 'message' | 'cert'>;
}

/** The round must not be applied (another instance owns it, or the monitor is gone). */
class Discard extends Error {}
/** Another process took the outbox entry over. */
class LostClaim extends Error {}

const CERT_THRESHOLDS = [0, 1, 3, 7, 14, 30];
const RECENT_MAX = 60;
/** A retry round of a multi-location monitor without new results waits this long instead of using up an attempt. */
const POSTPONE_MS = 10_000;
const OUTBOX_BACKOFF_S = [5, 15, 60, 300, 900, 1800];
const OUTBOX_MAX_ATTEMPTS = 10;
const OUTBOX_SWEEP_MS = 5_000;
const OUTBOX_KEEP_DAYS = 7;

export class Engine {
  private sweepTimer?: NodeJS.Timeout;
  private sweeping: Promise<unknown> | null = null;
  private lastPrune = 0;
  constructor(private ctx: Ctx) {}

  /** Periodic sweep for outbox entries a crashed or stuck process left behind (every role: claims make it safe). */
  start(): void {
    this.sweepTimer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = this.sweepOutbox().catch((e) => this.ctx.log.error({ err: e }, 'outbox sweep failed')).finally(() => { this.sweeping = null; });
    }, OUTBOX_SWEEP_MS);
    this.sweepTimer.unref();
  }

  async stop(waitMs = 0): Promise<void> {
    clearInterval(this.sweepTimer);
    let t: NodeJS.Timeout | undefined;
    if (this.sweeping) await Promise.race([this.sweeping, new Promise((r) => { t = setTimeout(r, waitMs); })]);
    clearTimeout(t);
  }

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

  /** One scheduling round: run local check / evaluate push / aggregate probe results, then record the verdict. Null when nothing was recorded. */
  async runRound(m: Monitor, opts: RecordOpts): Promise<CheckResult | null> {
    const start = Date.now();
    if (m.type === 'push') return this.pushRound(m, opts, start);
    let verdict: CheckResult | null;
    if (isMultiLocation(m)) {
      const local = m.locations!.includes('local') ? await this.runLocal(m) : null;
      if (local) {
        if (opts.advance && !(await this.ownsRound(m.id, opts))) { this.ctx.log.debug({ monitor: m.id }, 'round taken over by another instance, result discarded'); return null; }
        await this.storeLocation(m.id, LOCAL_LOCATION_ID, local);
      }
      const agg = await this.aggregateLocations(m);
      if (agg === 'postpone') {
        if (opts.advance) await this.reschedule(m, opts.scheduledFor, POSTPONE_MS);
        return null;
      }
      verdict = agg;
    } else verdict = await this.runLocal(m);
    if (verdict) recordSpan({ name: 'monitor.check', start, end: Date.now(), attrs: { 'monitor.id': m.id, 'monitor.type': m.type, 'check.ok': verdict.ok, ...(verdict.latencyMs != null ? { 'check.latency_ms': verdict.latencyMs } : {}) }, error: verdict.ok ? undefined : `${verdict.errorKind ?? 'error'}: ${verdict.message ?? ''}` });
    if (!verdict) {
      if (opts.advance) await this.reschedule(m, opts.scheduledFor);
      return null;
    }
    return this.commit(m, verdict, { ...opts, startedAt: start });
  }

  /**
   * A scheduled round of a push monitor writes exactly one heartbeat that shows the current state, so uptime is
   * up / (up + down) over the rounds: missed push = failure through the state machine; fresh push that was ok = up;
   * fresh push that reported a failure = that failure again, without a new transition or alert.
   */
  private async pushRound(m: Monitor, opts: RecordOpts, start: number): Promise<CheckResult | null> {
    const st = await this.ctx.db.selectFrom('monitor_state').select('last_push_at').where('monitor_id', '=', m.id).executeTakeFirst();
    const state = this.pushState(m, st?.last_push_at ?? null, Date.now());
    if (state === 'missed') return this.commit(m, this.missed(m, st?.last_push_at ?? null, Date.now()), { ...opts, startedAt: start, push: true });
    // manual "check now" leaves a push monitor alone unless its heartbeat is overdue; before the first push there is nothing to show
    if (!opts.advance) return null;
    if (state === 'wait') { await this.reschedule(m, opts.scheduledFor); return null; }
    return this.commit(m, null, { ...opts, startedAt: start, push: true });
  }

  private pushState(m: Monitor, lastPushAt: Date | null, nowMs: number): 'wait' | 'missed' | 'fresh' {
    const limitMs = m.intervalS * 1000 + (m.config.graceSeconds ?? 60) * 1000;
    const age = nowMs - (lastPushAt ?? m.createdAt).getTime();
    if (age > limitMs) return 'missed';
    return lastPushAt ? 'fresh' : 'wait'; // never pinged yet, still within the first window
  }

  private missed(m: Monitor, lastPushAt: Date | null, nowMs: number): CheckResult {
    const age = nowMs - (lastPushAt ?? m.createdAt).getTime();
    return fail('missed', `No heartbeat received for ${Math.round(age / 1000)}s (expected every ${m.intervalS}s)`);
  }

  /** Persist a single location's raw result and keep its latest state for quorum evaluation. */
  async storeLocation(monitorId: number, locationId: number, r: CheckResult, ts = new Date()): Promise<void> {
    const { db } = this.ctx;
    await db.insertInto('monitor_location_state').values({ monitor_id: monitorId, location_id: locationId, ok: r.ok ? 1 : 0, ts, latency_ms: r.latencyMs ?? null, error_kind: r.errorKind ?? null, message: r.message?.slice(0, 500) ?? null })
      .onDuplicateKeyUpdate({ ok: r.ok ? 1 : 0, ts, latency_ms: r.latencyMs ?? null, error_kind: r.errorKind ?? null, message: r.message?.slice(0, 500) ?? null }).execute();
    await db.insertInto('heartbeats').values({ monitor_id: monitorId, location_id: locationId, ts, status: r.ok ? 1 : 0, latency_ms: r.latencyMs ?? null, error_kind: r.errorKind ?? null, message: r.message?.slice(0, 500) ?? null }).execute();
  }

  private async aggregateLocations(m: Monitor): Promise<CheckResult | null | 'postpone'> {
    const { db } = this.ctx;
    const staleBefore = new Date(Date.now() - (m.intervalS * 3 + m.timeoutS) * 1000);
    const rows = await db.selectFrom('monitor_location_state').selectAll().where('monitor_id', '=', m.id).where('ts', '>', staleBefore).execute();
    const wanted = new Set<number>((m.locations ?? []).map((l) => (l === 'local' ? LOCAL_LOCATION_ID : l)));
    let fresh = rows.filter((r) => wanted.has(r.location_id));
    // a new monitor waits for its first results; afterwards a location that stopped reporting (probe offline) counts as failing, so the monitor cannot freeze in its last state
    const settling = m.createdAt > staleBefore;
    if (!fresh.length && settling) return null;
    const offline = settling ? [] : [...wanted].filter((id) => !fresh.some((r) => r.location_id === id));
    if (m.attempt > 0) {
      // A retry round only counts results that came in after the previous attempt; otherwise one failed probe result would be
      // counted again by every retry. Probes report once per interval, so wait (without using up an attempt) until the new
      // results decide the quorum, at most about one interval.
      const prev = (await db.selectFrom('monitor_state').select('last_check_at').where('monitor_id', '=', m.id).executeTakeFirst())?.last_check_at;
      if (prev) {
        const newer = fresh.filter((r) => r.ts > prev);
        const failing = newer.filter((r) => !bool(r.ok)).length + offline.length;
        const open = wanted.size - newer.length - offline.length;
        const q = Math.max(1, m.quorum);
        const decided = failing >= q || failing + open < q;
        const waitedOut = Date.now() - prev.getTime() > (m.intervalS + m.timeoutS) * 1000 + 30_000;
        if (!decided && !waitedOut) return 'postpone';
        if (!waitedOut) fresh = newer;
      }
    }
    const probeIds = [...wanted].filter((id) => id !== LOCAL_LOCATION_ID);
    const names = new Map<number, string>();
    if (probeIds.length) for (const p of await db.selectFrom('probes').select(['id', 'name']).where('id', 'in', probeIds).execute()) names.set(p.id, p.name);
    const nameOf = (id: number) => (id === LOCAL_LOCATION_ID ? 'Server' : names.get(id) ?? `Probe ${id}`);
    const results: LocationResult[] = fresh.map((r) => ({ id: r.location_id, name: nameOf(r.location_id), ok: bool(r.ok), latencyMs: r.latency_ms, errorKind: r.error_kind, message: r.message }));
    for (const id of offline) results.push({ id, name: nameOf(id), ok: false, errorKind: 'missed', message: `No result from ${nameOf(id)} for ${Math.round((Date.now() - staleBefore.getTime()) / 1000)}s` });
    const agg = aggregate(results, m.quorum);
    return { ok: agg.ok, latencyMs: agg.latencyMs, errorKind: agg.errorKind as CheckResult['errorKind'], message: agg.message, details: { locations: results } };
  }

  /**
   * Is the monitor suppressed by an ancestor that is down or on its way there (pending, failing streak), suppressed itself, or in maintenance?
   * Follows the dependency chain upwards (bounded, cycle safe).
   */
  private async suppressedByParent(monitorId: number): Promise<boolean> {
    const seen = new Set<number>([monitorId]);
    let frontier = [monitorId];
    for (let depth = 0; frontier.length && depth < 10; depth++) {
      const parents = await this.ctx.db.selectFrom('monitor_dependencies as d').innerJoin('monitor_state as s', 's.monitor_id', 'd.depends_on_id')
        .select(['d.depends_on_id', 's.status', 's.overlay', 's.fail_since']).where('d.monitor_id', 'in', frontier).execute();
      frontier = [];
      for (const p of parents) {
        if (p.status === 'down' || p.status === 'pending' || p.fail_since || p.overlay === 'suppressed' || this.ctx.maintenance.isActive(p.depends_on_id)) return true;
        if (!seen.has(p.depends_on_id)) { seen.add(p.depends_on_id); frontier.push(p.depends_on_id); }
      }
    }
    return false;
  }

  /** May this round change the monitor's schedule? Yes if it holds the lease, or the lease is free and nobody moved the slot it was claimed for. */
  private owns(row: { lease_owner: string | null; next_run_at: Date | null }, opts: Pick<RecordOpts, 'scheduledFor'>): boolean {
    // shortcut: the lease names the process, not the round; a round that outlives its own lease and is re-claimed by the same process is not told apart (the hard timeout makes that unlikely)
    if (row.lease_owner === this.ctx.instanceId) return true;
    if (row.lease_owner !== null) return false;
    return !opts.scheduledFor || row.next_run_at?.getTime() === opts.scheduledFor.getTime();
  }

  private async ownsRound(monitorId: number, opts: Pick<RecordOpts, 'scheduledFor'>): Promise<boolean> {
    const row = await this.ctx.db.selectFrom('monitors').select(['lease_owner', 'next_run_at']).where('id', '=', monitorId).executeTakeFirst();
    return !!row && this.owns(row, opts);
  }

  /** Plan the next round without recording anything (no verdict, or a postponed retry). Only the owner of the round may. */
  async reschedule(m: Monitor, scheduledFor?: Date, postponeMs?: number): Promise<void> {
    const next = postponeMs ? new Date(Date.now() + postponeMs) : this.nextRun(m, scheduledFor, false);
    const { instanceId } = this.ctx;
    await this.ctx.db.updateTable('monitors').set({ next_run_at: next, lease_owner: null, lease_until: null }).where('id', '=', m.id)
      .where((eb) => eb.or([eb('lease_owner', '=', instanceId), scheduledFor ? eb.and([eb('lease_owner', 'is', null), eb('next_run_at', '=', scheduledFor)]) : eb('lease_owner', 'is', null)]))
      .execute();
  }

  nextRun(m: Monitor, scheduledFor: Date | undefined, retry: boolean, startedAt?: number, spread = false): Date {
    const now = Date.now();
    const base = retry ? m.retryIntervalS * 1000 : m.intervalS * 1000;
    const jitter = (Math.random() - 0.5) * base * (config.scheduler.jitterPct / 100);
    if (retry) return new Date(Math.max((startedAt ?? now) + base + jitter, now + 1000));
    const planned = (scheduledFor?.getTime() ?? now) + base;
    // After a stall, a resume or an interval change do not keep the monitors in step (a burst every interval): spread the next round over the whole interval.
    if (spread || planned <= now) return new Date(now + Math.max(1000, Math.random() * base));
    return new Date(planned + jitter);
  }

  /** Apply a verdict to the monitor's state, write heartbeat/events, then fire incidents, notifications and realtime updates. False when the result was discarded. */
  async record(m: Monitor, r: CheckResult, opts: RecordOpts): Promise<boolean> {
    return (await this.commit(m, r, opts)) !== null;
  }

  /**
   * The state change and the record of what has to follow (outbox) commit together; the follow-up runs right after the commit
   * and, should this process die or the database hang, from the sweep. `r` is null for a push round with a fresh heartbeat.
   */
  private async commit(m: Monitor, r0: CheckResult | null, opts: RecordOpts): Promise<CheckResult | null> {
    const { db, maintenance, log, instanceId } = this.ctx;
    const now = new Date();
    const inMaintenance = maintenance.isActive(m.id, now);
    const suppressed = !inMaintenance && !!r0 && !r0.ok && (await this.suppressedByParent(m.id));
    const downAfterS = m.downAfterS ?? (await monitorDefaults(this.ctx)).downAfterS;

    let out: { r: CheckResult | null; publish: Record<string, unknown> | null; outboxId: number | null };
    try {
      out = await db.transaction().execute(async (trx) => {
        // lock order everywhere: monitors row, then monitor_state row
        const mon = await trx.selectFrom('monitors').select(['attempt', 'lease_owner', 'next_run_at']).where('id', '=', m.id).forUpdate().executeTakeFirst();
        if (!mon) throw new Discard('monitor deleted');
        if (opts.advance && !this.owns(mon, opts)) throw new Discard('round taken over by another instance');
        await trx.insertInto('monitor_state').values({ monitor_id: m.id }).ignore().execute();
        const st = await trx.selectFrom('monitor_state').selectAll().where('monitor_id', '=', m.id).forUpdate().executeTakeFirstOrThrow();

        const schedule = async (retry: boolean, spread: boolean, attempt?: number) => {
          const patch: Record<string, unknown> = attempt === undefined ? {} : { attempt };
          if (retry) {
            // checkNow / push: the retry is planned only when no scheduled round is running; that round plans it otherwise
            if (opts.advance || mon.lease_owner === null) Object.assign(patch, { next_run_at: this.nextRun(m, opts.scheduledFor, true, opts.startedAt), lease_owner: null, lease_until: null });
          } else if (opts.advance) Object.assign(patch, { next_run_at: this.nextRun(m, opts.scheduledFor, false, undefined, spread), lease_owner: null, lease_until: null });
          if (Object.keys(patch).length) await trx.updateTable('monitors').set(patch).where('id', '=', m.id).execute();
        };

        let r = r0;
        let mirror = false;
        if (opts.push) {
          const state = this.pushState(m, st.last_push_at, now.getTime());
          if (state === 'wait') { await schedule(false, false); return { r: null, publish: null, outboxId: null }; }
          if (state === 'missed') r = r0 ?? this.missed(m, st.last_push_at, now.getTime());
          else if (st.last_error_kind === null) {
            // an ok push counts once: unless nothing has recorded it yet (the push endpoint only records a change), the round just shows it
            if (!st.last_check_at || st.last_push_at! > st.last_check_at) r = { ok: true, message: st.last_message ?? 'Heartbeat received' };
            else mirror = true;
          }
          // the job reported a failure during maintenance, which absorbed it: once the window is over it counts
          else if (!inMaintenance && st.overlay === 'maintenance' && (st.status === 'up' || st.status === 'unknown')) r = { ok: false, errorKind: st.last_error_kind as CheckResult['errorKind'], message: st.last_message ?? undefined };
          else mirror = true;
        }

        if (mirror || !r) {
          // fresh push the state machine has already seen: show its outcome again without counting it twice
          const lastOk = st.last_error_kind === null;
          const hb: 0 | 1 | 2 | 3 | 4 = inMaintenance ? 3 : lastOk ? (st.status === 'down' ? 0 : 1) : st.overlay === 'suppressed' ? 4 : st.status === 'pending' ? 2 : 0;
          const overlay: Overlay = inMaintenance ? 'maintenance' : st.overlay === 'maintenance' ? 'none' : st.overlay;
          const recent = parseJson<[number, number, number | null][]>(st.recent, []);
          recent.push([Math.floor(now.getTime() / 1000), hb, null]);
          if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
          await trx.updateTable('monitor_state').set({ overlay, last_check_at: now, recent: JSON.stringify(recent), ...(opts.advance ? { sched_interval_s: m.intervalS } : {}) }).where('monitor_id', '=', m.id).execute();
          await trx.insertInto('heartbeats').values({ monitor_id: m.id, location_id: 0, ts: now, status: hb, latency_ms: null, error_kind: st.last_error_kind, message: st.last_message }).execute();
          await schedule(false, st.sched_interval_s !== m.intervalS);
          const res: CheckResult = lastOk ? { ok: true, message: st.last_message ?? undefined } : { ok: false, errorKind: (st.last_error_kind ?? undefined) as CheckResult['errorKind'], message: st.last_message ?? undefined };
          return { r: res, outboxId: null, publish: { id: m.id, status: st.status, overlay, latencyMs: null, errorKind: st.last_error_kind, message: st.last_message, ts: now.toISOString(), beat: recent[recent.length - 1], flapping: bool(st.flapping), statusSince: (st.status_since ?? now).toISOString(), anomalyFlagged: !!parseJson<AnomalyState | null>(st.anomaly, null)?.flagged } };
        }

        let overlay: Overlay = 'none';
        if (inMaintenance) overlay = 'maintenance';
        else if (!r.ok && suppressed) overlay = 'suppressed';

        const prevMachine = { ...initialState(), status: st.status, consecutiveFail: st.consecutive_fail, consecutiveOk: st.consecutive_ok, attempt: mon.attempt, outcomes: st.outcomes, flapping: bool(st.flapping), failSince: st.fail_since?.getTime() ?? null };
        // A failure streak does not survive a pause (or a long stall) or a maintenance window: a new failure afterwards
        // starts its own retries and down delay instead of going down at once.
        const gapMs = st.last_check_at ? now.getTime() - st.last_check_at.getTime() : Number.POSITIVE_INFINITY;
        const restart = gapMs > (Math.max(m.intervalS, m.retryIntervalS) * 2 + m.timeoutS) * 1000 + 60_000;
        if (restart || (st.overlay === 'maintenance' && overlay !== 'maintenance')) { prevMachine.failSince = null; prevMachine.attempt = 0; }
        const o = step(prevMachine, { retries: m.retries, upThreshold: m.upThreshold, flapWindow: m.flapWindow, flapThreshold: m.flapThreshold, overlay, downAfterS, nowMs: now.getTime() }, r.ok);

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

        const info = pickInfo(m.type, r.details);
        const statusChanged = o.status !== st.status;
        const statusSince = statusChanged || !st.status_since ? now : st.status_since;
        await trx.updateTable('monitor_state').set({
          status: o.status, overlay, status_since: statusSince,
          consecutive_fail: o.consecutiveFail, consecutive_ok: o.consecutiveOk, fail_since: o.failSince ? new Date(o.failSince) : null, last_check_at: now, last_latency_ms: r.latencyMs ?? null,
          last_error_kind: r.ok ? null : r.errorKind ?? 'internal', last_message: r.message?.slice(0, 500) ?? null,
          flapping: o.flapping ? 1 : 0, outcomes: o.outcomes, recent: JSON.stringify(recent), cert_expires_at: certExpires, cert_info: certInfo,
          anomaly: anomaly ? JSON.stringify(anomaly) : null,
          ...(opts.advance && !o.retryScheduled ? { sched_interval_s: m.intervalS } : {}),
          // game server details: cleared while the check fails, kept when a result carries none (multi-location aggregates)
          ...(r.ok ? (info ? { info: JSON.stringify(info) } : {}) : { info: null }),
        }).where('monitor_id', '=', m.id).execute();

        // a failed attempt that is being retried says so, so the check list shows where the monitor is in its round of retries
        const why = r.message ?? r.errorKind ?? 'no details';
        const beatMessage = o.hbStatus !== 2 ? r.message : o.attempt <= m.retries ? `Failed, retry ${o.attempt} of ${m.retries} follows in ${m.retryIntervalS}s: ${why}` : `Failed, reported as down once it has been failing for ${downAfterS}s: ${why}`;
        await trx.insertInto('heartbeats').values({ monitor_id: m.id, location_id: 0, ts: now, status: o.hbStatus, latency_ms: r.latencyMs ?? null, error_kind: r.ok ? null : r.errorKind ?? 'internal', message: beatMessage?.slice(0, 500) ?? null }).execute();

        const events: { type: string; from?: string; to?: string; kind?: string | null; msg?: string | null; details?: unknown }[] = [];
        if (o.transition) events.push({ type: 'status_change', from: o.transition.from, to: o.transition.to, kind: r.ok ? null : r.errorKind, msg: r.message, details: r.details });
        else if (!r.ok && overlay === 'none' && st.last_error_kind !== (r.errorKind ?? 'internal')) events.push({ type: 'check_error', kind: r.errorKind, msg: r.message, details: r.details });
        if (overlay === 'suppressed' && st.overlay !== 'suppressed') events.push({ type: 'suppressed', msg: 'Alerts suppressed: a dependency is down' });
        if (o.flapEvent) events.push({ type: o.flapEvent === 'start' ? 'flap_start' : 'flap_stop', msg: o.flapEvent === 'start' ? 'Monitor is flapping, notifications are muted' : 'Monitor is stable again' });
        if (certAlert !== null) events.push({ type: 'cert_expiry', kind: 'tls_expiry', msg: r.cert ? certNotice(r.cert, m.config) : `Certificate expires in ${certAlert} day(s)` });
        for (const e of events) {
          await trx.insertInto('events').values({ monitor_id: m.id, ts: now, type: e.type, from_status: e.from ?? null, to_status: e.to ?? null, error_kind: e.kind ?? null, message: e.msg?.slice(0, 1000) ?? null, details: e.details ? JSON.stringify(e.details).slice(0, 8000) : null }).execute();
        }

        let outboxId: number | null = null;
        if (o.transition || o.flapEvent || certAlert !== null) {
          const payload: OutboxPayload = { transition: o.transition, flapping: o.flapping, flapEvent: o.flapEvent, status: o.status, cert: certAlert !== null, result: { ok: r.ok, latencyMs: r.latencyMs, errorKind: r.errorKind, message: r.message?.slice(0, 2000), cert: r.cert } };
          const ins = await trx.insertInto('engine_outbox').values({ monitor_id: m.id, payload: JSON.stringify(payload), next_attempt_at: now }).executeTakeFirstOrThrow();
          outboxId = Number(ins.insertId);
        }

        await schedule(o.retryScheduled, restart || st.sched_interval_s !== m.intervalS, o.attempt);
        return {
          r, outboxId,
          publish: { id: m.id, status: o.status, overlay, latencyMs: r.latencyMs ?? null, errorKind: r.ok ? null : r.errorKind ?? null, message: r.message ?? null, ts: now.toISOString(), beat: recent[recent.length - 1], flapping: o.flapping, statusSince: statusSince.toISOString(), anomalyFlagged: !!anomaly?.flagged },
        };
      });
    } catch (e) {
      if (!(e instanceof Discard)) throw e;
      log.debug({ monitor: m.id, instance: instanceId, reason: e.message }, 'round result discarded');
      return null;
    }

    // realtime update and follow-up actions must never break the check loop; the outbox sweep retries what fails here
    if (out.publish) {
      try { this.ctx.bus.publish({ type: 'monitor', monitorId: m.id, data: out.publish }); } catch (e) { log.warn({ err: e, monitor: m.id }, 'realtime update failed'); }
    }
    if (out.outboxId !== null) await this.processOutbox(out.outboxId).catch((e) => log.error({ err: e, monitor: m.id }, 'post-check actions failed'));
    return out.r;
  }

  /* ---------------- outbox ---------------- */

  /** Process pending outbox entries that are due (left behind by a crash, a hang, or waiting for a retry). Returns how many were completed. */
  async sweepOutbox(): Promise<number> {
    const { db } = this.ctx;
    const rows = await db.selectFrom('engine_outbox').select('id').where('status', '=', 'pending').where('next_attempt_at', '<=', sql<Date>`NOW(3)`)
      .where((eb) => eb.or([eb('claimed_until', 'is', null), eb('claimed_until', '<', sql<Date>`NOW(3)`)])).orderBy('id').limit(100).execute();
    let done = 0;
    for (const r of rows) if (await this.processOutbox(r.id)) done++;
    if (Date.now() - this.lastPrune > 3_600_000) {
      this.lastPrune = Date.now();
      await db.deleteFrom('engine_outbox').where('status', 'in', ['done', 'failed']).where('done_at', '<', new Date(Date.now() - OUTBOX_KEEP_DAYS * 86_400_000)).limit(5000).execute();
    }
    return done;
  }

  /**
   * Claim one outbox entry (compare-and-set, safe across processes) and carry it out. The incident step is idempotent and
   * marked once done; the notifications are queued in the same transaction that marks the entry done, so a retry never
   * queues them twice. Entries of one monitor run in order.
   */
  async processOutbox(id: number): Promise<boolean> {
    const { db, instanceId, log } = this.ctx;
    const row = await db.selectFrom('engine_outbox').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row || row.status !== 'pending') return false;
    const older = await db.selectFrom('engine_outbox').select('id').where('monitor_id', '=', row.monitor_id).where('status', '=', 'pending').where('id', '<', id).limit(1).executeTakeFirst();
    if (older) return false; // the sweep handles the older one first
    const claim = await db.updateTable('engine_outbox').set({ claimed_by: instanceId, claimed_until: sql<Date>`DATE_ADD(NOW(3), INTERVAL 60 SECOND)`, attempts: sql<number>`attempts + 1` })
      .where('id', '=', id).where('status', '=', 'pending').where((eb) => eb.or([eb('claimed_until', 'is', null), eb('claimed_until', '<', sql<Date>`NOW(3)`)])).executeTakeFirst();
    if (Number(claim.numUpdatedRows) !== 1) return false;
    const attempt = row.attempts + 1;
    try {
      await this.applyOutbox(row, attempt);
      return true;
    } catch (e) {
      if (e instanceof LostClaim) return false;
      const msg = (e as Error).message?.slice(0, 900) ?? 'error';
      const giveUp = attempt >= OUTBOX_MAX_ATTEMPTS;
      log.error({ err: e, outbox: id, monitor: row.monitor_id, attempt }, giveUp ? 'post-check actions failed, giving up' : 'post-check actions failed, will retry');
      await db.updateTable('engine_outbox')
        .set(giveUp ? { status: 'failed', done_at: new Date(), claimed_until: null, last_error: msg } : { claimed_until: null, last_error: msg, next_attempt_at: new Date(Date.now() + OUTBOX_BACKOFF_S[Math.min(attempt - 1, OUTBOX_BACKOFF_S.length - 1)] * 1000) })
        .where('id', '=', id).where('claimed_by', '=', instanceId).where('status', '=', 'pending').execute().catch(() => {});
      return false;
    }
  }

  private async applyOutbox(row: Selectable<EngineOutboxTable>, attempt: number): Promise<void> {
    const { db, incidents, notifier, instanceId, log } = this.ctx;
    const p = parseJson<OutboxPayload | null>(row.payload, null);
    const mrow = await db.selectFrom('monitors').selectAll().where('id', '=', row.monitor_id).executeTakeFirst();
    const finish = async (notes: NotifyInput[]) => {
      const lang = notes.length ? (await notifyLang(this.ctx)).lang : undefined;
      let queued = 0;
      await db.transaction().execute(async (trx) => {
        const fin = await trx.updateTable('engine_outbox').set({ status: 'done', done_at: new Date(), claimed_until: null, last_error: null })
          .where('id', '=', row.id).where('claimed_by', '=', instanceId).where('status', '=', 'pending').executeTakeFirst();
        if (Number(fin.numUpdatedRows) !== 1) throw new LostClaim();
        for (const n of notes) queued += await notifier.notify(n, { db: trx, lang });
      });
      if (queued) notifier.kick();
    };
    if (!p || !mrow) return finish([]); // unreadable entry or the monitor was deleted meanwhile
    const m = parseMonitor(mrow);
    const r: CheckResult = { ...p.result };
    let incidentIds = parseJson<number[]>(row.incident_ids, []);
    if (!bool(row.incident_done)) {
      if (p.transition?.to === 'down') {
        try { incidentIds = [(await incidents.openFor(m, r)).id]; } catch (e) {
          // the alert must not wait for ever on the incident
          if (attempt < 3) throw e;
          log.error({ err: e, monitor: m.id }, 'could not open the incident, alerting without it');
          incidentIds = [];
        }
      } else if (p.transition?.to === 'up') {
        incidentIds = await incidents.resolveFor(m);
        for (const iid of incidentIds) await incidents.stopEscalation(iid);
      }
      await db.updateTable('engine_outbox').set({ incident_done: 1, incident_ids: JSON.stringify(incidentIds) }).where('id', '=', row.id).where('claimed_by', '=', instanceId).execute();
    }
    const notes: NotifyInput[] = [];
    const muted = p.flapping && !p.flapEvent;
    if (p.transition?.to === 'down') { if (!p.flapping) notes.push({ event: 'down', monitor: m, result: r, incidentId: incidentIds[0] }); }
    else if (p.transition?.to === 'up') { if (!p.flapping) notes.push({ event: 'up', monitor: m, result: r, incidentId: incidentIds[0] }); }
    if (p.flapEvent === 'start') notes.push({ event: 'flap', monitor: m, result: r });
    // when the end of flapping coincides with a status change, that change was already announced above
    if (p.flapEvent === 'stop' && !p.transition) notes.push({ event: p.status === 'down' ? 'down' : 'up', monitor: m, result: r });
    if (p.cert && !muted) notes.push({ event: 'cert', monitor: m, result: r });
    await finish(notes);
  }

  /** "Check now": run immediately and record, without touching the schedule. */
  async checkNow(monitorId: number): Promise<CheckResult | null> {
    const row = await this.ctx.db.selectFrom('monitors').selectAll().where('id', '=', monitorId).executeTakeFirst();
    if (!row) return null;
    const m = parseMonitor(row);
    // Same path as a scheduled round, so multi-location monitors still go through the quorum.
    const r = await this.runRound(m, { advance: false });
    return r ?? { ok: true, message: m.type === 'push' ? 'Nothing to check: the status follows the last heartbeat' : 'Waiting for results from the configured locations' };
  }
}
