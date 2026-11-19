// Theme ids shared with the web client, snooze body parsing, SLO target validation and the SLO arithmetic.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sloDetail, snoozeEnd, validSloTarget } from '../../src/server/alerts';
import { fileStamp } from '../../src/server/csv-export';
import { DEFAULT_THEME, isThemeId, THEME_IDS } from '../../src/server/themes';

describe('theme ids', () => {
  it('match the web registry (ThemeId type and THEMES entries)', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/themes/registry.ts'), 'utf8');
    const type = /export type ThemeId\s*=\s*([^;]+);/.exec(src)?.[1] ?? '';
    const fromType = [...type.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const fromList = [...src.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(fromType.length).toBeGreaterThan(0);
    expect([...fromType].sort()).toEqual([...THEME_IDS].sort());
    expect([...fromList].sort()).toEqual([...THEME_IDS].sort());
    expect(isThemeId(DEFAULT_THEME)).toBe(true);
    expect(isThemeId('neon')).toBe(false);
  });

  it('match the pre-paint script, which keeps its own copy because the CSP forbids inline scripts', () => {
    const js = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/public/theme-init.js'), 'utf8');
    const list = (name: string) => [...(new RegExp(`var ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(js)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...list('both'), ...list('darkOnly')].sort()).toEqual([...THEME_IDS].sort());
  });
});

describe('snoozeEnd', () => {
  const now = new Date('2026-11-19T12:00:00.000Z');
  it('accepts minutes or until within the limits', () => {
    expect(snoozeEnd({ minutes: 5 }, now)).toEqual(new Date('2026-11-19T12:05:00.000Z'));
    expect(snoozeEnd({ minutes: 10080 }, now)).toEqual(new Date('2026-11-26T12:00:00.000Z'));
    expect(snoozeEnd({ until: '2026-11-26T12:00:30.000Z' }, now)).toEqual(new Date('2026-11-26T12:00:30.000Z'));
  });
  it('rejects everything else with a message', () => {
    for (const b of [{}, { minutes: 4 }, { minutes: 10081 }, { minutes: 7.5 }, { minutes: 5, until: '2026-11-20T00:00:00Z' }, { until: 'soon' }, { until: '2026-11-19T12:00:00.000Z' }, { until: '2026-11-26T12:02:00.000Z' }]) {
      expect(typeof snoozeEnd(b, now), JSON.stringify(b)).toBe('string');
    }
  });
});

describe('SLO', () => {
  it('validates targets', () => {
    for (const ok of [50, 90, 99.9, 99.95, 99.999]) expect(validSloTarget(ok), String(ok)).toBe(true);
    for (const bad of [49.999, 100, 99.9999, Number.NaN, Infinity, '99', null]) expect(validSloTarget(bad), String(bad)).toBe(false);
  });
  it('computes uptime, budget and met without float noise at the boundary', () => {
    expect(sloDetail(99.9, undefined)).toEqual({ target: 99.9, uptime30d: null, met: null, budgetMinutes: 43.2, usedMinutes: 0, remainingMinutes: 43.2, windowDays: 30 });
    expect(sloDetail(99.9, { up: 999, down: 1 })).toMatchObject({ uptime30d: 99.9, met: true, usedMinutes: 43.2, remainingMinutes: 0 });
    // 99.89999...: shown cut to 99.899, and missed
    expect(sloDetail(99.9, { up: 99_899_999, down: 100_001 })).toMatchObject({ uptime30d: 99.899, met: false });
    expect(sloDetail(99.995, { up: 20_000, down: 0 })).toMatchObject({ uptime30d: 100, met: true, budgetMinutes: 2.2, remainingMinutes: 2.2 });
  });
});

describe('fileStamp', () => {
  it('is compact and safe in file names', () => expect(fileStamp(new Date('2026-11-01T08:30:05.123Z'))).toBe('20261101T083005Z'));
});
