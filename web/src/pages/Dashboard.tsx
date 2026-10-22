import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, CheckSquare, ChevronDown, ChevronRight, Clock, LayoutGrid, List, Pause, Play, Plus, Rocket, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Skeleton, cx, useConfirm, useToast } from '../components/ui';
import { displayStatus, HeartbeatBar, Sparkline, StatusBadge, StatusDot, uptimeTone, type DisplayStatus } from '../components/status';
import { PlayersLine } from '../components/ServerInfo';
import { ApiError, del, errorMessage, get, post, type Group, type MonitorItem, type Tag } from '../lib/api';
import { BulkEditModal } from '../components/BulkEdit';
import { tagText } from '../components/TagEditor';
import { useAuth } from '../lib/auth';
import { fmtMs, fmtPct, relTime } from '../lib/format';
import { useT } from '../lib/i18n';

interface Filters { q: string; status: '' | DisplayStatus; tag: string; group: string }
interface View { id: number; name: string; filters: Partial<Filters> & { tag?: string }; shared: boolean; own: boolean }
interface TimelineItem { id: number; ts: string; type: string; from: string | null; to: string | null; errorKind: string | null; message: string | null; monitorId: number; monitorName: string }

const EMPTY: Filters = { q: '', status: '', tag: '', group: '' };
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export default function Dashboard() {
  const t = useT();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [mode, setMode] = useState<'grid' | 'list'>(() => (lsGet('pw.dash.view', 'grid') === 'list' ? 'list' : 'grid'));
  const [f, setF] = useState<Filters>(EMPTY);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulkEdit, setBulkEdit] = useState(false);
  const [saveView, setSaveView] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const search = useRef<HTMLInputElement>(null);

  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors') });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups') });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => get<Tag[]>('/api/tags') });
  const views = useQuery({ queryKey: ['views'], queryFn: () => get<View[]>('/api/views') });

  useEffect(() => { const h = () => search.current?.focus(); window.addEventListener('pw:focus-search', h); return () => window.removeEventListener('pw:focus-search', h); }, []);
  const setView = (m: 'grid' | 'list') => { setMode(m); lsSet('pw.dash.view', m); };

  const list = monitors.data ?? [];
  const groupList = groups.data ?? [];

  /** Group id plus all descendants. */
  const descendants = useMemo(() => {
    const out = new Map<number, Set<number>>();
    for (const g of groupList) {
      const s = new Set([g.id]);
      for (let grew = true; grew;) { grew = false; for (const x of groupList) if (x.parentId && s.has(x.parentId) && !s.has(x.id)) { s.add(x.id); grew = true; } }
      out.set(g.id, s);
    }
    return out;
  }, [groupList]);

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const gset = f.group ? descendants.get(Number(f.group)) : null;
    return list.filter((m) => {
      if (f.status && displayStatus(m) !== f.status) return false;
      if (f.tag && !m.tags.some((x) => String(x.id) === f.tag || x.name === f.tag)) return false;
      if (gset && (m.groupId == null || !gset.has(m.groupId))) return false;
      return !q || `${m.name} ${m.type} ${m.description ?? ''} ${m.tags.map(tagText).join(' ')}`.toLowerCase().includes(q);
    });
  }, [list, f, descendants]);

  const counts = useMemo(() => {
    const c: Record<DisplayStatus, number> = { up: 0, down: 0, pending: 0, unknown: 0, maintenance: 0, suppressed: 0, paused: 0 };
    for (const m of list) c[displayStatus(m)]++;
    return c;
  }, [list]);

  /** Ordered group sections (tree order) holding their direct monitors; ungrouped monitors come first. */
  const sections = useMemo(() => {
    const byGroup = new Map<number | null, MonitorItem[]>();
    for (const m of filtered) { const k = m.groupId != null && groupList.some((g) => g.id === m.groupId) ? m.groupId : null; byGroup.set(k, [...(byGroup.get(k) ?? []), m]); }
    const out: { group: Group | null; depth: number; items: MonitorItem[]; total: number }[] = [];
    if (byGroup.get(null)?.length) out.push({ group: null, depth: 0, items: byGroup.get(null)!, total: byGroup.get(null)!.length });
    const walk = (parent: number | null, depth: number) => {
      for (const g of groupList.filter((x) => x.parentId === parent)) {
        const total = [...(descendants.get(g.id) ?? [])].reduce((a, id) => a + (byGroup.get(id)?.length ?? 0), 0);
        if (total) out.push({ group: g, depth, items: byGroup.get(g.id) ?? [], total });
        walk(g.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [filtered, groupList, descendants]);

  const hidden = useMemo(() => { // groups collapsed along the path
    const s = new Set<number>();
    for (const id of collapsed) for (const d of descendants.get(id) ?? []) if (d !== id) s.add(d);
    return s;
  }, [collapsed, descendants]);

  const bulk = useMutation({
    mutationFn: (b: { action: string; patch?: object }) => post('/api/monitors/bulk', { ids: [...sel], ...b }),
    onSuccess: (r: { affected: number }) => { toast(t('dashboard.bulkDone', { n: r.affected })); setSel(new Set()); void qc.invalidateQueries({ queryKey: ['monitors'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  /** Optimistic single-monitor pause/resume from the card; rolls back on error. */
  const quick = useMutation({
    mutationFn: ({ id, pause }: { id: number; pause: boolean }) => post(`/api/monitors/${id}/${pause ? 'pause' : 'resume'}`),
    onMutate: async ({ id, pause }) => {
      await qc.cancelQueries({ queryKey: ['monitors'] });
      const prev = qc.getQueryData<MonitorItem[]>(['monitors']);
      qc.setQueryData<MonitorItem[]>(['monitors'], (old) => old?.map((m) => (m.id === id ? { ...m, active: !pause } : m)));
      return { prev };
    },
    onError: (e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['monitors'], ctx.prev); toast(errorMessage(e), 'error'); },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['monitors'] }),
  });
  const delView = useMutation({ mutationFn: (id: number) => del(`/api/views/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['views'] }) });

  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const filtersActive = f.q || f.status || f.tag || f.group;
  const editor = can('editor');

  if (monitors.isLoading) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-32" />)}</div>;
  if (monitors.error) return <ErrorBox error={monitors.error} />;
  if (!list.length) return (<><PageHeader title={t('nav.dashboard')} /><Onboarding editor={editor} /></>);

  const status = (s: DisplayStatus, key: string, tone: string) => (
    <button type="button" key={s} onClick={() => setF({ ...f, status: f.status === s ? '' : s })} aria-pressed={f.status === s}
      className={cx('card flex min-w-[7rem] flex-1 items-center gap-3 px-4 py-3 text-left transition hover:border-brand-400', f.status === s && 'border-brand-500 ring-1 ring-brand-500')}>
      <StatusDot status={s} pulse={counts[s] > 0} /><div><div className={cx('text-2xl font-semibold leading-none', tone)}>{counts[key as DisplayStatus]}</div><div className="mt-1 text-xs text-slate-500">{t(`status.${s}`)}</div></div>
    </button>
  );

  return (
    <>
      <PageHeader title={t('nav.dashboard')} subtitle={t('dashboard.subtitle', { n: list.length })}
        actions={editor ? <><Button size="sm" variant={selecting ? 'primary' : 'default'} onClick={() => { setSelecting(!selecting); setSel(new Set()); }}><CheckSquare className="h-4 w-4" />{t('dashboard.select')}</Button><Link to="/monitors/new" className="btn btn-primary btn-sm no-underline"><Plus className="h-4 w-4" />{t('palette.newMonitor')}</Link></> : undefined} />
      {!editor && <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t('dashboard.readOnly')}</p>}

      <div className="mb-4 flex flex-wrap gap-3">
        {status('up', 'up', 'text-emerald-600')}{status('down', 'down', counts.down ? 'text-red-600' : '')}{status('maintenance', 'maintenance', 'text-sky-600')}{status('paused', 'paused', 'text-slate-500')}
        {counts.suppressed + counts.pending + counts.unknown > 0 && <div className="card flex min-w-[7rem] flex-1 items-center gap-3 px-4 py-3"><StatusDot status="pending" /><div><div className="text-2xl font-semibold leading-none">{counts.suppressed + counts.pending + counts.unknown}</div><div className="mt-1 text-xs text-slate-500">{t('dashboard.other')}</div></div></div>}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="search">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
          <input ref={search} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder={t('dashboard.search')} aria-label={t('dashboard.search')} className="input pl-9" />
        </div>
        <Select aria-label={t('common.status')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Filters['status'] })} className="w-auto">
          <option value="">{t('dashboard.anyStatus')}</option>{(['up', 'down', 'pending', 'maintenance', 'suppressed', 'paused', 'unknown'] as const).map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </Select>
        {!!tags.data?.length && <Select aria-label={t('dashboard.tag')} value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} className="w-auto"><option value="">{t('dashboard.anyTag')}</option>{tags.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        {groupList.length > 0 && <Select aria-label={t('dashboard.group')} value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} className="w-auto"><option value="">{t('dashboard.anyGroup')}</option>{groupList.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}
        {!!views.data?.length && (
          <Select aria-label={t('dashboard.savedViews')} value="" onChange={(e) => { const v = views.data!.find((x) => String(x.id) === e.target.value); if (v) setF({ ...EMPTY, ...v.filters, tag: tagToId(v.filters.tag, tags.data) }); }} className="w-auto">
            <option value="">{t('dashboard.savedViews')}</option>{views.data.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
        )}
        {filtersActive ? <><Button size="sm" onClick={() => setSaveView(true)}><Bookmark className="h-4 w-4" />{t('dashboard.saveView')}</Button><Button size="sm" variant="ghost" onClick={() => setF(EMPTY)}><X className="h-4 w-4" />{t('common.reset')}</Button></> : null}
        <div className="ml-auto flex overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700" role="group" aria-label={t('dashboard.layout')}>
          {(['grid', 'list'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} aria-label={t(`dashboard.${m}`)} title={t(`dashboard.${m}`)} onClick={() => setView(m)} className={cx('px-2.5 py-2', mode === m ? 'bg-brand-600 text-white' : 'bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800')}>{m === 'grid' ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}</button>)}
        </div>
      </div>
      {views.data?.some((v) => v.own) && <div className="mb-3 flex flex-wrap gap-2 text-xs text-slate-500">{views.data.filter((v) => v.own).map((v) => <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 dark:bg-slate-800"><button type="button" onClick={() => setF({ ...EMPTY, ...v.filters, tag: tagToId(v.filters.tag, tags.data) })} className="hover:underline">{v.name}</button><button type="button" aria-label={t('common.delete')} onClick={() => delView.mutate(v.id)}><X className="h-3 w-3" /></button></span>)}</div>}

      {(sel.size > 0 || selecting) && (
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-300 bg-brand-50 px-3 py-2 text-sm dark:border-brand-700 dark:bg-brand-700/20" role="toolbar" aria-label={t('dashboard.bulk')}>
          <span className="font-medium">{t('dashboard.selected', { n: sel.size })}</span>
          {sel.size < filtered.length && <Button size="sm" variant="ghost" onClick={() => setSel(new Set(filtered.map((m) => m.id)))}>{t('dashboard.selectAll', { n: filtered.length })}</Button>}
          <Button size="sm" onClick={() => bulk.mutate({ action: 'pause' })}><Pause className="h-4 w-4" />{t('monitors.pause')}</Button>
          <Button size="sm" onClick={() => bulk.mutate({ action: 'resume' })}><Play className="h-4 w-4" />{t('monitors.resume')}</Button>
          <Button size="sm" onClick={() => setBulkEdit(true)}>{t('dashboard.editSettings')}</Button>
          <Button size="sm" variant="danger" onClick={async () => { if (await confirm({ title: t('dashboard.bulkDeleteTitle', { n: sel.size }), body: t('dashboard.bulkDeleteBody'), danger: true, confirmLabel: t('common.delete') })) bulk.mutate({ action: 'delete' }); }}><Trash2 className="h-4 w-4" />{t('common.delete')}</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSel(new Set())}>{t('dashboard.clearSelection')}</Button>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-5">
          {filtered.length === 0 && <Card><EmptyState title={t('common.noResults')} body={t('dashboard.noMatch')} action={<Button onClick={() => setF(EMPTY)}>{t('common.reset')}</Button>} /></Card>}
          {sections.map((s) => {
            if (s.group && hidden.has(s.group.id)) return null;
            const isCollapsed = !!s.group && collapsed.has(s.group.id);
            return (
              <section key={s.group?.id ?? 'none'} style={{ marginLeft: s.depth * 12 }}>
                {s.group && (
                  <button type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(s.group!.id)) n.delete(s.group!.id); else n.add(s.group!.id); return n; })} className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-600 dark:text-slate-300">
                    {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}{s.group.name}<Badge>{s.total}</Badge>
                  </button>
                )}
                {!isCollapsed && s.items.length > 0 && (mode === 'grid'
                  ? <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{s.items.map((m) => <MonitorCard key={m.id} m={m} selecting={selecting} selected={sel.has(m.id)} onToggle={() => toggle(m.id)} onQuick={editor ? (pause) => quick.mutate({ id: m.id, pause }) : undefined} />)}</div>
                  : <Card className="divide-y divide-slate-100 dark:divide-slate-800">{s.items.map((m) => <MonitorRow key={m.id} m={m} selecting={selecting} selected={sel.has(m.id)} onToggle={() => toggle(m.id)} onQuick={editor ? (pause) => quick.mutate({ id: m.id, pause }) : undefined} />)}</Card>)}
              </section>
            );
          })}
        </div>
        <Timeline />
      </div>

      <SaveViewModal open={saveView} onClose={() => setSaveView(false)} filters={f} tags={tags.data} canShare={editor} />
      <BulkEditModal key={bulkEdit ? 'open' : 'closed'} open={bulkEdit} onClose={() => setBulkEdit(false)} count={sel.size} groups={groupList} tags={tags.data ?? []} onSubmit={(patch) => { bulk.mutate({ action: 'patch', patch }); setBulkEdit(false); }} />
    </>
  );
}

/** Saved views store the tag by name so they survive tag re-creation; the filter state uses ids. */
const tagToId = (tag: string | undefined, tags?: Tag[]) => (tag ? String(tags?.find((x) => x.name === tag || String(x.id) === tag)?.id ?? tag) : '');

function Uptimes({ m }: { m: MonitorItem }) {
  const t = useT();
  return (
    <dl className="grid grid-cols-4 gap-2 text-center text-xs">
      {([['24h', m.uptime.h24], ['7d', m.uptime.d7], ['30d', m.uptime.d30], ['90d', m.uptime.d90]] as const).map(([k, v]) => (
        <div key={k}><dt className="text-slate-400">{k}</dt><dd className={cx('font-semibold', uptimeTone(v))} aria-label={`${t('monitors.uptime')} ${k}`}>{fmtPct(v, 2)}</dd></div>
      ))}
    </dl>
  );
}

interface RowProps { m: MonitorItem; selecting: boolean; selected: boolean; onToggle: () => void; onQuick?: (pause: boolean) => void }

/** Pause/resume icon button; sits above the stretched card link. */
function QuickToggle({ m, onQuick }: { m: MonitorItem; onQuick?: (pause: boolean) => void }) {
  const t = useT();
  if (!onQuick) return null;
  const label = m.active ? t('monitors.pause') : t('monitors.resume');
  return <button type="button" title={label} aria-label={`${label}: ${m.name}`} onClick={() => onQuick(m.active)} className="relative z-10 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100">{m.active ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>;
}

/** Name link whose ::after covers the whole (relative) card; while selecting, a click toggles the selection instead of navigating. */
function CardLink({ m, selecting, onToggle, className }: Pick<RowProps, 'm' | 'selecting' | 'onToggle'> & { className: string }) {
  return <Link to={`/monitors/${m.id}`} onClick={(e) => { if (selecting) { e.preventDefault(); onToggle(); } }} className={cx(className, 'after:absolute after:inset-0')}>{m.name}</Link>;
}

function Check({ m, selected, onToggle }: Pick<RowProps, 'm' | 'selected' | 'onToggle'>) {
  return <input type="checkbox" checked={selected} onChange={onToggle} aria-label={m.name} className="relative z-10 h-4 w-4 rounded border-slate-300 text-brand-600" />;
}

function MonitorCard({ m, selecting, selected, onToggle, onQuick }: RowProps) {
  const t = useT();
  const s = displayStatus(m);
  return (
    <Card className={cx('relative cursor-pointer p-4 transition hover:border-brand-400', selected && 'border-brand-500 ring-1 ring-brand-500', s === 'down' && 'border-red-300 dark:border-red-900')}>
      <div className="flex items-start gap-2">
        {selecting && <Check m={m} selected={selected} onToggle={onToggle} />}
        <div className="min-w-0 flex-1">
          <CardLink m={m} selecting={selecting} onToggle={onToggle} className="block truncate font-medium text-slate-900 no-underline hover:underline dark:text-slate-100" />
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-slate-500"><span className="font-mono">{m.type}</span>{m.flapping && <Badge tone="amber">{t('monitors.flapping')}</Badge>}{m.anomaly && <Badge tone="violet">{t('monitors.slowdown')}</Badge>}{m.tags.map((x) => <span key={`${x.id}:${x.value}`} className="rounded px-1.5 py-0.5 text-[11px] text-white" style={{ background: x.color }}>{tagText(x)}</span>)}</div>
        </div>
        <StatusBadge status={s} /><QuickToggle m={m} onQuick={onQuick} />
      </div>
      <div className="mt-3 flex items-center gap-3"><HeartbeatBar beats={m.recent} count={32} className="flex-1" /><Sparkline beats={m.recent} width={72} /></div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500"><span className="inline-flex items-center gap-3">{fmtMs(m.latencyMs)}{m.info && <PlayersLine info={m.info} short />}</span><span title={m.message ?? ''}>{m.lastCheckAt ? relTime(m.lastCheckAt) : t('monitors.noChecks')}</span></div>
      {s === 'down' && m.message && <p className="mt-2 truncate text-xs text-red-600 dark:text-red-400" title={m.message}>{m.errorKind ? `${m.errorKind}: ` : ''}{m.message}</p>}
      <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800"><Uptimes m={m} /></div>
    </Card>
  );
}

function MonitorRow({ m, selecting, selected, onToggle, onQuick }: RowProps) {
  const s = displayStatus(m);
  return (
    <div className={cx('relative flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 sm:flex-nowrap', selected && 'bg-brand-50 dark:bg-brand-700/10')}>
      {selecting && <Check m={m} selected={selected} onToggle={onToggle} />}
      <StatusDot status={s} pulse />
      <CardLink m={m} selecting={selecting} onToggle={onToggle} className="min-w-0 flex-1 truncate font-medium text-slate-900 no-underline hover:underline dark:text-slate-100 sm:w-48 sm:flex-none" />
      <HeartbeatBar beats={m.recent} count={30} className="hidden flex-1 md:flex" height="h-5" />
      {m.info?.players !== undefined && <PlayersLine info={m.info} short className="text-xs text-slate-500" />}
      <span className="w-16 text-right text-xs text-slate-500">{fmtMs(m.latencyMs)}</span>
      <div className="hidden w-52 shrink-0 sm:block"><Uptimes m={m} /></div>
      <QuickToggle m={m} onQuick={onQuick} />
    </div>
  );
}

function Timeline() {
  const t = useT();
  const q = useInfiniteQuery({
    queryKey: ['timeline'], initialPageParam: 0,
    queryFn: ({ pageParam }) => get<TimelineItem[]>(`/api/timeline?limit=20${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.length >= 20 ? last[last.length - 1].id : undefined),
  });
  const items = q.data?.pages.flat() ?? [];
  const label = (e: TimelineItem) => e.type === 'status_change' ? t(`monitors.event.${e.to === 'down' ? 'down' : e.to === 'up' ? 'up' : 'change'}`) : t(`monitors.event.${e.type}`);
  const dot = (e: TimelineItem): DisplayStatus => (e.type === 'status_change' ? (e.to === 'down' ? 'down' : e.to === 'up' ? 'up' : 'pending') : e.type.startsWith('maintenance') ? 'maintenance' : 'pending');
  return (
    <Card className="h-fit">
      <CardHeader title={<span className="flex items-center gap-2"><Clock className="h-4 w-4" />{t('dashboard.timeline')}</span>} />
      {q.isLoading ? <Loading /> : items.length === 0 ? <p className="p-4 text-sm text-slate-500">{t('dashboard.timelineEmpty')}</p> : (
        <ol className="max-h-[32rem] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
          {items.map((e) => (
            <li key={e.id} className="flex gap-2.5 px-4 py-2.5 text-sm">
              <StatusDot status={dot(e)} className="mt-1.5" />
              <div className="min-w-0"><Link to={`/monitors/${e.monitorId}`} className="block truncate font-medium text-slate-900 no-underline hover:underline dark:text-slate-100">{e.monitorName}</Link>
                <div className="text-xs text-slate-500">{label(e)} · {relTime(e.ts)}</div>{e.message && e.to === 'down' && <div className="truncate text-xs text-slate-400" title={e.message}>{e.message}</div>}</div>
            </li>
          ))}
        </ol>
      )}
      {q.hasNextPage && <div className="border-t border-slate-100 p-2 text-center dark:border-slate-800"><Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('common.more')}</Button></div>}
    </Card>
  );
}

function SaveViewModal({ open, onClose, filters, tags, canShare }: { open: boolean; onClose: () => void; filters: Filters; tags?: Tag[]; canShare: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const m = useMutation({
    mutationFn: () => post('/api/views', { name, shared, filters: { ...filters, tag: tags?.find((x) => String(x.id) === filters.tag)?.name ?? filters.tag } }),
    onSuccess: () => { toast(t('common.saved')); setName(''); void qc.invalidateQueries({ queryKey: ['views'] }); onClose(); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} title={t('dashboard.saveView')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={m.isPending} disabled={!name.trim()} onClick={() => m.mutate()}>{t('common.save')}</Button></>}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) m.mutate(); }} className="space-y-3">
        <Field label={t('common.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />}</Field>
        {canShare && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />{t('dashboard.shareView')}</label>}
      </form>
    </Modal>
  );
}

/** First-monitor wizard shown when nothing is configured yet. */
function Onboarding({ editor }: { editor: boolean }) {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [type, setType] = useState<'http' | 'tcp' | 'ping' | 'dns'>('http');
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('443');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const create = useMutation({
    mutationFn: () => {
      const host = target.trim();
      const config = type === 'http' ? { url: /^https?:\/\//i.test(host) ? host : `https://${host}` } : type === 'tcp' ? { host, port: Number(port) } : { host };
      return post<{ id: number }>('/api/monitors', { name: name.trim() || host.replace(/^https?:\/\//i, ''), type, config, intervalS: 60 });
    },
    onSuccess: (m) => { void qc.invalidateQueries({ queryKey: ['monitors'] }); nav(`/monitors/${m.id}`); },
    onError: (e) => setError(e instanceof ApiError && e.body?.errors ? new Error(e.body.errors.join('; ')) : e),
  });
  if (!editor) return <Card><EmptyState title={t('dashboard.emptyViewer')} body={t('dashboard.emptyViewerBody')} /></Card>;
  const types = [['http', t('dashboard.onb.http')], ['tcp', t('dashboard.onb.tcp')], ['ping', t('dashboard.onb.ping')], ['dns', t('dashboard.onb.dns')]] as const;
  return (
    <Card className="mx-auto max-w-2xl p-6">
      <div className="mb-5 flex items-center gap-3"><div className="rounded-full bg-brand-100 p-3 text-brand-600 dark:bg-brand-700/30"><Rocket className="h-6 w-6" /></div><div><h2 className="text-lg font-semibold">{t('dashboard.onb.title')}</h2><p className="text-sm text-slate-500">{t('dashboard.onb.body')}</p></div></div>
      <form onSubmit={(e) => { e.preventDefault(); setError(null); create.mutate(); }} className="space-y-4">
        {error ? <ErrorBox error={error} /> : null}
        <div role="radiogroup" aria-label={t('common.type')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {types.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={type === k} onClick={() => setType(k)} className={cx('rounded-lg border px-3 py-2 text-sm font-medium', type === k ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100' : 'border-slate-300 dark:border-slate-700')}>{label}</button>)}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label={type === 'http' ? t('dashboard.onb.url') : t('dashboard.onb.host')} hint={type === 'http' ? t('dashboard.onb.urlHint') : undefined}>{(id) => <Input id={id} value={target} onChange={(e) => setTarget(e.target.value)} placeholder={type === 'http' ? 'https://example.com' : 'example.com'} required autoFocus />}</Field>
          {type === 'tcp' && <Field label={t('dashboard.onb.port')}>{(id) => <Input id={id} type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required />}</Field>}
        </div>
        <Field label={`${t('common.name')} (${t('common.optional')})`}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="flex flex-wrap items-center gap-3"><Button type="submit" variant="primary" loading={create.isPending}>{t('dashboard.onb.create')}</Button><Link to="/monitors/new" className="text-sm">{t('dashboard.onb.advanced')}</Link></div>
      </form>
    </Card>
  );
}
