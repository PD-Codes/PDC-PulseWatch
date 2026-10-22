import { describe, expect, it } from 'vitest';
import { packPages, type Row, type Section } from '../../web/src/lib/kiosk-layout';

const sec = (id: number, n: number): Section<number> => ({ key: String(id), id, label: `G${id}`, items: Array.from({ length: n }, (_, i) => id * 100 + i) });
const kinds = (page: Row<number>[]) => page.map((r) => (r.kind === 'head' ? (r.cont ? 'H*' : 'H') : 'T')).join('');

describe('kiosk page packing', () => {
  it('moves a heading that would end a page to the next page', () => {
    const pages = packPages([sec(1, 5), sec(2, 2), sec(3, 1)], 2, 400, 100);
    expect(pages.map(kinds)).toEqual(['HTTT', 'HTHT']);
  });

  it('repeats the heading of a group that continues on the next page', () => {
    expect(packPages([sec(1, 6)], 2, 250, 100).map(kinds)).toEqual(['HTT', 'H*T']);
  });

  it('still makes progress when not even one row fits', () => {
    const pages = packPages([sec(1, 4)], 2, 50, 100);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.some((r) => r.kind === 'tiles'))).toBe(true);
  });
});
