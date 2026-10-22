import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, EyeOff, Globe, Home, Lock, Megaphone, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, Toggle, useConfirm, useToast } from '../components/ui';
import { del, errorMessage, get, post, put, type Group, type MonitorItem } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { fmtDateTime, slugify } from '../lib/format';
import { useT } from '../lib/i18n';

interface PageRow { id: number; slug: string; title: string; domain: string | null; isPublic: boolean; protected: boolean; isDefault: boolean }
interface Comp { monitorId: number; displayName: string | null; hideIncidents?: boolean }
interface Full {
  id: number; slug: string; title: string; description: string | null; domain: string | null; isPublic: boolean; hasPassword: boolean; ssoRequired: boolean;
  branding: { logoUrl?: string; primaryColor?: string; footer?: string }; customCss: string | null; showHistory: boolean; historyDays: number; isDefault: boolean; incidentDays: number; incidentPageSize: number; blocks: BlockCfg[];
  sections: { name: string; components: Comp[] }[]; components: Comp[];
}
type BlockCfg = { type: 'summary' } | { type: 'streak' } | { type: 'heatmap'; days: 90 | 180 | 365 } | { type: 'text'; title: string; body: string };
const BLOCK_TYPES = ['summary', 'heatmap', 'streak', 'text'] as const;
const MAX_BLOCKS = 12; // keep in sync with src/server/status-blocks.ts
const newBlock = (type: (typeof BLOCK_TYPES)[number]): BlockCfg => (type === 'heatmap' ? { type, days: 365 } : type === 'text' ? { type, title: '', body: '' } : { type });
/** Editor model: group 0 is always the ungrouped list (name === null). */
interface Grp { name: string | null; items: Comp[] }
interface Form {
  slug: string; title: string; description: string; domain: string; isPublic: boolean; ssoRequired: boolean; showHistory: boolean; historyDays: number; isDefault: boolean; incidentDays: number; incidentPageSize: number;
  pwMode: 'keep' | 'set' | 'remove'; password: string; logoUrl: string; primaryColor: string; footer: string; customCss: string; groups: Grp[]; blocks: BlockCfg[];
}
const HISTORY_DAYS = [14, 30, 60, 90, 120, 150, 180];
const INCIDENT_DAYS = [1, 3, 7, 14, 30, 60, 90, 180, 365];
const INCIDENT_PAGE_SIZES = [5, 10, 20, 50];
type Tab = 'general' | 'components' | 'blocks' | 'appearance' | 'announcements' | 'subscribers';

const toForm = (p?: Full): Form => ({
  slug: p?.slug ?? '', title: p?.title ?? '', description: p?.description ?? '', domain: p?.domain ?? '', isPublic: p?.isPublic ?? true, ssoRequired: p?.ssoRequired ?? false, showHistory: p?.showHistory ?? true, historyDays: p?.historyDays ?? 90, incidentDays: p?.incidentDays ?? 30, incidentPageSize: p?.incidentPageSize ?? 10, isDefault: p?.isDefault ?? false,
  pwMode: 'keep', password: '', logoUrl: p?.branding.logoUrl ?? '', primaryColor: p?.branding.primaryColor ?? '', footer: p?.branding.footer ?? '', customCss: p?.customCss ?? '',
  blocks: p?.blocks ?? [],
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
  const [posting, setPosting] = useState<PageRow | null>(null);
  const pages = useQuery({ queryKey: ['status-pages'], queryFn: () => get<PageRow[]>('/api/status-pages') });

  const setDefault = useMutation({
    mutationFn: (p: PageRow) => put(`/api/status-pages/${p.id}/default`, { isDefault: !p.isDefault }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['status-pages'] }); void qc.invalidateQueries({ queryKey: ['default-page'] }); toast(t('common.saved')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (p: PageRow) => {
    if (!(await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: p.title }), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await del(`/api/status-pages/${p.id}`); void qc.invalidateQueries({ queryKey: ['status-pages'] }); void qc.invalidateQueries({ queryKey: ['default-page'] }); toast(t('common.deleted')); } catch (e) { toast(errorMessage(e), 'error'); }
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
                    <td><div className="flex flex-wrap items-center gap-2 font-medium">{p.title}{p.isDefault && <Badge tone="brand"><Home className="h-3 w-3" />{t('statuspages.homePage')}</Badge>}</div><Link to={`/status/${p.slug}`} target="_blank" className="inline-flex items-center gap-1 text-xs">/status/{p.slug}<ExternalLink className="h-3 w-3" aria-hidden /></Link></td>
                    <td className="text-sm text-slate-500">{p.domain ?? '—'}</td>
                    <td>{p.protected ? <Badge tone="amber"><Lock className="h-3 w-3" />{t('statuspages.protected')}</Badge> : p.isPublic ? <Badge tone="green">{t('statuspages.public')}</Badge> : <Badge>{t('statuspages.private')}</Badge>}</td>
                    <td className="text-right">
                      {isAdmin && (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setPosting(p)} aria-label={`${t('statuspages.postUpdate')}: ${p.title}`} title={t('statuspages.postUpdate')}><Megaphone className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" loading={setDefault.isPending && setDefault.variables?.id === p.id} onClick={() => setDefault.mutate(p)} aria-pressed={p.isDefault} aria-label={`${p.isDefault ? t('statuspages.unsetHome') : t('statuspages.setHome')}: ${p.title}`} title={p.isDefault ? t('statuspages.unsetHome') : t('statuspages.setHome')}><Home className={p.isDefault ? 'h-4 w-4 text-brand-600' : 'h-4 w-4'} /></Button>
                          <Button size="sm" onClick={() => setEditing(p.id)} aria-label={`${t('common.edit')}: ${p.title}`}><Pencil className="h-4 w-4" />{t('common.edit')}</Button>
                          <Button size="sm" variant="ghost" onClick={() => remove(p)} aria-label={`${t('common.delete')}: ${p.title}`}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {posting && <Modal open onClose={() => setPosting(null)} title={`${t('statuspages.postUpdate')}: ${posting.title}`}><AnnouncementForm pageId={posting.id} onDone={() => setPosting(null)} /></Modal>}
      {editing !== null && <Editor id={editing} onClose={() => setEditing(null)} onSaved={() => { void qc.invalidateQueries({ queryKey: ['status-pages'] }); void qc.invalidateQueries({ queryKey: ['default-page'] }); }} />}
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
  // a new page follows its title until the slug is typed by hand (emptying the field hands control back); an existing slug is a public URL and stays put
  const [slugOwn, setSlugOwn] = useState(id !== 'new');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors') });

  const save = useMutation({
    mutationFn: () => {
      const comp = (c: Comp) => ({ monitorId: c.monitorId, displayName: c.displayName?.trim() || null, hideIncidents: !!c.hideIncidents });
      const body = {
        slug: f.slug.trim().toLowerCase(), title: f.title.trim(), description: f.description.trim() || null, domain: f.domain.trim().toLowerCase() || null, isPublic: f.isPublic, ssoRequired: f.ssoRequired, showHistory: f.showHistory, historyDays: f.historyDays, incidentDays: f.incidentDays, incidentPageSize: f.incidentPageSize,
        // only send the home-page flag when this form changed it, so a stale form cannot take the home page back from another page
        ...(f.isDefault !== initial.isDefault ? { isDefault: f.isDefault } : {}),
        ...(f.pwMode === 'set' ? { password: f.password } : f.pwMode === 'remove' ? { password: null } : {}),
        branding: { ...(f.logoUrl.trim() && { logoUrl: f.logoUrl.trim() }), ...(f.primaryColor && { primaryColor: f.primaryColor }), ...(f.footer.trim() && { footer: f.footer.trim() }) },
        customCss: f.customCss.trim() || null,
        blocks: f.blocks,
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

  const smtp = useMeta()?.smtp;
  const tabs: { id: Tab; label: ReactNode }[] = [
    { id: 'general', label: t('statuspages.tab.general') }, { id: 'components', label: t('statuspages.tab.components') }, { id: 'blocks', label: t('statuspages.tab.blocks') }, { id: 'appearance', label: t('statuspages.tab.appearance') },
    ...(id === 'new' ? [] : [{ id: 'announcements' as const, label: t('statuspages.tab.announcements') }, ...(smtp ? [{ id: 'subscribers' as const, label: t('statuspages.tab.subscribers') }] : [])]),
  ];

  return (
    <Modal open wide onClose={onClose} title={title} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} onClick={submit}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <div className="overflow-x-auto"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
        {err && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{err}</div>}
        {tab === 'general' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('statuspages.f.title')}>{(i) => <Input id={i} value={f.title} onChange={(e) => setF((p) => ({ ...p, title: e.target.value, ...(slugOwn ? {} : { slug: slugify(e.target.value) }) }))} maxLength={255} />}</Field>
            <Field label={t('statuspages.f.slug')} hint={t('statuspages.f.slugHint')}>{(i) => <Input id={i} value={f.slug} onChange={(e) => { setSlugOwn(e.target.value !== ''); set('slug', e.target.value); }} maxLength={63} placeholder="status" />}</Field>
            <Field label={t('statuspages.f.description')} className="sm:col-span-2">{(i) => <Textarea id={i} rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={5000} />}</Field>
            <Field label={t('statuspages.f.domain')} hint={t('statuspages.f.domainHint')} className="sm:col-span-2">{(i) => <Input id={i} value={f.domain} onChange={(e) => set('domain', e.target.value)} placeholder="status.example.com" />}</Field>
            <div className="flex flex-col items-start gap-3 sm:col-span-2">
              <Toggle checked={f.isPublic} onChange={(v) => set('isPublic', v)} label={t('statuspages.f.isPublic')} />
              <div><Toggle checked={f.isDefault} onChange={(v) => set('isDefault', v)} label={t('statuspages.f.default')} /><p className="hint">{t('statuspages.f.defaultHint')}</p></div>
              <Toggle checked={f.ssoRequired} onChange={(v) => set('ssoRequired', v)} label={t('statuspages.f.sso')} />
              <Toggle checked={f.showHistory} onChange={(v) => set('showHistory', v)} label={t('statuspages.f.history')} />
              {f.showHistory && (
                <Field label={t('statuspages.f.historyDays')} className="max-w-xs">
                  {(i) => <Select id={i} value={f.historyDays} onChange={(e) => set('historyDays', Number(e.target.value))}>{HISTORY_DAYS.map((d) => <option key={d} value={d}>{t('statuspages.f.historyDaysOpt', { n: d })}</option>)}</Select>}
                </Field>
              )}
              <Toggle checked={f.incidentDays > 0} onChange={(v) => set('incidentDays', v ? 30 : 0)} label={t('statuspages.f.pastIncidents')} />
              {f.incidentDays > 0 && (
                <div className="flex flex-wrap gap-3">
                  <Field label={t('statuspages.f.incidentDays')}>
                    {(i) => <Select id={i} value={f.incidentDays} onChange={(e) => set('incidentDays', Number(e.target.value))}>{INCIDENT_DAYS.map((d) => <option key={d} value={d}>{d === 1 ? t('statuspages.f.dayOne') : t('statuspages.f.historyDaysOpt', { n: d })}</option>)}</Select>}
                  </Field>
                  <Field label={t('statuspages.f.incidentPageSize')}>
                    {(i) => <Select id={i} value={f.incidentPageSize} onChange={(e) => set('incidentPageSize', Number(e.target.value))}>{INCIDENT_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</Select>}
                  </Field>
                </div>
              )}
              <p className="hint">{t('statuspages.f.incidentHint')}</p>
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
        {tab === 'blocks' && <Blocks blocks={f.blocks} onChange={(b) => set('blocks', b)} />}
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
        {tab === 'subscribers' && smtp && id !== 'new' && <Subscribers pageId={id} />}
      </div>
    </Modal>
  );
}

function Components({ groups, onChange, monitors, loading, error }: { groups: Grp[]; onChange: (g: Grp[]) => void; monitors?: MonitorItem[]; loading: boolean; error: unknown }) {
  const t = useT();
  const monGroups = useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups') });
  const [withSub, setWithSub] = useState(true);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const all = monitors ?? [];
  const used = new Set(groups.flatMap((g) => g.items.map((c) => c.monitorId)));
  const free = all.filter((m) => !used.has(m.id));
  const nameOf = (id: number) => all.find((m) => m.id === id)?.name ?? `#${id}`;
  // Adds one section per monitor group (optionally with its subgroups), skipping monitors already on the page.
  const addWholeGroup = (root: number) => {
    const list = monGroups.data ?? [];
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
  };
  // Number of monitors a chip would still add (own + optional subgroups), so empty/used groups can be disabled.
  const freeIn = (root: number) => {
    const ids = [root];
    if (withSub) for (let i = 0; i < ids.length; i++) for (const g of monGroups.data ?? []) if (g.parentId === ids[i] && !ids.includes(g.id)) ids.push(g.id);
    return free.filter((m) => m.groupId != null && ids.includes(m.groupId)).length;
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
                <Button size="sm" variant={c.hideIncidents ? 'primary' : 'ghost'} title={`${t('statuspages.hideIncidents')}: ${t('statuspages.hideIncidentsHint')}`} aria-label={t('statuspages.hideIncidents')} aria-pressed={!!c.hideIncidents} onClick={() => patchGroup(gi, (x) => ({ ...x, items: x.items.map((y, i) => (i === ci ? { ...y, hideIncidents: !y.hideIncidents } : y)) }))}><EyeOff className="h-4 w-4" /></Button>
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
      <div className="space-y-2 rounded-lg border border-dashed border-slate-300 p-3 dark:border-slate-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{t('statuspages.addGroup')}</span>
          <label className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={withSub} onChange={(e) => setWithSub(e.target.checked)} />{t('statuspages.withSub')}</label>
        </div>
        {monGroups.data?.length ? (
          <div className="flex flex-wrap gap-2">
            {monGroups.data.map((g) => {
              const n = freeIn(g.id);
              return <button key={g.id} type="button" disabled={!n} onClick={() => addWholeGroup(g.id)} title={n ? undefined : t('statuspages.groupNothingToAdd')} className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"><Plus className="h-3.5 w-3.5" />{g.name}<span className="text-xs text-slate-500">{n}</span></button>;
            })}
          </div>
        ) : <p className="text-sm text-slate-500">{t('statuspages.noGroups')}</p>}
        <Button onClick={() => onChange([...groups, { name: '', items: [] }])}><Plus className="h-4 w-4" />{t('statuspages.addSection')}</Button>
      </div>
    </div>
  );
}

interface Announcement { id: number; kind: 'info' | 'maintenance' | 'incident'; title: string; body: string | null; startsAt: string; endsAt: string | null }
const KIND_TONE = { info: 'blue', maintenance: 'amber', incident: 'red' } as const;

const KINDS = ['info', 'maintenance', 'incident'] as const;
const KIND_STYLE = { info: 'border-sky-400 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200', maintenance: 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200', incident: 'border-red-400 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200' } as const;

/** Compose and publish one announcement; used inline in the editor and as the quick "Post update" dialog. */
function AnnouncementForm({ pageId, onDone }: { pageId: number; onDone?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const smtp = useMeta()?.smtp;
  const [kind, setKind] = useState<Announcement['kind']>('info');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [notify, setNotify] = useState(false);
  const add = useMutation({
    mutationFn: () => post(`/api/status-pages/${pageId}/announcements`, {
      kind, title: title.trim(), body: body.trim() || undefined, notify: smtp ? notify : false,
      ...(kind === 'maintenance' && from ? { startsAt: new Date(from).toISOString() } : {}), ...(kind === 'maintenance' && until ? { endsAt: new Date(until).toISOString() } : {}),
    }),
    onSuccess: () => { setTitle(''); setBody(''); setFrom(''); setUntil(''); void qc.invalidateQueries({ queryKey: ['status-page-announcements', pageId] }); toast(t('statuspages.ann.published')); onDone?.(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
      <div role="radiogroup" aria-label={t('statuspages.ann.kind')} className="grid grid-cols-3 gap-2">
        {KINDS.map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`rounded-lg border-2 px-3 py-2 text-sm font-medium ${kind === k ? KIND_STYLE[k] : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'}`}>{t(`statuspages.ann.kind.${k}`)}</button>)}
      </div>
      <Field label={t('statuspages.ann.title')}>{(i) => <Input id={i} required maxLength={255} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <Field label={t('statuspages.ann.body')}>{(i) => <Textarea id={i} rows={3} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
      {kind === 'maintenance' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('statuspages.ann.from')}>{(i) => <Input id={i} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label={t('statuspages.ann.until')}>{(i) => <Input id={i} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />}</Field>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {smtp ? <Toggle checked={notify} onChange={setNotify} label={t('statuspages.ann.notify')} /> : <span />}
        <Button type="submit" variant="primary" loading={add.isPending} disabled={!title.trim()}>{t('statuspages.ann.publish')}</Button>
      </div>
    </form>
  );
}

function Announcements({ pageId }: { pageId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['status-page-announcements', pageId];
  const list = useQuery({ queryKey: key, queryFn: () => get<Announcement[]>(`/api/status-pages/${pageId}/announcements`) });
  const remove = async (a: Announcement) => {
    try { await del(`/api/status-pages/${pageId}/announcements/${a.id}`); void qc.invalidateQueries({ queryKey: key }); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"><AnnouncementForm pageId={pageId} /></div>
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

function Blocks({ blocks, onChange }: { blocks: BlockCfg[]; onChange: (b: BlockCfg[]) => void }) {
  const t = useT();
  const patch = (i: number, b: BlockCfg) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('blocks.intro')}</p>
      {blocks.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500 dark:border-slate-700">{t('blocks.empty')}</p>}
      <ul className="space-y-2">
        {blocks.map((b, i) => (
          <li key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0"><div className="font-medium">{t(`blocks.type.${b.type}`)}</div><div className="text-xs text-slate-500">{t(`blocks.desc.${b.type}`)}</div></div>
              <div className="flex shrink-0">
                <Button size="sm" variant="ghost" aria-label={t('statuspages.moveUp')} disabled={i === 0} onClick={() => onChange(move(blocks, i, -1))}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('statuspages.moveDown')} disabled={i === blocks.length - 1} onClick={() => onChange(move(blocks, i, 1))}><ArrowDown className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => onChange(blocks.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
            {b.type === 'heatmap' && <Field label={t('blocks.range')} className="mt-2 max-w-[12rem]">{(id) => <Select id={id} value={b.days} onChange={(e) => patch(i, { type: 'heatmap', days: Number(e.target.value) as 90 | 180 | 365 })}>{[90, 180, 365].map((d) => <option key={d} value={d}>{t('insights.days', { n: d })}</option>)}</Select>}</Field>}
            {b.type === 'text' && (
              <div className="mt-2 grid gap-2">
                <Field label={t('blocks.textTitle')}>{(id) => <Input id={id} value={b.title} maxLength={120} onChange={(e) => patch(i, { ...b, title: e.target.value })} />}</Field>
                <Field label={t('blocks.textBody')}>{(id) => <Textarea id={id} rows={3} maxLength={2000} value={b.body} onChange={(e) => patch(i, { ...b, body: e.target.value })} />}</Field>
              </div>
            )}
          </li>
        ))}
      </ul>
      {blocks.length >= MAX_BLOCKS ? <p className="text-xs text-slate-500">{t('blocks.max', { n: MAX_BLOCKS })}</p> : (
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-slate-500">{t('blocks.add')}:</span>{BLOCK_TYPES.map((k) => <Button key={k} size="sm" onClick={() => onChange([...blocks, newBlock(k)])}><Plus className="h-4 w-4" />{t(`blocks.type.${k}`)}</Button>)}</div>
      )}
    </div>
  );
}
