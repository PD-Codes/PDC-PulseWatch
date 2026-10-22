import { describe, expect, it } from 'vitest';
import { initialState, step, type MachineParams, type MachineState } from '../../src/server/engine/machine';

const params = (o: Partial<MachineParams> = {}): MachineParams => ({ retries: 0, upThreshold: 1, downThreshold: 1, flapWindow: 10, flapThreshold: 0, overlay: 'none', downAfterS: 0, nowMs: 0, ...o });
const run = (s: MachineState, ok: boolean, nowMs: number, downAfterS: number) => step(s, params({ nowMs, downAfterS }), ok);

describe('down delay', () => {
  it('goes down immediately without a delay', () => {
    expect(run(initialState(), false, 1000, 0).transition?.to).toBe('down');
  });

  it('stays pending until the failure has lasted long enough, then goes down', () => {
    let s = run(initialState(), true, 0, 120); // up
    let o = run(s, false, 10_000, 120);
    expect([o.status, o.hbStatus, o.retryScheduled, o.transition]).toEqual(['pending', 2, true, null]);
    o = run(o, false, 70_000, 120);
    expect(o.status).toBe('pending');
    o = run(o, false, 130_000, 120); // 120 s after the first failure
    expect([o.status, o.transition?.to]).toEqual(['down', 'down']);
  });

  it('a recovery inside the delay never opens an incident and resets the streak', () => {
    let o = run(run(initialState(), true, 0, 120), false, 10_000, 120);
    o = run(o, true, 40_000, 120);
    expect([o.status, o.transition, o.failSince]).toEqual(['up', null, null]);
    o = run(o, false, 200_000, 120); // a new streak starts from its own first failure
    expect([o.status, o.failSince]).toEqual(['pending', 200_000]);
  });

  it('an already down monitor stays down while the rule changes', () => {
    let o = run(run(initialState(), true, 0, 0), false, 1000, 0);
    expect(o.status).toBe('down');
    o = run(o, false, 2000, 3600);
    expect([o.status, o.transition]).toEqual(['down', null]);
  });
});
