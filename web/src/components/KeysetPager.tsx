import { ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import { useT } from '../lib/i18n';
import { PAGE_SIZES } from './Pager';
import { Button, Select } from './ui';

export interface KeysetPagerProps { /** the page is loading: first / previous / next wait */ busy?: boolean; page: number; pageSize: number; count: number; hasNext: boolean; onFirst: () => void; onPrev: () => void; onNext: () => void; onPageSize: (n: number) => void }

/**
 * Pager for lists that are walked forward by cursor (no total known): size picker, rows shown, first / previous / next.
 * Hidden while everything fits on the first page of the smallest size.
 */
export function KeysetPager({ busy, page, pageSize, count, hasNext, onFirst, onPrev, onNext, onPageSize }: KeysetPagerProps) {
  const t = useT();
  if (page === 1 && !hasNext && count <= Math.min(PAGE_SIZES[0]!, pageSize)) return null;
  const all = PAGE_SIZES.includes(pageSize) ? PAGE_SIZES : [...PAGE_SIZES, pageSize].sort((a, b) => a - b);
  const from = (page - 1) * pageSize + 1;
  return (
    <nav aria-label={t('pager.label')} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
      <label className="inline-flex items-center gap-1.5">{t('pager.perPage')}
        <Select className="w-auto py-0.5 text-xs" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>{all.map((n) => <option key={n} value={n}>{n}</option>)}</Select>
      </label>
      <span aria-live="polite">{t('ux.pager.openRange', { from, to: from + count - 1, more: hasNext ? t('ux.pager.more') : '' })}</span>
      <span className="inline-flex items-center gap-0.5">
        <Button size="sm" variant="ghost" disabled={busy || page <= 1} onClick={onFirst} aria-label={t('shell.pager.first')} title={t('shell.pager.first')}><ChevronsLeft className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" disabled={busy || page <= 1} onClick={onPrev} aria-label={t('pager.prev')}><ChevronLeft className="h-4 w-4" /></Button>
        <span aria-current="page" className="min-w-[4.5rem] text-center">{t('ux.pager.pageN', { page })}</span>
        <Button size="sm" variant="ghost" disabled={busy || !hasNext} onClick={onNext} aria-label={t('pager.next')}><ChevronRight className="h-4 w-4" /></Button>
      </span>
    </nav>
  );
}
