/**
 * Pure monitor state machine: no I/O, so the retry / threshold / flap rules can be unit tested.
 *
 * Heartbeat status codes: 0 down, 1 up, 2 pending (failed attempt, confirmation running),
 * 3 maintenance (excluded from uptime), 4 suppressed (parent down, no alerts).
 */
export type Status = 'unknown' | 'up' | 'down' | 'pending';
export type Overlay = 'none' | 'maintenance' | 'suppressed';

export interface MachineState {
  status: Status;
  consecutiveFail: number;
  consecutiveOk: number;
  attempt: number;
  outcomes: string;
  flapping: boolean;
}

export interface MachineParams {
  retries: number;
  upThreshold: number;
  downThreshold: number;
  flapWindow: number;
  flapThreshold: number;
  overlay: Overlay;
}

export interface MachineOut extends MachineState {
  hbStatus: 0 | 1 | 2 | 3 | 4;
  /** Re-check after retry_interval instead of the regular interval. */
  retryScheduled: boolean;
  transition: { from: Status; to: 'up' | 'down' } | null;
  flapEvent: 'start' | 'stop' | null;
}

export const initialState = (): MachineState => ({ status: 'unknown', consecutiveFail: 0, consecutiveOk: 0, attempt: 0, outcomes: '', flapping: false });

export function countTransitions(outcomes: string): number {
  let n = 0;
  for (let i = 1; i < outcomes.length; i++) if (outcomes[i] !== outcomes[i - 1]) n++;
  return n;
}

export function step(s: MachineState, p: MachineParams, ok: boolean): MachineOut {
  const keep = (hb: MachineOut['hbStatus'], extra: Partial<MachineOut> = {}): MachineOut => ({ ...s, hbStatus: hb, retryScheduled: false, transition: null, flapEvent: null, ...extra });
  if (p.overlay === 'maintenance') return keep(3);
  if (!ok && p.overlay === 'suppressed') return keep(4, { attempt: 0 });

  let { status, consecutiveFail, consecutiveOk, attempt } = s;
  let hb: MachineOut['hbStatus'];
  let retry = false;
  let counted = false;

  if (ok) {
    attempt = 0; consecutiveFail = 0; consecutiveOk++; counted = true; hb = 1;
    if (status === 'unknown' || status === 'pending' || status === 'up') status = 'up';
    else if (consecutiveOk >= p.upThreshold) status = 'up'; // down -> up needs confirmation
  } else if (attempt < p.retries) {
    attempt++; hb = 2; retry = true;
    if (status !== 'down') status = 'pending';
  } else {
    attempt = 0; consecutiveFail++; consecutiveOk = 0; counted = true;
    if (consecutiveFail >= p.downThreshold) { status = 'down'; hb = 0; }
    else { hb = 2; retry = true; if (status !== 'down') status = 'pending'; }
  }

  let outcomes = s.outcomes;
  let flapping = s.flapping;
  let flapEvent: MachineOut['flapEvent'] = null;
  if (counted) {
    outcomes = (outcomes + (ok ? '1' : '0')).slice(-Math.max(2, p.flapWindow));
    if (p.flapThreshold > 0) {
      const t = countTransitions(outcomes);
      if (!flapping && t >= p.flapThreshold) { flapping = true; flapEvent = 'start'; }
      else if (flapping && t < Math.ceil(p.flapThreshold / 2)) { flapping = false; flapEvent = 'stop'; }
    }
  }

  const transition = (status === 'up' || status === 'down') && status !== s.status && !(s.status === 'unknown' && status === 'up') && !(s.status === 'pending' && status === 'up')
    ? { from: s.status, to: status as 'up' | 'down' }
    : null;
  return { status, consecutiveFail, consecutiveOk, attempt, outcomes, flapping, hbStatus: hb, retryScheduled: retry, transition, flapEvent };
}

/* -------- response-time anomaly hint (EWMA baseline, no ML) -------- */
export interface AnomalyState { slow: number; fast: number; varSlow: number; n: number; run: number; flagged: boolean }

export function anomalyStep(prev: AnomalyState | null, latency: number): AnomalyState {
  if (!prev) return { slow: latency, fast: latency, varSlow: 0, n: 1, run: 0, flagged: false };
  const aSlow = prev.n < 50 ? 1 / (prev.n + 1) : 0.02;
  const aFast = 0.3;
  // The baseline is only updated by samples that are not part of a flagged drift, so a slow service cannot "teach" the baseline.
  const learn = !prev.flagged;
  // Winsorize: outliers may nudge the baseline but cannot blow up its variance.
  const x = Math.min(latency, prev.slow + 3 * Math.sqrt(prev.varSlow) + 10);
  const diff = x - prev.slow;
  const slow = learn ? prev.slow + aSlow * diff : prev.slow;
  const varSlow = learn ? (1 - aSlow) * (prev.varSlow + aSlow * diff * diff) : prev.varSlow;
  const fast = prev.fast + aFast * (latency - prev.fast);
  const sd = Math.sqrt(varSlow);
  const drifting = prev.n >= 30 && fast > slow + 3 * sd && fast > slow * 1.5 && fast - slow > 25;
  const run = drifting ? prev.run + 1 : 0;
  let flagged = prev.flagged;
  if (!flagged && run >= 3) flagged = true;
  else if (flagged && fast < slow + 1.5 * sd + 10) flagged = false;
  return { slow, fast, varSlow, n: prev.n + 1, run, flagged };
}

/* -------- multi-location quorum -------- */
export interface LocationResult { id: number; name: string; ok: boolean; latencyMs?: number | null; errorKind?: string | null; message?: string | null }

export function aggregate(results: LocationResult[], quorum: number): { ok: boolean; latencyMs?: number; errorKind?: string; message: string } {
  const failing = results.filter((r) => !r.ok);
  const okLat = results.filter((r) => r.ok && r.latencyMs != null).map((r) => r.latencyMs as number).sort((a, b) => a - b);
  const median = okLat.length ? okLat[Math.floor(okLat.length / 2)] : undefined;
  if (failing.length >= Math.max(1, quorum)) {
    const kinds = new Map<string, number>();
    for (const f of failing) kinds.set(f.errorKind ?? 'internal', (kinds.get(f.errorKind ?? 'internal') ?? 0) + 1);
    const kind = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { ok: false, latencyMs: median, errorKind: kind, message: `Down from ${failing.length}/${results.length} locations: ${failing.map((f) => `${f.name} (${f.errorKind ?? 'error'})`).join(', ')}` };
  }
  return { ok: true, latencyMs: median, message: failing.length ? `Up (${failing.length}/${results.length} locations failing, below quorum ${quorum})` : `Up from all ${results.length} location(s)` };
}
