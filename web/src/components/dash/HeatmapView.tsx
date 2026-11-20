import { useQuery } from '@tanstack/react-query';
import { memo, useMemo } from 'react';
import { get, type HistoryCell, type HistoryResponse } from '../../lib/api';
import { statusOf } from '../../lib/dashboardView';
import type { MonitorX } from '../../lib/monitorExtras';
import { HEAT_LEVELS, HEAT_LOOK, cellUptime, cellsOf, heatLevel, hourStarts, rowUptime, type HeatLevel } from '../../lib/viewModel';
import { fmtPct } from '../../lib/format';
import { useI18n, useT } from '../../lib/i18n';
import { Pager } from '../Pager';
import { StatusDot, uptimeTone } from '../status';
import { Card, ErrorBox, Loading, cx } from '../ui';
import { GroupHead, SelectLink, useGroupedPage, type Section, type SelectProps } from './shared';

const NAME_COL = 'minmax(9rem,15rem)';
const cols = (hours: number) => ({ gridTemplateColumns: `${NAME_COL} repeat(${hours}, minmax(0.75rem,1fr)) 3.75rem` });

/** Rows are monitors, columns the last 24 hours (local time); paged like the table, grouped with a heading per group. */
export function HeatmapView({ rows, sections, resetKey, selecting, sel, onToggle }: SelectProps & { rows: MonitorX[]; sections: Section[] | null; resetKey: string }) {
  const t = useT();
  const { locale } = useI18n();
  // only mounted while the heatmap is shown, so the history is only fetched then
  const h = useQuery({ queryKey: ['history', 24], queryFn: () => get<HistoryResponse>('/api/monitors/history?hours=24'), refetchInterval: 60_000, staleTime: 30_000 });
  const { entries, pagerProps } = useGroupedPage(rows, sections, 'dash.heatmap', resetKey);

  const hours = useMemo(() => (h.data ? hourStarts(h.data) : []), [h.data]);
  // "Tue 14:00–15:00" per column for the cell titles, "14:00" every third column for the head
  const labels = useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const step = (h.data?.bucketS ?? 3600) * 1000;
    return hours.map((d) => ({ range: `${day.format(d)}–${time.format(d.getTime() + step)}`, short: time.format(d) }));
  }, [hours, locale, h.data?.bucketS]);
  // one cell array per monitor and response: stable props for the memoized rows while only the monitors change
  const cache = useMemo(() => new Map<number, HistoryCell[]>(), [h.data]);
  const cellsFor = (id: number) => { let c = cache.get(id); if (!c) { c = cellsOf(h.data, id); cache.set(id, c); } return c; };

  const n = hours.length || 24;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800">
        <span className="font-medium text-slate-700 dark:text-slate-200">{t('monitors.range.24h')}</span>
        <Legend />
      </div>
      {h.isLoading ? <Loading /> : h.error && !h.data ? <div className="p-3"><ErrorBox error={h.error} /></div> : (
        <div className="overflow-x-auto">
          <div className="min-w-[36rem]">
            <div className="grid items-end gap-x-[2px] border-b border-slate-100 px-3 py-1 text-[10px] text-slate-500 dark:border-slate-800" style={cols(n)}>
              <span className="sticky left-0 z-[1] bg-white text-xs dark:bg-slate-900">{t('common.name')}</span>
              {labels.map((l, i) => (i % 3 === 0 ? <span key={i} className="truncate tabular-nums" style={{ gridColumn: `${i + 2} / span 3` }}>{l.short}</span> : null))}
              <span className="text-right text-xs" style={{ gridColumn: n + 2 }} title={t('dview.heat.window')}>24 h</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {entries.map((e) => (e.kind === 'head'
                ? <GroupHead key={`h${e.section.key}`} section={e.section} continued={e.continued} />
                : <HeatRow key={e.item.id} m={e.item} cells={cellsFor(e.item.id)} labels={labels} n={n} selecting={selecting} selected={sel.has(e.item.id)} onToggle={onToggle} />))}
            </div>
          </div>
        </div>
      )}
      <Pager {...pagerProps} />
    </Card>
  );
}

function Legend() {
  const t = useT();
  const label: Record<HeatLevel, string> = { full: fmtPct(100), high: `≥ ${fmtPct(99)}`, mid: `≥ ${fmtPct(95)}`, low: `≥ ${fmtPct(80)}`, bad: `< ${fmtPct(80)}`, maintenance: t('status.maintenance'), none: t('dview.heat.none') };
  return (
    <ul className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={t('dview.heat.legend')}>
      {HEAT_LEVELS.map((l) => <li key={l} className="inline-flex items-center gap-1"><span aria-hidden className={cx('inline-block h-3 w-3 rounded-sm', HEAT_LOOK[l].cls)} style={HEAT_LOOK[l].style} />{label[l]}</li>)}
    </ul>
  );
}

interface Label { range: string; short: string }

const HeatRow = memo(function HeatRow({ m, cells, labels, n, selecting, selected, onToggle }: { m: MonitorX; cells: HistoryCell[]; labels: Label[]; n: number; selecting: boolean; selected: boolean; onToggle: (id: number) => void }) {
  const t = useT();
  const s = statusOf(m);
  const total = rowUptime(cells);
  const title = (c: HistoryCell, i: number) => {
    const parts = [labels[i]?.range ?? ''];
    if (!c || c[0] === 0) return [...parts, t('dview.heat.none')].join(' · ');
    const u = cellUptime(c);
    if (u != null) parts.push(fmtPct(u, 1));
    parts.push(c[2] ? t('dview.heat.failed', { down: c[2], n: c[0] }) : t('dview.heat.allOk', { n: c[0] }));
    if (c[3]) parts.push(t('dview.heat.maint', { n: c[3] }));
    return parts.join(' · ');
  };
  // rows need a solid background: the sticky name cell inherits it and covers the cells scrolled beneath it
  return (
    <div className={cx('relative grid items-center gap-x-[2px] px-3 py-1', selected ? 'bg-brand-50 dark:bg-slate-800' : 'bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800')} style={cols(n)}>
      <span className="sticky left-0 z-[1] flex min-w-0 items-center gap-1.5 bg-inherit pr-2">
        <StatusDot status={s} />
        <SelectLink m={m} selecting={selecting} selected={selected} onToggle={onToggle} title={`${m.name} · ${t(`status.${s}`)}`}
          className={cx('min-w-0 truncate text-sm font-medium text-slate-900 no-underline hover:underline dark:text-slate-100', selected && 'text-brand-700 dark:text-brand-100')} />
      </span>
      {Array.from({ length: n }, (_, i) => {
        const c = cells[i] ?? null;
        const look = HEAT_LOOK[heatLevel(c)];
        return <span key={i} title={title(c, i)} className={cx('h-4 rounded-sm', look.cls)} style={look.style} />;
      })}
      <span className={cx('text-right text-xs font-semibold tabular-nums', uptimeTone(total))} title={t('dview.heat.window')}>{fmtPct(total, 2)}</span>
    </div>
  );
});
