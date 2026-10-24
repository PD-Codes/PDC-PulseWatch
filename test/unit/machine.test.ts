import { describe, expect, it } from 'vitest';
import { aggregate, anomalyStep, initialState, step, type MachineParams, type MachineState } from '../../src/server/engine/machine';

const P: MachineParams = { retries: 0, upThreshold: 1, flapWindow: 10, flapThreshold: 6, overlay: 'none' };
const run = (seq: boolean[], p: Partial<MachineParams> = {}, s: MachineState = initialState()) => {
  const out = [];
  for (const ok of seq) { const o = step(s, { ...P, ...p }, ok); s = o; out.push(o); }
  return out;
};

describe('state machine', () => {
  it('first successful check does not count as a recovery', () => {
    const [o] = run([true]);
    expect(o.status).toBe('up');
    expect(o.transition).toBeNull();
  });
  it('goes down immediately without retries and recovers', () => {
    const o = run([true, false, true]);
    expect(o[1]).toMatchObject({ status: 'down', hbStatus: 0, transition: { from: 'up', to: 'down' } });
    expect(o[2]).toMatchObject({ status: 'up', hbStatus: 1, transition: { from: 'down', to: 'up' } });
  });
  it('retries stay pending until exhausted', () => {
    const o = run([true, false, false, false], { retries: 2 });
    expect(o[1]).toMatchObject({ status: 'pending', hbStatus: 2, retryScheduled: true, transition: null });
    expect(o[2]).toMatchObject({ status: 'pending', hbStatus: 2, retryScheduled: true });
    expect(o[3]).toMatchObject({ status: 'down', hbStatus: 0, transition: { from: 'pending', to: 'down' } });
  });
  it('a monitor that is already down does not start another round of retries', () => {
    const out = run([true, false, false, false, false, false], { retries: 2 });
    // up, then pending, pending, down; further failures stay down instead of going back to pending
    expect(out.map((o) => o.hbStatus)).toEqual([1, 2, 2, 0, 0, 0]);
    expect(out[5]!.retryScheduled).toBe(false);
  });
  it('recovering during retries is silent', () => {
    const o = run([true, false, true], { retries: 2 });
    expect(o[2]).toMatchObject({ status: 'up', transition: null, attempt: 0 });
  });
  it('is reported as down after exactly X failed retries', () => {
    const o = run([true, false, false, false, false], { retries: 3 });
    expect(o.map((x) => x.hbStatus)).toEqual([1, 2, 2, 2, 0]); // first failure + 3 retries, then down
    expect(o[4]).toMatchObject({ status: 'down', transition: { from: 'pending', to: 'down' } });
  });
  it('behaves like Uptime Kuma: pending while retries are left, then down, one success is up again', () => {
    const o = run([true, false, false, false, false, true], { retries: 2 });
    expect(o.map((x) => x.hbStatus)).toEqual([1, 2, 2, 0, 0, 1]);
    expect(o.map((x) => x.retryScheduled)).toEqual([false, true, true, false, false, false]); // only a pending beat waits for the retry interval
    expect(o.map((x) => x.transition?.to ?? null)).toEqual([null, null, null, 'down', null, 'up']); // pending -> down is the one that alerts
    expect(run([true, false, false, true, false, false], { retries: 2 }).map((x) => x.hbStatus)).toEqual([1, 2, 2, 1, 2, 2]); // a success starts the count over
  });
  it('up threshold keeps a down monitor down until confirmed', () => {
    const o = run([true, false, true, true], { upThreshold: 2 });
    expect(o[2]).toMatchObject({ status: 'down', hbStatus: 1, transition: null });
    expect(o[3]).toMatchObject({ status: 'up', transition: { from: 'down', to: 'up' } });
  });
  it('maintenance freezes the state and suppression blocks down', () => {
    const base = run([true])[0];
    expect(step(base, { ...P, overlay: 'maintenance' }, false)).toMatchObject({ hbStatus: 3, status: 'up', transition: null });
    expect(step(base, { ...P, overlay: 'suppressed' }, false)).toMatchObject({ hbStatus: 4, status: 'up', transition: null });
    expect(step(base, { ...P, overlay: 'suppressed' }, true)).toMatchObject({ hbStatus: 1 });
  });
  it('detects flapping and recovers from it', () => {
    const o = run([true, false, true, false, true, false, true], { flapWindow: 8, flapThreshold: 5 });
    expect(o.some((x) => x.flapEvent === 'start')).toBe(true);
    const calm = run(Array(12).fill(true), { flapWindow: 8, flapThreshold: 5 }, o[o.length - 1]);
    expect(calm.some((x) => x.flapEvent === 'stop')).toBe(true);
    expect(calm[calm.length - 1].flapping).toBe(false);
  });
});

describe('anomaly hint', () => {
  it('flags sustained latency drift and clears afterwards', () => {
    let s = anomalyStep(null, 100);
    for (let i = 0; i < 60; i++) s = anomalyStep(s, 100 + (i % 5));
    expect(s.flagged).toBe(false);
    for (let i = 0; i < 6; i++) s = anomalyStep(s, 400);
    expect(s.flagged).toBe(true);
    for (let i = 0; i < 15; i++) s = anomalyStep(s, 101);
    expect(s.flagged).toBe(false);
  });
  it('ignores a single spike', () => {
    let s = anomalyStep(null, 100);
    for (let i = 0; i < 60; i++) s = anomalyStep(s, 100 + (i % 5));
    s = anomalyStep(s, 900);
    expect(s.flagged).toBe(false);
  });
});

describe('quorum', () => {
  const L = (id: number, ok: boolean) => ({ id, name: `L${id}`, ok, latencyMs: ok ? 10 * id : null, errorKind: ok ? null : 'timeout' });
  it('is down only when enough locations fail', () => {
    expect(aggregate([L(1, true), L(2, false), L(3, true)], 2).ok).toBe(true);
    expect(aggregate([L(1, false), L(2, false), L(3, true)], 2)).toMatchObject({ ok: false, errorKind: 'timeout' });
    expect(aggregate([L(1, false)], 1).ok).toBe(false);
  });
});
