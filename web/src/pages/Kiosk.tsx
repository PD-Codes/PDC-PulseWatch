import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Link2, LogOut, Maximize2, Minimize2, Pause, Play, Settings2, TriangleAlert, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MultiSelect } from '../components/MultiSelect';
import { MonitorPicker, useGroupsQ, useTagsQ } from '../components/ops-shared';
import { PlayersLine } from '../components/ServerInfo';
import { displayStatus, HeartbeatBar, StatusDot, type DisplayStatus } from '../components/status';
import { Button, cx, Field, Modal, Select, Toggle, useToast } from '../components/ui';
import { get, type Group, type MonitorItem } from '../lib/api';
import { fmtDuration, fmtMs, fmtPct } from '../lib/format';
import { packPages, type Row, type Section } from '../lib/kiosk-layout';
import { useI18n, useT } from '../lib/i18n';

type View = 'all' | 'auto' | 'problems';
type Size = 's' | 'm' | 'l';
type Layout = 'flat' | 'grouped';
interface Cfg { groups: number[]; tags: string[]; monitors: number[]; view: View; layout: Layout; size: Size; zoom: number; rotate: number; theme: 'dark' | 'light'; incidents: boolean; clock: boolean; bars: boolean }
const DEFAULT: Cfg = { groups: [], tags: [], monitors: [], view: 'all', layout: 'flat', size: 'm', zoom: 100, rotate: 12, theme: 'dark', incidents: true, clock: true, bars: true };
const ROTATIONS = [0, 5, 8, 12, 20, 30, 60];
const TILE: Record<Size, [number, number]> = { s: [210, 124], m: [270, 156], l: [350, 196] };
const NAME_CLS: Record<Size, string> = { s: 'text-base', m: 'text-xl', l: 'text-2xl' };
const BIG_CLS: Record<Size, string> = { s: 'text-lg', m: 'text-2xl', l: 'text-3xl' };
const KEY = 'pw.kiosk';
const ZOOM_MIN = 50, ZOOM_MAX = 200;
const clampZoom = (n: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n / 5) * 5));
const RANK: Partial<Record<DisplayStatus, number>> = { down: 0, pending: 1, suppressed: 2, maintenance: 3, unknown: 4, up: 5, paused: 6 };
const isProblem = (s: DisplayStatus) => s === 'down' || s === 'pending' || s === 'suppressed';

// the whole look is described here once; the light variant is for bright rooms and projectors
const LOOK = {
  dark: { root: 'bg-slate-950 text-white', muted: 'text-slate-300', faint: 'text-slate-400', neutral: 'border-slate-600 bg-slate-900', tile: { down: 'border-red-500 bg-red-950/60', pending: 'border-amber-500 bg-amber-950/50', suppressed: 'border-violet-500 bg-violet-950/50', maintenance: 'border-sky-500 bg-sky-950/50', up: 'border-emerald-800 bg-emerald-950/40' } as Record<string, string>, strip: 'bg-slate-900 text-white' },
  light: { root: 'bg-slate-100 text-slate-900', muted: 'text-slate-600', faint: 'text-slate-500', neutral: 'border-slate-300 bg-white', tile: { down: 'border-red-500 bg-red-50', pending: 'border-amber-400 bg-amber-50', suppressed: 'border-violet-400 bg-violet-50', maintenance: 'border-sky-400 bg-sky-50', up: 'border-emerald-400 bg-white' } as Record<string, string>, strip: 'bg-white text-slate-900' },
};

/** Settings come from the address first (so a link sets up a wall display), then from what this browser remembered. */
function readCfg(p: URLSearchParams): Cfg {
  let stored: Partial<Cfg> = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { /* storage unavailable or damaged: use the defaults */ }
  const ints = (s: string | null) => (s ? s.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : null);
  const one = Number(p.get('group')); // older links carried a single group
  const groups = ints(p.get('groups')) ?? (one > 0 ? [one] : null);
  const tags = p.get('tags') ? p.get('tags')!.split(',').filter(Boolean) : null;
  const picked = ints(p.get('monitors'));
  const pick = <T extends string>(v: string | null, ok: readonly T[]) => (ok.includes(v as T) ? (v as T) : undefined);
  const rotate = p.get('rotate') !== null ? Number(p.get('rotate')) : undefined;
  const zoom = Number(p.get('zoom'));
  const merged: Cfg = {
    ...DEFAULT, ...stored,
    ...(groups ? { groups } : {}), ...(tags ? { tags } : {}), ...(picked ? { monitors: picked } : {}),
    ...(pick(p.get('layout'), ['flat', 'grouped'] as const) ? { layout: pick(p.get('layout'), ['flat', 'grouped'] as const)! } : {}),
    ...(pick(p.get('view'), ['all', 'auto', 'problems'] as const) ? { view: pick(p.get('view'), ['all', 'auto', 'problems'] as const)! } : {}),
    ...(pick(p.get('size'), ['s', 'm', 'l'] as const) ? { size: pick(p.get('size'), ['s', 'm', 'l'] as const)! } : {}),
    ...(Number.isFinite(zoom) && zoom >= ZOOM_MIN && zoom <= ZOOM_MAX ? { zoom: clampZoom(zoom) } : {}),
    ...(rotate !== undefined && Number.isFinite(rotate) && rotate >= 0 && rotate <= 300 ? { rotate } : {}),
    ...(pick(p.get('theme'), ['dark', 'light'] as const) ? { theme: pick(p.get('theme'), ['dark', 'light'] as const)! } : {}),
    ...(p.get('incidents') !== null ? { incidents: p.get('incidents') !== '0' } : {}), ...(p.get('clock') !== null ? { clock: p.get('clock') !== '0' } : {}), ...(p.get('bars') !== null ? { bars: p.get('bars') !== '0' } : {}),
  };
  return merged;
}
/** Only what differs from the defaults goes into the address, so links stay short. */
function toParams(c: Cfg): URLSearchParams {
  const p = new URLSearchParams();
  if (c.groups.length) p.set('groups', c.groups.join(','));
  if (c.tags.length) p.set('tags', c.tags.join(','));
  if (c.monitors.length) p.set('monitors', c.monitors.join(','));
  if (c.layout !== DEFAULT.layout) p.set('layout', c.layout);
  if (c.view !== DEFAULT.view) p.set('view', c.view);
  if (c.size !== DEFAULT.size) p.set('size', c.size);
  if (c.zoom !== DEFAULT.zoom) p.set('zoom', String(c.zoom));
  if (c.rotate !== DEFAULT.rotate) p.set('rotate', String(c.rotate));
  if (c.theme !== DEFAULT.theme) p.set('theme', c.theme);
  if (!c.incidents) p.set('incidents', '0');
  if (!c.clock) p.set('clock', '0');
  if (!c.bars) p.set('bars', '0');
  return p;
}

/** The monitors per group, a subgroup named by its path. Groups with problems come first, monitors without a group last. */
function sectionsOf(list: MonitorItem[], groups: Group[]): Section<MonitorItem>[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const path = (id: number) => { const names: string[] = []; for (let g = byId.get(id), n = 0; g && n < 10; g = g.parentId != null ? byId.get(g.parentId) : undefined, n++) names.unshift(g.name); return names.join(' / '); };
  const map = new Map<number | null, MonitorItem[]>();
  for (const m of list) { const k = m.groupId != null && byId.has(m.groupId) ? m.groupId : null; map.set(k, [...(map.get(k) ?? []), m]); }
  const worst = (items: MonitorItem[]) => Math.min(...items.map((m) => RANK[displayStatus(m)] ?? 9));
  return [...map].map(([id, items]) => ({ key: String(id), id, label: id == null ? '' : path(id), items }))
    .sort((a, b) => Number(a.id == null) - Number(b.id == null) || worst(a.items) - worst(b.items) || a.label.localeCompare(b.label));
}

interface ActiveIncident { id: number; title: string; status: string; severity: 'minor' | 'major' | 'critical'; startedAt: string }

export default function Kiosk() {
  const t = useT();
  const { locale } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [cfg, setCfg] = useState<Cfg>(() => readCfg(params));
  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const look = LOOK[cfg.theme];
  const body = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1280, h: 720 });
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const [settings, setSettings] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [full, setFull] = useState(!!document.fullscreenElement);
  const [idle, setIdle] = useState(false);

  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors'), refetchInterval: 20_000 });
  const groups = useGroupsQ();
  const tags = useTagsQ();
  const incidents = useQuery({ queryKey: ['incidents', 'kiosk'], queryFn: () => get<ActiveIncident[]>('/api/incidents?status=active&limit=4'), refetchInterval: 20_000, enabled: cfg.incidents });

  // the address always shows the current settings, so it can be bookmarked or copied to another screen
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* storage unavailable */ }
    setParams(toParams(cfg), { replace: true });
  }, [cfg, setParams]);

  useEffect(() => { document.title = `${t('kiosk.title')} · PulseWatch`; }, [t]);
  // zoom scales the root font size, so everything sized in rem (text, padding, tiles) grows together; the tile grid below uses the same factor
  useEffect(() => {
    const root = document.documentElement;
    const was = root.style.fontSize;
    root.style.fontSize = `${(16 * cfg.zoom) / 100}px`;
    return () => { root.style.fontSize = was; };
  }, [cfg.zoom]);
  // the shared components (heartbeat bars, dialogs) follow the page theme, so the kiosk look sets it while it is open
  useEffect(() => {
    const root = document.documentElement;
    const was = root.classList.contains('dark');
    root.classList.toggle('dark', cfg.theme === 'dark');
    return () => { root.classList.toggle('dark', was); };
  }, [cfg.theme]);
  useEffect(() => { const i = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // keep the screen awake while the wall display is open
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => { try { lock = (await navigator.wakeLock?.request('screen')) ?? null; } catch { /* not allowed here: the screen may sleep */ } };
    void acquire();
    const again = () => { if (document.visibilityState === 'visible') void acquire(); };
    document.addEventListener('visibilitychange', again);
    return () => { document.removeEventListener('visibilitychange', again); void lock?.release(); };
  }, []);

  // hide the mouse pointer a few seconds after the last movement
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => { setIdle(false); clearTimeout(timer); timer = setTimeout(() => setIdle(true), 4000); };
    wake();
    window.addEventListener('mousemove', wake);
    return () => { window.removeEventListener('mousemove', wake); clearTimeout(timer); };
  }, []);
  useEffect(() => { const h = () => setFull(!!document.fullscreenElement); document.addEventListener('fullscreenchange', h); return () => document.removeEventListener('fullscreenchange', h); }, []);

  const scoped = useMemo(() => {
    let all = (monitors.data ?? []).filter((m) => displayStatus(m) !== 'paused');
    if (cfg.groups.length) {
      const ids = new Set(cfg.groups);
      for (let grew = true; grew;) { grew = false; for (const g of groups.data ?? []) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) { ids.add(g.id); grew = true; } }
      all = all.filter((m) => m.groupId != null && ids.has(m.groupId));
    }
    if (cfg.tags.length) all = all.filter((m) => m.tags.some((x) => cfg.tags.includes(x.name)));
    if (cfg.monitors.length) all = all.filter((m) => cfg.monitors.includes(m.id));
    // problems first, the longest-lasting first; the healthy ones by name
    return all.sort((a, b) => (RANK[displayStatus(a)] ?? 9) - (RANK[displayStatus(b)] ?? 9) || (isProblem(displayStatus(a)) ? (a.statusSince ?? '').localeCompare(b.statusSince ?? '') : a.name.localeCompare(b.name)));
  }, [monitors.data, groups.data, cfg.groups, cfg.tags, cfg.monitors]);

  const count = (f: (s: DisplayStatus) => boolean) => scoped.filter((m) => f(displayStatus(m))).length;
  const down = count((s) => s === 'down'), trouble = count((s) => s === 'pending' || s === 'suppressed'), maint = count((s) => s === 'maintenance'), up = count((s) => s === 'up');
  const problems = scoped.filter((m) => isProblem(displayStatus(m)));
  const list = cfg.view === 'problems' ? problems : cfg.view === 'auto' && problems.length ? problems : scoped;

  const z = cfg.zoom / 100;
  const tw = TILE[cfg.size][0] * z, th = TILE[cfg.size][1] * z;
  const cols = Math.max(1, Math.floor(size.w / tw));
  const rows = Math.max(1, Math.floor(size.h / th));
  const perPage = cols * rows;
  const grouped = cfg.layout === 'grouped';
  const sections = useMemo(() => (grouped ? sectionsOf(list, groups.data ?? []) : []), [grouped, list, groups.data]);
  // grouped pages are packed by height: a heading row is low, a tile row is a full tile high, and a heading never ends a page alone
  const gpages = useMemo(() => (grouped ? packPages(sections, cols, size.h - 20 * z, th, 48 * z) : []), [grouped, sections, cols, size.h, th, z]);
  const pages = grouped ? Math.max(1, gpages.length) : Math.max(1, Math.ceil(list.length / perPage));
  const cur = Math.min(page, pages - 1);
  const visible = list.slice(cur * perPage, (cur + 1) * perPage);
  const go = (d: number) => setPage((p) => (Math.min(p, pages - 1) + d + pages) % pages);

  const rotating = cfg.rotate > 0 && pages > 1 && !paused && !settings;
  useEffect(() => {
    if (!rotating) return;
    const i = setInterval(() => setPage((p) => (p + 1) % pages), cfg.rotate * 1000);
    return () => clearInterval(i);
  }, [rotating, pages, cfg.rotate]);
  // a new problem should be seen at once, not on page four
  const seenDown = useRef(0);
  useEffect(() => { if (down > seenDown.current) setPage(0); seenDown.current = down; }, [down]);

  const toggleFull = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.().catch(() => {}); };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (settings || (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { if (!document.fullscreenElement) nav('/dashboard'); }
      else if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p); }
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'f' || e.key === 'F') toggleFull();
      else if (e.key === 's' || e.key === 'S') setSettings(true);
      else if (e.key === '+' || e.key === '=') set('zoom', clampZoom(cfg.zoom + 10));
      else if (e.key === '-') set('zoom', clampZoom(cfg.zoom - 10));
      else if (e.key === '0') set('zoom', DEFAULT.zoom);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const tone = scoped.length === 0 ? 'bg-slate-700' : down > 0 ? 'bg-red-700' : trouble > 0 ? 'bg-amber-600' : maint > 0 ? 'bg-sky-700' : 'bg-emerald-700';
  const headline = scoped.length === 0 ? t('kiosk.title') : down > 0 ? t(down === 1 ? 'kiosk.oneDown' : 'kiosk.someDown', { n: down }) : trouble > 0 ? t('kiosk.trouble', { n: trouble }) : maint > 0 ? t('kiosk.maintenance') : t('kiosk.allUp');
  const lat = scoped.filter((m) => displayStatus(m) === 'up' && m.latencyMs != null);
  const avgLat = lat.length ? lat.reduce((a, m) => a + (m.latencyMs ?? 0), 0) / lat.length : null;
  const ups = scoped.filter((m) => m.uptime.h24 != null);
  const avgUp = ups.length ? ups.reduce((a, m) => a + (m.uptime.h24 ?? 0), 0) / ups.length : null;
  const groupName = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g.name])), [groups.data]);
  const active = cfg.incidents ? incidents.data ?? [] : [];

  const tile = (m: MonitorItem) => {
    const s = displayStatus(m);
    const since = m.statusSince ? (now.getTime() - new Date(m.statusSince).getTime()) / 1000 : null;
    return (
      <li key={m.id} className={cx('flex min-h-0 flex-col justify-between gap-1 overflow-hidden rounded-2xl border-2 p-4', look.tile[s] ?? look.neutral)}>
        <div>
          <div className="flex items-start gap-2"><StatusDot status={s} pulse className="mt-2 h-3 w-3" /><span className={cx('min-w-0 flex-1 truncate font-semibold leading-tight', NAME_CLS[cfg.size])}>{m.name}</span></div>
          {!grouped && m.groupId != null && groupName.get(m.groupId) && <div className={cx('truncate pl-5 text-xs', look.faint)}>{groupName.get(m.groupId)}</div>}
        </div>
        {s === 'down' && m.message ? <p className="truncate text-sm font-medium text-red-500" title={m.message}>{m.message}</p> : null}
        {cfg.bars && <HeartbeatBar beats={m.recent} count={cfg.size === 's' ? 24 : 32} height={cfg.size === 's' ? 'h-4' : 'h-6'} />}
        <div className={cx('flex items-end justify-between gap-2', look.muted)}>
          <span className={cx('font-bold tabular-nums', BIG_CLS[cfg.size], cfg.theme === 'dark' ? 'text-white' : 'text-slate-900')}>{s === 'down' ? t(`status.${s}`) : fmtMs(m.latencyMs)}</span>
          <span className="flex flex-col items-end text-sm leading-tight">
            {m.info?.players !== undefined && <PlayersLine info={m.info} short className="font-semibold" />}
            <span>{s !== 'up' && since != null ? t('kiosk.for', { d: fmtDuration(since) }) : <><span className="sr-only">{t('monitors.uptime')} 24h </span>{fmtPct(m.uptime.h24, 2)}</>}</span>
          </span>
        </div>
      </li>
    );
  };
  const head = (r: Extract<Row<MonitorItem>, { kind: 'head' }>) => {
    const ms = r.sec.items;
    const dn = ms.filter((m) => displayStatus(m) === 'down').length, tr = ms.filter((m) => isProblem(displayStatus(m))).length - dn, ok = ms.filter((m) => displayStatus(m) === 'up').length;
    return (
      <li key={`h-${r.sec.key}-${r.cont}`} className={cx('col-span-full flex h-9 items-center gap-3 border-b', cfg.theme === 'dark' ? 'border-slate-700' : 'border-slate-300')}>
        <span className={cx('h-3 w-3 shrink-0 rounded-full', dn ? 'bg-red-500' : tr ? 'bg-amber-500' : ok === ms.length ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden />
        <h2 className="min-w-0 truncate text-xl font-semibold">{r.sec.id == null ? t('kiosk.noGroup') : r.sec.label}{r.cont && <span className={cx('ml-2 text-sm font-normal', look.faint)}>{t('kiosk.groupCont')}</span>}</h2>
        <span className={cx('ml-auto shrink-0 text-sm', dn ? 'font-semibold text-red-500' : look.faint)}>{t('kiosk.groupUp', { n: ok, total: ms.length })}</span>
      </li>
    );
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/kiosk${toParams(cfg).toString() ? `?${toParams(cfg)}` : ''}`); toast(t('kiosk.s.copied')); } catch { toast(t('common.failed'), 'error'); }
  };
  const chip = (n: number, label: string, cls: string) => n > 0 && <span className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold', cls)}>{n} {label}</span>;

  return (
    <div className={cx('flex h-screen flex-col', look.root, idle && 'cursor-none')}>
      <header className={cx('px-6 py-4 text-white', tone)} role="status" aria-live="polite">
        <div className="flex items-center gap-4">
          {down > 0 || trouble > 0 ? <TriangleAlert className="h-10 w-10 shrink-0" aria-hidden /> : maint > 0 ? <Wrench className="h-10 w-10 shrink-0" aria-hidden /> : <CheckCircle2 className="h-10 w-10 shrink-0" aria-hidden />}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-bold sm:text-4xl">{headline}</h1>
            <div className="mt-1 hidden flex-wrap items-center gap-2 sm:flex">
              {chip(up, t('status.up'), 'bg-white/20')}{chip(down, t('status.down'), 'bg-white/25')}{chip(trouble, t('status.pending'), 'bg-white/20')}{chip(maint, t('status.maintenance'), 'bg-white/20')}
              {avgUp != null && <span className="text-sm text-white/85">{t('kiosk.uptime24')} {fmtPct(avgUp, 2)}</span>}
              {avgLat != null && <span className="text-sm text-white/85">· {t('kiosk.avgLatency')} {fmtMs(avgLat)}</span>}
            </div>
          </div>
          {cfg.clock && (
            <time className="hidden text-right sm:block" dateTime={now.toISOString()}>
              <div className="text-4xl font-semibold tabular-nums">{now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</div>
              <div className="text-sm text-white/85">{now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
            </time>
          )}
          <div className={cx('flex shrink-0 gap-1.5', idle && !settings && 'opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100')}>
            <Button size="sm" onClick={() => setSettings(true)} aria-label={t('kiosk.settings')} title={`${t('kiosk.settings')} (S)`}><Settings2 className="h-4 w-4" /></Button>
            <Button size="sm" onClick={toggleFull} aria-label={t(full ? 'kiosk.exitFullscreen' : 'kiosk.fullscreen')} title={`${t(full ? 'kiosk.exitFullscreen' : 'kiosk.fullscreen')} (F)`}>{full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button>
            <Button size="sm" onClick={() => nav('/dashboard')} aria-label={t('kiosk.exit')} title={`${t('kiosk.exit')} (Esc)`}><LogOut className="h-4 w-4" /><span className="hidden lg:inline">{t('kiosk.exit')}</span></Button>
          </div>
        </div>
      </header>

      {active.length > 0 && (
        <section aria-label={t('kiosk.incidents')} className={cx('flex flex-wrap items-center gap-x-6 gap-y-1 border-b px-6 py-2 text-sm', look.strip, cfg.theme === 'dark' ? 'border-slate-800' : 'border-slate-200')}>
          <span className={cx('font-semibold uppercase tracking-wide', look.faint)}>{t('kiosk.incidents')}</span>
          {active.map((i) => (
            <span key={i.id} className="inline-flex min-w-0 items-center gap-2">
              <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', i.severity === 'minor' ? 'bg-amber-500' : 'bg-red-500')} aria-hidden />
              <span className="truncate font-medium">{i.title}</span>
              <span className={look.faint}>{t(`incidents.status.${i.status}`)} · {t('kiosk.for', { d: fmtDuration((now.getTime() - new Date(i.startedAt).getTime()) / 1000) })}</span>
            </span>
          ))}
        </section>
      )}

      <div ref={body} className="min-h-0 flex-1 p-4">
        {monitors.isLoading ? <p className={cx('p-8 text-center', look.faint)}>{t('common.loading')}</p> : list.length === 0 ? <p className={cx('p-8 text-center text-2xl', look.faint)}>{t(scoped.length === 0 ? (monitors.data?.length ? 'kiosk.noMatch' : 'kiosk.empty') : 'kiosk.noProblems')}</p> : (
          grouped ? (
            <ul className="grid h-full content-start gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: (gpages[cur] ?? []).map((r) => (r.kind === 'head' ? '2.25rem' : `${th - 12 * z}px`)).join(' ') }}>
              {(gpages[cur] ?? []).flatMap((r) => (r.kind === 'head' ? [head(r)] : r.items.map(tile)))}
            </ul>
          ) : (
            <ul className="grid h-full gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
              {visible.map(tile)}
            </ul>
          )
        )}
      </div>

      <footer className={cx('relative flex items-center justify-between gap-3 px-6 pb-2 pt-1 text-xs', look.faint)}>
        {rotating && <><style>{'@keyframes kiosk-progress{from{width:0}to{width:100%}}'}</style><div key={`${cur}-${cfg.rotate}`} className="absolute inset-x-0 top-0 h-0.5 bg-white/0"><div className={cx('h-full motion-reduce:hidden', cfg.theme === 'dark' ? 'bg-white/40' : 'bg-slate-400')} style={{ animation: `kiosk-progress ${cfg.rotate}s linear` }} /></div></>}
        <span className="hidden min-w-0 truncate md:inline">{t('kiosk.hints')}</span>
        {pages > 1 ? (
          <nav className="flex items-center gap-2" aria-label={t('kiosk.pages')}>
            {Array.from({ length: pages }, (_, i) => <button key={i} type="button" onClick={() => setPage(i)} aria-label={t('kiosk.page', { n: i + 1 })} aria-current={i === cur} className={cx('h-2.5 rounded-full transition-all', i === cur ? (cfg.theme === 'dark' ? 'w-8 bg-white' : 'w-8 bg-slate-800') : (cfg.theme === 'dark' ? 'w-2.5 bg-slate-600' : 'w-2.5 bg-slate-300'))} />)}
            <span className="ml-1 tabular-nums">{t('kiosk.pageOf', { n: cur + 1, total: pages })}</span>
          </nav>
        ) : <span />}
        <span className="flex items-center gap-3">
          {pages > 1 && cfg.rotate > 0 && <button type="button" onClick={() => setPaused((p) => !p)} className="inline-flex items-center gap-1 hover:underline" aria-label={t(paused ? 'kiosk.play' : 'kiosk.pause')}>{paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{paused ? t('kiosk.paused') : null}</button>}
          <span className="tabular-nums">{t('kiosk.updated', { when: monitors.dataUpdatedAt ? new Date(monitors.dataUpdatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–' })}</span>
        </span>
      </footer>

      <Modal open={settings} onClose={() => setSettings(false)} title={t('kiosk.s.title')} wide footer={<><Button onClick={() => void copyLink()}><Link2 className="h-4 w-4" />{t('kiosk.s.link')}</Button><Button variant="primary" onClick={() => setSettings(false)}>{t('common.close')}</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('kiosk.s.groups')}>{() => <MultiSelect label={t('kiosk.s.groups')} allLabel={t('kiosk.s.allGroups')} options={(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))} value={cfg.groups} onChange={(v) => set('groups', v)} />}</Field>
          <Field label={t('kiosk.s.tags')}>{() => <MultiSelect label={t('kiosk.s.tags')} allLabel={t('kiosk.s.allTags')} options={[...new Set((tags.data ?? []).map((x) => x.name))].map((n) => ({ value: n, label: n }))} value={cfg.tags} onChange={(v) => set('tags', v)} />}</Field>
          <Field label={t('kiosk.s.view')}>{(i) => <Select id={i} value={cfg.view} onChange={(e) => set('view', e.target.value as View)}>{(['all', 'auto', 'problems'] as const).map((v) => <option key={v} value={v}>{t(`kiosk.s.view.${v}`)}</option>)}</Select>}</Field>
          <Field label={t('kiosk.s.layout')}>{(i) => <Select id={i} value={cfg.layout} onChange={(e) => set('layout', e.target.value as Layout)}>{(['flat', 'grouped'] as const).map((v) => <option key={v} value={v}>{t(`kiosk.s.layout.${v}`)}</option>)}</Select>}</Field>
          <Field label={t('kiosk.s.size')}>{(i) => <Select id={i} value={cfg.size} onChange={(e) => set('size', e.target.value as Size)}>{(['s', 'm', 'l'] as const).map((v) => <option key={v} value={v}>{t(`kiosk.s.size.${v}`)}</option>)}</Select>}</Field>
          <Field label={t('kiosk.s.zoom', { n: cfg.zoom })}>{(i) => <input id={i} type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={5} value={cfg.zoom} onChange={(e) => set('zoom', clampZoom(Number(e.target.value)))} className="w-full accent-indigo-600" />}</Field>
          <Field label={t('kiosk.s.rotate')}>{(i) => <Select id={i} value={cfg.rotate} onChange={(e) => set('rotate', Number(e.target.value))}>{(ROTATIONS.includes(cfg.rotate) ? ROTATIONS : [...ROTATIONS, cfg.rotate].sort((a, b) => a - b)).map((n) => <option key={n} value={n}>{n === 0 ? t('kiosk.s.rotateOff') : t('kiosk.s.rotateN', { n })}</option>)}</Select>}</Field>
          <Field label={t('kiosk.s.theme')}>{(i) => <Select id={i} value={cfg.theme} onChange={(e) => set('theme', e.target.value as Cfg['theme'])}><option value="dark">{t('kiosk.s.theme.dark')}</option><option value="light">{t('kiosk.s.theme.light')}</option></Select>}</Field>
          <div className="sm:col-span-2">
            <span className="label">{t('kiosk.s.monitors')}</span>
            <MonitorPicker monitors={(monitors.data ?? []).filter((m) => displayStatus(m) !== 'paused')} groups={groups.data ?? []} value={cfg.monitors} onChange={(v) => set('monitors', v)} />
            <p className="hint mt-2">{t('kiosk.s.monitorsHint')}</p>
          </div>
          <div className="flex flex-col items-start gap-3 sm:col-span-2">
            <Toggle checked={cfg.bars} onChange={(v) => set('bars', v)} label={t('kiosk.s.bars')} />
            <Toggle checked={cfg.incidents} onChange={(v) => set('incidents', v)} label={t('kiosk.s.incidents')} />
            <Toggle checked={cfg.clock} onChange={(v) => set('clock', v)} label={t('kiosk.s.clock')} />
            <p className="hint">{t('kiosk.s.linkHint')}</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
