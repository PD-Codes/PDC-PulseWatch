import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, FileText, Pencil, Plus, RotateCw, Send, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FieldDef } from '../../../src/core/types';
import { CheckList, timeZones } from '../components/ops-shared';
import { FieldsForm } from '../components/settingsParts';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, Toggle, useConfirm, useToast, type Tone } from '../components/ui';
import { ApiError, del, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useT } from '../lib/i18n';

interface TypeInfo { type: string; label: string; fields: FieldDef[] }
interface Quiet { start: string; end: string; timezone?: string; days?: number[]; mode?: 'defer' | 'drop'; bypassDown?: boolean }
interface Channel { id: number; name: string; type: string; config?: Record<string, any>; active: boolean; isDefault: boolean; quietHours?: Quiet | null; templateId?: number | null }
interface Template { id: number; name: string; subject: string; body: string }
interface Policy { id: number; name: string; steps: { delayMin: number; channelIds: number[] }[]; repeatEveryMin: number | null }
interface Delivery { id: number; ts: string; event: string; status: 'pending' | 'sent' | 'failed' | 'skipped'; attempts: number; nextAttemptAt: string | null; error: string | null; subject: string | null; monitor: string | null; incidentId: number | null; channel: string | null; channelType: string | null }
type Tab = 'channels' | 'templates' | 'policies' | 'log';

const PLACEHOLDERS = ['{{monitor.name}}', '{{monitor.type}}', '{{monitor.id}}', '{{status}}', '{{message}}', '{{errorKind}}', '{{latency}}', '{{url}}', '{{time}}', '{{incident.id}}'];
const DELIVERY_TONE: Record<Delivery['status'], Tone> = { sent: 'green', failed: 'red', pending: 'amber', skipped: 'gray' };

function useFail() { const t = useT(); const toast = useToast(); return (e: unknown) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error'); }

/** Editable key/value pairs (webhook headers). shortcut: rows with an empty key are dropped on the next edit and only one blank row can exist, fine for headers. */
function KvEditor({ label, value, onChange, secret }: { label: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void; secret?: boolean }) {
  const t = useT();
  const rows = Object.entries(value ?? {});
  const setRows = (r: [string, string][]) => onChange(Object.fromEntries(r.filter(([k]) => k !== '')));
  return (
    <div>
      <span className="label">{label}</span>
      <div className="space-y-2">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label={t('notifications.kv.key')} value={k} placeholder="Header" onChange={(e) => setRows(rows.map((r, j): [string, string] => (j === i ? [e.target.value, v] : r)))} />
            <Input aria-label={t('notifications.kv.value')} type={secret ? 'password' : 'text'} autoComplete="off" value={v} onChange={(e) => setRows(rows.map((r, j): [string, string] => (j === i ? [k, e.target.value] : r)))} />
            <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => setRows(rows.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button size="sm" onClick={() => onChange({ ...(value ?? {}), '': '' })}><Plus className="h-4 w-4" />{t('common.add')}</Button>
      </div>
    </div>
  );
}

function ConfigFields({ fields, value, onChange }: { fields: FieldDef[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const plain = fields.filter((f) => f.kind !== 'kv' && f.kind !== 'json' && f.kind !== 'codes');
  const kv = fields.filter((f) => f.kind === 'kv');
  return (
    <div className="space-y-4">
      <FieldsForm fields={plain} value={value} onChange={onChange} />
      {kv.map((f) => <KvEditor key={f.key} label={f.label} secret={f.secretValues} value={value[f.key] ?? {}} onChange={(v) => onChange({ ...value, [f.key]: v })} />)}
    </div>
  );
}

const DAYS = [1, 2, 3, 4, 5, 6, 0];

function QuietEditor({ value, onChange }: { value: Quiet | null; onChange: (v: Quiet | null) => void }) {
  const t = useT();
  const dayNames = t('notifications.quiet.dayNames').split(',');
  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <legend className="px-1 text-sm font-medium"><Toggle checked={!!value} onChange={(on) => onChange(on ? { start: '22:00', end: '07:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', days: [0, 1, 2, 3, 4, 5, 6], mode: 'defer', bypassDown: false } : null)} label={t('notifications.quiet.title')} /></legend>
      {value && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('notifications.quiet.start')}>{(id) => <Input id={id} type="time" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />}</Field>
            <Field label={t('notifications.quiet.end')}>{(id) => <Input id={id} type="time" value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} />}</Field>
            <Field label={t('maintenance.timezone')}>{(id) => <Select id={id} value={value.timezone ?? 'UTC'} onChange={(e) => onChange({ ...value, timezone: e.target.value })}>{(timeZones.includes(value.timezone ?? 'UTC') ? timeZones : [value.timezone!, ...timeZones]).map((z) => <option key={z}>{z}</option>)}</Select>}</Field>
          </div>
          <div role="group" aria-label={t('notifications.quiet.days')} className="flex flex-wrap gap-1">
            {DAYS.map((d) => { const on = (value.days ?? []).includes(d); return <Button key={d} size="sm" variant={on ? 'primary' : 'default'} aria-pressed={on} onClick={() => onChange({ ...value, days: on ? (value.days ?? []).filter((x) => x !== d) : [...(value.days ?? []), d] })}>{dayNames[d]}</Button>; })}
          </div>
          <Field label={t('notifications.quiet.mode')} hint={t(`notifications.quiet.mode.${value.mode ?? 'defer'}Hint`)}>{(id) => <Select id={id} value={value.mode ?? 'defer'} onChange={(e) => onChange({ ...value, mode: e.target.value as 'defer' | 'drop' })}><option value="defer">{t('notifications.quiet.mode.defer')}</option><option value="drop">{t('notifications.quiet.mode.drop')}</option></Select>}</Field>
          <Toggle checked={!!value.bypassDown} onChange={(v) => onChange({ ...value, bypassDown: v })} label={t('notifications.quiet.bypass')} />
        </>
      )}
    </fieldset>
  );
}

type ChForm = { id?: number; name: string; type: string; config: Record<string, any>; active: boolean; isDefault: boolean; quietHours: Quiet | null; templateId: number | null };

/** One language for alerts, the daily digest and report mails. Without a saved choice the server follows the administrators' profile language. */
function LanguageSetting() {
  const t = useT(); const qc = useQueryClient(); const toast = useToast(); const fail = useFail();
  const q = useQuery({ queryKey: ['notification-language'], queryFn: () => get<{ language: 'en' | 'de'; explicit: boolean }>('/api/settings/notifications') });
  const save = useMutation({ mutationFn: (language: 'en' | 'de') => put('/api/settings/notifications', { language }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['notification-language'] }); toast(t('common.saved')); }, onError: fail });
  return (
    <Field label={t('notifications.language')} hint={t('notifications.languageHint')} className="max-w-sm">
      {(id) => <Select id={id} value={q.data?.language ?? 'en'} disabled={!q.data || save.isPending} onChange={(e) => save.mutate(e.target.value as 'en' | 'de')}><option value="en">English</option><option value="de">Deutsch</option></Select>}
    </Field>
  );
}

function Channels({ admin }: { admin: boolean }) {
  const t = useT(); const qc = useQueryClient(); const toast = useToast(); const confirm = useConfirm(); const fail = useFail();
  const types = useQuery({ queryKey: ['notification-types'], queryFn: () => get<TypeInfo[]>('/api/notification-types'), staleTime: 3_600_000 });
  const list = useQuery({ queryKey: ['notification-channels'], queryFn: () => get<Channel[]>('/api/notification-channels') });
  const templates = useQuery({ queryKey: ['notification-templates'], queryFn: () => get<Template[]>('/api/notification-templates'), enabled: admin });
  const [f, setF] = useState<ChForm | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['notification-channels'] });
  const info = (type: string) => types.data?.find((x) => x.type === type);
  const defaults = (type: string) => Object.fromEntries((info(type)?.fields ?? []).filter((x) => x.default !== undefined).map((x) => [x.key, x.default]));

  const save = useMutation({
    mutationFn: (v: ChForm) => { const body = { name: v.name.trim(), type: v.type, config: v.config, active: v.active, isDefault: v.isDefault, quietHours: v.quietHours, templateId: v.templateId }; return v.id ? put(`/api/notification-channels/${v.id}`, body) : post('/api/notification-channels', body); },
    onSuccess: () => { refresh(); setF(null); toast(t('common.saved')); }, onError: fail,
  });
  const test = async (c: Channel) => {
    setTesting(c.id);
    try { const r = await post<{ ok: boolean; error?: string }>(`/api/notification-channels/${c.id}/test`); toast(r.ok ? t('notifications.testOk', { name: c.name }) : t('notifications.testFail', { error: r.error ?? '?' }), r.ok ? 'ok' : 'error'); } catch (e) { fail(e); } finally { setTesting(null); }
  };
  const remove = async (c: Channel) => { if (await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: c.name }), danger: true, confirmLabel: t('common.delete') })) { try { await del(`/api/notification-channels/${c.id}`); refresh(); toast(t('common.deleted')); } catch (e) { fail(e); } } };
  const missing = f ? (info(f.type)?.fields ?? []).some((x) => x.required && (!x.showIf || f.config[x.showIf.key] === x.showIf.equals) && (f.config[x.key] === undefined || f.config[x.key] === '')) : false;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">{admin ? <LanguageSetting /> : <span />}{admin && <Button variant="primary" disabled={!types.data} onClick={() => { const ty = types.data![0].type; setF({ name: '', type: ty, config: defaults(ty), active: true, isDefault: false, quietHours: null, templateId: null }); }}><Plus className="h-4 w-4" />{t('notifications.channel.new')}</Button>}</div>
      <Card>
        {list.isLoading ? <Loading /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : !list.data?.length ? <EmptyState icon={<Bell className="h-6 w-6" />} title={t('notifications.channel.empty')} body={t('notifications.channel.emptyBody')} /> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.type')}</th><th>{t('common.status')}</th>{admin && <th><span className="sr-only">{t('common.actions')}</span></th>}</tr></thead>
            <tbody>{list.data.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}{c.isDefault && <Badge tone="brand" >{t('notifications.default')}</Badge>}</td>
                <td>{info(c.type)?.label ?? c.type}{c.quietHours && <span className="ml-2 text-xs text-slate-500">{t('notifications.quiet.short', { start: c.quietHours.start, end: c.quietHours.end })}</span>}</td>
                <td><Badge tone={c.active ? 'green' : 'gray'}>{t(c.active ? 'common.active' : 'common.disabled')}</Badge></td>
                {admin && <td className="whitespace-nowrap text-right">
                  <Button size="sm" loading={testing === c.id} onClick={() => void test(c)}><Send className="h-4 w-4" />{t('common.test')}</Button>
                  <Button size="sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setF({ id: c.id, name: c.name, type: c.type, config: c.config ?? {}, active: c.active, isDefault: c.isDefault, quietHours: c.quietHours ?? null, templateId: c.templateId ?? null })}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove(c)}><Trash2 className="h-4 w-4" /></Button>
                </td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {f && (
        <Modal wide open onClose={() => setF(null)} title={f.id ? t('notifications.channel.edit') : t('notifications.channel.new')} footer={<><Button onClick={() => setF(null)}>{t('common.cancel')}</Button>{f.id && <Button loading={testing === f.id} onClick={() => void test({ id: f.id!, name: f.name } as Channel)}><Send className="h-4 w-4" />{t('common.test')}</Button>}<Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || missing} onClick={() => save.mutate(f)}>{t('common.save')}</Button></>}>
          <div className="space-y-4">
            <Field label={t('common.name')}>{(id) => <Input id={id} value={f.name} maxLength={128} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label={t('common.type')} hint={f.id ? t('notifications.typeLocked') : undefined}>{(id) => <Select id={id} disabled={!!f.id} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, config: defaults(e.target.value) })}>{types.data?.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}</Select>}</Field>
            <ConfigFields fields={info(f.type)?.fields ?? []} value={f.config} onChange={(config) => setF({ ...f, config })} />
            <Field label={t('notifications.template')} hint={t('notifications.templateHint')}>{(id) => <Select id={id} value={f.templateId ?? ''} onChange={(e) => setF({ ...f, templateId: e.target.value ? Number(e.target.value) : null })}><option value="">{t('notifications.templateDefault')}</option>{templates.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
            <QuietEditor value={f.quietHours} onChange={(quietHours) => setF({ ...f, quietHours })} />
            <div className="flex flex-wrap gap-6">
              <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label={t('common.active')} />
              <Toggle checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} label={t('notifications.defaultHint')} />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function Templates({ admin }: { admin: boolean }) {
  const t = useT(); const qc = useQueryClient(); const toast = useToast(); const confirm = useConfirm(); const fail = useFail();
  const list = useQuery({ queryKey: ['notification-templates'], queryFn: () => get<Template[]>('/api/notification-templates') });
  const [f, setF] = useState<Partial<Template> & { name: string; subject: string; body: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['notification-templates'] });
  const save = useMutation({
    mutationFn: (v: NonNullable<typeof f>) => { const body = { name: v.name.trim(), subject: v.subject, body: v.body }; return v.id ? put(`/api/notification-templates/${v.id}`, body) : post('/api/notification-templates', body); },
    onSuccess: () => { refresh(); setF(null); toast(t('common.saved')); }, onError: fail,
  });
  const remove = async (x: Template) => { if (await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: x.name }), danger: true, confirmLabel: t('common.delete') })) { try { await del(`/api/notification-templates/${x.id}`); refresh(); toast(t('common.deleted')); } catch (e) { fail(e); } } };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-slate-500">{t('notifications.template.intro')}</p>{admin && <Button variant="primary" onClick={() => setF({ name: '', subject: '[{{status}}] {{monitor.name}}', body: '{{monitor.name}} is {{status}}\n{{message}}\n{{url}}' })}><Plus className="h-4 w-4" />{t('notifications.template.new')}</Button>}</div>
      <Card>
        {list.isLoading ? <Loading /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : !list.data?.length ? <EmptyState icon={<FileText className="h-6 w-6" />} title={t('notifications.template.empty')} body={t('notifications.template.emptyBody')} /> : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.map((x) => (
            <li key={x.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{x.name}</div><div className="truncate font-mono text-xs text-slate-500">{x.subject}</div></div>
              {admin && <><Button size="sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setF(x)}><Pencil className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove(x)}><Trash2 className="h-4 w-4" /></Button></>}
            </li>
          ))}</ul>
        )}
      </Card>
      {f && (
        <Modal wide open onClose={() => setF(null)} title={f.id ? t('notifications.template.edit') : t('notifications.template.new')} footer={<><Button onClick={() => setF(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || !f.body.trim()} onClick={() => save.mutate(f)}>{t('common.save')}</Button></>}>
          <div className="space-y-4">
            <Field label={t('common.name')}>{(id) => <Input id={id} value={f.name} maxLength={128} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label={t('notifications.template.subject')}>{(id) => <Input id={id} className="font-mono" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />}</Field>
            <Field label={t('notifications.template.body')}>{(id) => <Textarea id={id} rows={7} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</Field>
            <div><span className="label">{t('notifications.template.placeholders')}</span><div className="flex flex-wrap gap-1">{PLACEHOLDERS.map((p) => <code key={p} className="kbd">{p}</code>)}</div><p className="hint">{t('notifications.template.webhookExtra')}</p></div>
          </div>
        </Modal>
      )}
    </>
  );
}

type PolForm = { id?: number; name: string; steps: { delayMin: number; channelIds: number[] }[]; repeatEveryMin: number | '' };

function Policies({ admin }: { admin: boolean }) {
  const t = useT(); const qc = useQueryClient(); const toast = useToast(); const confirm = useConfirm(); const fail = useFail();
  const list = useQuery({ queryKey: ['escalation-policies'], queryFn: () => get<Policy[]>('/api/escalation-policies') });
  const channels = useQuery({ queryKey: ['notification-channels'], queryFn: () => get<Channel[]>('/api/notification-channels') });
  const [f, setF] = useState<PolForm | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['escalation-policies'] });
  const chName = (id: number) => channels.data?.find((c) => c.id === id)?.name ?? `#${id}`;
  const save = useMutation({
    mutationFn: (v: PolForm) => { const body = { name: v.name.trim(), steps: v.steps, ...(v.repeatEveryMin ? { repeatEveryMin: v.repeatEveryMin } : {}) }; return v.id ? put(`/api/escalation-policies/${v.id}`, body) : post('/api/escalation-policies', body); },
    onSuccess: () => { refresh(); setF(null); toast(t('common.saved')); }, onError: fail,
  });
  const remove = async (p: Policy) => { if (await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: p.name }), danger: true, confirmLabel: t('common.delete') })) { try { await del(`/api/escalation-policies/${p.id}`); refresh(); toast(t('common.deleted')); } catch (e) { fail(e); } } };
  const setStep = (i: number, patch: Partial<PolForm['steps'][number]>) => setF({ ...f!, steps: f!.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const valid = f && f.name.trim() && f.steps.length > 0 && f.steps.every((s) => s.channelIds.length > 0 && s.delayMin >= 0) && (f.repeatEveryMin === '' || (f.repeatEveryMin >= 5 && f.repeatEveryMin <= 10080));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-slate-500">{t('notifications.policy.intro')}</p>{admin && <Button variant="primary" onClick={() => setF({ name: '', steps: [{ delayMin: 0, channelIds: [] }], repeatEveryMin: '' })}><Plus className="h-4 w-4" />{t('notifications.policy.new')}</Button>}</div>
      <Card>
        {list.isLoading ? <Loading /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : !list.data?.length ? <EmptyState icon={<Bell className="h-6 w-6" />} title={t('notifications.policy.empty')} body={t('notifications.policy.emptyBody')} /> : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.map((p) => (
            <li key={p.id} className="px-4 py-3">
              <div className="flex items-center gap-3"><div className="min-w-0 flex-1 font-medium">{p.name}</div>
                {admin && <><Button size="sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setF({ id: p.id, name: p.name, steps: p.steps, repeatEveryMin: p.repeatEveryMin ?? '' })}><Pencil className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove(p)}><Trash2 className="h-4 w-4" /></Button></>}</div>
              <ol className="mt-1 space-y-0.5 text-sm text-slate-600 dark:text-slate-300">{p.steps.map((s, i) => <li key={i}>{t('notifications.policy.stepLine', { n: i + 1, delay: s.delayMin, channels: s.channelIds.map(chName).join(', ') })}</li>)}</ol>
              {p.repeatEveryMin ? <p className="mt-1 text-xs text-slate-500">{t('notifications.policy.repeatLine', { n: p.repeatEveryMin })}</p> : null}
            </li>
          ))}</ul>
        )}
      </Card>
      {f && (
        <Modal wide open onClose={() => setF(null)} title={f.id ? t('notifications.policy.edit') : t('notifications.policy.new')} footer={<><Button onClick={() => setF(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(f)}>{t('common.save')}</Button></>}>
          <div className="space-y-4">
            <Field label={t('common.name')}>{(id) => <Input id={id} value={f.name} maxLength={128} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            {f.steps.map((s, i) => (
              <fieldset key={i} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <legend className="flex items-center gap-2 px-1 text-sm font-medium">{t('notifications.policy.step', { n: i + 1 })}{f.steps.length > 1 && <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></Button>}</legend>
                <Field label={t('notifications.policy.delay')} hint={i === 0 ? t('notifications.policy.delayFirst') : undefined}>{(id) => <Input id={id} type="number" min={0} max={1440} value={s.delayMin} onChange={(e) => setStep(i, { delayMin: Number(e.target.value) })} className="max-w-[8rem]" />}</Field>
                <div><span className="label">{t('notifications.policy.channels')}</span><CheckList items={(channels.data ?? []).map((c) => ({ id: c.id, label: c.name }))} value={s.channelIds} onChange={(v) => setStep(i, { channelIds: v })} empty={t('notifications.channel.empty')} /></div>
              </fieldset>
            ))}
            {f.steps.length < 10 && <Button onClick={() => setF({ ...f, steps: [...f.steps, { delayMin: 10, channelIds: [] }] })}><Plus className="h-4 w-4" />{t('notifications.policy.addStep')}</Button>}
            <Field label={t('notifications.policy.repeat')} hint={t('notifications.policy.repeatHint')}>{(id) => <Input id={id} type="number" min={5} max={10080} value={f.repeatEveryMin} onChange={(e) => setF({ ...f, repeatEveryMin: e.target.value === '' ? '' : Number(e.target.value) })} className="max-w-[10rem]" />}</Field>
          </div>
        </Modal>
      )}
    </>
  );
}

const PAGE = 50;
function Log({ admin }: { admin: boolean }) {
  const t = useT(); const qc = useQueryClient(); const toast = useToast(); const fail = useFail();
  const [status, setStatus] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['notification-deliveries', status], initialPageParam: undefined as number | undefined, refetchInterval: 15_000,
    queryFn: ({ pageParam }) => get<Delivery[]>(`/api/notification-deliveries?limit=${PAGE}${status ? `&status=${status}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].id : undefined),
  });
  const retry = useMutation({ mutationFn: (id: number) => post(`/api/notification-deliveries/${id}/retry`), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['notification-deliveries'] }); toast(t('notifications.log.retried')); }, onError: fail });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label={t('common.status')}>{['', 'pending', 'sent', 'failed', 'skipped'].map((s) => <Button key={s} size="sm" variant={status === s ? 'primary' : 'default'} aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? t(`notifications.log.status.${s}`) : t('common.all')}</Button>)}</div>
      <Card>
        {q.isLoading ? <Loading /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !rows.length ? <EmptyState icon={<Send className="h-6 w-6" />} title={t('notifications.log.empty')} /> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>{t('notifications.log.time')}</th><th>{t('common.status')}</th><th>{t('notifications.log.what')}</th><th className="hidden md:table-cell">{t('notifications.log.channel')}</th><th className="hidden lg:table-cell">{t('notifications.log.attempts')}</th>{admin && <th><span className="sr-only">{t('common.actions')}</span></th>}</tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.id}>
                <td className="whitespace-nowrap">{fmtDateTime(d.ts)}</td>
                <td><Badge tone={DELIVERY_TONE[d.status]}>{t(`notifications.log.status.${d.status}`)}</Badge></td>
                <td className="max-w-xs"><div className="truncate">{d.subject ?? d.event}</div>{d.error && <div className="truncate text-xs text-red-600" title={d.error}>{d.error}</div>}{d.status === 'pending' && d.nextAttemptAt && <div className="text-xs text-slate-500">{t('notifications.log.next', { when: fmtDateTime(d.nextAttemptAt) })}</div>}</td>
                <td className="hidden md:table-cell">{d.channel ?? '–'}</td>
                <td className="hidden lg:table-cell">{d.attempts}</td>
                {admin && <td className="text-right">{d.status === 'failed' && <Button size="sm" loading={retry.isPending && retry.variables === d.id} onClick={() => retry.mutate(d.id)}><RotateCw className="h-4 w-4" />{t('notifications.log.retry')}</Button>}</td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {q.hasNextPage && <div className="border-t border-slate-200 p-3 text-center dark:border-slate-800"><Button size="sm" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>{t('common.more')}</Button></div>}
      </Card>
    </>
  );
}

export default function Notifications() {
  const t = useT();
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [tab, setTab] = useState<Tab>('channels');
  return (
    <>
      <PageHeader title={t('nav.notifications')} subtitle={admin ? t('notifications.subtitle') : t('notifications.readOnly')} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'channels', label: t('notifications.tab.channels') }, { id: 'templates', label: t('notifications.tab.templates') }, { id: 'policies', label: t('notifications.tab.policies') }, { id: 'log', label: t('notifications.tab.log') }]} />
      {tab === 'channels' && <Channels admin={admin} />}
      {tab === 'templates' && <Templates admin={admin} />}
      {tab === 'policies' && <Policies admin={admin} />}
      {tab === 'log' && <Log admin={admin} />}
    </>
  );
}
