import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarHeatmap, type HeatDay } from '../components/CalendarHeatmap';
import { Badge, Card, CardHeader, EmptyState, ErrorBox, Loading, PageHeader, Select, Tabs } from '../components/ui';
import { StatusDot } from '../components/status';
import { get, type MonitorItem } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useT } from '../lib/i18n';

type Tab = 'heatmap' | 'changes';

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

function Heatmap() {
  const t = useT();
  const [monitorId, setMonitorId] = useState('');
  const [days, setDays] = useState('365');
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors') });
  const q = useQuery({ queryKey: ['insights', 'heatmap', monitorId, days], queryFn: () => get<{ days: HeatDay[] }>(`/api/insights/heatmap?days=${days}${monitorId ? `&monitorId=${monitorId}` : ''}`) });

  return (
    <Card>
      <CardHeader title={t('insights.heatmap')} subtitle={t('insights.heatmapHint')} actions={<>
        <Select aria-label={t('insights.monitor')} value={monitorId} onChange={(e) => setMonitorId(e.target.value)} className="w-auto max-w-[14rem]"><option value="">{t('insights.allMonitors')}</option>{monitors.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
        <Select aria-label={t('insights.period')} value={days} onChange={(e) => setDays(e.target.value)} className="w-auto">{['90', '180', '365'].map((d) => <option key={d} value={d}>{t('insights.days', { n: d })}</option>)}</Select>
      </>} />
      <div className="p-4">
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.days.length ? <EmptyState title={t('monitors.noData')} /> : (
          <CalendarHeatmap days={q.data?.days ?? []} />
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
