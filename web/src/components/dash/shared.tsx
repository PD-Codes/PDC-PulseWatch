import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { pageEntries, statusOf, type PageEntry } from '../../lib/dashboardView';
import type { MonitorX } from '../../lib/monitorExtras';
import { usePagedList } from '../../lib/usePagedList';
import type { Summary, ViewSection } from '../../lib/viewModel';
import { fmtDuration, fmtPct } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { StatusDot, uptimeTone } from '../status';
import { cx } from '../ui';

export type Section = ViewSection<MonitorX>;
export interface SelectProps { selecting: boolean; sel: Set<number>; onToggle: (id: number) => void }

/** Link to the monitor; while selecting, a click toggles the selection instead (it then acts as a checkbox). */
export function SelectLink({ m, selecting, selected, onToggle, className, title, children }: { m: MonitorX; selecting: boolean; selected: boolean; onToggle: (id: number) => void; className?: string; title?: string; children?: ReactNode }) {
  return (
    <Link to={`/monitors/${m.id}`} title={title} role={selecting ? 'checkbox' : undefined} aria-checked={selecting ? selected : undefined}
      onClick={(e) => { if (selecting) { e.preventDefault(); onToggle(m.id); } }} className={className}>{children ?? m.name}</Link>
  );
}

/** "Down for 2h 5m"; just the status when the start is unknown. */
export function useStatusFor() {
  const t = useT();
  return (m: MonitorX, now: number) => {
    const status = t(`status.${statusOf(m)}`);
    return m.statusSince ? t('dview.for', { status, dur: fmtDuration((now - Date.parse(m.statusSince)) / 1000) }) : status;
  };
}

const COUNT_TONE = { up: 'text-emerald-600 dark:text-emerald-400', down: 'text-red-600 dark:text-red-400', attention: 'text-amber-600 dark:text-amber-400', maintenance: 'text-sky-600 dark:text-sky-400', other: 'text-slate-500' } as const;

/** "12 ok · 1 down · 1 maintenance": only the kinds that occur, numbers in their status color. */
export function SummaryCounts({ s, className }: { s: Summary; className?: string }) {
  const t = useT();
  const parts = (['up', 'down', 'attention', 'maintenance', 'other'] as const).filter((k) => s[k] > 0);
  return (
    <span className={cx('whitespace-nowrap text-xs text-slate-500', className)}>
      {parts.map((k, i) => <span key={k}>{i > 0 && ' · '}<span className={cx('font-semibold tabular-nums', COUNT_TONE[k])}>{s[k]}</span> {t(`dview.n.${k}`)}</span>)}
    </span>
  );
}

export const MeanUptime = ({ s, className }: { s: Summary; className?: string }) => {
  const t = useT();
  return <span className={cx('text-xs font-semibold tabular-nums', uptimeTone(s.uptime24), className)} title={t('dview.meanUptime')}>{fmtPct(s.uptime24, 2)}</span>;
};

/** Heading row of a group inside a paged list (table, heatmap). */
export function GroupHead({ section, continued, className }: { section: Section; continued: boolean; className?: string }) {
  const t = useT();
  return (
    <div className={cx('flex items-center gap-2 bg-slate-50 px-3 py-1 text-xs dark:bg-slate-800/60', className)}>
      {section.summary.worst && <StatusDot status={section.summary.worst} className="!h-2 !w-2" />}
      <span className="min-w-0 truncate font-semibold text-slate-700 dark:text-slate-200">{section.path || t('monitors.noGroup')}</span>
      {continued && <span className="shrink-0 text-slate-400">{t('dview.continued')}</span>}
      <SummaryCounts s={section.summary} className="ml-auto" /><MeanUptime s={section.summary} className="w-14 text-right" />
    </div>
  );
}

/**
 * Paging for table and heatmap: flat, or grouped with a heading per group on every page (see pageEntries).
 * The page size is remembered per list (`key`) and offers "All".
 */
export function useGroupedPage(rows: MonitorX[], sections: Section[] | null, key: string, resetKey: string) {
  const flat = useMemo(() => (sections ? sections.flatMap((s) => s.items) : rows), [rows, sections]);
  const { pageRows, pagerProps, page, pageSize } = usePagedList(flat, { key, resetKey: `${resetKey}|${sections ? 'g' : ''}`, all: true });
  const entries = useMemo<PageEntry<MonitorX, Section>[]>(
    () => (sections ? pageEntries<MonitorX, Section>(sections, page, pageSize) : pageRows.map((item) => ({ kind: 'row', item }))),
    [sections, page, pageSize, pageRows],
  );
  return { entries, pagerProps };
}
