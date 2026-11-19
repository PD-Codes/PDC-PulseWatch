import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { KeysetPagerProps } from '../components/KeysetPager';
import { usePageSize } from './usePagedList';

/**
 * Numbered pages on top of the server's "before=<id>" cursor lists (incidents, audit log, delivery log), which have no offset and no total.
 * Page N is fetched with the id of the last row of page N-1 (remembered while the user walks forward); one extra row tells whether a next page exists.
 * `resetKey` (filters) and the page size send the list back to page 1.
 */
export function useKeysetPages<T extends { id: number }>(opts: {
  /** Base of the TanStack Query key (invalidation by prefix keeps working). */
  queryKey: unknown[];
  /** localStorage key of the remembered page size. */
  sizeKey: string;
  fetchPage: (before: number | undefined, limit: number, signal: AbortSignal) => Promise<T[]>;
  resetKey?: unknown;
  refetchInterval?: number;
}) {
  const [size, setSize] = usePageSize(opts.sizeKey);
  const sig = JSON.stringify([opts.resetKey ?? null, size]);
  const [state, setState] = useState<{ sig: string; page: number; cursors: Record<number, number | undefined> }>({ sig, page: 1, cursors: {} });
  // a new filter or size starts at page 1 for good: the old state is dropped, so switching back does not return to the old page
  if (state.sig !== sig) setState({ sig, page: 1, cursors: {} });
  const cur = state.sig === sig ? state : { sig, page: 1, cursors: {} as Record<number, number | undefined> };
  const { page, cursors } = cur;
  const before = cursors[page];

  const q = useQuery({
    queryKey: [...opts.queryKey, size, page, before ?? null],
    queryFn: ({ signal }) => opts.fetchPage(before, size + 1, signal),
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
  });
  const rows = useMemo(() => (q.data ?? []).slice(0, size), [q.data, size]);
  const hasNext = (q.data?.length ?? 0) > size;
  // while the previous page's rows stand in for the next one, they must not be used for a cursor: a second click would reuse the old last id
  const busy = q.isPlaceholderData;

  const go = useCallback((p: number, c: Record<number, number | undefined>) => setState({ sig, page: p, cursors: c }), [sig]);
  const next = () => { if (!busy && hasNext && rows.length) go(page + 1, { ...cursors, [page + 1]: rows[rows.length - 1]!.id }); };
  const prev = () => { if (!busy && page > 1) go(page - 1, cursors); };
  const first = () => { if (!busy && page > 1) go(1, {}); };
  const onPageSize = (n: number) => { setSize(n); };

  const pager: KeysetPagerProps = { busy, page, pageSize: size, count: rows.length, hasNext, onFirst: first, onPrev: prev, onNext: next, onPageSize };
  return { rows, page, pageSize: size, hasNext, pager, isLoading: q.isLoading, isFetching: q.isFetching, isPlaceholder: q.isPlaceholderData, error: q.error, refetch: q.refetch };
}
