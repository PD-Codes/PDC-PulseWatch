import { describe, expect, it } from 'vitest';
import { GROUPED_DEFAULT, pageEntries, readStoredView, rememberView, resolveView, savedViewChoice, switchView, viewToParams, type PageEntry } from '../../web/src/lib/dashboardView';

const P = (s = '') => new URLSearchParams(s);
const none = readStoredView(null, null);

describe('dashboard view from address and storage', () => {
  it('defaults: table from 12 monitors on, else cards, grouped per display', () => {
    expect(resolveView(P(), none, 11)).toEqual({ display: 'cards', grouped: true });
    expect(resolveView(P(), none, 12)).toEqual({ display: 'table', grouped: false });
    expect(GROUPED_DEFAULT).toEqual({ cards: true, groups: true, table: false, wall: true, heatmap: false });
    expect(resolveView(P('display=wall'), none, 1)).toEqual({ display: 'wall', grouped: true });
    expect(resolveView(P('display=heatmap'), none, 1)).toEqual({ display: 'heatmap', grouped: false });
  });

  it('the address wins over storage; invalid values are ignored', () => {
    const stored = readStoredView('wall', '{"table":true,"wall":false}');
    expect(resolveView(P(), stored, 50)).toEqual({ display: 'wall', grouped: false });
    expect(resolveView(P('display=table'), stored, 50)).toEqual({ display: 'table', grouped: true });
    expect(resolveView(P('display=table&grouped=0'), stored, 50)).toEqual({ display: 'table', grouped: false });
    expect(resolveView(P('grouped=1'), stored, 50)).toEqual({ display: 'wall', grouped: true });
    expect(resolveView(P('display=bogus&grouped=x'), stored, 50)).toEqual({ display: 'wall', grouped: false });
    // the group overview is always grouped
    expect(resolveView(P('display=groups&grouped=0'), stored, 50)).toEqual({ display: 'groups', grouped: true });
  });

  it('migrates the old grid/list choice, but a stored display wins', () => {
    expect(readStoredView(null, null, 'grid').display).toBe('cards');
    expect(readStoredView(null, null, 'list').display).toBe('table');
    expect(readStoredView(null, null, 'other').display).toBeNull();
    expect(readStoredView('heatmap', null, 'grid').display).toBe('heatmap');
    expect(resolveView(P(), readStoredView(null, null, 'list'), 3)).toEqual({ display: 'table', grouped: false });
  });

  it('reads grouped per display and survives broken storage', () => {
    expect(readStoredView('cards', '{"cards":false,"wall":"yes","nope":true}').grouped).toEqual({ cards: false });
    expect(readStoredView('cards', 'not json').grouped).toEqual({});
    expect(readStoredView('cards', '[true]').grouped).toEqual({});
  });

  it('switching brings back the stored grouping; remembering keeps the others', () => {
    const s = readStoredView('cards', '{"table":true}');
    expect(switchView('table', s)).toEqual({ display: 'table', grouped: true });
    expect(switchView('heatmap', s)).toEqual({ display: 'heatmap', grouped: false });
    const n = rememberView(s, { display: 'wall', grouped: false });
    expect(n).toEqual({ display: 'wall', grouped: { table: true, wall: false } });
    expect(rememberView(n, { display: 'groups', grouped: true }).grouped).toEqual({ table: true, wall: false });
  });

  it('writes both params and keeps the others', () => {
    expect(viewToParams({ display: 'table', grouped: true }, P('q=web&grouped=0')).toString()).toBe('q=web&grouped=1&display=table');
    expect(viewToParams({ display: 'groups', grouped: true }, P('grouped=1&sort=name')).toString()).toBe('sort=name&display=groups');
  });

  it('saved views carry the view; older ones without it keep the current one', () => {
    expect(savedViewChoice({ q: 'x' }, none)).toBeNull();
    expect(savedViewChoice({ display: 'nope' }, none)).toBeNull();
    expect(savedViewChoice(null, none)).toBeNull();
    expect(savedViewChoice({ display: 'table', grouped: true }, none)).toEqual({ display: 'table', grouped: true });
    expect(savedViewChoice({ display: 'wall' }, readStoredView(null, '{"wall":false}'))).toEqual({ display: 'wall', grouped: false });
  });
});

describe('grouped pages', () => {
  const sec = (key: string, n: number) => ({ key, items: Array.from({ length: n }, (_, i) => `${key}${i + 1}`) });
  const sections = [sec('a', 3), sec('b', 4), sec('c', 1)];
  const show = (e: PageEntry<string, ReturnType<typeof sec>>[]) => e.map((x) => (x.kind === 'head' ? `#${x.section.key}${x.continued ? '+' : ''}` : x.item));

  it('puts a heading before the first row of each group; headings do not count', () => {
    expect(show(pageEntries(sections, 1, 5))).toEqual(['#a', 'a1', 'a2', 'a3', '#b', 'b1', 'b2']);
  });

  it('repeats the heading of a group that continues from the previous page', () => {
    expect(show(pageEntries(sections, 2, 5))).toEqual(['#b+', 'b3', 'b4', '#c', 'c1']);
    expect(show(pageEntries(sections, 2, 2))).toEqual(['#a+', 'a3', '#b', 'b1']);
    expect(show(pageEntries(sections, 3, 2))).toEqual(['#b+', 'b2', 'b3']);
  });

  it('shows everything for "All" and nothing past the end', () => {
    expect(show(pageEntries(sections, 1, -1))).toHaveLength(11);
    expect(pageEntries(sections, 9, 5)).toEqual([]);
    expect(pageEntries([], 1, 20)).toEqual([]);
  });
});
