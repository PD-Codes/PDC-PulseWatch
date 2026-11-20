import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_PAGE_SIZE, PAGE_ALL, PAGE_SIZES, type PagerProps } from '../components/Pager';

const KEY = (key: string) => `pw.pageSize.${key}`;
const SIZES_ALL = [...PAGE_SIZES, PAGE_ALL];
const read = (key: string | undefined, fallback: number, allowAll = false): number => {
  if (!key) return fallback;
  try { const n = Number(localStorage.getItem(KEY(key))); return (allowAll && n === PAGE_ALL) || (Number.isInteger(n) && n >= 1 && n <= 500) ? n : fallback; } catch { return fallback; }
};

/** Page size that is remembered per list (localStorage `pw.pageSize.<key>`). For lists whose pages are loaded from the server. */
export function usePageSize(key?: string, defaultSize = DEFAULT_PAGE_SIZE, allowAll = false): [number, (n: number) => void] {
  const [size, set] = useState(() => read(key, defaultSize, allowAll));
  const setSize = useCallback((n: number) => {
    set(n);
    if (key) { try { localStorage.setItem(KEY(key), String(n)); } catch { /* storage unavailable */ } }
  }, [key]);
  return [size, setSize];
}

/**
 * Client-side paging of an already filtered list.
 * `resetKey`: put the filter/search/sort state in here (any value, compared with ===); a change jumps back to page 1.
 * The page is also pulled back to the last valid one when the list shrinks.
 * `all`: offer "All" (PAGE_ALL) as a page size; `pageSize` is then PAGE_ALL while everything is shown.
 */
export function usePagedList<T>(rows: readonly T[], opts: { key?: string; defaultSize?: number; sizes?: number[]; resetKey?: unknown; all?: boolean } = {}): { pageRows: T[]; pagerProps: PagerProps; page: number; pageSize: number; setPage: (p: number) => void } {
  const [pageSize, setPageSize] = usePageSize(opts.key, opts.defaultSize, opts.all);
  const [wanted, setPage] = useState(1);
  const total = rows.length;
  const size = pageSize === PAGE_ALL ? Math.max(1, total) : pageSize;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, wanted), pages); // never render a page that no longer exists
  useEffect(() => { if (wanted !== page) setPage(page); }, [wanted, page]);
  useEffect(() => { setPage(1); }, [opts.resetKey]);
  const pageRows = useMemo(() => rows.slice((page - 1) * size, page * size), [rows, page, size]);
  const onPageSize = useCallback((n: number) => { setPageSize(n); setPage(1); }, [setPageSize]);
  const sizes = opts.sizes ?? (opts.all ? SIZES_ALL : PAGE_SIZES);
  return { pageRows, page, pageSize, setPage, pagerProps: { page, pageSize, total, onPage: setPage, onPageSize, sizes } };
}
