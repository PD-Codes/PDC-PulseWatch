import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, Bookmark, CheckSquare, ChevronDown, ChevronRight, Clock, Pause, Play, Plus, Rocket, Search, Trash2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Skeleton, cx, useConfirm, useToast } from '../components/ui';
import { HeartbeatBar, Sparkline, StatusBadge, StatusDot, uptimeTone, type DisplayStatus } from '../components/status';
import { PlayersLine } from '../components/ServerInfo';
import { PAGE_ALL, PAGE_SIZES, Pager } from '../components/Pager';
import { ViewSwitcher } from '../components/dash/ViewSwitcher';
import { GroupOverview } from '../components/dash/GroupOverview';
import { StatusWall } from '../components/dash/StatusWall';
import { HeatmapView } from '../components/dash/HeatmapView';
import { GroupHead, useGroupedPage, type Section } from '../components/dash/shared';
import { SloBadge } from '../components/Slo';
import { SnoozeBadge } from '../components/Snooze';
import { ApiError, del, errorMessage, get, post, type Group, type MonitorItem, type Tag } from '../lib/api';
import { BulkEditModal } from '../components/BulkEdit';
import { tagText } from '../components/TagEditor';
import { useAuth } from '../lib/auth';
import { DISPLAY_KEY, EMPTY_FILTERS, GROUPED_KEY, LEGACY_VIEW_KEY, filtersActive, filtersToParams, isProblem, matchQuery, matchStatus, parseFilters, readStoredView, rememberView, resolveView, savedViewChoice, sortMonitors, statusOf, switchView, viewToParams, type DashFilters, type Display, type SortKey, type StatusFilter, type StoredView, type ViewChoice } from '../lib/dashboardView';
import { byUrgency, groupSections } from '../lib/viewModel';
import { snoozeActive, sloViolated, type MonitorX } from '../lib/monitorExtras';
import { usePagedList } from '../lib/usePagedList';
import { useNow } from '../lib/useNow';
import { fmtMs, fmtPct, relTime } from '../lib/format';
import { useT } from '../lib/i18n';

/** Saved view: the filters plus, since there are several views, display and grouped (older ones lack them). */
interface View { id: number; name: string; filters: Partial<DashFilters> & { display?: unknown; grouped?: unknown }; shared: boolean; own: boolean }
interface TimelineItem { id: number; ts: string; type: string; from: string | null; to: string | null; errorKind: string | null; message: string | null; monitorId: number; monitorName: string }

const COLLAPSED_KEY = 'pw.dash.collapsed';
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
/** The view this device remembers; an old grid/list choice is moved to the new key once. */
const readView = (): StoredView => {
  const d = lsGet(DISPLAY_KEY), legacy = d == null ? lsGet(LEGACY_VIEW_KEY) : null;
  const v = readStoredView(d, lsGet(GROUPED_KEY), legacy);
  if (legacy != null) { if (v.display) lsSet(DISPLAY_KEY, v.display); try { localStorage.removeItem(LEGACY_VIEW_KEY); } catch { /* storage unavailable */ } }
  return v;
};
const readCollapsed = (): Set<number> => { try { const v = JSON.parse(lsGet(COLLAPSED_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter(Number.isInteger) : []); } catch { return new Set(); } };

/** Status chips in the order of urgency; the cross-cutting sets come last. */
const CHIP_ORDER: Exclude<StatusFilter, ''>[] = ['down', 'pending', 'maintenance', 'suppressed', 'unknown', 'up', 'paused', 'slo', 'snoozed'];
const CHIP_TONE: Partial<Record<StatusFilter, string>> = { down: 'text-red-700 dark:text-red-400', pending: 'text-amber-700 dark:text-amber-400', slo: 'text-red-700 dark:text-red-400' };

export default function Dashboard() {
  const t = useT();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const f = useMemo(() => parseFilters(params), [params]);
  // filters live in the address: back/forward and shared links keep them; typing replaces the entry instead of piling up history
  const setF = useCallback((next: DashFilters) => setParams((p) => filtersToParams(next, p), { replace: true }), [setParams]);
  const patchF = (p: Partial<DashFilters>) => setF({ ...f, ...p });
  const [stored, setStored] = useState<StoredView>(readView);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulkEdit, setBulkEdit] = useState(false);
  const [saveView, setSaveView] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(readCollapsed);
  const search = useRef<HTMLInputElement>(null);
  const now = useNow(); // snoozes run out and "since" times move on without new data

  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors') });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups') });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => get<Tag[]>('/api/tags') });
  const views = useQuery({ queryKey: ['views'], queryFn: () => get<View[]>('/api/views') });

  useEffect(() => { const h = () => search.current?.focus(); window.addEventListener('pw:focus-search', h); return () => window.removeEventListener('pw:focus-search', h); }, []);

  const list = (monitors.data ?? []) as MonitorX[];
  const groupList = useMemo(() => groups.data ?? [], [groups.data]); // stable while loading, for the memos below
  // the address wins, then what this device remembers; else the dense table once there are many monitors
  const view = resolveView(params, stored, list.length);
  const { display, grouped } = view;
  const remember = (v: ViewChoice) => { const n = rememberView(stored, v); setStored(n); lsSet(DISPLAY_KEY, v.display); lsSet(GROUPED_KEY, JSON.stringify(n.grouped)); };
  const chooseView = (v: ViewChoice) => { remember(v); setParams((p) => viewToParams(v, p), { replace: true }); };
  const collapseMany = useCallback((ids: number[], on: boolean) => setCollapsed((c) => {
    const n = new Set(c);
    for (const id of ids) { if (on) n.add(id); else n.delete(id); }
    lsSet(COLLAPSED_KEY, JSON.stringify([...n]));
    return n;
  }), []);
  const toggleCollapsed = useCallback((id: number) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id); else n.add(id);
    lsSet(COLLAPSED_KEY, JSON.stringify([...n]));
    return n;
  }), []);

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
  const groupName = useMemo(() => new Map(groupList.map((g) => [g.id, g.name])), [groupList]);

  const filtered = useMemo(() => {
    const gset = f.group ? descendants.get(Number(f.group)) : null;
    return sortMonitors(list.filter((m) => {
      if (!matchStatus(m, f.status, now)) return false;
      if (f.tag && !m.tags.some((x) => String(x.id) === f.tag || x.name === f.tag)) return false;
      if (gset && (m.groupId == null || !gset.has(m.groupId))) return false;
      return matchQuery(m, f.q, tagText);
    }), f.sort);
  }, [list, f, descendants, now]);

  const counts = useMemo(() => {
    const c: Record<Exclude<StatusFilter, ''>, number> = { up: 0, down: 0, pending: 0, unknown: 0, maintenance: 0, suppressed: 0, paused: 0, problems: 0, slo: 0, snoozed: 0 };
    for (const m of list) {
      const s = statusOf(m);
      c[s]++;
      if (isProblem(s)) c.problems++;
      if (sloViolated(m)) c.slo++;
      if (snoozeActive(m, now)) c.snoozed++;
    }
    return c;
  }, [list, now]);
  const problems = useMemo(() => sortMonitors(list.filter((m) => isProblem(statusOf(m))), 'status'), [list]);

  /** Ordered group sections (tree order) holding their direct monitors; ungrouped monitors come first. */
  const sections = useMemo(() => {
    if (display !== 'cards' || !grouped) return [];
    const byGroup = new Map<number | null, MonitorX[]>();
    for (const m of filtered) { const k = m.groupId != null && groupName.has(m.groupId) ? m.groupId : null; byGroup.set(k, [...(byGroup.get(k) ?? []), m]); }
    const out: { group: Group | null; depth: number; items: MonitorX[]; total: number }[] = [];
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
  }, [filtered, groupList, groupName, descendants, display, grouped]);

  /** Sections for the other views (tree order, ungrouped last); groups and wall put problems first by urgency when sorted by status. */
  const viewRows = useMemo(() => ((display === 'groups' || display === 'wall') && f.sort === 'status' ? [...filtered].sort(byUrgency) : filtered), [filtered, display, f.sort]);
  const viewSections = useMemo<Section[] | null>(() => (display === 'groups' || (grouped && display !== 'cards') ? groupSections(viewRows, groupList, { order: 'tree', ungrouped: 'last' }) : null), [viewRows, groupList, display, grouped]);

  const hidden = useMemo(() => { // groups collapsed along the path
    const s = new Set<number>();
    for (const id of collapsed) for (const d of descendants.get(id) ?? []) if (d !== id) s.add(d);
    return s;
  }, [collapsed, descendants]);

  const chosen = filtered.filter((m) => sel.has(m.id)).map((m) => m.id);
  const bulk = useMutation({
    mutationFn: (b: { action: string; patch?: object }) => post('/api/monitors/bulk', { ids: chosen, ...b }),
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

  // stable callbacks, so memoized cards and rows re-render only when their own monitor changes (live updates patch one entry at a time)
  const toggle = useCallback((id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const quickMutate = quick.mutate;
  const onQuick = useCallback((id: number, pause: boolean) => quickMutate({ id, pause }), [quickMutate]);
  const editor = can('editor');
  const quickFn = editor ? onQuick : undefined;
  const resetKey = `${f.q}|${f.status}|${f.tag}|${f.group}|${f.sort}`;

  if (monitors.isLoading) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>;
  if (monitors.error) return <ErrorBox error={monitors.error} />;
  if (!list.length) return (<><PageHeader title={t('nav.dashboard')} /><Onboarding editor={editor} /></>);

  const applyView = (v: View) => {
    const nf: DashFilters = { ...EMPTY_FILTERS, ...parseFilters(filtersToParams({ ...EMPTY_FILTERS, ...v.filters })), tag: tagToId(v.filters.tag, tags.data) };
    const vc = savedViewChoice(v.filters, stored); // older saved views keep the current view
    if (vc) remember(vc);
    setParams((p) => { const n = filtersToParams(nf, p); return vc ? viewToParams(vc, n) : n; }, { replace: true });
  };
  const chip = (s: Exclude<StatusFilter, ''>) => {
    if (!counts[s]) return null;
    const on = f.status === s;
    const label = s === 'slo' ? t('mux.dash.sloMissed') : s === 'snoozed' ? t('mux.dash.snoozed') : t(`status.${s}`);
    return (
      <button key={s} type="button" aria-pressed={on} onClick={() => patchF({ status: on ? '' : s })} title={t('mux.dash.chipTip', { label })}
        className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition', on ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-700/20' : 'border-slate-200 bg-white hover:border-brand-400 dark:border-slate-700 dark:bg-slate-900')}>
        {s === 'slo' || s === 'snoozed' ? <span className={cx('h-2 w-2 rounded-full', s === 'slo' ? 'bg-red-500' : 'bg-slate-400')} aria-hidden /> : <StatusDot status={s as DisplayStatus} className="!h-2 !w-2" />}
        <span className={cx('tabular-nums', CHIP_TONE[s])}>{counts[s]}</span><span className="text-slate-600 dark:text-slate-300">{label}</span>
      </button>
    );
  };
  // the problem line repeats what the list already shows on top when it is sorted by status and unfiltered
  const showProblems = problems.length > 0 && !['problems', 'down', 'pending'].includes(f.status) && !(display === 'table' && !grouped && f.sort === 'status' && !filtersActive(f));

  return (
    <>
      <PageHeader title={t('nav.dashboard')} subtitle={filtersActive(f) ? t('mux.dash.shown', { n: filtered.length, total: list.length }) : t('dashboard.subtitle', { n: list.length })}
        actions={editor ? <><Button size="sm" variant={selecting ? 'primary' : 'default'} onClick={() => { setSelecting(!selecting); setSel(new Set()); }}><CheckSquare className="h-4 w-4" />{t('dashboard.select')}</Button><Link to="/monitors/new" className="btn btn-primary btn-sm no-underline"><Plus className="h-4 w-4" />{t('palette.newMonitor')}</Link></> : undefined} />
      {!editor && <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t('dashboard.readOnly')}</p>}

      <div className="mb-2 flex flex-wrap items-center gap-2" role="search">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
          <input ref={search} value={f.q} onChange={(e) => patchF({ q: e.target.value })} placeholder={t('dashboard.search')} aria-label={t('dashboard.search')} className="input pl-9" />
        </div>
        {!!tags.data?.length && <Select aria-label={t('dashboard.tag')} value={f.tag} onChange={(e) => patchF({ tag: e.target.value })} className="w-auto"><option value="">{t('dashboard.anyTag')}</option>{tags.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        {groupList.length > 0 && <Select aria-label={t('dashboard.group')} value={f.group} onChange={(e) => patchF({ group: e.target.value })} className="w-auto"><option value="">{t('dashboard.anyGroup')}</option>{groupList.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}
        <Select aria-label={t('mux.dash.sort')} value={f.sort} onChange={(e) => patchF({ sort: e.target.value as SortKey })} className="w-auto">
          {(['status', 'name', 'latency', 'uptime'] as const).map((k) => <option key={k} value={k}>{t(`mux.dash.sort.${k}`)}</option>)}
        </Select>
        {!!views.data?.length && (
          <Select aria-label={t('dashboard.savedViews')} value="" onChange={(e) => { const v = views.data!.find((x) => String(x.id) === e.target.value); if (v) applyView(v); }} className="w-auto">
            <option value="">{t('dashboard.savedViews')}</option>{views.data.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
        )}
        {filtersActive(f) ? <><Button size="sm" onClick={() => setSaveView(true)}><Bookmark className="h-4 w-4" />{t('dashboard.saveView')}</Button><Button size="sm" variant="ghost" onClick={() => setF({ ...EMPTY_FILTERS, sort: f.sort })}><X className="h-4 w-4" />{t('common.reset')}</Button></> : null}
        <ViewSwitcher display={display} grouped={grouped} onDisplay={(d: Display) => chooseView(switchView(d, stored))} onGrouped={(g) => chooseView({ display, grouped: g })} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('mux.dash.statusFilter')}>
        {CHIP_ORDER.map(chip)}
        {views.data?.some((v) => v.own) && <span className="ml-auto flex flex-wrap gap-1.5 text-xs text-slate-500">{views.data.filter((v) => v.own).map((v) => <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 dark:bg-slate-800"><Bookmark className="h-3 w-3" aria-hidden /><button type="button" onClick={() => applyView(v)} className="hover:underline">{v.name}</button><button type="button" aria-label={`${t('common.delete')}: ${v.name}`} onClick={() => delView.mutate(v.id)}><X className="h-3 w-3" /></button></span>)}</span>}
      </div>

      {showProblems && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/30" role="region" aria-label={t('mux.dash.problems', { n: problems.length })}>
          <button type="button" onClick={() => patchF({ status: 'problems' })} className="font-semibold text-red-700 hover:underline dark:text-red-400">{t('mux.dash.problems', { n: problems.length })}</button>
          {problems.slice(0, 8).map((m) => (
            <Link key={m.id} to={`/monitors/${m.id}`} title={m.message ?? undefined} className="inline-flex min-w-0 max-w-[18rem] items-center gap-1.5 text-slate-800 no-underline hover:underline dark:text-slate-100">
              <StatusDot status={statusOf(m)} pulse /><span className="truncate">{m.name}</span>{m.statusSince && <span className="shrink-0 text-xs text-slate-500">{relTime(m.statusSince)}</span>}
              {snoozeActive(m) && <SnoozeBadge until={m.snoozedUntil} short />}
            </Link>
          ))}
          {problems.length > 8 && <button type="button" onClick={() => patchF({ status: 'problems' })} className="text-xs text-red-700 underline dark:text-red-400">{t('mux.dash.more', { n: problems.length - 8 })}</button>}
        </div>
      )}

      {(chosen.length > 0 || selecting) && (
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-300 bg-brand-50 px-3 py-2 text-sm dark:border-brand-700 dark:bg-brand-700/20" role="toolbar" aria-label={t('dashboard.bulk')}>
          <span className="font-medium">{t('dashboard.selected', { n: chosen.length })}</span>
          {chosen.length < filtered.length && <Button size="sm" variant="ghost" onClick={() => setSel(new Set(filtered.map((m) => m.id)))}>{t('dashboard.selectAll', { n: filtered.length })}</Button>}
          <Button size="sm" onClick={() => bulk.mutate({ action: 'pause' })}><Pause className="h-4 w-4" />{t('monitors.pause')}</Button>
          <Button size="sm" onClick={() => bulk.mutate({ action: 'resume' })}><Play className="h-4 w-4" />{t('monitors.resume')}</Button>
          <Button size="sm" onClick={() => setBulkEdit(true)}>{t('dashboard.editSettings')}</Button>
          <Button size="sm" variant="danger" onClick={async () => { if (await confirm({ title: t('dashboard.bulkDeleteTitle', { n: chosen.length }), body: t('dashboard.bulkDeleteBody'), danger: true, confirmLabel: t('common.delete') })) bulk.mutate({ action: 'delete' }); }}><Trash2 className="h-4 w-4" />{t('common.delete')}</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSel(new Set())}>{t('dashboard.clearSelection')}</Button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-4">
          {filtered.length === 0 && <Card><EmptyState title={t('common.noResults')} body={t('dashboard.noMatch')} action={<Button onClick={() => setF({ ...EMPTY_FILTERS, sort: f.sort })}>{t('common.reset')}</Button>} /></Card>}
          {filtered.length > 0 && display === 'table' && <FlatList rows={filtered} sections={viewSections} sort={f.sort} onSort={(s) => patchF({ sort: s })} resetKey={resetKey} groupName={groupName} selecting={selecting} sel={sel} onToggle={toggle} onQuick={quickFn} />}
          {display === 'cards' && grouped && sections.map((s) => {
            if (s.group && hidden.has(s.group.id)) return null;
            return <GroupSection key={s.group?.id ?? 'none'} group={s.group} depth={s.depth} items={s.items} total={s.total} collapsed={!!s.group && collapsed.has(s.group.id)} onCollapse={toggleCollapsed} resetKey={resetKey} selecting={selecting} sel={sel} onToggle={toggle} onQuick={quickFn} />;
          })}
          {filtered.length > 0 && display === 'cards' && !grouped && <GroupSection group={null} depth={0} items={filtered} total={filtered.length} collapsed={false} onCollapse={toggleCollapsed} pagerKey="dash.cards" resetKey={resetKey} selecting={selecting} sel={sel} onToggle={toggle} onQuick={quickFn} />}
          {filtered.length > 0 && display === 'groups' && viewSections && <GroupOverview sections={viewSections} collapsed={collapsed} onCollapse={toggleCollapsed} onCollapseMany={collapseMany} selecting={selecting} sel={sel} onToggle={toggle} />}
          {filtered.length > 0 && display === 'wall' && <StatusWall rows={viewRows} sections={viewSections} selecting={selecting} sel={sel} onToggle={toggle} />}
          {filtered.length > 0 && display === 'heatmap' && <HeatmapView rows={filtered} sections={viewSections} resetKey={resetKey} selecting={selecting} sel={sel} onToggle={toggle} />}
        </div>
        <div className="min-w-0 xl:sticky xl:top-16 xl:self-start"><Timeline /></div>
      </div>

      <SaveViewModal open={saveView} onClose={() => setSaveView(false)} filters={f} view={view} tags={tags.data} canShare={editor} />
      <BulkEditModal key={bulkEdit ? 'open' : 'closed'} open={bulkEdit} onClose={() => setBulkEdit(false)} count={chosen.length} groups={groupList} tags={tags.data ?? []} onSubmit={(patch) => { bulk.mutate({ action: 'patch', patch }); setBulkEdit(false); }} />
    </>
  );
}

/** Saved views store the tag by name so they survive tag re-creation; the filter state uses ids. */
const tagToId = (tag: string | undefined, tags?: Tag[]) => (tag ? String(tags?.find((x) => x.name === tag || String(x.id) === tag)?.id ?? tag) : '');

interface ListProps { selecting: boolean; sel: Set<number>; onToggle: (id: number) => void; onQuick?: (id: number, pause: boolean) => void }

/** One group of cards; pages appear only when the group holds more than one page of monitors. */
function GroupSection({ group, depth, items, total, collapsed, onCollapse, resetKey, pagerKey = 'dash.group', ...rest }: ListProps & { group: Group | null; depth: number; items: MonitorX[]; total: number; collapsed: boolean; onCollapse: (id: number) => void; resetKey: string; pagerKey?: string }) {
  const { pageRows, pagerProps, pageSize } = usePagedList(items, { key: pagerKey, resetKey, all: true });
  // with "All" the picker stays reachable once there is more than the smallest page
  const paged = pageSize === PAGE_ALL ? items.length > PAGE_SIZES[0]! : items.length > pageSize;
  return (
    <section style={{ marginLeft: depth * 12 }} aria-label={group?.name}>
      {group && (
        <button type="button" aria-expanded={!collapsed} onClick={() => onCollapse(group.id)} className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-600 dark:text-slate-300">
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}{group.name}<Badge>{total}</Badge>
        </button>
      )}
      {!collapsed && items.length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{pageRows.map((m) => <MonitorCard key={m.id} m={m} selecting={rest.selecting} selected={rest.sel.has(m.id)} onToggle={rest.onToggle} onQuick={rest.onQuick} />)}</div>
          {paged && <div className="card mt-2 overflow-hidden [&>nav]:border-t-0"><Pager {...pagerProps} /></div>}
        </>
      )}
    </section>
  );
}

/** Dense list with sortable column heads; 20 rows per page by default. Grouped: by group in tree order, a heading per group on every page. */
function FlatList({ rows, sections, sort, onSort, resetKey, groupName, ...rest }: ListProps & { rows: MonitorX[]; sections: Section[] | null; sort: SortKey; onSort: (s: SortKey) => void; resetKey: string; groupName: Map<number, string> }) {
  const t = useT();
  const { entries, pagerProps } = useGroupedPage(rows, sections, 'dash.list', resetKey);
  const head = (k: SortKey, label: string, cls: string) => (
    <button type="button" onClick={() => onSort(k)} aria-pressed={sort === k} className={cx('inline-flex items-center gap-0.5 hover:text-slate-900 dark:hover:text-slate-100', sort === k && 'font-semibold text-slate-800 dark:text-slate-100', cls)}>
      {label}{sort === k && <ArrowDown className="h-3 w-3" aria-hidden />}
    </button>
  );
  return (
    <Card className="overflow-hidden">
      <div className="hidden items-center gap-x-3 border-b border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800 sm:flex" role="group" aria-label={t('mux.dash.sort')}>
        {rest.selecting && <span className="w-4" />}
        <button type="button" onClick={() => onSort('status')} aria-pressed={sort === 'status'} title={t('mux.dash.sort.status')} aria-label={t('mux.dash.sort.status')} className={cx('h-2.5 w-2.5 rounded-full border', sort === 'status' ? 'border-slate-700 bg-slate-700 dark:border-slate-200 dark:bg-slate-200' : 'border-slate-400')} />
        <span className="w-64 shrink-0">{head('name', t('common.name'), '')}</span>
        <span className="hidden flex-1 md:block" aria-hidden>{t('mux.dash.history')}</span>
        <span className="ml-auto w-16 text-right md:ml-0">{head('latency', t('mux.dash.col.latency'), 'justify-end w-full')}</span>
        <span className="w-14 text-right">{head('uptime', '24 h', 'justify-end w-full')}</span>
        <span className="w-14 text-right" aria-hidden>30 d</span>
        <span className="hidden w-24 text-right lg:block" aria-hidden>{t('monitors.lastCheck')}</span>
        {rest.onQuick && <span className="w-7" />}
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {entries.map((e) => (e.kind === 'head' ? <GroupHead key={`h${e.section.key}`} section={e.section} continued={e.continued} />
          : <MonitorRow key={e.item.id} m={e.item} group={!sections && e.item.groupId != null ? groupName.get(e.item.groupId) : undefined} selecting={rest.selecting} selected={rest.sel.has(e.item.id)} onToggle={rest.onToggle} onQuick={rest.onQuick} />))}
      </div>
      <Pager {...pagerProps} />
    </Card>
  );
}

interface RowProps { m: MonitorX; selecting: boolean; selected: boolean; onToggle: (id: number) => void; onQuick?: (id: number, pause: boolean) => void; group?: string }

/** Pause/resume icon button; sits above the stretched card link. */
function QuickToggle({ m, onQuick }: Pick<RowProps, 'm' | 'onQuick'>) {
  const t = useT();
  if (!onQuick) return null;
  const label = m.active ? t('monitors.pause') : t('monitors.resume');
  return <button type="button" title={label} aria-label={`${label}: ${m.name}`} onClick={() => onQuick(m.id, m.active)} className="relative z-10 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100">{m.active ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>;
}

/** Name link whose ::after covers the whole (relative) card; while selecting, a click toggles the selection instead of navigating. */
function CardLink({ m, selecting, onToggle, className, title }: Pick<RowProps, 'm' | 'selecting' | 'onToggle'> & { className: string; title?: string }) {
  return <Link to={`/monitors/${m.id}`} title={title} onClick={(e) => { if (selecting) { e.preventDefault(); onToggle(m.id); } }} className={cx(className, 'after:absolute after:inset-0')}>{m.name}</Link>;
}

function Check({ m, selected, onToggle }: Pick<RowProps, 'm' | 'selected' | 'onToggle'>) {
  return <input type="checkbox" checked={selected} onChange={() => onToggle(m.id)} aria-label={m.name} className="relative z-10 h-4 w-4 rounded border-slate-300 text-brand-600" />;
}

/** Tags as small color dots; the names are in the tooltip (and on the detail page). */
function TagDots({ m }: { m: MonitorX }) {
  if (!m.tags.length) return null;
  const all = m.tags.map(tagText).join(', ');
  return <span className="inline-flex items-center gap-0.5" title={all}><span className="sr-only">{all}</span>{m.tags.slice(0, 5).map((x) => <span key={`${x.id}:${x.value}`} aria-hidden className="h-2 w-2 rounded-full" style={{ background: x.color }} />)}</span>;
}

const Pct = ({ v, label }: { v: number | null; label: string }) => <span className={cx('font-semibold tabular-nums', uptimeTone(v))} aria-label={label}>{fmtPct(v, 2)}</span>;

const MonitorCard = memo(function MonitorCard({ m, selecting, selected, onToggle, onQuick }: RowProps) {
  const t = useT();
  const now = useNow(); // relative times and "overdue" move on although the props stay the same
  const s = statusOf(m) as DisplayStatus;
  // the last check is only worth space when it is overdue (three intervals and a minute)
  const stale = m.active && (!m.lastCheckAt || now - Date.parse(m.lastCheckAt) > (m.intervalS * 3 + 60) * 1000);
  return (
    <Card className={cx('relative cursor-pointer p-3 transition hover:border-brand-400', selected && 'border-brand-500 ring-1 ring-brand-500', s === 'down' && 'border-red-300 dark:border-red-900')}>
      <div className="flex items-start gap-2">
        {selecting && <Check m={m} selected={selected} onToggle={onToggle} />}
        <div className="min-w-0 flex-1">
          <CardLink m={m} selecting={selecting} onToggle={onToggle} className="block truncate font-medium text-slate-900 no-underline hover:underline dark:text-slate-100" />
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500"><span className="font-mono">{m.type}</span><TagDots m={m} />{m.flapping && <Badge tone="amber">{t('monitors.flapping')}</Badge>}{m.anomaly && <Badge tone="violet">{t('monitors.slowdown')}</Badge>}<SloBadge slo={m.slo} /><SnoozeBadge until={m.snoozedUntil} /></div>
        </div>
        <StatusBadge status={s} /><QuickToggle m={m} onQuick={onQuick} />
      </div>
      <div className="mt-2 flex items-center gap-3"><HeartbeatBar beats={m.recent} count={32} className="flex-1" height="h-5" interactive={false} /><Sparkline beats={m.recent} width={64} height={22} /></div>
      {s === 'down' && m.message && <p className="mt-1.5 truncate text-xs text-red-600 dark:text-red-400" title={m.message}>{m.errorKind ? `${m.errorKind}: ` : ''}{m.message}</p>}
      <div className="mt-1.5 flex items-center gap-3 whitespace-nowrap text-xs text-slate-500">
        <span className="tabular-nums" title={m.lastCheckAt ? `${t('monitors.lastCheck')}: ${relTime(m.lastCheckAt)}` : undefined}>{fmtMs(m.latencyMs)}</span>
        {m.info && <PlayersLine info={m.info} short />}
        <span className="ml-auto inline-flex items-center gap-1">24 h <Pct v={m.uptime.h24} label={`${t('monitors.uptime')} 24h`} /></span>
        <span className="inline-flex items-center gap-1">30 d <Pct v={m.uptime.d30} label={`${t('monitors.uptime')} 30d`} /></span>
      </div>
      {stale && <p className="mt-1 truncate text-xs text-amber-700 dark:text-amber-400">{m.lastCheckAt ? t('mux.dash.stale', { when: relTime(m.lastCheckAt) }) : t('monitors.noChecks')}</p>}
    </Card>
  );
});

const MonitorRow = memo(function MonitorRow({ m, selecting, selected, onToggle, onQuick, group }: RowProps) {
  const t = useT();
  useNow(); // re-render every 30 s: last check time and snooze state
  const s = statusOf(m) as DisplayStatus;
  return (
    <div className={cx('relative flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 sm:flex-nowrap', selected && 'bg-brand-50 dark:bg-brand-700/10')}>
      {selecting && <Check m={m} selected={selected} onToggle={onToggle} />}
      <StatusDot status={s} pulse />
      <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">
        <div className="flex min-w-0 items-center gap-1.5">
          <CardLink m={m} selecting={selecting} onToggle={onToggle} title={[t(`status.${s}`), m.tags.map(tagText).join(', ')].filter(Boolean).join(' · ')} className="min-w-0 truncate text-sm font-medium text-slate-900 no-underline hover:underline dark:text-slate-100" />
          <SnoozeBadge until={m.snoozedUntil} short /><SloBadge slo={m.slo} className="shrink-0 !px-1 !py-0 text-[10px]" />
        </div>
        {s === 'down' && m.message ? <div className="truncate text-xs text-red-600 dark:text-red-400" title={m.message}>{m.errorKind ? `${m.errorKind}: ` : ''}{m.message}</div>
          : group ? <div className="truncate text-xs text-slate-400">{group}</div> : null}
      </div>
      <HeartbeatBar beats={m.recent} count={40} className="hidden flex-1 md:flex" height="h-4" interactive={false} />
      {m.info?.players !== undefined && <PlayersLine info={m.info} short className="text-xs text-slate-500" />}
      <span className="w-16 text-right text-xs tabular-nums text-slate-500">{fmtMs(m.latencyMs)}</span>
      <span className="w-14 text-right text-xs"><Pct v={m.uptime.h24} label={`${t('monitors.uptime')} 24h`} /></span>
      <span className="w-14 text-right text-xs"><Pct v={m.uptime.d30} label={`${t('monitors.uptime')} 30d`} /></span>
      <span className="hidden w-24 truncate text-right text-xs text-slate-500 lg:block">{m.lastCheckAt ? relTime(m.lastCheckAt) : '–'}</span>
      <QuickToggle m={m} onQuick={onQuick} />
    </div>
  );
});

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

function SaveViewModal({ open, onClose, filters, view, tags, canShare }: { open: boolean; onClose: () => void; filters: DashFilters; view: ViewChoice; tags?: Tag[]; canShare: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const m = useMutation({
    mutationFn: () => post('/api/views', { name, shared, filters: { ...filters, tag: tags?.find((x) => String(x.id) === filters.tag)?.name ?? filters.tag, display: view.display, grouped: view.grouped } }),
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
