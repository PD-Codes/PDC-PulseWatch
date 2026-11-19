import { describe, expect, it } from 'vitest';
import { alertKind, claimLease, parseLease } from '../../web/src/lib/browserAlerts';
import { EMPTY_FILTERS, filtersToParams, initialMode, matchStatus, parseFilters, sortMonitors } from '../../web/src/lib/dashboardView';
import { nextMorning, snoozeActive, snoozeBody, sloTone, type MonitorX } from '../../web/src/lib/monitorExtras';

const mon = (id: number, p: Partial<MonitorX> = {}): MonitorX => ({
  id, name: `m${id}`, type: 'http', groupId: null, active: true, intervalS: 60, description: null, status: 'up', overlay: 'none', statusSince: null, lastCheckAt: null, latencyMs: null,
  errorKind: null, message: null, flapping: false, recent: [], certExpiresAt: null, anomaly: false, publicBadge: false, locations: null, pushToken: null, tags: [], dependsOn: [],
  uptime: { h24: null, d7: null, d30: null, d90: null, d365: null }, info: null, ...p,
});

describe('dashboard filters in the address', () => {
  it('round-trips and leaves defaults out', () => {
    const f = { ...EMPTY_FILTERS, q: 'web shop', status: 'slo' as const, group: '4', sort: 'latency' as const };
    const p = filtersToParams(f);
    expect(p.toString()).toBe('q=web+shop&status=slo&group=4&sort=latency');
    expect(parseFilters(p)).toEqual(f);
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe('');
  });
  it('keeps unrelated parameters and drops invalid values', () => {
    const p = filtersToParams({ ...EMPTY_FILTERS, q: 'x' }, new URLSearchParams('tab=1&q=old'));
    expect(p.get('tab')).toBe('1');
    expect(p.get('q')).toBe('x');
    expect(parseFilters(new URLSearchParams('status=nope&sort=foo&group=abc'))).toEqual(EMPTY_FILTERS);
  });
});

describe('dashboard sorting', () => {
  const list = [
    mon(1, { name: 'b', status: 'up', latencyMs: 50, uptime: { h24: 99, d7: null, d30: null, d90: null, d365: null } }),
    mon(2, { name: 'a', status: 'down', statusSince: '2026-01-02T00:00:00Z', latencyMs: null }),
    mon(3, { name: 'c', status: 'pending', latencyMs: 300, uptime: { h24: 90, d7: null, d30: null, d90: null, d365: null } }),
    mon(4, { name: 'd', overlay: 'maintenance' }),
    mon(5, { name: 'e', status: 'down', statusSince: '2026-01-01T00:00:00Z' }),
    mon(6, { name: 'A2', active: false }),
  ];
  it('puts problems first: down (longest first) > pending > maintenance > rest', () => {
    expect(sortMonitors(list, 'status').map((m) => m.id)).toEqual([5, 2, 3, 4, 1, 6]);
  });
  it('sorts by latency (slowest first) and uptime (worst first), missing values last', () => {
    expect(sortMonitors(list, 'latency').map((m) => m.id).slice(0, 2)).toEqual([3, 1]);
    expect(sortMonitors(list, 'uptime').map((m) => m.id).slice(0, 2)).toEqual([3, 1]);
    expect(sortMonitors(list, 'name').map((m) => m.name)).toEqual(['a', 'A2', 'b', 'c', 'd', 'e']);
  });
  it('filters the cross-cutting sets', () => {
    const now = Date.parse('2026-06-01T12:00:00Z');
    const slo = mon(7, { slo: { target: 99.9, uptime30d: 99, met: false } });
    const muted = mon(8, { snoozedUntil: '2026-06-01T13:00:00Z' });
    expect(matchStatus(slo, 'slo', now)).toBe(true);
    expect(matchStatus(muted, 'snoozed', now)).toBe(true);
    expect(matchStatus(muted, 'snoozed', Date.parse('2026-06-01T14:00:00Z'))).toBe(false);
    expect(list.filter((m) => matchStatus(m, 'problems')).map((m) => m.id)).toEqual([2, 3, 5]);
  });
  it('starts in the dense list from 12 monitors unless a layout was chosen', () => {
    expect(initialMode(null, 11)).toBe('grid');
    expect(initialMode(null, 12)).toBe('list');
    expect(initialMode('grid', 50)).toBe('grid');
  });
});

describe('snooze times', () => {
  it('"until morning" is tomorrow 08:00 during the day and today 08:00 at night', () => {
    expect(nextMorning(new Date(2026, 10, 19, 14, 30)).getTime()).toBe(new Date(2026, 10, 20, 8, 0).getTime());
    expect(nextMorning(new Date(2026, 10, 19, 2, 0)).getTime()).toBe(new Date(2026, 10, 19, 8, 0).getTime());
    expect(nextMorning(new Date(2026, 10, 30, 9, 0)).getTime()).toBe(new Date(2026, 11, 1, 8, 0).getTime()); // month boundary
  });
  it('builds the request bodies', () => {
    expect(snoozeBody('h1')).toEqual({ minutes: 60 });
    expect(snoozeBody('h4')).toEqual({ minutes: 240 });
    const now = new Date(2026, 10, 19, 22, 0);
    expect(snoozeBody('morning', now)).toEqual({ until: new Date(2026, 10, 20, 8, 0).toISOString() });
  });
  it('knows whether a snooze is running', () => {
    expect(snoozeActive({ snoozedUntil: null })).toBe(false);
    expect(snoozeActive({ snoozedUntil: '2000-01-01T00:00:00Z' })).toBe(false);
    expect(snoozeActive({ snoozedUntil: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
  });
  it('rates the SLO budget', () => {
    expect(sloTone({ met: false })).toBe('red');
    expect(sloTone({ met: null })).toBe('gray');
    expect(sloTone({ met: true, budgetMinutes: 43, remainingMinutes: 5 })).toBe('amber');
    expect(sloTone({ met: true, budgetMinutes: 43, remainingMinutes: 30 })).toBe('green');
    expect(sloTone({ met: true, budgetMinutes: 43, remainingMinutes: 0 })).toBe('red');
  });
});

describe('browser alerts', () => {
  it('lets one tab hold the lease until it stops renewing', () => {
    expect(claimLease(null, 'a', 1000)).toBe(true);
    expect(claimLease({ id: 'a', ts: 1000 }, 'a', 2000)).toBe(true);
    expect(claimLease({ id: 'b', ts: 1000 }, 'a', 5000)).toBe(false);
    expect(claimLease({ id: 'b', ts: 1000 }, 'a', 1000 + 15_001)).toBe(true);
    expect(parseLease('{"id":"x","ts":5}')).toEqual({ id: 'x', ts: 5 });
    expect(parseLease('garbage')).toBeNull();
    expect(parseLease('{"id":1}')).toBeNull();
  });
  it('alerts on new outages, recoveries only in mode all, never while muted or in maintenance', () => {
    const down = { status: 'down' as const, overlay: 'none' as const };
    const up = { status: 'up' as const, overlay: 'none' as const };
    expect(alertKind('up', down, 'down', false)).toBe('down');
    expect(alertKind('pending', down, 'down', false)).toBe('down');
    expect(alertKind('down', down, 'down', false)).toBeNull();
    expect(alertKind(undefined, down, 'down', false)).toBeNull();
    expect(alertKind('up', down, 'down', true)).toBeNull();
    expect(alertKind('up', down, 'off', false)).toBeNull();
    expect(alertKind('up', { status: 'down', overlay: 'maintenance' }, 'all', false)).toBeNull();
    expect(alertKind('down', up, 'down', false)).toBeNull();
    expect(alertKind('down', up, 'all', false)).toBe('up');
    expect(alertKind('pending', up, 'all', false)).toBeNull();
  });
});

describe('kiosk reload budget', () => {
  it('spreads the first reload, then backs off to every 6 hours after three attempts', async () => {
    const { parseReloads, reloadDelay, GIVE_UP_MS } = await import('../../web/src/lib/kioskReload');
    const now = 1_000_000_000;
    expect(parseReloads(null, now)).toEqual({ n: 0, at: 0 });
    expect(reloadDelay({ n: 0, at: 0 }, now, 0)).toBe(5_000);
    expect(reloadDelay({ n: 1, at: now }, now, 0)).toBe(120_000);
    expect(reloadDelay({ n: 2, at: now }, now, 0)).toBe(600_000);
    expect(reloadDelay({ n: 3, at: now }, now, 0)).toBe(GIVE_UP_MS);
    expect(reloadDelay({ n: 7, at: now - GIVE_UP_MS }, now, 0)).toBe(5_000);
    expect(parseReloads(JSON.stringify({ n: 3, at: now - 25 * 3_600_000 }), now)).toEqual({ n: 0, at: 0 }); // a day later: fresh budget
  });
  it('skips an event another tab announced a moment ago', async () => {
    const { seenRecently } = await import('../../web/src/lib/browserAlerts');
    const raw = JSON.stringify({ key: '3:down:x', ts: 1000 });
    expect(seenRecently(raw, '3:down:x', 5000)).toBe(true);
    expect(seenRecently(raw, '3:down:y', 5000)).toBe(false);
    expect(seenRecently(raw, '3:down:x', 1000 + 60_001)).toBe(false);
    expect(seenRecently('junk', '3:down:x', 5000)).toBe(false);
  });
});
