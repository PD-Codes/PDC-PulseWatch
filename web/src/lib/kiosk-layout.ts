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
