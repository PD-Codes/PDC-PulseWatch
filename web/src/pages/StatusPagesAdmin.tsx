import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, Globe, Lock, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, Toggle, useConfirm, useToast } from '../components/ui';
import { del, errorMessage, get, post, put, type Group, type MonitorItem } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useT } from '../lib/i18n';

interface PageRow { id: number; slug: string; title: string; domain: string | null; isPublic: boolean; protected: boolean }
interface Comp { monitorId: number; displayName: string | null }
interface Full {
  id: number; slug: string; title: string; description: string | null; domain: string | null; isPublic: boolean; hasPassword: boolean; ssoRequired: boolean;
  branding: { logoUrl?: string; primaryColor?: string; footer?: string }; customCss: string | null; showHistory: boolean; historyDays: number;
  sections: { name: string; components: Comp[] }[]; components: Comp[];
}
/** Editor model: group 0 is always the ungrouped list (name === null). */
interface Grp { name: string | null; items: Comp[] }
interface Form {
  slug: string; title: string; description: string; domain: string; isPublic: boolean; ssoRequired: boolean; showHistory: boolean; historyDays: number;
  pwMode: 'keep' | 'set' | 'remove'; password: string; logoUrl: string; primaryColor: string; footer: string; customCss: string; groups: Grp[];
}
const HISTORY_DAYS = [14, 30, 60, 90, 120, 150, 180];
type Tab = 'general' | 'components' | 'appearance' | 'announcements' | 'subscribers';

const toForm = (p?: Full): Form => ({
  slug: p?.slug ?? '', title: p?.title ?? '', description: p?.description ?? '', domain: p?.domain ?? '', isPublic: p?.isPublic ?? true, ssoRequired: p?.ssoRequired ?? false, showHistory: p?.showHistory ?? true, historyDays: p?.historyDays ?? 90,
  pwMode: 'keep', password: '', logoUrl: p?.branding.logoUrl ?? '', primaryColor: p?.branding.primaryColor ?? '', footer: p?.branding.footer ?? '', customCss: p?.customCss ?? '',
  groups: [{ name: null, items: p?.components ?? [] }, ...(p?.sections ?? []).map((s) => ({ name: s.name, items: s.components }))],
});

function move<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const c = [...list];
  [c[i], c[j]] = [c[j]!, c[i]!];
  return c;
}

export default function StatusPagesAdmin() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useAuth();
  const isAdmin = can('admin');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const pages = useQuery({ queryKey: ['status-pages'], queryFn: () => get<PageRow[]>('/api/status-pages') });

  const remove = async (p: PageRow) => {
    if (!(await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: p.title }), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await del(`/api/status-pages/${p.id}`); void qc.invalidateQueries({ queryKey: ['status-pages'] }); toast(t('common.deleted')); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  return (
    <>
      <PageHeader title={t('statuspages.title')} subtitle={t('statuspages.subtitle')} actions={isAdmin && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />{t('statuspages.new')}</Button>} />
      <Card>
        {pages.isLoading ? <Loading /> : pages.error ? <div className="p-4"><ErrorBox error={pages.error} /></div> : !pages.data?.length ? (
          <EmptyState icon={<Globe className="h-6 w-6" />} title={t('statuspages.empty')} body={t('statuspages.emptyBody')} action={isAdmin ? <Button variant="primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />{t('statuspages.new')}</Button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t('statuspages.page')}</th><th>{t('statuspages.domain')}</th><th>{t('statuspages.access')}</th><th className="text-right">{t('common.actions')}</th></tr></thead>
              <tbody>
                {pages.data.map((p) => (
                  <tr key={p.id}>
                    <td><div className="font-medium">{p.title}</div><Link to={`/status/${p.slug}`} target="_blank" className="inline-flex items-center gap-1 text-xs">/status/{p.slug}<ExternalLink className="h-3 w-3" aria-hidden /></Link></td>
                    <td className="text-sm text-slate-500">{p.domain ?? '—'}</td>
                    <td>{p.protected ? <Badge tone="amber"><Lock className="h-3 w-3" />{t('statuspages.protected')}</Badge> : p.isPublic ? <Badge tone="green">{t('statuspages.public')}</Badge> : <Badge>{t('statuspages.private')}</Badge>}</td>
                    <td className="text-right">
                      {isAdmin && <div className="flex justify-end gap-1"><Button size="sm" onClick={() => setEditing(p.id)} aria-label={`${t('common.edit')}: ${p.title}`}><Pencil className="h-4 w-4" />{t('common.edit')}</Button><Button size="sm" variant="ghost" onClick={() => remove(p)} aria-label={`${t('common.delete')}: ${p.title}`}><Trash2 className="h-4 w-4" /></Button></div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing !== null && <Editor id={editing} onClose={() => setEditing(null)} onSaved={() => { void qc.invalidateQueries({ queryKey: ['status-pages'] }); }} />}
    </>
  );
}

function Editor({ id, onClose, onSaved }: { id: number | 'new'; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const full = useQuery({ queryKey: ['status-page', id], queryFn: () => get<Full>(`/api/status-pages/${id}`), enabled: id !== 'new', gcTime: 0 });
  const title = id === 'new' ? t('statuspages.new') : t('statuspages.edit');
  if (id !== 'new' && (full.isLoading || full.error)) return <Modal open onClose={onClose} title={title}>{full.isLoading ? <Loading /> : <ErrorBox error={full.error} />}</Modal>;
  return <EditorForm id={id} initial={toForm(full.data)} hadPassword={!!full.data?.hasPassword} title={title} onClose={onClose} onSaved={() => { onSaved(); toast(t('common.saved')); }} />;
}

function EditorForm({ id, initial, hadPassword, title, onClose, onSaved }: { id: number | 'new'; initial: Form; hadPassword: boolean; title: string; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [f, setF] = useState<Form>(initial);
  const [tab, setTab] = useState<Tab>('general');
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors') });

  const save = useMutation({
    mutationFn: () => {
      const comp = (c: Comp) => ({ monitorId: c.monitorId, displayName: c.displayName?.trim() || null });
      const body = {
        slug: f.slug.trim().toLowerCase(), title: f.title.trim(), description: f.description.trim() || null, domain: f.domain.trim().toLowerCase() || null, isPublic: f.isPublic, ssoRequired: f.ssoRequired, showHistory: f.showHistory, historyDays: f.historyDays,
        ...(f.pwMode === 'set' ? { password: f.password } : f.pwMode === 'remove' ? { password: null } : {}),
        branding: { ...(f.logoUrl.trim() && { logoUrl: f.logoUrl.trim() }), ...(f.primaryColor && { primaryColor: f.primaryColor }), ...(f.footer.trim() && { footer: f.footer.trim() }) },
        customCss: f.customCss.trim() || null,
        sections: f.groups.slice(1).map((g) => ({ name: (g.name ?? '').trim() || t('statuspages.sectionDefault'), components: g.items.map(comp) })),
        components: f.groups[0]!.items.map(comp),
      };
      return id === 'new' ? post('/api/status-pages', body) : put(`/api/status-pages/${id}`, body);
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e) => setErr(errorMessage(e)),
  });

  const submit = () => {
    setErr(null);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(f.slug.trim().toLowerCase())) { setTab('general'); return setErr(t('statuspages.slugInvalid')); }
    if (!f.title.trim()) { setTab('general'); return setErr(t('statuspages.titleRequired')); }
    if (f.pwMode === 'set' && f.password.length < 4) { setTab('general'); return setErr(t('statuspages.passwordShort')); }
    save.mutate();
  };

  const tabs: { id: Tab; label: ReactNode }[] = [
    { id: 'general', label: t('statuspages.tab.general') }, { id: 'components', label: t('statuspages.tab.components') }, { id: 'appearance', label: t('statuspages.tab.appearance') },
    ...(id === 'new' ? [] : [{ id: 'announcements' as const, label: t('statuspages.tab.announcements') }, { id: 'subscribers' as const, label: t('statuspages.tab.subscribers') }]),
  ];

  return (
    <Modal open wide onClose={onClose} title={title} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} onClick={submit}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <div className="overflow-x-auto"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
        {err && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{err}</div>}
        {tab === 'general' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('statuspages.f.title')}>{(i) => <Input id={i} value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={255} />}</Field>
            <Field label={t('statuspages.f.slug')} hint={t('statuspages.f.slugHint')}>{(i) => <Input id={i} value={f.slug} onChange={(e) => set('slug', e.target.value)} maxLength={63} placeholder="status" />}</Field>
            <Field label={t('statuspages.f.description')} className="sm:col-span-2">{(i) => <Textarea id={i} rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={5000} />}</Field>
            <Field label={t('statuspages.f.domain')} hint={t('statuspages.f.domainHint')} className="sm:col-span-2">{(i) => <Input id={i} value={f.domain} onChange={(e) => set('domain', e.target.value)} placeholder="status.example.com" />}</Field>
            <div className="space-y-3 sm:col-span-2">
              <Toggle checked={f.isPublic} onChange={(v) => set('isPublic', v)} label={t('statuspages.f.isPublic')} />
              <Toggle checked={f.ssoRequired} onChange={(v) => set('ssoRequired', v)} label={t('statuspages.f.sso')} />
              <Toggle checked={f.showHistory} onChange={(v) => set('showHistory', v)} label={t('statuspages.f.history')} />
              {f.showHistory && (
                <Field label={t('statuspages.f.historyDays')} className="max-w-xs">
                  {(i) => <Select id={i} value={f.historyDays} onChange={(e) => set('historyDays', Number(e.target.value))}>{HISTORY_DAYS.map((d) => <option key={d} value={d}>{t('statuspages.f.historyDaysOpt', { n: d })}</option>)}</Select>}
                </Field>
              )}
            </div>
            <Field label={t('statuspages.f.password')} hint={t('statuspages.f.passwordHint')} className="sm:col-span-2">
              {(i) => (
                <div className="flex flex-wrap gap-2">
                  <Select id={i} className="w-auto" value={f.pwMode} onChange={(e) => set('pwMode', e.target.value as Form['pwMode'])}>
                    <option value="keep">{hadPassword ? t('statuspages.pw.keep') : t('statuspages.pw.none')}</option>
                    <option value="set">{t('statuspages.pw.set')}</option>
                    {hadPassword && <option value="remove">{t('statuspages.pw.remove')}</option>}
                  </Select>
                  {f.pwMode === 'set' && <Input type="password" autoComplete="new-password" className="min-w-[12rem] flex-1" aria-label={t('statuspages.f.password')} value={f.password} onChange={(e) => set('password', e.target.value)} />}
                </div>
              )}
            </Field>
          </div>
        )}
        {tab === 'components' && <Components groups={f.groups} onChange={(g) => set('groups', g)} monitors={monitors.data} loading={monitors.isLoading} error={monitors.error} />}
        {tab === 'appearance' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('statuspages.f.logo')} hint={t('statuspages.f.logoHint')}>{(i) => <Input id={i} type="url" value={f.logoUrl} onChange={(e) => set('logoUrl', e.target.value)} placeholder="https://…" />}</Field>
            <Field label={t('statuspages.f.color')}>
              {(i) => (
                <div className="flex items-center gap-2">
                  <input id={i} type="color" className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700" value={f.primaryColor || '#4f46e5'} onChange={(e) => set('primaryColor', e.target.value)} />
                  <span className="font-mono text-sm text-slate-500">{f.primaryColor || t('statuspages.f.colorDefault')}</span>
                  {f.primaryColor && <Button size="sm" variant="ghost" onClick={() => set('primaryColor', '')}>{t('common.reset')}</Button>}
                </div>
              )}
            </Field>
            <Field label={t('statuspages.f.footer')} className="sm:col-span-2">{(i) => <Input id={i} value={f.footer} onChange={(e) => set('footer', e.target.value)} maxLength={500} />}</Field>
            <Field label={t('statuspages.f.css')} hint={t('statuspages.f.cssHint')} className="sm:col-span-2">{(i) => <Textarea id={i} rows={8} spellCheck={false} value={f.customCss} onChange={(e) => set('customCss', e.target.value)} />}</Field>
          </div>
        )}
        {tab === 'announcements' && id !== 'new' && <Announcements pageId={id} />}
        {tab === 'subscribers' && id !== 'new' && <Subscribers pageId={id} />}
      </div>
    </Modal>
  );
}

function Components({ groups, onChange, monitors, loading, error }: { groups: Grp[]; onChange: (g: Grp[]) => void; monitors?: MonitorItem[]; loading: boolean; error: unknown }) {
  const t = useT();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const all = monitors ?? [];
  const monGroups = useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups') });
  const [pickGroup, setPickGroup] = useState('');
  const [withSub, setWithSub] = useState(true);
  const used = new Set(groups.flatMap((g) => g.items.map((c) => c.monitorId)));
  const free = all.filter((m) => !used.has(m.id));
  const nameOf = (id: number) => all.find((m) => m.id === id)?.name ?? `#${id}`;
  // Adds one section per monitor group (optionally with its subgroups), skipping monitors already on the page.
  const addWholeGroup = () => {
    const root = Number(pickGroup);
    const list = monGroups.data ?? [];
    if (!root) return;
    const ids = [root];
    if (withSub) for (let i = 0; i < ids.length; i++) for (const g of list) if (g.parentId === ids[i] && !ids.includes(g.id)) ids.push(g.id);
    const taken = new Set(used);
    const added: Grp[] = [];
    for (const gid of ids) {
      const items = all.filter((m) => m.groupId === gid && !taken.has(m.id)).map((m) => ({ monitorId: m.id, displayName: null }));
      items.forEach((c) => taken.add(c.monitorId));
      if (items.length) added.push({ name: list.find((g) => g.id === gid)?.name ?? `#${gid}`, items });
    }
    onChange([...groups, ...added]);
    setPickGroup('');
  };
  const patchGroup = (gi: number, fn: (g: Grp) => Grp) => onChange(groups.map((g, i) => (i === gi ? fn(g) : g)));

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">{t('statuspages.componentsHint')}</p>
      {groups.map((g, gi) => (
        <section key={gi} className="rounded-lg border border-slate-200 dark:border-slate-800" aria-label={g.name ?? t('statuspages.ungrouped')}>
          <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-800/40">
            {g.name === null ? <span className="px-1 text-sm font-medium">{t('statuspages.ungrouped')}</span> : (
              <>
                <Input aria-label={t('statuspages.sectionName')} value={g.name} onChange={(e) => patchGroup(gi, (x) => ({ ...x, name: e.target.value }))} maxLength={255} />
                <Button size="sm" variant="ghost" aria-label={t('statuspages.moveUp')} disabled={gi < 2} onClick={() => onChange([groups[0]!, ...move(groups.slice(1), gi - 1, -1)])}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('statuspages.moveDown')} disabled={gi === groups.length - 1} onClick={() => onChange([groups[0]!, ...move(groups.slice(1), gi - 1, 1)])}><ArrowDown className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('statuspages.removeSection')} onClick={() => onChange(groups.filter((_, i) => i !== gi))}><Trash2 className="h-4 w-4" /></Button>
              </>
            )}
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {g.items.map((c, ci) => (
              <li key={c.monitorId} className="flex flex-wrap items-center gap-2 p-2">
                <span className="min-w-[8rem] flex-1 truncate text-sm font-medium">{nameOf(c.monitorId)}</span>
                <Input className="min-w-[8rem] flex-1" aria-label={t('statuspages.displayName')} placeholder={t('statuspages.displayName')} value={c.displayName ?? ''} onChange={(e) => patchGroup(gi, (x) => ({ ...x, items: x.items.map((y, i) => (i === ci ? { ...y, displayName: e.target.value } : y)) }))} maxLength={255} />
                <Button size="sm" variant="ghost" aria-label={t('statuspages.moveUp')} disabled={ci === 0} onClick={() => patchGroup(gi, (x) => ({ ...x, items: move(x.items, ci, -1) }))}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('statuspages.moveDown')} disabled={ci === g.items.length - 1} onClick={() => patchGroup(gi, (x) => ({ ...x, items: move(x.items, ci, 1) }))}><ArrowDown className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('common.remove')} onClick={() => patchGroup(gi, (x) => ({ ...x, items: x.items.filter((_, i) => i !== ci) }))}><X className="h-4 w-4" /></Button>
              </li>
            ))}
            <li className="p-2">
              <Select aria-label={t('statuspages.addMonitor')} value="" disabled={!free.length} onChange={(e) => { const m = Number(e.target.value); if (m) patchGroup(gi, (x) => ({ ...x, items: [...x.items, { monitorId: m, displayName: null }] })); }}>
                <option value="">{free.length ? t('statuspages.addMonitor') : t('statuspages.noFreeMonitors')}</option>
                {free.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </li>
          </ul>
        </section>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <Button onClick={() => onChange([...groups, { name: '', items: [] }])}><Plus className="h-4 w-4" />{t('statuspages.addSection')}</Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select className="w-auto" aria-label={t('statuspages.addGroup')} value={pickGroup} onChange={(e) => setPickGroup(e.target.value)}>
            <option value="">{t('statuspages.addGroup')}</option>
            {monGroups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
          <label className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={withSub} onChange={(e) => setWithSub(e.target.checked)} />{t('statuspages.withSub')}</label>
          <Button disabled={!pickGroup} onClick={addWholeGroup}><Plus className="h-4 w-4" />{t('statuspages.addGroupBtn')}</Button>
        </div>
      </div>
    </div>
  );
}

interface Announcement { id: number; kind: 'info' | 'maintenance' | 'incident'; title: string; body: string | null; startsAt: string; endsAt: string | null }
const KIND_TONE = { info: 'blue', maintenance: 'amber', incident: 'red' } as const;

function Announcements({ pageId }: { pageId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['status-page-announcements', pageId];
  const list = useQuery({ queryKey: key, queryFn: () => get<Announcement[]>(`/api/status-pages/${pageId}/announcements`) });
  const [kind, setKind] = useState<Announcement['kind']>('info');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [notify, setNotify] = useState(false);
  const add = useMutation({
    mutationFn: () => post(`/api/status-pages/${pageId}/announcements`, { kind, title: title.trim(), body: body.trim() || undefined, notify }),
    onSuccess: () => { setTitle(''); setBody(''); void qc.invalidateQueries({ queryKey: key }); toast(t('common.saved')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (a: Announcement) => {
    try { await del(`/api/status-pages/${pageId}/announcements/${a.id}`); void qc.invalidateQueries({ queryKey: key }); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <div className="space-y-4">
      <form className="grid gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Field label={t('statuspages.ann.kind')}>{(i) => <Select id={i} value={kind} onChange={(e) => setKind(e.target.value as Announcement['kind'])}>{(['info', 'maintenance', 'incident'] as const).map((k) => <option key={k} value={k}>{t(`statuspages.ann.kind.${k}`)}</option>)}</Select>}</Field>
        <Field label={t('statuspages.ann.title')} className="sm:col-span-2">{(i) => <Input id={i} required maxLength={255} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('statuspages.ann.body')} className="sm:col-span-3">{(i) => <Textarea id={i} rows={3} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-3"><Toggle checked={notify} onChange={setNotify} label={t('statuspages.ann.notify')} /><Button type="submit" variant="primary" loading={add.isPending} disabled={!title.trim()}><Plus className="h-4 w-4" />{t('statuspages.ann.publish')}</Button></div>
      </form>
      {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? <p className="text-sm text-slate-500">{t('statuspages.ann.empty')}</p> : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {list.data.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone={KIND_TONE[a.kind]}>{t(`statuspages.ann.kind.${a.kind}`)}</Badge><span className="font-medium">{a.title}</span></div>{a.body && <p className="mt-1 whitespace-pre-wrap text-sm">{a.body}</p>}<p className="mt-1 text-xs text-slate-500">{fmtDateTime(a.startsAt)}{a.endsAt ? ` – ${fmtDateTime(a.endsAt)}` : ''}</p></div>
              <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => remove(a)}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Sub { id: number; kind: 'email' | 'webhook'; target: string; verified: boolean; createdAt: string }

function Subscribers({ pageId }: { pageId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['status-page-subscribers', pageId];
  const list = useQuery({ queryKey: key, queryFn: () => get<Sub[]>(`/api/status-pages/${pageId}/subscribers`) });
  const [kind, setKind] = useState<Sub['kind']>('email');
  const [target, setTarget] = useState('');
  const add = useMutation({
    mutationFn: () => post(`/api/status-pages/${pageId}/subscribers`, { kind, target: target.trim() }),
    onSuccess: () => { setTarget(''); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (s: Sub) => {
    try { await del(`/api/status-pages/${pageId}/subscribers/${s.id}`); void qc.invalidateQueries({ queryKey: key }); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <div className="space-y-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Field label={t('statuspages.sub.kind')}>{(i) => <Select id={i} value={kind} onChange={(e) => setKind(e.target.value as Sub['kind'])}><option value="email">{t('statuspages.sub.email')}</option><option value="webhook">{t('statuspages.sub.webhook')}</option></Select>}</Field>
        <Field label={t('statuspages.sub.target')} className="min-w-[14rem] flex-1">{(i) => <Input id={i} required type={kind === 'email' ? 'email' : 'url'} value={target} onChange={(e) => setTarget(e.target.value)} placeholder={kind === 'email' ? 'ops@example.com' : 'https://…'} />}</Field>
        <Button type="submit" variant="primary" loading={add.isPending}><Plus className="h-4 w-4" />{t('common.add')}</Button>
      </form>
      {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? <p className="text-sm text-slate-500">{t('statuspages.sub.empty')}</p> : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>{t('statuspages.sub.kind')}</th><th>{t('statuspages.sub.target')}</th><th>{t('common.status')}</th><th>{t('statuspages.sub.since')}</th><th /></tr></thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id}>
                  <td><Badge>{t(`statuspages.sub.${s.kind}`)}</Badge></td><td className="break-all font-mono text-xs">{s.target}</td>
                  <td>{s.verified ? <Badge tone="green">{t('statuspages.sub.verified')}</Badge> : <Badge tone="amber">{t('statuspages.sub.pending')}</Badge>}</td>
                  <td className="whitespace-nowrap text-xs text-slate-500">{fmtDateTime(s.createdAt)}</td>
                  <td className="text-right"><Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => remove(s)}><Trash2 className="h-4 w-4" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
