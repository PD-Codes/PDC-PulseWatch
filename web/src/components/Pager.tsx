import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { fmtNumber } from '../lib/format';
import { useT } from '../lib/i18n';
import { Button, Select } from './ui';

export const PAGE_SIZES = [10, 20, 50, 100];
export const DEFAULT_PAGE_SIZE = 20;

export interface PagerProps { page: number; pageSize: number; total: number; capped?: boolean; onPage: (p: number) => void; onPageSize: (n: number) => void; sizes?: number[] }

/**
 * Page buttons with a page-size picker; hidden while everything fits on the first page of the smallest size.
 * A page size that is not in `sizes` (e.g. an old default) is added to the picker instead of showing an empty select.
 */
export function Pager({ page, pageSize, total, capped, onPage, onPageSize, sizes = PAGE_SIZES }: PagerProps) {
  const t = useT();
  if (total <= Math.min(sizes[0]!, pageSize)) return null;
  const all = sizes.includes(pageSize) ? sizes : [...sizes, pageSize].sort((a, b) => a - b);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1, to = Math.min(total, page * pageSize);
  return (
    <nav aria-label={t('pager.label')} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
      <label className="inline-flex items-center gap-1.5">{t('pager.perPage')}
        <Select className="w-auto py-0.5 text-xs" value={pageSize} onChange={(e) => { onPageSize(Number(e.target.value)); onPage(1); }}>{all.map((n) => <option key={n} value={n}>{n}</option>)}</Select>
      </label>
      <span aria-live="polite">{t('pager.range', { from, to, total: capped ? `${fmtNumber(total)}+` : total })}</span>
      <span className="inline-flex items-center gap-0.5">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(1)} aria-label={t('shell.pager.first')} title={t('shell.pager.first')}><ChevronsLeft className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('pager.prev')}><ChevronLeft className="h-4 w-4" /></Button>
        <span aria-current="page" className="min-w-[4.5rem] text-center">{t('pager.page', { page, pages: capped && page >= pages ? `${pages}+` : pages })}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('pager.next')}><ChevronRight className="h-4 w-4" /></Button>
        {!capped && <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(pages)} aria-label={t('shell.pager.last')} title={t('shell.pager.last')}><ChevronsRight className="h-4 w-4" /></Button>}
      </span>
    </nav>
  );
}
