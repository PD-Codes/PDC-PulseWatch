import { describe, expect, it } from 'vitest';
import { cardFit, chunk, packColumns, packPages, wallFit, wallFitGrouped, type Column, type Row, type Section } from '../../web/src/lib/kiosk-layout';

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

describe('status wall fit', () => {
  it('picks the largest tiles that put everything on one page', () => {
    const f = wallFit(6, 1000, 600, 150, 60, 10);
    expect(f.pages).toBe(1);
    expect(f.cols * f.rows).toBeGreaterThanOrEqual(6);
    expect(f.scale).toBeGreaterThan(2); // 6 tiles on a large screen grow well beyond the minimum
    // every other column count gives smaller tiles
    for (let cols = 1; cols <= 6; cols++) {
      const rows = Math.ceil(6 / cols);
      const s = Math.min((1000 - 10 * (cols - 1)) / cols / 150, (600 - 10 * (rows - 1)) / rows / 60);
      expect(s).toBeLessThanOrEqual(f.scale + 1e-9);
    }
  });

  it('pages at the minimum size when not everything fits', () => {
    const f = wallFit(100, 640, 300, 150, 60, 10);
    expect(f).toMatchObject({ cols: 4, rows: 4, perPage: 16, pages: 7, scale: 1 });
  });

  it('never returns zero columns or rows on a tiny screen', () => {
    const f = wallFit(3, 50, 20, 150, 60, 10);
    expect(f.cols).toBe(1);
    expect(f.rows).toBe(1);
    expect(f.pages).toBe(3);
  });

  it('grouped: one page with grown tiles when it fits, packed pages otherwise', () => {
    const one = wallFitGrouped([sec(1, 3), sec(2, 2)], 1000, 600, 150, 60, 10, 40);
    expect(one.pages).toHaveLength(1);
    expect(one.scale).toBeGreaterThan(1);
    expect(one.pages[0]!.filter((r) => r.kind === 'head')).toHaveLength(2);
    const used = one.pages[0]!.reduce((n, r) => n + (r.kind === 'head' ? 40 : one.rowH), 0);
    expect(used).toBeLessThanOrEqual(600);

    const many = wallFitGrouped([sec(1, 40), sec(2, 40)], 640, 300, 150, 60, 10, 40);
    expect(many.scale).toBe(1);
    expect(many.cols).toBe(4);
    expect(many.pages.length).toBeGreaterThan(1);
  });
});

describe('group blocks in columns', () => {
  const blk = (id: number, n: number) => ({ id, items: Array.from({ length: n }, (_, i) => id * 100 + i) });
  const shape = (pages: Column<ReturnType<typeof blk>>[][]) => pages.map((p) => p.map((c) => c.map((x) => `${x.block.id}:${x.items.length}${x.cont ? '+' : ''}`).join(' ')));
  const height = (c: Column<ReturnType<typeof blk>>) => c.reduce((n, x, i) => n + (i ? 5 : 0) + 10 + x.items.length * 10, 0);

  it('puts 4 small blocks on 4 columns one per column', () => {
    // the screenshot case: Web 4, Data 2, Infrastructure 2, Web / APIs 2 on a tall screen
    expect(shape(packColumns([blk(1, 4), blk(2, 2), blk(3, 2), blk(4, 2)], 4, 900, 10, 10, 5))).toEqual([['1:4', '2:2', '3:2', '4:2']]);
  });

  it('uses only as many, wider columns as there are blocks', () => {
    expect(shape(packColumns([blk(1, 3), blk(2, 3)], 4, 900, 10, 10, 5))).toEqual([['1:3', '2:3']]);
    expect(shape(packColumns([blk(1, 3)], 4, 900, 10, 10, 5))).toEqual([['1:3']]);
  });

  it('balances the heights: each block goes into the shortest column, in reading order', () => {
    const pages = packColumns([blk(1, 8), blk(2, 1), blk(3, 1), blk(4, 2), blk(5, 1)], 2, 300, 10, 10, 5);
    expect(shape(pages)).toEqual([['1:8', '2:1 3:1 4:2 5:1']]);
    const hs = pages[0]!.map(height);
    expect(Math.abs(hs[0]! - hs[1]!)).toBeLessThanOrEqual(30);
    // without balancing all of them would fit in the first column; spread over three columns they stack evenly
    expect(shape(packColumns([blk(1, 2), blk(2, 2), blk(3, 2), blk(4, 2), blk(5, 2), blk(6, 2)], 3, 900, 10, 10, 5))).toEqual([['1:2 4:2', '2:2 5:2', '3:2 6:2']]);
  });

  it('moves on to the next column and page when a page is full', () => {
    expect(shape(packColumns([blk(1, 3), blk(2, 3), blk(3, 3)], 2, 100, 10, 10, 5))).toEqual([['1:3 3:3', '2:3']]);
    expect(shape(packColumns([blk(1, 8), blk(2, 8), blk(3, 8)], 2, 100, 10, 10, 5))).toEqual([['1:8', '2:8'], ['3:8']]);
    expect(shape(packColumns([blk(1, 6), blk(2, 4)], 2, 100, 10, 10, 5))).toEqual([['1:6', '2:4']]);
  });

  it('the last page of several is balanced too', () => {
    const pages = packColumns([blk(1, 8), blk(2, 8), blk(3, 3), blk(4, 3)], 2, 100, 10, 10, 5);
    expect(shape(pages)).toEqual([['1:8', '2:8'], ['3:3', '4:3']]);
  });

  it('splits only a block taller than an empty column, with a continued header', () => {
    expect(shape(packColumns([blk(1, 20)], 3, 100, 10, 10, 5))).toEqual([['1:9', '1:9+', '1:2+']]);
    // a block that fits an empty column is not split into the rest of another one
    expect(shape(packColumns([blk(1, 2), blk(2, 8)], 2, 100, 10, 10, 5))).toEqual([['1:2', '2:8']]);
  });

  it('keeps every item exactly once and makes progress on tiny screens', () => {
    const blocks = [blk(1, 7), blk(2, 1), blk(3, 12)];
    for (const [cols, avail] of [[1, 5], [2, 35], [3, 100]] as const) {
      const pages = packColumns(blocks, cols, avail, 10, 10, 5);
      const ids = pages.flat(2).flatMap((x) => x.items).sort((a, b) => a - b);
      expect(ids).toEqual(blocks.flatMap((b) => b.items).sort((a, b) => a - b));
      expect(pages.every((p) => p.length <= cols)).toBe(true);
      expect(pages.every((p) => p.every((c) => c.length === 1 || height(c) <= avail))).toBe(true);
    }
    expect(packColumns([], 2, 100, 10, 10)).toEqual([[]]);
  });
});

describe('card fit', () => {
  // chosen tile 270 x 156 including a 12 px gap, so the tile itself is 258 x 144
  it('grows a single tile to fill a TV, up to 2.5 times the chosen size', () => {
    const f = cardFit(1, 1888, 900, 270, 156, 12);
    expect(f).toMatchObject({ cols: 1, rows: 1, pages: 1, scale: 2.5 });
    expect(f.tile).toEqual({ w: 258 * 2.5, h: 144 * 2.5 });
  });

  it('picks the column count with the largest tiles when several fit', () => {
    const f = cardFit(4, 1888, 900, 270, 156, 12);
    expect(f.pages).toBe(1);
    expect(f.cols * f.rows).toBeGreaterThanOrEqual(4);
    expect(f.scale).toBeGreaterThan(1.5);
    expect(f.tile!.w).toBeLessThanOrEqual((1888 - 12 * (f.cols - 1)) / f.cols);
    expect(f.tile!.h).toBeLessThanOrEqual((900 - 12 * (f.rows - 1)) / f.rows);
  });

  it('stays at the chosen size and pages when not everything fits', () => {
    expect(cardFit(100, 1080, 624, 270, 156, 12)).toEqual({ cols: 4, rows: 4, perPage: 16, pages: 7, tile: null, scale: 1 });
  });

  it('never shrinks below the chosen size', () => {
    const f = cardFit(16, 1080, 624, 270, 156, 12);
    expect(f.scale).toBeGreaterThanOrEqual(1);
    expect(f.pages).toBe(1);
  });
});

describe('list pages', () => {
  it('cuts a list into pages and always has one page', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([[]]);
  });
});
