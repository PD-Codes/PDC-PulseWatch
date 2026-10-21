import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { IncidentStatusBadge, INCIDENT_STATUSES, MonitorPicker, SeverityBadge, useGroupsQ, useMonitorsQ } from '../components/ops-shared';
import { Button, Card, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Textarea, Toggle, useToast } from '../components/ui';
import { ApiError, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDuration, relTime } from '../lib/format';
import { useT } from '../lib/i18n';

interface Incident { id: number; title: string; status: string; severity: string; source: string; startedAt: string; acknowledgedAt: string | null; resolvedAt: string | null; assignee: { id: number; name: string } | null; monitors: { id: number; name: string }[] }
interface Stats { days: number; total: number; open: number; mttrSeconds: number | null; mttaSeconds: number | null; topMonitors: { id: number; name: string; incidents: number }[] }
const PAGE = 30;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <Card className="p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold">{value}</div>{sub && <div className="mt-0.5 truncate text-xs text-slate-500">{sub}</div>}</Card>;
}

export default function Incidents() {
  const t = useT();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [days, setDays] = useState(30);
  const [creating, setCreating] = useState(false);

  const list = useInfiniteQuery({
    queryKey: ['incidents', 'list', status], initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => get<Incident[]>(`/api/incidents${qs({ status, limit: PAGE, before: pageParam })}`),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].id : undefined),
  });
  const stats = useQuery({ queryKey: ['incidents', 'stats', days], queryFn: () => get<Stats>(`/api/incidents/stats?days=${days}`) });
  const items = list.data?.pages.flat() ?? [];

  const [f, setF] = useState({ title: '', severity: 'major', body: '', public: false, monitorIds: [] as number[] });
  const monitors = useMonitorsQ();
  const groups = useGroupsQ();
  const create = useMutation({
    mutationFn: () => post<{ id: number }>('/api/incidents', { title: f.title, severity: f.severity, body: f.body || undefined, public: f.public, monitorIds: f.monitorIds }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['incidents'] }); setCreating(false); nav(`/incidents/${r.id}`); },
    onError: (e) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error'),
  });

  return (
    <>
      <PageHeader title={t('nav.incidents')} subtitle={t('incidents.subtitle')} actions={can('editor') && <Button variant="primary" onClick={() => { setF({ title: '', severity: 'major', body: '', public: false, monitorIds: [] }); setCreating(true); }}><Plus className="h-4 w-4" />{t('incidents.new')}</Button>} />

      <div className="mb-2 flex items-center justify-end gap-2 text-sm">
        <label htmlFor="inc-days" className="text-slate-500">{t('incidents.period')}</label>
        <Select id="inc-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto">{[7, 30, 90, 365].map((d) => <option key={d} value={d}>{t('incidents.lastDays', { n: d })}</option>)}</Select>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('incidents.stat.total')} value={String(stats.data?.total ?? '–')} sub={t('incidents.stat.open', { n: stats.data?.open ?? 0 })} />
        <Stat label={t('incidents.stat.mttr')} value={fmtDuration(stats.data?.mttrSeconds)} sub={t('incidents.stat.mttrHint')} />
        <Stat label={t('incidents.stat.mtta')} value={fmtDuration(stats.data?.mttaSeconds)} sub={t('incidents.stat.mttaHint')} />
        <Card className="p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{t('incidents.stat.top')}</div>
          {stats.data?.topMonitors.length ? <ul className="mt-1 space-y-0.5 text-sm">{stats.data.topMonitors.slice(0, 3).map((m) => <li key={m.id} className="flex justify-between gap-2"><Link to={`/monitors/${m.id}`} className="truncate">{m.name}</Link><span className="text-slate-500">{m.incidents}</span></li>)}</ul> : <div className="mt-1 text-sm text-slate-500">–</div>}
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label={t('common.status')}>
        {['', 'active', ...INCIDENT_STATUSES].map((s) => <Button key={s} size="sm" variant={status === s ? 'primary' : 'default'} aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? t(`incidents.status.${s}`) : t('common.all')}</Button>)}
      </div>

      <Card>
        {list.isLoading ? <Loading /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : items.length === 0 ? (
          <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title={t('incidents.empty')} body={t('incidents.emptyBody')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t('incidents.col.incident')}</th><th>{t('common.status')}</th><th className="hidden md:table-cell">{t('incidents.col.monitors')}</th><th className="hidden sm:table-cell">{t('incidents.col.started')}</th><th className="hidden lg:table-cell">{t('incidents.col.duration')}</th><th className="hidden lg:table-cell">{t('incidents.assignee')}</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td className="max-w-xs"><div className="flex items-center gap-2"><SeverityBadge severity={i.severity} /><Link to={`/incidents/${i.id}`} className="truncate font-medium">{i.title}</Link></div>{i.source === 'manual' && <span className="text-xs text-slate-400">{t('incidents.manual')}</span>}</td>
                    <td><IncidentStatusBadge status={i.status} /></td>
                    <td className="hidden max-w-[14rem] truncate md:table-cell">{i.monitors.map((m, k) => <span key={m.id}>{k > 0 && ', '}<Link to={`/monitors/${m.id}`}>{m.name}</Link></span>)}</td>
                    <td className="hidden whitespace-nowrap sm:table-cell" title={i.startedAt}>{relTime(i.startedAt)}</td>
                    <td className="hidden whitespace-nowrap lg:table-cell">{fmtDuration(((i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now()) - new Date(i.startedAt).getTime()) / 1000)}</td>
                    <td className="hidden lg:table-cell">{i.assignee?.name ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.hasNextPage && <div className="border-t border-slate-200 p-3 text-center dark:border-slate-800"><Button size="sm" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>{t('common.more')}</Button></div>}
      </Card>

      <Modal open={creating} onClose={() => setCreating(false)} title={t('incidents.new')} footer={<><Button onClick={() => setCreating(false)}>{t('common.cancel')}</Button><Button variant="primary" loading={create.isPending} disabled={!f.title.trim()} onClick={() => create.mutate()}>{t('common.create')}</Button></>}>
        <div className="space-y-4">
          <Field label={t('incidents.field.title')}>{(id) => <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={255} />}</Field>
          <Field label={t('incidents.field.severity')}>{(id) => <Select id={id} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['minor', 'major', 'critical'].map((s) => <option key={s} value={s}>{t(`incidents.severity.${s}`)}</option>)}</Select>}</Field>
          <Field label={t('incidents.field.description')}>{(id) => <Textarea id={id} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className="font-sans" />}</Field>
          <div><span className="label">{t('incidents.field.monitors')}</span><MonitorPicker monitors={monitors.data ?? []} groups={groups.data ?? []} value={f.monitorIds} onChange={(v) => setF({ ...f, monitorIds: v })} /></div>
          <Toggle checked={f.public} onChange={(v) => setF({ ...f, public: v })} label={t('incidents.field.public')} />
        </div>
      </Modal>
    </>
  );
}
