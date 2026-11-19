import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Eye, EyeOff, Plus } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KeysetPager } from '../components/KeysetPager';
import { CancelButton, FormAlert, IncidentStatusBadge, INCIDENT_STATUSES, MonitorPicker, SeverityBadge, useFieldErrors, useGroupsQ, useMonitorsQ } from '../components/ops-shared';
import { NO_VERSIONS, Translations, type Versions } from '../components/Translations';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Textarea, Toggle, useToast } from '../components/ui';
import { ApiError, get, patch, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirty } from '../lib/dirty';
import { fmtDuration, relTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { groupIncidents, type IncidentGroup } from '../lib/incidentGroups';
import { useKeysetPages } from '../lib/keysetPages';

interface Incident { id: number; title: string; status: string; severity: string; source: string; startedAt: string; acknowledgedAt: string | null; resolvedAt: string | null; assignee: { id: number; name: string } | null; monitors: { id: number; name: string }[]; public: boolean }
interface Stats { days: number; total: number; open: number; mttrSeconds: number | null; mttaSeconds: number | null; topMonitors: { id: number; name: string; incidents: number }[] }
const CREATE_FIELDS = { title: ['titleEn', 'titleDe'], severity: [], body: ['description', 'bodyEn', 'bodyDe'], monitorIds: ['monitor', 'monitors'], public: [] };
const SEVERITY_RANK: Record<string, number> = { minor: 1, major: 2, critical: 3 };

const secondsOf = (i: Incident) => ((i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now()) - new Date(i.startedAt).getTime()) / 1000;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <Card className="p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold">{value}</div>{sub && <div className="mt-0.5 truncate text-xs text-slate-500">{sub}</div>}</Card>;
}

/** Whether the incident is shown on the status pages, as text (an icon alone says nothing). */
function PublicBadge({ on }: { on: boolean }) {
  const t = useT();
  return on ? <Badge tone="blue" className="whitespace-nowrap">{t('ux.incidents.public')}</Badge> : <Badge className="whitespace-nowrap">{t('ux.incidents.internal')}</Badge>;
}

export default function Incidents() {
  const t = useT();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  // shows incidents on the status pages or takes them off again, without touching their history
  const hide = useMutation({
    mutationFn: (v: { ids: number[]; public: boolean }) => Promise.all(v.ids.map((id) => patch(`/api/incidents/${id}`, { public: v.public }))),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['incidents'] }),
    onError: (e) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error'),
  });
  const [status, setStatus] = useState('');
  const [days, setDays] = useState(30);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const pages = useKeysetPages<Incident>({
    queryKey: ['incidents', 'list', status], sizeKey: 'incidents', resetKey: status,
    fetchPage: (before, limit, signal) => get<Incident[]>(`/api/incidents${qs({ status, limit, before })}`, { signal }),
  });
  const stats = useQuery({ queryKey: ['incidents', 'stats', days], queryFn: () => get<Stats>(`/api/incidents/stats?days=${days}`) });
  // flapping makes one incident per drop: the same outage within an hour is one row
  const groups = useMemo(() => groupIncidents(pages.rows), [pages.rows]);
  const toggleOpen = (id: number) => setOpen((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });

  const blank = { title: '', titleV: NO_VERSIONS as Versions, severity: 'major', body: '', bodyV: NO_VERSIONS as Versions, public: false, monitorIds: [] as number[] };
  const [f, setF] = useState(blank);
  const dirty = useDirty(creating ? f : null);
  const monitors = useMonitorsQ();
  const allGroups = useGroupsQ();
  const create = useMutation({
    mutationFn: () => post<{ id: number }>('/api/incidents', { title: f.title, titleEn: f.titleV.en, titleDe: f.titleV.de, severity: f.severity, body: f.body || undefined, bodyEn: f.bodyV.en, bodyDe: f.bodyV.de, public: f.public, monitorIds: f.monitorIds }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['incidents'] }); setCreating(false); nav(`/incidents/${r.id}`); },
  });
  const { fieldErrors: fe, rest } = useFieldErrors(create.error, CREATE_FIELDS);

  const monitorCell = (i: Incident) => i.monitors.map((m, k) => <span key={m.id}>{k > 0 && ', '}<Link to={`/monitors/${m.id}`}>{m.name}</Link></span>);
  const eye = (ids: number[], on: boolean) => can('editor') && (
    <Button size="sm" variant="ghost" aria-label={on ? t('incidents.hide') : t('incidents.unhide')} title={on ? t('incidents.hide') : t('incidents.unhide')} onClick={() => hide.mutate({ ids, public: !on })}>{on ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>
  );

  /** One incident as a row; `nested` rows sit under an opened group. */
  const row = (i: Incident, nested = false) => (
    <tr key={i.id} className={nested ? 'bg-slate-50/70 dark:bg-slate-800/30' : undefined}>
      <td />
      <td className={`max-w-xs ${nested ? 'pl-6' : ''}`}><div className="flex items-center gap-2"><SeverityBadge severity={i.severity} /><Link to={`/incidents/${i.id}`} className="truncate font-medium">{i.title}</Link></div>{i.source === 'manual' && <span className="text-xs text-slate-400">{t('incidents.manual')}</span>}</td>
      <td><IncidentStatusBadge status={i.status} /></td>
      <td className="hidden md:table-cell"><PublicBadge on={i.public} /></td>
      <td className="hidden max-w-[14rem] truncate lg:table-cell">{monitorCell(i)}</td>
      <td className="hidden whitespace-nowrap sm:table-cell" title={i.startedAt}>{relTime(i.startedAt)}</td>
      <td className="hidden whitespace-nowrap lg:table-cell">{fmtDuration(secondsOf(i))}</td>
      <td className="hidden xl:table-cell">{i.assignee?.name ?? '–'}</td>
      <td className="text-right">{eye([i.id], i.public)}</td>
    </tr>
  );

  /** A flapping run: one summary row, the single incidents on demand. */
  const groupRow = (g: IncidentGroup<Incident>) => {
    const h = g.head, isOpen = open.has(h.id), n = g.items.length;
    const worst = g.items.reduce((a, x) => ((SEVERITY_RANK[x.severity] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? x.severity : a), h.severity);
    const anyPublic = g.items.some((x) => x.public);
    const oldest = g.items[n - 1]!;
    return (
      <Fragment key={h.id}>
        <tr>
          <td><button type="button" className="btn btn-ghost btn-sm !p-1" aria-expanded={isOpen} aria-label={t('ux.incidents.showAll', { n })} title={t('ux.incidents.showAll', { n })} onClick={() => toggleOpen(h.id)}>{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
          <td className="max-w-xs"><div className="flex items-center gap-2"><SeverityBadge severity={worst} /><Link to={`/incidents/${h.id}`} className="truncate font-medium">{h.title}</Link><span title={t('ux.incidents.groupHint')}><Badge tone="amber" className="whitespace-nowrap">{n}×</Badge></span></div><span className="text-xs text-slate-400">{t('ux.incidents.groupSpan', { first: relTime(oldest.startedAt) })}</span></td>
          <td><IncidentStatusBadge status={h.status} /></td>
          <td className="hidden md:table-cell"><PublicBadge on={anyPublic} /></td>
          <td className="hidden max-w-[14rem] truncate lg:table-cell">{monitorCell(h)}</td>
          <td className="hidden whitespace-nowrap sm:table-cell" title={h.startedAt}>{relTime(h.startedAt)}</td>
          <td className="hidden whitespace-nowrap lg:table-cell" title={t('ux.incidents.groupDuration', { n })}>{fmtDuration(g.items.reduce((a, x) => a + secondsOf(x), 0))}</td>
          <td className="hidden xl:table-cell">{h.assignee?.name ?? '–'}</td>
          <td className="text-right">{eye(g.items.map((x) => x.id), anyPublic)}</td>
        </tr>
        {isOpen && g.items.map((x) => row(x, true))}
      </Fragment>
    );
  };

  return (
    <>
      <PageHeader title={t('nav.incidents')} subtitle={t('incidents.subtitle')} actions={can('editor') && <Button variant="primary" onClick={() => { create.reset(); setF(blank); setCreating(true); }}><Plus className="h-4 w-4" />{t('incidents.new')}</Button>} />

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
        {pages.isLoading ? <Loading /> : pages.error ? <div className="p-4"><ErrorBox error={pages.error} /></div> : pages.rows.length === 0 ? (
          <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title={t('incidents.empty')} body={t('incidents.emptyBody')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th className="w-8"><span className="sr-only">{t('common.details')}</span></th><th>{t('incidents.col.incident')}</th><th>{t('common.status')}</th><th className="hidden whitespace-nowrap md:table-cell">{t('ux.incidents.col.public')}</th><th className="hidden lg:table-cell">{t('incidents.col.monitors')}</th><th className="hidden sm:table-cell">{t('incidents.col.started')}</th><th className="hidden lg:table-cell">{t('incidents.col.duration')}</th><th className="hidden xl:table-cell">{t('incidents.assignee')}</th><th><span className="sr-only">{t('incidents.hide')}</span></th></tr></thead>
              <tbody>{groups.map((g) => (g.items.length > 1 ? groupRow(g) : row(g.head)))}</tbody>
            </table>
          </div>
        )}
        <KeysetPager {...pages.pager} />
      </Card>

      <Modal open={creating} dirty={dirty} onClose={() => setCreating(false)} title={t('incidents.new')} footer={<><CancelButton /><Button variant="primary" loading={create.isPending} disabled={!f.title.trim()} onClick={() => create.mutate()}>{t('common.create')}</Button></>}>
        <div className="space-y-4">
          <FormAlert messages={rest} />
          <Field label={t('incidents.field.title')} error={fe.title}>{(id) => <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={255} />}</Field>
          <Translations value={f.titleV} onChange={(v) => setF({ ...f, titleV: v })} max={255} />
          <Field label={t('incidents.field.severity')} error={fe.severity}>{(id) => <Select id={id} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['minor', 'major', 'critical'].map((s) => <option key={s} value={s}>{t(`incidents.severity.${s}`)}</option>)}</Select>}</Field>
          <Field label={t('incidents.field.description')} error={fe.body}>{(id) => <Textarea id={id} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className="font-sans" />}</Field>
          <Translations multiline value={f.bodyV} onChange={(v) => setF({ ...f, bodyV: v })} max={10000} />
          <div><span className="label">{t('incidents.field.monitors')}</span><MonitorPicker monitors={monitors.data ?? []} groups={allGroups.data ?? []} value={f.monitorIds} onChange={(v) => setF({ ...f, monitorIds: v })} />{fe.monitorIds && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{fe.monitorIds}</p>}</div>
          <div><Toggle checked={f.public} onChange={(v) => setF({ ...f, public: v })} label={t('incidents.field.public')} /><p className="hint">{t(f.public ? 'incidents.publicOn' : 'incidents.publicOff')}</p></div>
        </div>
      </Modal>
    </>
  );
}
