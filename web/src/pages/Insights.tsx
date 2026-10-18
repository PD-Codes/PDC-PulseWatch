import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Card, CardHeader, EmptyState, ErrorBox, Loading, PageHeader, Select, Tabs, cx } from '../components/ui';
import { StatusDot } from '../components/status';
import { get, type MonitorItem } from '../lib/api';
import { fmtDate, fmtDateTime, fmtPct } from '../lib/format';
import { useT } from '../lib/i18n';

type Tab = 'heatmap' | 'changes';
interface Day { date: string; uptime: number | null; down: number; total: number; maintenance: number }
interface Change { id: number; ts: string; monitorId: number; monitor: string; type: string; from: string | null; to: string | null; errorKind: string | null; message: string | null; relation: string; offsetSec: number }
interface Changes { anchor: { at: string; monitorId: number | null; incidentId: number | null; title: string | null }; windowMin: number; hints: string[]; events: Change[] }
interface IncidentRow { id: number; title: string; startedAt: string; status: string }

export default function Insights() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'changes' || params.get('incidentId') ? 'changes' : 'heatmap';
  const setTab = (v: Tab) => { const p = new URLSearchParams(params); p.set('tab', v); setParams(p, { replace: true }); };
  return (
    <>
      <PageHeader title={t('nav.insights')} subtitle={t('insights.subtitle')} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'heatmap', label: t('insights.heatmap') }, { id: 'changes', label: t('insights.changes') }]} />
      {tab === 'heatmap' ? <Heatmap /> : <WhatChanged />}
    </>
  );
}

/** Red for failures (scaled by uptime), green for clean days, gray when no data. */
function cellClass(d: Day): string {
  if (d.uptime == null) return 'bg-slate-200 dark:bg-slate-800';
  if (d.uptime >= 99.95) return 'bg-emerald-500';
  if (d.uptime >= 99) return 'bg-emerald-300 dark:bg-emerald-700';
  if (d.uptime >= 97) return 'bg-amber-300 dark:bg-amber-500';
  if (d.uptime >= 90) return 'bg-orange-400';
  return 'bg-red-500';
}

function Heatmap() {
  const t = useT();
  const [monitorId, setMonitorId] = useState('');
  const [days, setDays] = useState('365');
  const [hover, setHover] = useState<Day | null>(null);
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors') });
  const q = useQuery({ queryKey: ['insights', 'heatmap', monitorId, days], queryFn: () => get<{ days: Day[] }>(`/api/insights/heatmap?days=${days}${monitorId ? `&monitorId=${monitorId}` : ''}`) });

  // Weeks as columns, Sunday-first rows; pad the first week so weekdays line up.
  const weeks = useMemo(() => {
    const list = q.data?.days ?? [];
    if (!list.length) return [] as (Day | null)[][];
    const lead = new Date(`${list[0].date}T00:00:00Z`).getUTCDay();
    const cells: (Day | null)[] = [...Array<null>(lead).fill(null), ...list];
    const out: (Day | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [q.data]);

  const stats = useMemo(() => {
    const l = (q.data?.days ?? []).filter((d) => d.uptime != null);
    return { clean: l.filter((d) => d.down === 0).length, bad: l.filter((d) => d.down > 0).length, avg: l.length ? l.reduce((a, d) => a + (d.uptime ?? 0), 0) / l.length : null };
  }, [q.data]);
  const dayNames = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((i) => new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + i)))), []);

  return (
    <Card>
      <CardHeader title={t('insights.heatmap')} subtitle={t('insights.heatmapHint')} actions={<>
        <Select aria-label={t('insights.monitor')} value={monitorId} onChange={(e) => setMonitorId(e.target.value)} className="w-auto max-w-[14rem]"><option value="">{t('insights.allMonitors')}</option>{monitors.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
        <Select aria-label={t('insights.period')} value={days} onChange={(e) => setDays(e.target.value)} className="w-auto">{['90', '180', '365'].map((d) => <option key={d} value={d}>{t('insights.days', { n: d })}</option>)}</Select>
      </>} />
      <div className="p-4">
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : weeks.length === 0 ? <EmptyState title={t('monitors.noData')} /> : (
          <>
            <div className="overflow-x-auto pb-2">
              <div className="flex gap-1">
                <div className="flex flex-col gap-1 pr-1 text-[10px] text-slate-400" aria-hidden>{dayNames.map((n, i) => <span key={n} className="h-3.5 leading-[14px]">{i % 2 ? n : ''}</span>)}</div>
                {weeks.map((w, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    {Array.from({ length: 7 }, (_, r) => {
                      const d = w[r];
                      if (!d) return <span key={r} className="h-3.5 w-3.5" />;
                      const label = d.uptime == null ? t('insights.noData', { date: fmtDate(`${d.date}T12:00:00Z`) }) : t('insights.cell', { date: fmtDate(`${d.date}T12:00:00Z`), uptime: fmtPct(d.uptime, 2), down: d.down, total: d.total });
                      return <button key={r} type="button" aria-label={label} title={label} onMouseEnter={() => setHover(d)} onFocus={() => setHover(d)} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)} className={cx('h-3.5 w-3.5 rounded-sm outline-offset-1 hover:ring-2 hover:ring-slate-900/40 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:ring-white/50', cellClass(d))} />;
                    })}
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 min-h-[1.25rem] text-sm text-slate-600 dark:text-slate-300" aria-live="polite">{hover ? (hover.uptime == null ? t('insights.noData', { date: fmtDate(`${hover.date}T12:00:00Z`) }) : t('insights.cell', { date: fmtDate(`${hover.date}T12:00:00Z`), uptime: fmtPct(hover.uptime, 2), down: hover.down, total: hover.total })) : ''}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500">
              <span className="flex items-center gap-1">{t('insights.worse')}{['bg-red-500', 'bg-orange-400', 'bg-amber-300 dark:bg-amber-500', 'bg-emerald-300 dark:bg-emerald-700', 'bg-emerald-500'].map((c) => <span key={c} className={cx('h-3 w-3 rounded-sm', c)} />)}{t('insights.better')}</span>
              <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-slate-200 dark:bg-slate-800" />{t('insights.none')}</span>
              <span>{t('insights.summary', { clean: stats.clean, bad: stats.bad, avg: fmtPct(stats.avg, 3) })}</span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

const RELATION_TONE: Record<string, 'red' | 'amber' | 'blue' | 'violet' | 'gray'> = { self: 'red', dependency: 'amber', same_host: 'violet', same_group: 'blue', unrelated: 'gray' };

function WhatChanged() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const incidentId = params.get('incidentId') ?? '';
  const [windowMin, setWindowMin] = useState('30');
  const incidents = useQuery({ queryKey: ['incidents', 'picker'], queryFn: () => get<IncidentRow[]>('/api/incidents?limit=50') });
  const q = useQuery({ queryKey: ['insights', 'changes', incidentId, windowMin], queryFn: () => get<Changes>(`/api/insights/changes?incidentId=${incidentId}&windowMin=${windowMin}`), enabled: !!incidentId });
  const pick = (v: string) => { const p = new URLSearchParams(params); p.set('tab', 'changes'); if (v) p.set('incidentId', v); else p.delete('incidentId'); setParams(p, { replace: true }); };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('insights.changes')} subtitle={t('insights.changesHint')} actions={<>
          <Select aria-label={t('insights.incident')} value={incidentId} onChange={(e) => pick(e.target.value)} className="w-auto max-w-[18rem]">
            <option value="">{t('insights.pickIncident')}</option>
            {incidents.data?.map((i) => <option key={i.id} value={i.id}>{`#${i.id} ${i.title} · ${fmtDateTime(i.startedAt)}`}</option>)}
          </Select>
          <Select aria-label={t('insights.window')} value={windowMin} onChange={(e) => setWindowMin(e.target.value)} className="w-auto">{['5', '15', '30', '60', '180'].map((m) => <option key={m} value={m}>{t('insights.windowOpt', { n: m })}</option>)}</Select>
        </>} />
        {!incidentId ? <EmptyState title={t('insights.pickIncident')} body={incidents.data?.length === 0 ? t('insights.noIncidents') : t('insights.pickBody')} /> : q.isLoading ? <Loading /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : q.data && (
          <div className="space-y-4 p-4">
            <p className="text-sm text-slate-600 dark:text-slate-300"><Link to={`/incidents/${incidentId}`} className="font-medium">{q.data.anchor.title ?? `#${incidentId}`}</Link> · {fmtDateTime(q.data.anchor.at)}</p>
            <section aria-label={t('insights.hints')}>
              <h3 className="mb-2 text-sm font-semibold">{t('insights.hints')}</h3>
              <ul className="space-y-1.5">{q.data.hints.map((h, i) => <li key={i} className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800 dark:bg-brand-700/20 dark:text-brand-100">{h}</li>)}</ul>
            </section>
          </div>
        )}
      </Card>

      {q.data && (
        <Card>
          <CardHeader title={t('insights.timeline')} subtitle={t('insights.timelineHint', { n: q.data.windowMin })} />
          {q.data.events.length === 0 ? <p className="p-4 text-sm text-slate-500">{t('insights.noEvents')}</p> : (
            <ol className="divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.events.map((e) => {
                const abs = Math.abs(e.offsetSec);
                const off = abs < 60 ? `${abs}s` : `${Math.round(abs / 60)}m`;
                return (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <StatusDot status={e.to === 'down' ? 'down' : e.to === 'up' ? 'up' : e.type.startsWith('maintenance') ? 'maintenance' : 'pending'} />
                    <Link to={`/monitors/${e.monitorId}`} className="font-medium">{e.monitor}</Link>
                    <Badge tone={RELATION_TONE[e.relation] ?? 'gray'}>{t(`insights.rel.${e.relation}`)}</Badge>
                    <span className="text-slate-500">{e.type === 'status_change' && e.from && e.to ? `${e.from} → ${e.to}` : t(`monitors.event.${e.type}`)}</span>
                    {e.message && <span className="min-w-0 flex-1 truncate text-xs text-slate-400" title={e.message}>{e.errorKind ? `${e.errorKind}: ` : ''}{e.message}</span>}
                    <span className="ml-auto whitespace-nowrap text-xs text-slate-400"><time dateTime={e.ts}>{fmtDateTime(e.ts)}</time> · {e.offsetSec < 0 ? t('insights.before', { t: off }) : e.offsetSec > 0 ? t('insights.after', { t: off }) : t('insights.at')}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      )}
    </div>
  );
}
