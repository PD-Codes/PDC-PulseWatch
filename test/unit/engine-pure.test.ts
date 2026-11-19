// Pure parts of the monitoring engine: maintenance schedules (cron, time zones, DST), quiet hours, attempt cap, round spreading.
import { describe, expect, it } from 'vitest';
import { Maintenance } from '../../src/server/engine/maintenance';
import { initialState, MAX_ATTEMPT, step, type MachineParams } from '../../src/server/engine/machine';
import { Engine } from '../../src/server/engine/engine';
import { quietUntil } from '../../src/server/notify/notifier';
import type { Monitor } from '../../src/server/monitors/model';

const cron = (expr: string, durationMin: number, timezone: string) => ({ kind: 'cron', starts_at: null, ends_at: null, cron_expr: expr, duration_min: durationMin, timezone });
const at = (iso: string) => new Date(iso);
const span = (o: { start: Date; end: Date } | null) => (o ? [o.start.toISOString(), o.end.toISOString()] : null);

describe('maintenance windows', () => {
  it('a one-off window covers [start, end) exactly', () => {
    const w = { kind: 'once', starts_at: at('2026-05-01T10:00:00Z'), ends_at: at('2026-05-01T11:00:00Z'), cron_expr: null, duration_min: null, timezone: 'UTC' };
    expect(Maintenance.current(w, at('2026-05-01T09:59:59.999Z'))).toBeNull();
    expect(span(Maintenance.current(w, at('2026-05-01T10:00:00Z')))).toEqual(['2026-05-01T10:00:00.000Z', '2026-05-01T11:00:00.000Z']);
    expect(Maintenance.current(w, at('2026-05-01T11:00:00Z'))).toBeNull();
  });

  it('a cron window starts exactly at the cron time in its own zone and lasts duration_min', () => {
    const w = cron('0 3 * * *', 30, 'Europe/Berlin'); // 03:00 Berlin = 01:00 UTC in summer
    expect(Maintenance.current(w, at('2026-07-10T00:59:59.999Z'))).toBeNull();
    expect(span(Maintenance.current(w, at('2026-07-10T01:00:00Z')))).toEqual(['2026-07-10T01:00:00.000Z', '2026-07-10T01:30:00.000Z']);
    expect(Maintenance.current(w, at('2026-07-10T01:30:00Z'))).toBeNull();
    // winter: 03:00 Berlin = 02:00 UTC
    expect(Maintenance.current(w, at('2026-12-10T01:30:00Z'))).toBeNull();
    expect(span(Maintenance.current(w, at('2026-12-10T02:10:00Z')))).toEqual(['2026-12-10T02:00:00.000Z', '2026-12-10T02:30:00.000Z']);
    expect(Maintenance.next(w, at('2026-12-10T02:10:00Z'))?.toISOString()).toBe('2026-12-11T02:00:00.000Z');
  });

  it('the same cron in another zone is another instant', () => {
    expect(span(Maintenance.current(cron('0 22 * * *', 60, 'America/New_York'), at('2026-07-02T02:30:00Z')))).toEqual(['2026-07-02T02:00:00.000Z', '2026-07-02T03:00:00.000Z']);
    expect(Maintenance.current(cron('0 22 * * *', 60, 'UTC'), at('2026-07-02T02:30:00Z'))).toBeNull();
  });

  it('spring forward: a start time that does not exist that day is never active before it begins', () => {
    // 2026-03-29 Berlin jumps from 02:00 to 03:00; 02:30 does not exist, croner moves it to 03:30 CEST (01:30 UTC)
    const w = cron('30 2 * * *', 60, 'Europe/Berlin');
    expect(Maintenance.current(w, at('2026-03-29T01:10:00Z'))).toBeNull(); // 03:10 CEST: the shifted start is still ahead
    expect(span(Maintenance.current(w, at('2026-03-29T01:45:00Z')))).toEqual(['2026-03-29T01:30:00.000Z', '2026-03-29T02:30:00.000Z']);
    expect(span(Maintenance.current(w, at('2026-03-28T02:00:00Z')))).toEqual(['2026-03-28T01:30:00.000Z', '2026-03-28T02:30:00.000Z']); // the day before, CET
  });

  it('fall back: a start time that exists twice opens the window once', () => {
    // 2026-10-25 Berlin: 02:30 CEST (00:30 UTC) and again 02:30 CET (01:30 UTC)
    const w = cron('30 2 * * *', 30, 'Europe/Berlin');
    expect(span(Maintenance.current(w, at('2026-10-25T00:40:00Z')))).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:00:00.000Z']);
    expect(Maintenance.current(w, at('2026-10-25T01:40:00Z'))).toBeNull();
    expect(Maintenance.next(w, at('2026-10-25T00:40:00Z'))?.toISOString()).toBe('2026-10-26T01:30:00.000Z'); // the next day, CET
  });

  it('a window that spans midnight in its zone and a window without duration', () => {
    expect(span(Maintenance.current(cron('0 23 * * *', 120, 'Asia/Tokyo'), at('2026-01-05T15:30:00Z')))).toEqual(['2026-01-05T14:00:00.000Z', '2026-01-05T16:00:00.000Z']);
    expect(Maintenance.current(cron('0 23 * * *', 0, 'UTC'), at('2026-01-05T23:00:00Z'))).toBeNull();
  });
});

describe('quiet hours', () => {
  it('is inside a window that wraps midnight and returns its end in the channel zone', () => {
    const q = { start: '22:00', end: '07:00', timezone: 'Europe/Berlin' };
    expect(quietUntil(q, at('2026-07-10T21:30:00Z'))?.toISOString()).toBe('2026-07-11T05:00:00.000Z'); // 23:30 -> 07:00 CEST
    expect(quietUntil(q, at('2026-07-10T12:00:00Z'))).toBeNull();
    expect(quietUntil({ ...q, days: [1] }, at('2026-07-10T21:30:00Z'))).toBeNull(); // a Friday, only Mondays are quiet
    expect(quietUntil({ start: '09:00', end: '17:00', timezone: 'Nowhere/Invalid' }, at('2026-07-10T12:00:00Z'))).toBeNull(); // unknown zone never blocks
    expect(quietUntil(null)).toBeNull();
  });
});

describe('attempt counter', () => {
  const P: MachineParams = { retries: 0, upThreshold: 1, flapWindow: 10, flapThreshold: 0, overlay: 'none', downAfterS: 86_400, nowMs: 0 };
  it('stops at MAX_ATTEMPT instead of overflowing the column', () => {
    const s = { ...initialState(), status: 'pending' as const, attempt: MAX_ATTEMPT, failSince: 0 };
    const o = step(s, { ...P, nowMs: 1000 }, false);
    expect(o).toMatchObject({ status: 'pending', attempt: MAX_ATTEMPT, retryScheduled: true });
    expect(MAX_ATTEMPT).toBeLessThanOrEqual(65_535); // SMALLINT UNSIGNED
  });
});

describe('round planning', () => {
  const engine = new Engine({} as never);
  const m = { intervalS: 60, retryIntervalS: 20 } as Monitor;
  it('an overdue monitor is spread over the whole interval, not a few seconds', () => {
    const now = Date.now();
    const offsets = Array.from({ length: 200 }, () => engine.nextRun(m, new Date(now - 3_600_000), false).getTime() - now);
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(900);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(60_100);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(30_000);
  });
  it('a punctual round keeps its cadence unless asked to spread', () => {
    const now = Date.now();
    const next = engine.nextRun(m, new Date(now), false).getTime() - now;
    expect(next).toBeGreaterThan(58_000); expect(next).toBeLessThan(62_000);
    const spread = Array.from({ length: 200 }, () => engine.nextRun(m, new Date(now), false, undefined, true).getTime() - now);
    expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(30_000);
  });
});
