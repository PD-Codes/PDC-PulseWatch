import { describe, expect, it } from 'vitest';
import type { HistoryCell, HistoryResponse } from '../../web/src/lib/api';
import { byUrgency, cellsOf, groupSections, heatLevel, hourStarts, rowUptime, summarize, type ViewMonitor } from '../../web/src/lib/viewModel';

const mon = (id: number, name: string, groupId: number | null, status: ViewMonitor['status'] = 'up', extra: Partial<ViewMonitor> = {}): ViewMonitor => ({
  id, name, groupId, active: true, status, overlay: 'none', statusSince: null, latencyMs: 10, recent: [], uptime: { h24: 100 }, ...extra,
});

describe('urgency order', () => {
  it('problems first, the oldest problem first, then by name', () => {
    const list = [mon(1, 'b', null), mon(2, 'a', null), mon(3, 'new', null, 'down', { statusSince: '2026-11-20T08:00:00Z' }), mon(4, 'old', null, 'down', { statusSince: '2026-11-20T07:00:00Z' }), mon(5, 'p', null, 'pending')];
    expect(list.sort(byUrgency).map((m) => m.name)).toEqual(['old', 'new', 'p', 'a', 'b']);
  });
});

describe('summary', () => {
  it('counts per kind and averages the known uptimes', () => {
    const s = summarize([mon(1, 'a', null), mon(2, 'b', null, 'down', { uptime: { h24: 90 } }), mon(3, 'c', null, 'pending', { uptime: { h24: null } }), mon(4, 'd', null, 'up', { overlay: 'maintenance' }), mon(5, 'e', null, 'up', { active: false })]);
    expect(s).toMatchObject({ total: 5, up: 1, down: 1, attention: 1, maintenance: 1, other: 1, worst: 'down' });
    expect(s.uptime24).toBeCloseTo(97.5); // 100, 90, 100, 100
    expect(summarize([]).worst).toBeNull();
  });
});

describe('group sections', () => {
  const groups = [{ id: 1, parentId: null, name: 'Servers' }, { id: 2, parentId: 1, name: 'Linux' }, { id: 3, parentId: null, name: 'Network' }, { id: 4, parentId: 99, name: 'Lost' }];
  const list = [mon(1, 'web', 2), mon(2, 'sw1', 3, 'down'), mon(3, 'loose', null), mon(4, 'x', 4), mon(5, 'ghost', 42)];

  it('tree order with paths; groups without monitors of their own are left out', () => {
    const s = groupSections(list, groups, { order: 'tree', ungrouped: 'last' });
    expect(s.map((x) => [x.key, x.path, x.depth])).toEqual([['2', 'Servers / Linux', 1], ['3', 'Network', 0], ['4', 'Lost', 0], ['none', '', 0]]);
    expect(s.at(-1)!.items.map((m) => m.name)).toEqual(['loose', 'ghost']); // unknown group counts as none
  });

  it('problem order puts the worst section first, ungrouped as asked', () => {
    const s = groupSections(list, groups, { order: 'problems', ungrouped: 'first' });
    expect(s.map((x) => x.key)).toEqual(['none', '3', '4', '2']);
    expect(s[1]!.summary.worst).toBe('down');
  });

  it('does not loop on a parent cycle', () => {
    const s = groupSections([mon(1, 'a', 1), mon(2, 'b', 2)], [{ id: 1, parentId: 2, name: 'A' }, { id: 2, parentId: 1, name: 'B' }]);
    expect(s.map((x) => x.key).sort()).toEqual(['1', '2']);
  });
});

describe('heatmap cells', () => {
  it('steps by availability; maintenance-only and empty hours apart', () => {
    const lv = (c: HistoryCell) => heatLevel(c);
    expect(lv(null)).toBe('none');
    expect(lv([0, 0, 0, 0])).toBe('none');
    expect(lv([60, 60, 0, 0])).toBe('full');
    expect(lv([200, 199, 1, 0])).toBe('high');
    expect(lv([100, 96, 4, 0])).toBe('mid');
    expect(lv([10, 8, 2, 0])).toBe('low');
    expect(lv([10, 1, 9, 0])).toBe('bad');
    expect(lv([12, 0, 0, 12])).toBe('maintenance');
  });

  it('aligns the hours of a monitor and sums a row', () => {
    const h: HistoryResponse = { from: '2026-11-19T09:00:00.000Z', hours: 3, bucketS: 3600, monitors: { 7: [[10, 10, 0, 0], null, [10, 5, 5, 0]] } };
    expect(hourStarts(h).map((d) => d.toISOString())).toEqual(['2026-11-19T09:00:00.000Z', '2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00.000Z']);
    expect(cellsOf(h, 7)).toHaveLength(3);
    expect(cellsOf(h, 8)).toEqual([null, null, null]);
    expect(cellsOf(undefined, 7)).toEqual([]);
    expect(rowUptime(cellsOf(h, 7))).toBe(75);
    expect(rowUptime([null, null])).toBeNull();
  });
});
