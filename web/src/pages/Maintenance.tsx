import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CheckList, timeZones, useGroupsQ, useMonitorsQ, useTagsQ } from '../components/ops-shared';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Textarea, Toggle, useConfirm, useToast, type Tone } from '../components/ui';
import { ApiError, del, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useT } from '../lib/i18n';

type Target = { type: 'monitor' | 'group' | 'tag'; id: number };
interface Win { id: number; name: string; description: string | null; kind: 'once' | 'cron'; startsAt: string | null; endsAt: string | null; cronExpr: string | null; durationMin: number | null; timezone: string | null; active: boolean; announce: boolean; targets: Target[]; state: 'disabled' | 'running' | 'scheduled' | 'finished'; currentEnd: string | null; nextStart: string | null }
const STATE_TONE: Record<Win['state'], Tone> = { running: 'amber', scheduled: 'blue', finished: 'gray', disabled: 'violet' };
const PRESETS = [{ k: 'daily', v: '0 2 * * *' }, { k: 'weekdays', v: '0 22 * * 1-5' }, { k: 'weekly', v: '0 3 * * 0' }, { k: 'monthly', v: '0 3 1 * *' }];

/** Local "YYYY-MM-DDTHH:mm" value for datetime-local inputs. */
const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const hh = (n: string) => n.padStart(2, '0');

/** shortcut: only understands "m h dom * dow" with plain numbers or one range, anything else shows the raw expression; upgrade when users need full cron prose. */
function describeCron(expr: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const m = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|[0-6]|[0-6]-[0-6])$/.exec(expr.trim());
  if (!m) return t('maintenance.cron.custom', { expr });
  const [, mi, h, dom, dow] = m;
  const time = `${hh(h)}:${hh(mi)}`;
  const days = t('maintenance.cron.days').split(',');
  if (dom !== '*') return t('maintenance.cron.monthly', { day: dom, time });
  if (dow === '*') return t('maintenance.cron.daily', { time });
  const [a, b] = dow.split('-');
  return t('maintenance.cron.weekly', { days: b ? `${days[Number(a)]}–${days[Number(b)]}` : days[Number(a)], time });
}

const blank = () => ({ id: 0, name: '', description: '', kind: 'once' as 'once' | 'cron', startsAt: toLocalInput(new Date(Date.now() + 3600_000).toISOString()), endsAt: toLocalInput(new Date(Date.now() + 7200_000).toISOString()), cronExpr: '0 2 * * *', durationMin: 60, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', active: true, announce: false, targets: [] as Target[] });

export default function Maintenance() {
  const t = useT();
  const { can } = useAuth();
  const editor = can('editor');
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ['maintenance'], queryFn: () => get<Win[]>('/api/maintenance') });
  const monitors = useMonitorsQ(); const groups = useGroupsQ(); const tags = useTagsQ();
  const [f, setF] = useState<ReturnType<typeof blank> | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['maintenance'] });
  const save = useMutation({
    mutationFn: (v: ReturnType<typeof blank>) => {
      const body = { name: v.name.trim(), description: v.description || undefined, kind: v.kind, active: v.active, announce: v.announce, targets: v.targets,
        ...(v.kind === 'once' ? { startsAt: new Date(v.startsAt).toISOString(), endsAt: new Date(v.endsAt).toISOString() } : { cronExpr: v.cronExpr.trim(), durationMin: v.durationMin, timezone: v.timezone }) };
      return v.id ? put(`/api/maintenance/${v.id}`, body) : post('/api/maintenance', body);
    },
    onSuccess: () => { refresh(); setF(null); toast(t('common.saved')); },
    onError: (e) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error'),
  });
  const toggle = useMutation({
    mutationFn: (w: Win) => put(`/api/maintenance/${w.id}`, { name: w.name, description: w.description ?? undefined, kind: w.kind, active: !w.active, announce: w.announce, targets: w.targets,
      ...(w.kind === 'once' ? { startsAt: w.startsAt, endsAt: w.endsAt } : { cronExpr: w.cronExpr, durationMin: w.durationMin, timezone: w.timezone }) }),
    onSuccess: refresh, onError: (e) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error'),
  });
  const remove = async (w: Win) => { if (await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: w.name }), danger: true, confirmLabel: t('common.delete') })) { try { await del(`/api/maintenance/${w.id}`); refresh(); toast(t('common.deleted')); } catch (e) { toast(errMsg(e, t), 'error'); } } };

  const has = (type: Target['type']) => f!.targets.filter((x) => x.type === type).map((x) => x.id);
  const setType = (type: Target['type'], ids: number[]) => setF({ ...f!, targets: [...f!.targets.filter((x) => x.type !== type), ...ids.map((id) => ({ type, id }))] });
  const valid = f && f.name.trim() && f.targets.length > 0 && (f.kind === 'once' ? f.startsAt && f.endsAt && new Date(f.endsAt) > new Date(f.startsAt) : f.cronExpr.trim() && f.durationMin >= 1);
  const targetNames = (w: Win) => w.targets.map((x) => (x.type === 'monitor' ? monitors.data?.find((m) => m.id === x.id)?.name : x.type === 'group' ? groups.data?.find((g) => g.id === x.id)?.name : tags.data?.find((g) => g.id === x.id)?.name) ?? `${x.type} #${x.id}`);

  return (
    <>
      <PageHeader title={t('nav.maintenance')} subtitle={t('maintenance.subtitle')} actions={editor && <Button variant="primary" onClick={() => setF(blank())}><Plus className="h-4 w-4" />{t('maintenance.new')}</Button>} />
      <Card>
        {list.isLoading ? <Loading /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : !list.data?.length ? (
          <EmptyState icon={<CalendarClock className="h-6 w-6" />} title={t('maintenance.empty')} body={t('maintenance.emptyBody')} />
        ) : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.status')}</th><th>{t('maintenance.schedule')}</th><th className="hidden md:table-cell">{t('maintenance.targets')}</th>{editor && <th><span className="sr-only">{t('common.actions')}</span></th>}</tr></thead>
            <tbody>{list.data.map((w) => (
              <tr key={w.id}>
                <td className="max-w-xs"><div className="truncate font-medium">{w.name}</div>{w.announce && <span className="text-xs text-slate-500">{t('maintenance.announced')}</span>}</td>
                <td><Badge tone={STATE_TONE[w.state]}>{t(`maintenance.state.${w.state}`)}</Badge></td>
                <td className="text-sm">
                  {w.kind === 'once' ? <>{fmtDateTime(w.startsAt)} → {fmtDateTime(w.endsAt)}</> : <><div>{describeCron(w.cronExpr ?? '', t)} · {t('maintenance.forMin', { n: w.durationMin ?? 0 })}</div><div className="text-xs text-slate-500">{w.timezone}</div></>}
                  {w.state === 'running' && w.currentEnd && <div className="text-xs text-amber-600">{t('maintenance.endsAt', { when: fmtDateTime(w.currentEnd) })}</div>}
                  {w.state === 'scheduled' && w.nextStart && <div className="text-xs text-slate-500">{t('maintenance.nextAt', { when: fmtDateTime(w.nextStart) })}</div>}
                </td>
                <td className="hidden max-w-[16rem] truncate text-sm md:table-cell" title={targetNames(w).join(', ')}>{targetNames(w).join(', ')}</td>
                {editor && <td className="whitespace-nowrap text-right">
                  <Toggle checked={w.active} onChange={() => toggle.mutate(w)} label={<span className="sr-only">{t('common.enabled')}</span>} />
                  <Button size="sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setF({ id: w.id, name: w.name, description: w.description ?? '', kind: w.kind, startsAt: toLocalInput(w.startsAt) || blank().startsAt, endsAt: toLocalInput(w.endsAt) || blank().endsAt, cronExpr: w.cronExpr ?? '0 2 * * *', durationMin: w.durationMin ?? 60, timezone: w.timezone ?? 'UTC', active: w.active, announce: w.announce, targets: w.targets })}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove(w)}><Trash2 className="h-4 w-4" /></Button>
                </td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      {f && (
        <Modal wide open onClose={() => setF(null)} title={f.id ? t('maintenance.edit') : t('maintenance.new')} footer={<><Button onClick={() => setF(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(f)}>{t('common.save')}</Button></>}>
          <div className="space-y-4">
            <Field label={t('common.name')}>{(id) => <Input id={id} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label={t('common.description')}>{(id) => <Textarea id={id} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="font-sans" />}</Field>
            <Field label={t('maintenance.kind')}>{(id) => <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'once' | 'cron' })}><option value="once">{t('maintenance.kind.once')}</option><option value="cron">{t('maintenance.kind.cron')}</option></Select>}</Field>
            {f.kind === 'once' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('maintenance.starts')}>{(id) => <Input id={id} type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />}</Field>
                <Field label={t('maintenance.ends')} error={f.endsAt && f.startsAt && new Date(f.endsAt) <= new Date(f.startsAt) ? t('maintenance.endBeforeStart') : undefined}>{(id) => <Input id={id} type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />}</Field>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-1" role="group" aria-label={t('maintenance.presets')}>{PRESETS.map((p) => <Button key={p.k} size="sm" variant={f.cronExpr === p.v ? 'primary' : 'default'} onClick={() => setF({ ...f, cronExpr: p.v })}>{t(`maintenance.preset.${p.k}`)}</Button>)}</div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t('maintenance.cron')} hint={describeCron(f.cronExpr, t)} className="sm:col-span-3">{(id) => <Input id={id} className="font-mono" value={f.cronExpr} onChange={(e) => setF({ ...f, cronExpr: e.target.value })} />}</Field>
                  <Field label={t('maintenance.duration')}>{(id) => <Input id={id} type="number" min={1} max={10080} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: Number(e.target.value) })} />}</Field>
                  <Field label={t('maintenance.timezone')} className="sm:col-span-2">{(id) => <Select id={id} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{(timeZones.includes(f.timezone) ? timeZones : [f.timezone, ...timeZones]).map((z) => <option key={z}>{z}</option>)}</Select>}</Field>
                </div>
              </div>
            )}
            <fieldset className="space-y-3"><legend className="label">{t('maintenance.targets')} <span className="font-normal text-slate-500">· {t('maintenance.targetsHint')}</span></legend>
              <div><span className="hint">{t('maintenance.monitors')}</span><CheckList searchable items={(monitors.data ?? []).map((m) => ({ id: m.id, label: m.name }))} value={has('monitor')} onChange={(v) => setType('monitor', v)} /></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><span className="hint">{t('maintenance.groups')}</span><CheckList items={(groups.data ?? []).map((g) => ({ id: g.id, label: g.name }))} value={has('group')} onChange={(v) => setType('group', v)} /></div>
                <div><span className="hint">{t('maintenance.tags')}</span><CheckList items={(tags.data ?? []).map((g) => ({ id: g.id, label: g.name }))} value={has('tag')} onChange={(v) => setType('tag', v)} /></div>
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-6">
              <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label={t('common.enabled')} />
              <Toggle checked={f.announce} onChange={(v) => setF({ ...f, announce: v })} label={t('maintenance.announce')} />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

const errMsg = (e: unknown, t: (k: string) => string) => (e instanceof ApiError ? e.message : t('common.failed'));
