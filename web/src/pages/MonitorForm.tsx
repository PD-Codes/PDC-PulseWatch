import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Card, CardHeader, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea, Toggle, useToast } from '../components/ui';
import { TagValueEditor, toTagValues, type TagValueRow } from '../components/TagEditor';
import { initValues, MonitorFields, toConfig, type FieldValue, type FieldValues, type MonitorType } from '../components/MonitorFields';
import { ApiError, errorMessage, get, post, put, type Group, type MonitorItem, type Tag, type TagInfo } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseBulk } from '../lib/bulkParse';
import { fmtDuration } from '../lib/format';
import { useT } from '../lib/i18n';

interface Probe { id: number; name: string; location: string | null; online: boolean; enabled: boolean }
interface Channel { id: number; name: string }
interface Policy { id: number; name: string }
interface Rule { channelId: number | null; policyId: number | null; events: string[] }
interface Detail extends MonitorItem {
  config: Record<string, unknown>; timeoutS: number; retries: number; retryIntervalS: number; upThreshold: number;
  flapWindow: number; flapThreshold: number; quorum: number; notifications: Rule[];
}
const EVENTS = ['down', 'up', 'flap', 'cert'] as const;

interface Common {
  name: string; description: string; groupId: string; intervalS: string; timeoutS: string; retries: string; retryIntervalS: string;
  upThreshold: string; flapWindow: string; flapThreshold: string; active: boolean; publicBadge: boolean; quorum: string;
}
const COMMON: Common = { name: '', description: '', groupId: '', intervalS: '60', timeoutS: '48', retries: '0', retryIntervalS: '60', upThreshold: '1', flapWindow: '10', flapThreshold: '6', active: true, publicBadge: false, quorum: '1' };

export default function MonitorForm() {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const id = useParams().id ? Number(useParams().id) : null;
  const clone = Number(useSearchParams()[0].get('clone')) || null;
  const cloned = useRef(false);

  const types = useQuery({ queryKey: ['monitor-types'], queryFn: () => get<MonitorType[]>('/api/monitor-types'), staleTime: Infinity });
  const detail = useQuery({ queryKey: ['monitor', id], queryFn: () => get<Detail>(`/api/monitors/${id}`), enabled: id != null });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups') });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => get<TagInfo[]>('/api/tags') });
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors') });
  const probes = useQuery({ queryKey: ['probes'], queryFn: () => get<Probe[]>('/api/probes'), retry: false });
  const channels = useQuery({ queryKey: ['notification-channels'], queryFn: () => get<Channel[]>('/api/notification-channels'), retry: false });
  const policies = useQuery({ queryKey: ['escalation-policies'], queryFn: () => get<Policy[]>('/api/escalation-policies'), retry: false });

  const [type, setType] = useState('http');
  const [c, setC] = useState<Common>(COMMON);
  const [vals, setVals] = useState<FieldValues>({});
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [tagVals, setTagVals] = useState<TagValueRow[]>([]);
  const [deps, setDeps] = useState<number[]>([]);
  const [locations, setLocations] = useState<(number | 'local')[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [newTag, setNewTag] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  const runner = types.data?.find((x) => x.type === type);

  // New monitors start from the instance-wide defaults (Settings > Defaults).
  const defaults = useQuery({ queryKey: ['monitor-defaults'], queryFn: () => get<{ defaults: Record<string, number> }>('/api/settings/monitor-defaults'), enabled: id == null && !clone, staleTime: 0 });
  const seeded = useRef(false);
  useEffect(() => {
    const d = defaults.data?.defaults;
    if (!d || seeded.current || id != null || clone) return;
    seeded.current = true;
    setC((o) => ({ ...o, ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, String(v)])) }));
  }, [defaults.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Inline "new group": null = closed.
  const [newGroup, setNewGroup] = useState<{ name: string; parent: string } | null>(null);
  const addGroup = useMutation({
    mutationFn: () => post<{ id: number }>('/api/groups', { name: newGroup!.name.trim(), parentId: newGroup!.parent ? Number(newGroup!.parent) : null }),
    onSuccess: (g) => { void qc.invalidateQueries({ queryKey: ['groups'] }); setC((o) => ({ ...o, groupId: String(g.id) })); setNewGroup(null); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  // Bulk add: one name/address per line, everything else shared.
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [skipExisting, setSkipExisting] = useState(true);
  const addressField = runner?.fields.find((f) => f.kind === 'text' && f.required);
  const bulkLines = useMemo(() => parseBulk(bulkText), [bulkText]);
  const existingNames = useMemo(() => new Set((monitors.data ?? []).map((m) => m.name.toLowerCase())), [monitors.data]);
  const lineState = (i: number) => {
    const n = bulkLines[i]!.name.toLowerCase();
    if (bulkLines.findIndex((x) => x.name.toLowerCase() === n) !== i) return 'dupList';
    return existingNames.has(n) ? 'exists' : 'ok';
  };

  // Clone: let the server copy (it keeps stored secrets), then continue in the edit form.
  useEffect(() => {
    if (!clone || cloned.current) return;
    cloned.current = true;
    post<{ id: number }>(`/api/monitors/${clone}/clone`).then((m) => { void qc.invalidateQueries({ queryKey: ['monitors'] }); toast(t('monitors.form.cloned')); nav(`/monitors/${m.id}/edit`, { replace: true }); }, (e) => { setErrors([errorMessage(e)]); });
  }, [clone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the existing monitor into the form once.
  useEffect(() => {
    const d = detail.data; const rt = types.data;
    if (!d || !rt || loaded) return;
    const r = rt.find((x) => x.type === d.type);
    setType(d.type);
    setC({ name: d.name, description: d.description ?? '', groupId: d.groupId ? String(d.groupId) : '', intervalS: String(d.intervalS), timeoutS: String(d.timeoutS), retries: String(d.retries), retryIntervalS: String(d.retryIntervalS), upThreshold: String(d.upThreshold), flapWindow: String(d.flapWindow), flapThreshold: String(d.flapThreshold), active: d.active, publicBadge: d.publicBadge, quorum: String(d.quorum) });
    setVals(initValues(r?.fields ?? [], d.config));
    setTagIds(d.tags.filter((x) => !x.value).map((x) => x.id)); setTagVals(d.tags.filter((x) => x.value).map((x) => ({ tagId: x.id, value: x.value }))); setDeps(d.dependsOn); setLocations((d.locations ?? []) as (number | 'local')[]); setRules(d.notifications ?? []);
    setLoaded(true);
  }, [detail.data, types.data, loaded]);

  // New monitor: seed field defaults for the selected type.
  useEffect(() => { if (id == null && !clone && runner) setVals(initValues(runner.fields)); }, [type, runner?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => {
      const config = toConfig(runner!.fields, vals);
      const n = (s: string) => Number(s);
      const body = {
        name: c.name.trim(), type, description: c.description.trim() || null, groupId: c.groupId ? n(c.groupId) : null, config,
        intervalS: n(c.intervalS), timeoutS: n(c.timeoutS), retries: n(c.retries), retryIntervalS: n(c.retryIntervalS), upThreshold: n(c.upThreshold),
        flapWindow: n(c.flapWindow), flapThreshold: n(c.flapThreshold), active: c.active, publicBadge: c.publicBadge, quorum: n(c.quorum),
        locations: locations.length ? locations : null, tagIds, tagValues: toTagValues(tagVals), dependsOn: deps, notifications: rules.filter((r) => r.channelId || r.policyId),
      };
      return id ? put<{ id: number }>(`/api/monitors/${id}`, body) : post<{ id: number }>('/api/monitors', body);
    },
    onSuccess: (m) => {
      toast(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['monitors'] }); void qc.invalidateQueries({ queryKey: ['monitor'] });
      nav(`/monitors/${m.id ?? id}`);
    },
    onError: (e) => setErrors(e instanceof ApiError && Array.isArray(e.body?.errors) && e.body.errors.length ? e.body.errors : [errorMessage(e)]),
  });

  const saveBulk = useMutation({
    mutationFn: () => {
      const n = (x: string) => Number(x);
      const template = {
        description: c.description.trim() || null, groupId: c.groupId ? n(c.groupId) : null, config: toConfig(runner!.fields.filter((f) => f.key !== addressField!.key), vals),
        intervalS: n(c.intervalS), timeoutS: n(c.timeoutS), retries: n(c.retries), retryIntervalS: n(c.retryIntervalS), upThreshold: n(c.upThreshold),
        flapWindow: n(c.flapWindow), flapThreshold: n(c.flapThreshold), active: c.active, publicBadge: c.publicBadge, quorum: n(c.quorum),
        locations: locations.length ? locations : null, tagIds, tagValues: toTagValues(tagVals), dependsOn: deps, notifications: rules.filter((r) => r.channelId || r.policyId),
      };
      return post<{ created: { index: number }[]; skipped: { index: number }[]; failed: { index: number; errors: string[] }[] }>('/api/monitors/bulk-create', {
        type, addressKey: addressField!.key, skipExisting, template, items: bulkLines.map((l) => ({ name: l.name, address: l.address })),
      });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['monitors'] });
      toast(t('monitors.bulk.done', { created: r.created.length, skipped: r.skipped.length, failed: r.failed.length }));
      if (!r.failed.length) return nav('/dashboard');
      // keep only the failed lines so the user can fix and resend them
      setBulkText(r.failed.map((f) => bulkLines[f.index]!).map((l) => `${l.name} | ${l.address}`).join('\n'));
      setErrors(r.failed.map((f) => `${bulkLines[f.index]!.name}: ${f.errors.join('; ')}`));
    },
    onError: (e) => setErrors(e instanceof ApiError && Array.isArray(e.body?.errors) && e.body.errors.length ? e.body.errors : [errorMessage(e)]),
  });

  const addTag = useMutation({
    mutationFn: () => post<Tag>('/api/tags', { name: newTag.trim() }),
    onSuccess: (tg) => { setTagIds((x) => [...x, tg.id]); setNewTag(''); void qc.invalidateQueries({ queryKey: ['tags'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const byCategory = useMemo(() => {
    const m = new Map<string, MonitorType[]>();
    for (const x of types.data ?? []) m.set(x.category, [...(m.get(x.category) ?? []), x]);
    return [...m.entries()];
  }, [types.data]);

  if (!can('editor')) return <ErrorBox error={new Error(t('monitors.form.forbidden'))} />;
  if (clone) return errors.length ? <ErrorBox error={new Error(errors[0])} /> : <Loading />;
  if (types.isLoading || (id != null && (detail.isLoading || !loaded))) return <Loading />;
  if (types.error || detail.error) return <ErrorBox error={types.error ?? detail.error} />;

  const set = <K extends keyof Common>(k: K, v: Common[K]) => setC((o) => ({ ...o, [k]: v }));
  // Like Uptime Kuma: a retry follows the interval while both are the same, and the timeout never exceeds 80% of the interval (checked when the field is left, so typing "120" does not clamp at "1").
  const changeInterval = (v: string) => setC((o) => ({ ...o, intervalS: v, retryIntervalS: o.retryIntervalS === o.intervalS ? v : o.retryIntervalS }));
  const clampTimeout = () => setC((o) => { const cap = Math.max(1, Math.floor((Number(o.intervalS) || 0) * 0.8)); return Number(o.timeoutS) > cap ? { ...o, timeoutS: String(cap) } : o; });
  const num = (k: keyof Common, label: string, min: number, max: number, hint?: string, on?: { onChange?: (v: string) => void; onBlur?: () => void }) => (
    <Field label={label} hint={hint}>{(fid) => <Input id={fid} type="number" min={min} max={max} value={c[k] as string} onChange={(e) => (on?.onChange ?? ((v: string) => set(k, v as never)))(e.target.value)} onBlur={on?.onBlur} required />}</Field>
  );
  const toggleIn = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const onSubmit = (e: FormEvent) => { e.preventDefault(); setErrors([]); try { if (bulk) { if (bulkLines.length) saveBulk.mutate(); else setErrors([t('monitors.bulk.empty')]); } else save.mutate(); } catch (err) { setErrors([errorMessage(err)]); } };
  // Worst case until the monitor is reported as down: every attempt may run into the timeout, and each retry waits for the retry interval.
  const retries = Number(c.retries) || 0;
  const retrySummary = retries === 0 ? t('monitors.retryNow') : t('monitors.retrySummary', { time: fmtDuration((retries + 1) * (Number(c.timeoutS) || 0) + retries * (Number(c.retryIntervalS) || 0)) });
  const probeList = probes.data ?? [];
  const isPush = type === 'push';
  const locCount = locations.length;

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={id ? t('monitors.form.editTitle') : t('monitors.form.newTitle')} actions={<><Button onClick={() => nav(-1)}>{t('common.cancel')}</Button><Button type="submit" variant="primary" loading={save.isPending || saveBulk.isPending}>{bulk ? t('monitors.bulk.create', { n: bulkLines.length }) : t('common.save')}</Button></>} />
      {errors.length > 0 && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"><ul className="list-disc pl-5">{errors.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}

      <Card>
        <CardHeader title={t('monitors.form.general')} />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label={`${t('monitors.form.type')} *`}>{(fid) => (
            <Select id={fid} value={type} disabled={id != null} onChange={(e) => setType(e.target.value)}>
              {byCategory.map(([cat, list]) => <optgroup key={cat} label={cat}>{list.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}</optgroup>)}
            </Select>)}</Field>
          {id == null && addressField && (
            <div className="sm:col-span-2"><Toggle checked={bulk} onChange={setBulk} label={t('monitors.bulk.toggle')} /><p className="hint">{t('monitors.bulk.hint', { field: addressField.label })}</p></div>
          )}
          {bulk && addressField && (
            <div className="space-y-2 sm:col-span-2">
              <Field label={t('monitors.bulk.targets')} hint={t('monitors.bulk.format')}>{(fid) => <Textarea id={fid} rows={6} spellCheck={false} className="font-mono text-xs" placeholder={'Website | https://example.com\nShop | https://shop.example.com\nmail.example.com'} value={bulkText} onChange={(e) => setBulkText(e.target.value)} />}</Field>
              {bulkLines.length > 0 && (
                <div className="max-h-56 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="tbl text-xs">
                    <thead><tr><th>#</th><th>{t('common.name')}</th><th>{addressField.label}</th><th /></tr></thead>
                    <tbody>{bulkLines.map((l, i) => { const st = lineState(i); return (
                      <tr key={l.line}><td className="text-slate-400">{l.line}</td><td>{l.name}</td><td className="break-all font-mono">{l.address}</td>
                        <td className={st === 'ok' ? 'text-emerald-600' : 'text-amber-600'}>{t(`monitors.bulk.state.${st}`)}</td></tr>); })}</tbody>
                  </table>
                </div>
              )}
              <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />{t('monitors.bulk.skip')}</label>
            </div>
          )}
          {!bulk && <Field label={`${t('common.name')} *`}>{(fid) => <Input id={fid} value={c.name} maxLength={255} required onChange={(e) => set('name', e.target.value)} />}</Field>}
          <Field label={t('monitors.group')} className={bulk ? 'sm:col-span-2' : undefined}>{(fid) => (
            <div className="flex gap-2">
              <Select id={fid} value={c.groupId} onChange={(e) => set('groupId', e.target.value)}><option value="">{t('monitors.noGroup')}</option>{groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
              <Button type="button" className="shrink-0" title={t('monitors.form.newGroup')} aria-label={t('monitors.form.newGroup')} onClick={() => setNewGroup(newGroup ? null : { name: '', parent: '' })}><FolderPlus className="h-4 w-4" /></Button>
            </div>)}</Field>
          {newGroup && (
            <div className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:col-span-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input aria-label={t('monitors.form.newGroupName')} placeholder={t('monitors.form.newGroupName')} maxLength={255} autoFocus value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (newGroup.name.trim()) addGroup.mutate(); } }} />
              <Select aria-label={t('monitors.form.newGroupParent')} value={newGroup.parent} onChange={(e) => setNewGroup({ ...newGroup, parent: e.target.value })}><option value="">{t('monitors.form.newGroupTop')}</option>{groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
              <Button type="button" variant="primary" loading={addGroup.isPending} disabled={!newGroup.name.trim()} onClick={() => addGroup.mutate()}>{t('monitors.form.createGroup')}</Button>
            </div>
          )}
          <Field label={t('common.description')} className="sm:col-span-2">{(fid) => <Textarea id={fid} rows={2} value={c.description} onChange={(e) => set('description', e.target.value)} />}</Field>
        </div>
      </Card>

      {runner && runner.fields.length > 0 && (
        <Card>
          <CardHeader title={runner.label} />
          <div className="p-4"><MonitorFields idPrefix="mf" fields={bulk && addressField ? runner.fields.filter((f) => f.key !== addressField.key) : runner.fields} values={vals} onChange={(k: string, v: FieldValue) => setVals((o) => ({ ...o, [k]: v }))} /></div>
        </Card>
      )}

      <Card>
        <CardHeader title={t('monitors.form.timing')} />
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {num('intervalS', t('monitors.interval'), 5, 86400, t('monitors.form.checkEvery', { n: c.intervalS }), { onChange: changeInterval, onBlur: clampTimeout })}
          {num('timeoutS', t('monitors.timeout'), 1, 300, t('monitors.form.timeoutAfter', { n: c.timeoutS }), { onBlur: clampTimeout })}
          {num('retries', t('monitors.retries'), 0, 100, t('monitors.form.retriesHint'))}
          {num('retryIntervalS', t('monitors.retryInterval'), 5, 3600, t('monitors.form.retryEvery', { n: c.retryIntervalS }))}
          {num('upThreshold', t('monitors.upThreshold'), 1, 20, t('monitors.form.upHint'))}
          {num('flapWindow', t('monitors.flapWindow'), 4, 60, t('monitors.form.flapWindowHint'))}
          {num('flapThreshold', t('monitors.flapThreshold'), 0, 60, t('monitors.form.flapThresholdHint'))}
          <p className="hint sm:col-span-2 lg:col-span-4" data-testid="retry-summary">{retrySummary}</p>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('monitors.form.organize')} />
        <div className="space-y-4 p-4">
          <fieldset>
            <legend className="label">{t('monitors.form.tags')}</legend>
            <div className="flex flex-wrap items-center gap-2">
              {tags.data?.map((x) => <button key={x.id} type="button" aria-pressed={tagIds.includes(x.id)} onClick={() => setTagIds(toggleIn(tagIds, x.id))} className="rounded-full border px-2.5 py-1 text-xs transition" style={tagIds.includes(x.id) ? { background: x.color, borderColor: x.color, color: '#fff' } : { borderColor: x.color }}>{x.name}</button>)}
              <span className="inline-flex gap-1"><input className="input w-36 py-1 text-xs" aria-label={t('monitors.form.newTag')} placeholder={t('monitors.form.newTag')} value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (newTag.trim()) addTag.mutate(); } }} /><Button size="sm" disabled={!newTag.trim()} loading={addTag.isPending} onClick={() => addTag.mutate()} aria-label={t('common.add')}><Plus className="h-4 w-4" /></Button></span>
            </div>
          </fieldset>
          <TagValueEditor tags={tags.data ?? []} rows={tagVals} onChange={setTagVals} />
          <Field label={t('monitors.form.deps')} hint={t('monitors.form.depsHint')}>{(fid) => (
            <select id={fid} multiple size={5} className="input" value={deps.map(String)} onChange={(e) => setDeps([...e.target.selectedOptions].map((o) => Number(o.value)))}>
              {monitors.data?.filter((x) => x.id !== id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>)}</Field>
          <Toggle checked={c.active} onChange={(v) => set('active', v)} label={t('monitors.form.active')} />
          <div><Toggle checked={c.publicBadge} onChange={(v) => set('publicBadge', v)} label={t('monitors.form.publicBadge')} /><p className="hint">{t('monitors.form.publicBadgeHint')}</p></div>
        </div>
      </Card>

      {!isPush && probeList.length > 0 && (
        <Card>
          <CardHeader title={t('monitors.locations')} subtitle={t('monitors.form.locationsHint')} />
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap gap-3">
              {([{ id: 'local' as const, name: t('monitors.form.local'), online: true }, ...probeList.filter((p) => p.enabled)]).map((p) => (
                <label key={p.id} className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={locations.includes(p.id)} onChange={() => setLocations(toggleIn(locations, p.id))} />{p.name}{p.id !== 'local' && !p.online && <span className="text-xs text-amber-600">({t('monitors.form.offline')})</span>}</label>
              ))}
            </div>
            {locCount > 1 && <div className="max-w-xs"><Field label={t('monitors.form.quorum')} hint={t('monitors.form.quorumHint', { n: c.quorum || 1, total: locCount })}>{(fid) => <Input id={fid} type="number" min={1} max={locCount} value={c.quorum} onChange={(e) => set('quorum', e.target.value)} />}</Field></div>}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title={t('monitors.form.notifications')} subtitle={t('monitors.form.notificationsHint')} actions={<Button size="sm" onClick={() => setRules([...rules, { channelId: null, policyId: null, events: ['down', 'up'] }])}><Plus className="h-4 w-4" />{t('monitors.form.addRule')}</Button>} />
        <div className="space-y-3 p-4">
          {rules.length === 0 && <p className="text-sm text-slate-500">{t('monitors.form.noRules')}</p>}
          {rules.map((r, i) => {
            const patch = (p: Partial<Rule>) => setRules(rules.map((x, n) => (n === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="grid gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-[1fr_1fr_auto]">
                <Field label={t('monitors.form.channel')}>{(fid) => <Select id={fid} value={r.channelId ?? ''} onChange={(e) => patch({ channelId: e.target.value ? Number(e.target.value) : null })}><option value="">–</option>{channels.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
                <Field label={t('monitors.form.policy')}>{(fid) => <Select id={fid} value={r.policyId ?? ''} onChange={(e) => patch({ policyId: e.target.value ? Number(e.target.value) : null })}><option value="">–</option>{policies.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
                <div className="flex items-end"><Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => setRules(rules.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4" /></Button></div>
                <div className="flex flex-wrap gap-3 sm:col-span-3">{EVENTS.map((ev) => <label key={ev} className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={r.events.includes(ev)} onChange={() => patch({ events: toggleIn(r.events, ev) })} />{t(`monitors.form.event.${ev}`)}</label>)}</div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="flex justify-end gap-2 pb-6"><Button onClick={() => nav(-1)}>{t('common.cancel')}</Button><Button type="submit" variant="primary" loading={save.isPending || saveBulk.isPending}>{bulk ? t('monitors.bulk.create', { n: bulkLines.length }) : t('common.save')}</Button></div>
    </form>
  );
}
