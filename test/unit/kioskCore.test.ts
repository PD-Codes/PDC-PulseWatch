import { describe, expect, it } from 'vitest';
import { inKioskScope, KIOSK_DEFAULTS, kioskConfigDiff, normalizeKioskConfig, SLUG_RE } from '../../src/core/kiosk';

const THEMES = ['classic', 'dark', 'lcars'];

describe('kiosk preset config', () => {
  it('fills missing values from the defaults and drops unknown keys', () => {
    const c = normalizeKioskConfig({ display: 'wall', evil: '<script>' }, THEMES);
    expect(c).toEqual({ ...KIOSK_DEFAULTS, display: 'wall' });
    expect('evil' in c).toBe(false);
  });

  it('replaces invalid values instead of keeping them', () => {
    const c = normalizeKioskConfig({ display: 'pie', show: 1, size: 'xl', zoom: 999, rotate: -3, theme: 'nope', mode: 'grey', clock: 'yes', groups: [1, 1, 'x', -2, 3.5, 7], tags: ['a', '', 'a', 5], monitors: 'all' }, THEMES);
    expect(c.display).toBe('cards');
    expect(c.show).toBe('all');
    expect(c.size).toBe('m');
    expect(c.zoom).toBe(200); // clamped, not reset
    expect(c.rotate).toBe(12);
    expect(c.theme).toBe('classic');
    expect(c.mode).toBe('dark');
    expect(c.clock).toBe(true);
    expect(c.groups).toEqual([1, 7]);
    expect(c.tags).toEqual(['a']);
    expect(c.monitors).toEqual([]);
  });

  it('takes the base for what is missing, so a link can change one setting of a preset', () => {
    const base = normalizeKioskConfig({ display: 'heatmap', groups: [4], theme: 'lcars' }, THEMES);
    const c = normalizeKioskConfig({ zoom: 133 }, THEMES, base);
    expect(c).toEqual({ ...base, zoom: 135 });
    expect(c.groups).not.toBe(base.groups); // copied, not shared
  });

  it('diff keeps only what differs', () => {
    const c = { ...KIOSK_DEFAULTS, display: 'groups' as const, groups: [2, 3] };
    expect(kioskConfigDiff(c)).toEqual({ display: 'groups', groups: [2, 3] });
    expect(kioskConfigDiff({ ...KIOSK_DEFAULTS, groups: [] })).toEqual({});
  });

  it('slugs are short, lower-case and without outer dashes', () => {
    for (const ok of ['noc', 'noc-wall-2', 'a', '0', 'x'.repeat(32)]) expect(SLUG_RE.test(ok), ok).toBe(true);
    for (const bad of ['', 'NOC', '-noc', 'noc-', 'noc wall', 'noc_wall', 'x'.repeat(33), 'ä']) expect(SLUG_RE.test(bad), bad).toBe(false);
  });
});

describe('kiosk scope', () => {
  const groups = [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4, parentId: null }];
  const m = (id: number, groupId: number | null, tags: string[] = [], active = true) => ({ id, groupId, active, tags: tags.map((name) => ({ name })) });
  const list = [m(1, 1, ['prod']), m(2, 3, ['prod', 'db']), m(3, 4, ['db']), m(4, null), m(5, 2, ['prod'], false)];
  const ids = (c: Partial<{ groups: number[]; tags: string[]; monitors: number[] }>) => inKioskScope(list, groups, { groups: [], tags: [], monitors: [], ...c }).map((x) => x.id);

  it('leaves out paused monitors', () => expect(ids({})).toEqual([1, 2, 3, 4]));
  it('a group includes its subgroups at any depth', () => expect(ids({ groups: [1] })).toEqual([1, 2]));
  it('tags match by name, any of them', () => expect(ids({ tags: ['db'] })).toEqual([2, 3]));
  it('everything narrows together', () => expect(ids({ groups: [1], tags: ['db'], monitors: [2, 3] })).toEqual([2]));
  it('survives a parent cycle', () => expect(inKioskScope(list, [{ id: 1, parentId: 2 }, { id: 2, parentId: 1 }], { groups: [1], tags: [], monitors: [] }).map((x) => x.id)).toEqual([1]));
});
