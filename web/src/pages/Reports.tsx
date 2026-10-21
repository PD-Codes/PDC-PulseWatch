import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Download, FileText, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EMAIL_RE, splitList } from '../components/settingsParts';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, Toggle, useConfirm, useToast } from '../components/ui';
import { del, download, errorMessage, get, post, put, qs } from '../lib/api';
import type { Group, MonitorItem, Tag } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { fmtDateTime, fmtMs, fmtPct } from '../lib/format';
import { useT } from '../lib/i18n';

type ScopeType = 'all' | 'group' | 'monitor' | 'tag';
const SCOPES: ScopeType[] = ['all', 'group', 'monitor', 'tag'];
const RANGES = [7, 30, 90, 365];

interface SlaRow { monitorId: number; name: string; group: string | null; uptime: number | null; downtimeMin: number; incidents: number; mttrMin: number | null; avgMs: number | null; p95Ms: number | null; checks: number }
interface Sla { generatedAt: string; from: string; to: string; days: number; scope: string; rows: SlaRow[]; overall: number | null }
interface Schedule { id: number; name: string; scopeType: ScopeType; scopeId: number | null; rangeDays: number; cronExpr: string; timezone: string; recipients: string[]; format: 'pdf' | 'csv'; enabled: boolean; lastRunAt: string | null }

export default function Reports() {
  const t = useT(); const { can } = useAuth(); const meta = useMeta();
  const [sp, setSp] = useSearchParams();
  const admin = can('admin');
  // scheduled reports are mailed, so they only exist when SMTP is configured
  const schedules = admin && !!meta?.smtp;
  const tab = schedules && sp.get('tab') === 'schedules' ? 'schedules' : 'report';
  return (
    <div className="space-y-6">
      <PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')} />
      {schedules && <Tabs tabs={[{ id: 'report', label: t('reports.tab.report') }, { id: 'schedules', label: t('reports.tab.schedules') }]} value={tab} onChange={(v) => setSp(v === 'report' ? {} : { tab: v }, { replace: true })} />}
      {tab === 'report' ? <Builder /> : <Schedules />}
    </div>
  );
}

/* ---------- scope picker (shared by builder and schedule form) ---------- */

function useScopeOptions() {
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors') });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups') });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => get<Tag[]>('/api/tags') });
  return {
    group: (groups.data ?? []).map((g) => ({ id: g.id, name: g.name })),
    monitor: (monitors.data ?? []).map((m) => ({ id: m.id, name: m.name })),
    tag: (tags.data ?? []).map((x) => ({ id: x.id, name: x.name })),
  };
}

function ScopePicker({ type, id, onChange }: { type: ScopeType; id: number | null; onChange: (type: ScopeType, id: number | null) => void }) {
  const t = useT(); const opts = useScopeOptions();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('reports.scope')}>{(fid) => <Select id={fid} value={type} onChange={(e) => onChange(e.target.value as ScopeType, null)}>{SCOPES.map((s) => <option key={s} value={s}>{t(`reports.scope.${s}`)}</option>)}</Select>}</Field>
      {type !== 'all' && (
        <Field label={t(`reports.scope.${type}`)}>{(fid) => (
          <Select id={fid} value={id ?? ''} required onChange={(e) => onChange(type, e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('reports.pick')}</option>{opts[type].map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        )}</Field>
      )}
    </div>
  );
}

/* ---------- SLA report builder ---------- */

function Builder() {
  const t = useT(); const toast = useToast();
  const [type, setType] = useState<ScopeType>('all'); const [id, setId] = useState<number | null>(null);
  const [preset, setPreset] = useState<number | 'custom'>(30); const [custom, setCustom] = useState(14);
  const days = preset === 'custom' ? Math.min(730, Math.max(1, Math.round(custom) || 1)) : preset;
  const query = (format?: string) => qs({ scope: type, id: type === 'all' ? undefined : id, days, format });
  const ready = type === 'all' || id != null;
  const run = useMutation({ mutationFn: () => get<Sla>(`/api/reports/sla${query()}`), onError: (e) => toast(errorMessage(e), 'error') });
  const rep = run.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><FileText className="h-4 w-4" aria-hidden />{t('reports.tab.report')}</span>} />
        <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); if (!ready) return toast(t('reports.pickRequired', { scope: t(`reports.scope.${type}`) }), 'error'); run.mutate(); }}>
          <ScopePicker type={type} id={id} onChange={(a, b) => { setType(a); setId(b); }} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('reports.range')}>{(fid) => (
              <Select id={fid} value={preset} onChange={(e) => setPreset(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}>
                {RANGES.map((r) => <option key={r} value={r}>{t('reports.days', { n: r })}</option>)}<option value="custom">{t('reports.custom')}</option>
              </Select>
            )}</Field>
            {preset === 'custom' && <Field label={t('reports.customDays')}>{(fid) => <Input id={fid} type="number" min={1} max={730} value={custom} onChange={(e) => setCustom(Number(e.target.value))} />}</Field>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={run.isPending}>{t('reports.run')}</Button>
            <Button disabled={!ready} onClick={() => download(`/api/reports/sla${query('csv')}`)}><Download className="h-4 w-4" />{t('reports.csv')}</Button>
            <Button disabled={!ready} onClick={() => download(`/api/reports/sla${query('pdf')}`)}><Download className="h-4 w-4" />{t('reports.pdf')}</Button>
          </div>
        </form>
      </Card>
      {run.error && <ErrorBox error={run.error} />}
      {rep && (
        <Card>
          <CardHeader title={t('reports.overall')} subtitle={`${t('reports.period')}: ${fmtDateTime(rep.from)} – ${fmtDateTime(rep.to)}`} actions={<span className="text-2xl font-semibold tabular-nums">{fmtPct(rep.overall)}</span>} />
          {rep.rows.length === 0 ? <EmptyState title={t('reports.empty')} /> : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>{t('reports.monitor')}</th><th>{t('reports.group')}</th><th className="text-right">{t('reports.uptime')}</th><th className="text-right">{t('reports.downtime')}</th><th className="text-right">{t('reports.incidents')}</th><th className="text-right" title={t('reports.mttrTip')}>{t('reports.mttr')}</th><th className="text-right" title={t('stat.avg.tip')}>{t('reports.avg')}</th><th className="text-right" title={t('stat.p95.tip')}>{t('stat.p95')}</th><th className="text-right">{t('reports.checks')}</th></tr></thead>
                <tbody>{rep.rows.map((r) => (
                  <tr key={r.monitorId}>
                    <td className="font-medium">{r.name}</td><td>{r.group ?? '–'}</td>
                    <td className="text-right tabular-nums">{fmtPct(r.uptime)}</td><td className="text-right tabular-nums">{t('reports.minutes', { n: r.downtimeMin })}</td>
                    <td className="text-right tabular-nums">{r.incidents}</td><td className="text-right tabular-nums">{r.mttrMin == null ? '–' : t('reports.minutes', { n: r.mttrMin })}</td>
                    <td className="text-right tabular-nums">{fmtMs(r.avgMs)}</td><td className="text-right tabular-nums">{fmtMs(r.p95Ms)}</td><td className="text-right tabular-nums">{r.checks}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <p className="hint p-4">{t('reports.note')}</p>
        </Card>
      )}
    </div>
  );
}

/* ---------- scheduled reports (admin) ---------- */

const PRESETS = [['0 8 * * *', 'reports.sched.daily'], ['0 8 * * 1', 'reports.sched.weekly'], ['0 8 1 * *', 'reports.sched.monthly']] as const;
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
type Draft = Omit<Schedule, 'id' | 'recipients' | 'lastRunAt'> & { id?: number; recipients: string };
const blank = (): Draft => ({ name: '', scopeType: 'all', scopeId: null, rangeDays: 30, cronExpr: PRESETS[1][0], timezone: localTz(), recipients: '', format: 'pdf', enabled: true });

function Schedules() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['report-schedules'], queryFn: () => get<Schedule[]>('/api/report-schedules') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ['report-schedules'] });
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const recipients = splitList(d.recipients); const bad = recipients.find((r) => !EMAIL_RE.test(r));
      if (bad) throw new Error(t('settings.digest.badRecipients', { value: bad }));
      if (d.scopeType !== 'all' && !d.scopeId) throw new Error(t('reports.pickRequired', { scope: t(`reports.scope.${d.scopeType}`) }));
      const { id, ...rest } = d; const body = { ...rest, recipients, scopeId: d.scopeType === 'all' ? null : d.scopeId };
      return id ? put(`/api/report-schedules/${id}`, body) : post('/api/report-schedules', body);
    },
    onSuccess: () => { toast(t('common.saved')); setDraft(null); inv(); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/api/report-schedules/${id}`), onSuccess: () => { toast(t('common.deleted')); inv(); }, onError: (e) => toast(errorMessage(e), 'error') });
  const runNow = useMutation({ mutationFn: (id: number) => post(`/api/report-schedules/${id}/run`), onSuccess: () => { toast(t('reports.sched.sent')); inv(); }, onError: (e) => toast(errorMessage(e), 'error') });
  const toggle = useMutation({ mutationFn: (s: Schedule) => put(`/api/report-schedules/${s.id}`, { ...s, enabled: !s.enabled }), onSuccess: inv, onError: (e) => toast(errorMessage(e), 'error') });
  const set = (p: Partial<Draft>) => setDraft((d) => d && { ...d, ...p });
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><CalendarClock className="h-4 w-4" aria-hidden />{t('reports.tab.schedules')}</span>}
        actions={<Button variant="primary" size="sm" onClick={() => setDraft(blank())}><Plus className="h-4 w-4" />{t('reports.sched.add')}</Button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? (
        <EmptyState icon={<CalendarClock className="h-8 w-8" />} title={t('reports.sched.empty')} body={t('reports.sched.emptyBody')} />
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {q.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <Badge tone="blue">{s.format.toUpperCase()}</Badge><code>{s.cronExpr}</code><span>{s.timezone}</span><span>{t('reports.days', { n: s.rangeDays })}</span>
                  <span>{t('reports.sched.last')}: {fmtDateTime(s.lastRunAt)}</span>
                </div>
                <div className="mt-1 truncate text-xs text-slate-500">{s.recipients.join(', ')}</div>
              </div>
              <Toggle checked={s.enabled} onChange={() => toggle.mutate(s)} label={s.enabled ? t('common.enabled') : t('common.disabled')} />
              <Button size="sm" loading={runNow.isPending && runNow.variables === s.id} onClick={() => runNow.mutate(s.id)}><Send className="h-3.5 w-3.5" />{t('reports.sched.runNow')}</Button>
              <Button size="sm" aria-label={`${t('common.edit')} ${s.name}`} onClick={() => setDraft({ ...s, recipients: s.recipients.join('\n') })}><Pencil className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="danger" aria-label={`${t('common.delete')} ${s.name}`} onClick={async () => { if (await confirm({ title: t('common.delete'), body: s.name, danger: true, confirmLabel: t('common.delete') })) remove.mutate(s.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!draft} onClose={() => setDraft(null)} wide title={draft?.id ? t('reports.sched.edit') : t('reports.sched.new')}
        footer={<><Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} onClick={() => draft && save.mutate(draft)}>{t('common.save')}</Button></>}>
        {draft && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            <Field label={t('common.name')}>{(id) => <Input id={id} required value={draft.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
            <ScopePicker type={draft.scopeType} id={draft.scopeId} onChange={(scopeType, scopeId) => set({ scopeType, scopeId })} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('reports.sched.range')}>{(id) => <Input id={id} type="number" min={1} max={730} value={draft.rangeDays} onChange={(e) => set({ rangeDays: Number(e.target.value) })} />}</Field>
              <Field label={t('reports.sched.format')}>{(id) => <Select id={id} value={draft.format} onChange={(e) => set({ format: e.target.value as 'pdf' | 'csv' })}><option value="pdf">PDF</option><option value="csv">CSV</option></Select>}</Field>
              <Field label={t('reports.sched.timezone')}>{(id) => <Input id={id} value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} />}</Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('reports.sched.preset')}>{(id) => (
                <Select id={id} value={PRESETS.some(([c]) => c === draft.cronExpr) ? draft.cronExpr : ''} onChange={(e) => e.target.value && set({ cronExpr: e.target.value })}>
                  {PRESETS.map(([c, k]) => <option key={c} value={c}>{t(k)}</option>)}<option value="">{t('reports.sched.customCron')}</option>
                </Select>
              )}</Field>
              <Field label={t('reports.sched.cron')}>{(id) => <Input id={id} required className="font-mono" value={draft.cronExpr} onChange={(e) => set({ cronExpr: e.target.value })} />}</Field>
            </div>
            <Field label={t('reports.sched.recipients')} hint={t('reports.sched.recipientsHelp')}>{(id) => <Textarea id={id} rows={3} required value={draft.recipients} onChange={(e) => set({ recipients: e.target.value })} spellCheck={false} />}</Field>
            <Toggle checked={draft.enabled} onChange={(enabled) => set({ enabled })} label={t('common.enabled')} />
          </form>
        )}
      </Modal>
    </Card>
  );
}
