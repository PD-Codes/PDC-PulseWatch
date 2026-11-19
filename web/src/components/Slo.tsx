import { Target } from 'lucide-react';
import { fmtDuration, fmtPct } from '../lib/format';
import { useT } from '../lib/i18n';
import { sloTone, type SloDetail, type SloSummary } from '../lib/monitorExtras';
import { Badge, cx } from './ui';

const DOT: Record<ReturnType<typeof sloTone>, string> = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', gray: 'bg-slate-400' };
const BAR: Record<ReturnType<typeof sloTone>, string> = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', gray: 'bg-slate-400' };

/** Red "SLO 99.9 %" badge while the 30-day uptime is below the target; nothing otherwise. */
export function SloBadge({ slo, className }: { slo: SloSummary | null | undefined; className?: string }) {
  const t = useT();
  if (!slo || slo.met !== false) return null;
  return <Badge tone="red" className={className}><span title={t('mux.slo.missedTip', { uptime: fmtPct(slo.uptime30d, 3), target: fmtPct(slo.target, 3) })}>{t('mux.slo.badge', { target: fmtPct(slo.target, 3) })}</span></Badge>;
}

/** Compact SLO tile: target, 30-day uptime, error budget left (minutes and bar) and a traffic light. */
export function SloPanel({ slo, className }: { slo: SloDetail; className?: string }) {
  const t = useT();
  const tone = sloTone(slo);
  const left = Math.max(0, slo.remainingMinutes);
  const usedPct = slo.budgetMinutes > 0 ? Math.min(100, Math.max(0, (slo.usedMinutes / slo.budgetMinutes) * 100)) : slo.usedMinutes > 0 ? 100 : 0;
  const state = tone === 'red' ? t('mux.slo.missed') : tone === 'amber' ? t('mux.slo.tight') : tone === 'green' ? t('mux.slo.met') : t('mux.slo.noData');
  return (
    <div className={cx('card p-3', className)} role="group" aria-label={t('mux.slo.title')}>
      <div className="flex items-center gap-1.5 text-xs text-slate-500"><Target className="h-3.5 w-3.5" aria-hidden />{t('mux.slo.titleTarget', { target: fmtPct(slo.target, 3) })}
        <span className="ml-auto inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200"><span className={cx('h-2.5 w-2.5 rounded-full', DOT[tone])} aria-hidden />{state}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cx('text-xl font-semibold tabular-nums', tone === 'red' && 'text-red-600 dark:text-red-400')}>{fmtPct(slo.uptime30d, 3)}</span>
        <span className="text-xs text-slate-500">{t('mux.slo.window', { n: slo.windowDays })}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" role="img" aria-label={t('mux.slo.usedPct', { pct: Math.round(usedPct) })}><div className={cx('h-full rounded-full', BAR[tone])} style={{ width: `${usedPct}%` }} /></div>
      <div className="mt-1 flex justify-between gap-2 text-xs text-slate-500">
        <span>{t('mux.slo.left', { time: fmtDuration(left * 60) })}</span>
        <span>{t('mux.slo.budget', { time: fmtDuration(slo.budgetMinutes * 60) })}</span>
      </div>
    </div>
  );
}
