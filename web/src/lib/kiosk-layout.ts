// Page layout of the wall display. Pure functions on sizes in px, so they can be unit tested without a browser.

export interface Section<T> { key: string; id: number | null; label: string; items: T[] }
export type Row<T> = { kind: 'head'; sec: Section<T>; cont: boolean } | { kind: 'tiles'; sec: Section<T>; items: T[] };

/** Fills pages by height. A heading never ends a page alone, and a group that runs over onto the next page gets its heading again. */
/** `headH` is the height of a heading row including the gap below it (2.25rem plus 0.75rem). */
export function packPages<T>(sections: Section<T>[], cols: number, avail: number, rowH: number, headH = 48): Row<T>[][] {
  const rows: Row<T>[] = sections.flatMap((sec) => {
    const r: Row<T>[] = [{ kind: 'head', sec, cont: false }];
    for (let i = 0; i < sec.items.length; i += cols) r.push({ kind: 'tiles', sec, items: sec.items.slice(i, i + cols) });
    return r;
  });
  const h = (r: Row<T>) => (r.kind === 'head' ? headH : rowH);
  const pages: Row<T>[][] = [];
  let cur: Row<T>[] = [], used = 0;
  for (const r of rows) {
    if (cur.some((x) => x.kind === 'tiles') && used + h(r) > avail) {
      const lone = cur[cur.length - 1].kind === 'head' ? cur.pop() : undefined;
      pages.push(cur);
      cur = lone ? [lone] : r.kind === 'tiles' ? [{ kind: 'head', sec: r.sec, cont: true }] : [];
      used = cur.reduce((n, x) => n + h(x), 0);
    }
    cur.push(r); used += h(r);
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/** Rows of a list (table, heatmap) per page: every row holds one item. */
export const perPage = (avail: number, rowH: number): number => Math.max(1, Math.floor(avail / rowH));

/** Pages of a flat list cut into pieces of `n`; always at least one (empty) page. */
export function chunk<T>(list: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out.length ? out : [[]];
}

export interface WallFit {
  cols: number; rows: number; perPage: number; pages: number;
  /** How much larger than the minimum the tiles are (1 when paging); text grows with it. */
  scale: number;
}

/**
 * Status wall without headings: the largest tiles that put all `n` monitors on one page, never smaller than `minW` x `minH`.
 * When even the minimum does not fit, the minimum is used and the monitors are paged.
 */
export function wallFit(n: number, w: number, h: number, minW: number, minH: number, gap: number): WallFit {
  const count = Math.max(1, n);
  let best: WallFit | null = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const tw = (w - gap * (cols - 1)) / cols, th = (h - gap * (rows - 1)) / rows;
    if (tw < minW || th < minH) continue;
    const scale = Math.min(tw / minW, th / minH);
    if (!best || scale > best.scale) best = { cols, rows, perPage: count, pages: 1, scale };
  }
  if (best) return best;
  const cols = Math.max(1, Math.floor((w + gap) / (minW + gap))), rows = Math.max(1, Math.floor((h + gap) / (minH + gap)));
  return { cols, rows, perPage: cols * rows, pages: Math.ceil(count / (cols * rows)), scale: 1 };
}

export interface WallFitGrouped<T> { cols: number; rowH: number; scale: number; pages: Row<T>[][] }

/**
 * Status wall with a heading per group: the fewest columns (so the largest tiles, which keep the aspect of the minimum)
 * that put everything on one page. When nothing fits, the minimum tile is used and the rows are paged like packPages does.
 * `headH` and `rowH` include the gap below them.
 */
export function wallFitGrouped<T>(sections: Section<T>[], w: number, h: number, minW: number, minH: number, gap: number, headH: number): WallFitGrouped<T> {
  const maxCols = Math.max(1, Math.floor((w + gap) / (minW + gap)));
  const heads = sections.length;
  let best: { cols: number; th: number; scale: number } | null = null;
  for (let cols = 1; cols <= maxCols; cols++) {
    const tw = (w - gap * (cols - 1)) / cols;
    const tileRows = sections.reduce((n, s) => n + Math.ceil(s.items.length / cols), 0);
    // the tile height that fills the page, but never taller than the aspect of the minimum tile allows
    const fill = tileRows ? (h - heads * headH) / tileRows - gap : minH;
    const th = Math.min(fill, (tw * minH) / minW);
    if (tw < minW || th < minH) continue;
    const scale = Math.min(tw / minW, th / minH);
    if (!best || scale > best.scale) best = { cols, th, scale };
  }
  if (best) {
    const { cols, th, scale } = best, rowH = th + gap;
    return { cols, rowH, scale, pages: [sections.flatMap((sec) => packPages([sec], cols, Infinity, rowH, headH)[0] ?? [])] };
  }
  const rowH = minH + gap;
  return { cols: maxCols, rowH, scale: 1, pages: packPages(sections, maxCols, h, rowH, headH) };
}

/** A part of a block (a group) in one column: all of its items, or a part of a block taller than a column, with `cont` set after the first. */
export interface Piece<B> { block: B; items: B extends { items: (infer T)[] } ? T[] : never; cont: boolean }
export type Column<B> = Piece<B>[];

/** Height of a column: every piece is a header plus its rows, with `gap` between pieces. */
const columnHeight = <B,>(col: readonly Piece<B>[], headH: number, rowH: number, gap: number) =>
  col.reduce((n, p, i) => n + (i ? gap : 0) + headH + p.items.length * rowH, 0);

/**
 * Group blocks into columns, columns into pages. A block is a header (`headH`) plus one row (`rowH`) per item, with `gap`
 * between blocks. Only a block taller than an empty column is split (the next parts get a "(continued)" header); every other
 * block stays whole. Pages are cut by filling columns in order; then each page is spread over as many columns as it has
 * blocks (at most `cols`), each block going into the currently shortest column, so a page uses its width and reads left to
 * right, top to bottom. The page's column count is the length of its array: fewer blocks give fewer, wider columns.
 */
export function packColumns<B extends { items: unknown[] }>(blocks: readonly B[], cols: number, avail: number, headH: number, rowH: number, gap = 0): Column<B>[][] {
  type P = Piece<B>;
  const maxCols = Math.max(1, cols);
  // 1. pieces: a block that fits an empty column stays whole, a taller one is cut into column-sized parts (at least one row each)
  const per = Math.max(1, Math.floor((avail - headH) / rowH));
  const pieces: P[] = [];
  for (const b of blocks) {
    if (!b.items.length) continue;
    const n = headH + b.items.length * rowH <= avail ? b.items.length : per;
    for (let i = 0; i < b.items.length; i += n) pieces.push({ block: b, items: b.items.slice(i, i + n) as P['items'], cont: i > 0 });
  }
  // 2. pages: fill columns in order; a piece that does not fit the rest of a column starts the next one
  const pages: P[][][] = [];
  let page: P[][] = [], col: P[] = [];
  for (const p of pieces) {
    if (col.length && columnHeight([...col, p], headH, rowH, gap) > avail) {
      page.push(col); col = [];
      if (page.length >= maxCols) { pages.push(page); page = []; }
    }
    col.push(p);
  }
  if (col.length) page.push(col);
  if (page.length) pages.push(page);
  if (!pages.length) return [[]];
  // 3. spread each page over its width, balanced by height; keep the plain fill when balancing would overflow a column
  return pages.map((filled) => {
    const items = filled.flat();
    const spread: P[][] = Array.from({ length: Math.min(maxCols, items.length) }, () => []);
    for (const p of items) {
      let best = 0;
      for (let c = 1; c < spread.length; c++) if (columnHeight(spread[c]!, headH, rowH, gap) < columnHeight(spread[best]!, headH, rowH, gap)) best = c;
      spread[best]!.push(p);
    }
    const fits = spread.every((c) => c.length <= 1 || columnHeight(c, headH, rowH, gap) <= avail);
    return fits ? spread : filled;
  });
}

export interface CardFit {
  cols: number; rows: number; perPage: number; pages: number;
  /** Size of a grown tile in px, or null for the plain grid (tiles share the page, which is paged). */
  tile: { w: number; h: number } | null;
  /** How much larger than the chosen size the tiles are; text grows with it. */
  scale: number;
}

/**
 * Tiles with history. `tw` x `th` is the chosen tile size including the `gap`. When all `n` fit on one page at that size, the
 * tiles grow to fill the page, up to `maxGrow` times the chosen size, with the column count that gives the largest tiles.
 * Otherwise the plain grid of today is used and the list is paged.
 */
export function cardFit(n: number, w: number, h: number, tw: number, th: number, gap: number, maxGrow = 2.5): CardFit {
  const cols = Math.max(1, Math.floor(w / tw)), rows = Math.max(1, Math.floor(h / th));
  const count = Math.max(1, n);
  if (count > cols * rows) return { cols, rows, perPage: cols * rows, pages: Math.ceil(count / (cols * rows)), tile: null, scale: 1 };
  const bw = Math.max(1, tw - gap), bh = Math.max(1, th - gap); // the tile itself, without the gap
  let best: CardFit | null = null;
  for (let c = 1; c <= count; c++) {
    const r = Math.ceil(count / c);
    if (r * c - count >= c) continue; // a whole empty row: the same tiles fit with fewer rows
    const cw = (w - gap * (c - 1)) / c, ch = (h - gap * (r - 1)) / r;
    const tile = { w: Math.min(cw, bw * maxGrow), h: Math.min(ch, bh * maxGrow) };
    const scale = Math.min(tile.w / bw, tile.h / bh);
    if (!best || scale > best.scale) best = { cols: c, rows: r, perPage: count, pages: 1, tile, scale };
  }
  return best && best.scale >= 1 ? best : { cols, rows, perPage: cols * rows, pages: 1, tile: null, scale: 1 };
}
