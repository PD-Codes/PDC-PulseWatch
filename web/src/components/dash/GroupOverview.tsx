import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { memo } from 'react';
import { statusOf } from '../../lib/dashboardView';
import type { MonitorX } from '../../lib/monitorExtras';
import { needsAttention } from '../../lib/viewModel';
import { fmtMs, fmtPct } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useT } from '../../lib/i18n';
import { StatusDot, uptimeTone } from '../status';
import { Button, cx } from '../ui';
import { MeanUptime, SelectLink, SummaryCounts, useStatusFor, type Section, type SelectProps } from './shared';

/** Collapsed-state id of a section; monitors without a group use 0. */
export const sectionId = (s: Section) => s.group?.id ?? 0;

/**
 * One compact block per group with monitors of its own. Blocks flow in columns (1, 2 from lg, 3 on very wide screens) so the
 * page fills without holes. Everything is visible, no pages.
 */
export function GroupOverview({ sections, collapsed, onCollapse, onCollapseMany, ...sp }: SelectProps & { sections: Section[]; collapsed: Set<number>; onCollapse: (id: number) => void; onCollapseMany: (ids: number[], collapse: boolean) => void }) {
  const t = useT();
  return (
    <div>
      {sections.length > 1 && (
        <div className="-mt-1 mb-1.5 flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => onCollapseMany(sections.map(sectionId), false)}><ChevronsUpDown className="h-4 w-4" />{t('dview.expandAll')}</Button>
          <Button size="sm" variant="ghost" onClick={() => onCollapseMany(sections.map(sectionId), true)}><ChevronsDownUp className="h-4 w-4" />{t('dview.collapseAll')}</Button>
        </div>
      )}
      <div className="columns-1 gap-3 lg:columns-2 min-[1800px]:columns-3">
        {sections.map((s) => <GroupBlock key={s.key} s={s} collapsed={collapsed.has(sectionId(s))} onCollapse={onCollapse} {...sp} />)}
      </div>
    </div>
  );
}

function GroupBlock({ s, collapsed, onCollapse, selecting, sel, onToggle }: SelectProps & { s: Section; collapsed: boolean; onCollapse: (id: number) => void }) {
  const t = useT();
  const name = s.path || t('monitors.noGroup');
  return (
    <section className="card mb-3 break-inside-avoid overflow-hidden" aria-label={name}>
      <button type="button" aria-expanded={!collapsed} onClick={() => onCollapse(sectionId(s))} className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40', !collapsed && 'border-b border-slate-100 dark:border-slate-800')}>
        {collapsed ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
        {s.summary.worst && <StatusDot status={s.summary.worst} pulse />}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100" title={name}>{name}</span>
        <SummaryCounts s={s.summary} /><MeanUptime s={s.summary} className="w-14 text-right" />
      </button>
      {!collapsed && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {s.items.map((m) => <GroupRow key={m.id} m={m} selecting={selecting} selected={sel.has(m.id)} onToggle={onToggle} />)}
        </ul>
      )}
    </section>
  );
}

/** Memoized: live updates replace one monitor object at a time, so only its row re-renders. */
const GroupRow = memo(function GroupRow({ m, selecting, selected, onToggle }: { m: MonitorX; selecting: boolean; selected: boolean; onToggle: (id: number) => void }) {
  const t = useT();
  const now = useNow();
  const statusFor = useStatusFor();
  const s = statusOf(m);
  const problem = needsAttention(s);
  const note = problem ? (m.message ? `${m.errorKind ? `${m.errorKind}: ` : ''}${m.message}` : statusFor(m, now)) : null;
  return (
    <li className={cx('relative flex items-center gap-2 px-3 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/40', selected && 'bg-brand-50 ring-1 ring-inset ring-brand-500 dark:bg-brand-700/20')}>
      <StatusDot status={s} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <SelectLink m={m} selecting={selecting} selected={selected} onToggle={onToggle} title={note ? `${m.name}: ${note}` : m.name}
          className="min-w-0 shrink truncate font-medium text-slate-900 no-underline after:absolute after:inset-0 hover:underline dark:text-slate-100" />
        {note && <span className={cx('min-w-0 flex-1 truncate text-xs', s === 'down' ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400')}>{note}</span>}
      </span>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-slate-500">{fmtMs(m.latencyMs)}</span>
      <span className={cx('w-14 shrink-0 text-right text-xs font-semibold tabular-nums', uptimeTone(m.uptime.h24))} aria-label={`${t('monitors.uptime')} 24h`}>{fmtPct(m.uptime.h24, 2)}</span>
    </li>
  );
});
