import { memo } from 'react';
import { statusOf, type DashStatus } from '../../lib/dashboardView';
import type { MonitorX } from '../../lib/monitorExtras';
import { fmtMs } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useT } from '../../lib/i18n';
import { StatusDot } from '../status';
import { cx } from '../ui';
import { MeanUptime, SelectLink, SummaryCounts, useStatusFor, type Section, type SelectProps } from './shared';

// Strong tint for down, clear for pending, suppressed and maintenance, subtle for up, neutral for unknown and paused.
const TILE: Record<DashStatus, string> = {
  down: 'border-red-700 bg-red-600 text-white dark:border-red-500 dark:bg-red-700',
  pending: 'border-amber-400 bg-amber-100 text-amber-950 dark:border-amber-600 dark:bg-amber-900/50 dark:text-amber-50',
  suppressed: 'border-violet-400 bg-violet-100 text-violet-950 dark:border-violet-600 dark:bg-violet-900/50 dark:text-violet-50',
  maintenance: 'border-sky-400 bg-sky-100 text-sky-950 dark:border-sky-600 dark:bg-sky-900/50 dark:text-sky-50',
  up: 'border-emerald-200 bg-emerald-50 text-slate-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-slate-100',
  unknown: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
  paused: 'border-dashed border-slate-300 bg-white text-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-400',
};

/** Every monitor as a small tile in a dense grid; grouped: a slim heading across the full width per group. No pages. */
export function StatusWall({ rows, sections, selecting, sel, onToggle }: SelectProps & { rows: MonitorX[]; sections: Section[] | null }) {
  const tile = (m: MonitorX) => <WallTile key={m.id} m={m} selecting={selecting} selected={sel.has(m.id)} onToggle={onToggle} />;
  return (
    <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr))]">
      {sections ? sections.map((s) => [<WallHead key={`h${s.key}`} s={s} />, ...s.items.map(tile)]) : rows.map(tile)}
    </div>
  );
}

function WallHead({ s }: { s: Section }) {
  const t = useT();
  return (
    <div className="col-span-full flex items-center gap-2 border-b border-slate-200 pb-0.5 pt-1.5 text-xs first:pt-0 dark:border-slate-800">
      {s.summary.worst && <StatusDot status={s.summary.worst} className="!h-2 !w-2" />}
      <span className="min-w-0 truncate font-semibold text-slate-700 dark:text-slate-200">{s.path || t('monitors.noGroup')}</span>
      <SummaryCounts s={s.summary} /><MeanUptime s={s.summary} className="ml-auto" />
    </div>
  );
}

/** Memoized: live updates replace one monitor object at a time, so only its tile re-renders. */
const WallTile = memo(function WallTile({ m, selecting, selected, onToggle }: { m: MonitorX; selecting: boolean; selected: boolean; onToggle: (id: number) => void }) {
  const now = useNow();
  const statusFor = useStatusFor();
  const s = statusOf(m);
  const line = s === 'up' ? fmtMs(m.latencyMs) : statusFor(m, now);
  const detail = s === 'down' && m.message ? ` · ${m.message}` : '';
  return (
    <SelectLink m={m} selecting={selecting} selected={selected} onToggle={onToggle} title={`${m.name} · ${line}${detail}`}
      className={cx('block h-14 min-w-0 rounded-md border px-2 py-1.5 no-underline hover:brightness-95 dark:hover:brightness-110', TILE[s], selected && 'ring-2 ring-brand-500 ring-offset-1 dark:ring-offset-slate-950')}>
      <span className="block truncate text-sm font-medium leading-5">{m.name}</span>
      <span className={cx('block truncate text-xs leading-4 tabular-nums', s === 'down' ? 'text-red-50' : 'opacity-75')}>{line}</span>
    </SelectLink>
  );
});
