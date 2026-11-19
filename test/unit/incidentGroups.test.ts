import { describe, expect, it } from 'vitest';
import { groupIncidents } from '../../web/src/lib/incidentGroups';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - min * 60_000).toISOString();
const inc = (id: number, title: string, minAgo: number, mons: number[] = [1]) => ({ id, title, startedAt: at(minAgo), monitors: mons.map((m) => ({ id: m })) });

describe('groupIncidents', () => {
  it('folds a flapping run of the same monitor and title into one group', () => {
    const list = [1, 2, 3, 4, 5].map((n) => inc(10 - n, 'Checkout (flaky) is down', n * 10));
    const g = groupIncidents(list);
    expect(g).toHaveLength(1);
    expect(g[0]!.items).toHaveLength(5);
    expect(g[0]!.head.id).toBe(9);
  });
  it('keeps incidents apart when the gap is longer than the window', () => {
    const g = groupIncidents([inc(3, 'A is down', 0), inc(2, 'A is down', 61), inc(1, 'A is down', 200)]);
    expect(g.map((x) => x.items.length)).toEqual([1, 1, 1]);
  });
  it('measures each incident against its predecessor, not against the newest one', () => {
    const g = groupIncidents([inc(4, 'A', 0), inc(3, 'A', 50), inc(2, 'A', 100), inc(1, 'A', 150)]);
    expect(g).toHaveLength(1);
  });
  it('does not mix other titles or other monitors, and keeps the page order', () => {
    const g = groupIncidents([inc(5, 'A is down', 0), inc(4, 'B is down', 5), inc(3, 'A is down', 10, [2]), inc(2, 'A is down', 15), inc(1, 'B is down', 20)]);
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([[5, 2], [4, 1], [3]]);
  });
  it('treats monitor order and letter case as irrelevant', () => {
    const g = groupIncidents([inc(2, 'Db Down', 0, [2, 1]), inc(1, 'db down ', 5, [1, 2])]);
    expect(g).toHaveLength(1);
  });
  it('returns an empty list for an empty page', () => { expect(groupIncidents([])).toEqual([]); });
});
