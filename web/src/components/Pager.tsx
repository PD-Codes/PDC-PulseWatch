import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useT } from '../lib/i18n';
import { Button, Select } from './ui';

/** Page buttons with a page-size picker; hidden while everything fits on the first (smallest) page. */
export function Pager({ page, pageSize, total, capped, onPage, onPageSize, sizes = [5, 10, 25, 50] }: { page: number; pageSize: number; total: number; capped?: boolean; onPage: (p: number) => void; onPageSize: (n: number) => void; sizes?: number[] }) {
  const t = useT();
  if (total <= sizes[0]!) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1, to = Math.min(total, page * pageSize);
  return (
    <nav aria-label={t('pager.label')} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
      <label className="inline-flex items-center gap-1.5">{t('pager.perPage')}
        <Select className="w-auto py-0.5 text-xs" value={pageSize} onChange={(e) => { onPageSize(Number(e.target.value)); onPage(1); }}>{sizes.map((n) => <option key={n} value={n}>{n}</option>)}</Select>
      </label>
      <span aria-live="polite">{t('pager.range', { from, to, total: capped ? `${total.toLocaleString()}+` : total })}</span>
      <span className="inline-flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('pager.prev')}><ChevronLeft className="h-4 w-4" /></Button>
        <span aria-current="page" className="min-w-[4.5rem] text-center">{t('pager.page', { page, pages: capped && page >= pages ? `${pages}+` : pages })}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('pager.next')}><ChevronRight className="h-4 w-4" /></Button>
      </span>
    </nav>
  );
}
