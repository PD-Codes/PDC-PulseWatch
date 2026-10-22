import { useMemo, useState } from 'react';
import { fmtDate, fmtPct } from '../lib/format';
import { useT } from '../lib/i18n';
import { cx } from './ui';

export interface HeatDay { date: string; uptime: number | null; down: number; total: number }

/** Red for failures (scaled by uptime), green for clean days, gray when no data. */
function cellClass(d: HeatDay): string {
  if (d.uptime == null) return 'bg-slate-200 dark:bg-slate-800';
  if (d.uptime >= 99.95) return 'bg-emerald-500';
  if (d.uptime >= 99) return 'bg-emerald-300 dark:bg-emerald-700';
  if (d.uptime >= 97) return 'bg-amber-300 dark:bg-amber-500';
  if (d.uptime >= 90) return 'bg-orange-400';
  return 'bg-red-500';
}

/** Day grid with weeks as columns (Sunday first), shared by the Insights page and public status pages. */
export function CalendarHeatmap({ days }: { days: HeatDay[] }) {
  const t = useT();
  const [hover, setHover] = useState<HeatDay | null>(null);
  const weeks = useMemo(() => {
    if (!days.length) return [] as (HeatDay | null)[][];
    const lead = new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay();
    const cells: (HeatDay | null)[] = [...Array<null>(lead).fill(null), ...days];
    const out: (HeatDay | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [days]);
  const stats = useMemo(() => {
    const l = days.filter((d) => d.uptime != null);
    return { clean: l.filter((d) => d.down === 0).length, bad: l.filter((d) => d.down > 0).length, avg: l.length ? l.reduce((a, d) => a + (d.uptime ?? 0), 0) / l.length : null };
  }, [days]);
  const dayNames = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((i) => new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + i)))), []);
  const label = (d: HeatDay) => (d.uptime == null ? t('insights.noData', { date: fmtDate(`${d.date}T12:00:00Z`) }) : t('insights.cell', { date: fmtDate(`${d.date}T12:00:00Z`), uptime: fmtPct(d.uptime, 2), down: d.down, total: d.total }));

  return (
    <>
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-1">
          <div className="flex flex-col gap-1 pr-1 text-[10px] text-slate-400" aria-hidden>{dayNames.map((n, i) => <span key={n} className="h-3.5 leading-[14px]">{i % 2 ? n : ''}</span>)}</div>
          {weeks.map((w, i) => (
            <div key={i} className="flex flex-col gap-1">
              {Array.from({ length: 7 }, (_, r) => {
                const d = w[r];
                if (!d) return <span key={r} className="h-3.5 w-3.5" />;
                return <button key={r} type="button" aria-label={label(d)} title={label(d)} onMouseEnter={() => setHover(d)} onFocus={() => setHover(d)} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)} className={cx('h-3.5 w-3.5 rounded-sm outline-offset-1 hover:ring-2 hover:ring-slate-900/40 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:ring-white/50', cellClass(d))} />;
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 min-h-[1.25rem] text-sm text-slate-600 dark:text-slate-300" aria-live="polite">{hover ? label(hover) : ''}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500">
        <span className="flex items-center gap-1">{t('insights.worse')}{['bg-red-500', 'bg-orange-400', 'bg-amber-300 dark:bg-amber-500', 'bg-emerald-300 dark:bg-emerald-700', 'bg-emerald-500'].map((c) => <span key={c} className={cx('h-3 w-3 rounded-sm', c)} />)}{t('insights.better')}</span>
        <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-slate-200 dark:bg-slate-800" />{t('insights.none')}</span>
        <span>{t('insights.summary', { clean: stats.clean, bad: stats.bad, avg: fmtPct(stats.avg, 3) })}</span>
      </div>
    </>
  );
}
