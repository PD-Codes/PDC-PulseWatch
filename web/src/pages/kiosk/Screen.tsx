import { CheckCircle2, Hourglass, LogOut, Maximize2, Minimize2, Pause, Play, Settings2, TriangleAlert, WifiOff, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clampZoom, KIOSK_DEFAULTS, type KioskConfig } from '../../../../src/core/kiosk';
import { Button, cx } from '../../components/ui';
import type { HistoryResponse, KioskIncident } from '../../lib/api';
import { fmtDuration, fmtMs, fmtPct } from '../../lib/format';
import { useI18n, useT } from '../../lib/i18n';
import { parseReloads, RELOAD_KEY, reloadDelay } from '../../lib/kioskReload';
import { applyTheme, isThemeId } from '../../lib/theme';
import { useVersionMismatch } from '../../lib/useVersionCheck';
import { byUrgency, needsAttention, summarize, viewStatus, type GroupLike } from '../../lib/viewModel';
import { planDisplay } from './displays';
import { isDark, LOOKS, type DisplayCtx, type ScreenMonitor } from './shared';

/** Last good data older than this, or the live connection down longer than LOST_MS, puts up the warning strip. */
const STALE_MS = 120_000;
const LOST_MS = 60_000;

export interface ScreenProps {
  cfg: KioskConfig;
  /** The monitors in scope, paused ones excluded; undefined while loading. */
  monitors: ScreenMonitor[] | undefined;
  /** Shown when the scope holds no monitor. */
  emptyText: string;
  groups: GroupLike[];
  incidents: KioskIncident[];
  history?: HistoryResponse;
  /** When the last data arrived (ms); 0 before any. */
  dataAt: number;
  connected: boolean;
  /** Opened with a kiosk key: no settings, no exit. */
  keyMode: boolean;
  presetName?: string | null;
  onZoom: (zoom: number) => void;
  onSettings?: () => void;
  onExit?: () => void;
  /** Settings are open: rotation and keys wait. */
  hold?: boolean;
  notice?: ReactNode;
  children?: ReactNode;
}

/** The wall display itself: header band, incidents, the chosen display in pages, footer. Shared by both ways in. */
export function Screen({ cfg, monitors, emptyText, groups, incidents, history, dataAt, connected, keyMode, presetName, onZoom, onSettings, onExit, hold = false, notice, children }: ScreenProps) {
  const t = useT();
  const { locale } = useI18n();
  const dark = isDark(cfg);
  const look = LOOKS[dark ? 'dark' : 'light'];
  const mismatch = useVersionMismatch();
  const body = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 1280, h: 640 });
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [full, setFull] = useState(!!document.fullscreenElement);
  const [idle, setIdle] = useState(false);
  const [lostAt, setLostAt] = useState<number | null>(() => Date.now());

  useEffect(() => { setLostAt(connected ? null : Date.now()); }, [connected]);
  useEffect(() => { document.title = `${presetName ? `${presetName} · ` : ''}${t('kiosk.title')} · PulseWatch`; }, [t, presetName]);
  // zoom scales the root font size, so everything sized in rem (text, padding, tiles) grows together; the layouts use the same factor
  useEffect(() => {
    const root = document.documentElement;
    const was = root.style.fontSize;
    root.style.fontSize = `${(16 * cfg.zoom) / 100}px`;
    return () => { root.style.fontSize = was; };
  }, [cfg.zoom]);
  // the wall display has its own theme; it is applied without touching what this device chose, and dropped on leaving
  useEffect(() => { applyTheme(isThemeId(cfg.theme) ? cfg.theme : 'classic', cfg.mode); }, [cfg.theme, cfg.mode]);
  useEffect(() => () => applyTheme(), []);
  // a wall display runs for weeks: after an update of the server, load the new version by itself. Attempts are counted per tab,
  // so a version that stays different (two instances behind one load balancer) costs three reloads and then one every 6 hours.
  useEffect(() => {
    if (!mismatch) return;
    let store: Storage | null = null;
    try { store = sessionStorage; } catch { /* storage unavailable: no automatic reload, the update banner remains */ }
    if (!store) return;
    const state = parseReloads(store.getItem(RELOAD_KEY), Date.now());
    const timer = setTimeout(() => {
      try { store!.setItem(RELOAD_KEY, JSON.stringify({ n: state.n + 1, at: Date.now() })); } catch { return; }
      location.reload();
    }, reloadDelay(state, Date.now()));
    return () => clearTimeout(timer);
  }, [mismatch]);
  useEffect(() => { const i = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setArea({ w: el.clientWidth, h: el.clientHeight });
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

  const sorted = useMemo(() => [...(monitors ?? [])].sort(byUrgency), [monitors]);
  const sum = useMemo(() => summarize(sorted), [sorted]);
  const problems = useMemo(() => sorted.filter((m) => needsAttention(viewStatus(m))), [sorted]);
  // "auto" shows everything while nothing is wrong, as its label says; "problems" shows the all-clear screen then
  const list = cfg.show === 'problems' || (cfg.show === 'auto' && problems.length) ? problems : sorted;
  const allClear = cfg.show === 'problems' && sorted.length > 0 && problems.length === 0;
  const groupPath = useMemo(() => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const path = (id: number) => { const names: string[] = []; for (let g = byId.get(id), n = 0; g && n < 10; g = g.parentId != null ? byId.get(g.parentId) : undefined, n++) names.unshift(g.name); return names.join(' / '); };
    return new Map(groups.map((g) => [g.id, path(g.id)]));
  }, [groups]);

  const z = cfg.zoom / 100;
  const plan = useMemo(() => planDisplay({ cfg, list, groups, w: area.w, h: area.h, z, history: cfg.display === 'heatmap' ? history : undefined }),
    // only what changes the layout: cfg as a whole changes identity with every render of the parent
    [cfg.display, cfg.size, cfg.grouped, cfg.bars, list, groups, area.w, area.h, z, history]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = allClear ? 1 : plan.pages;
  const cur = Math.min(page, pages - 1);
  const go = (d: number) => setPage((p) => (Math.min(p, pages - 1) + d + pages) % pages);

  const rotating = cfg.rotate > 0 && pages > 1 && !paused && !hold;
  useEffect(() => {
    if (!rotating) return;
    const i = setInterval(() => setPage((p) => (p + 1) % pages), cfg.rotate * 1000);
    return () => clearInterval(i);
  }, [rotating, pages, cfg.rotate]);
  // a new problem should be seen at once, not on page four
  const seenDown = useRef(0);
  useEffect(() => { if (sum.down > seenDown.current) setPage(0); seenDown.current = sum.down; }, [sum.down]);

  const toggleFull = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.().catch(() => {}); };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (hold || (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { if (onExit && !document.fullscreenElement) onExit(); }
      else if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p); }
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'f' || e.key === 'F') toggleFull();
      // the dialog focuses its preset select at once: without preventDefault the same key press would pick a preset by type-ahead
      else if ((e.key === 's' || e.key === 'S') && onSettings) { e.preventDefault(); onSettings(); }
      else if (e.key === '+' || e.key === '=') onZoom(clampZoom(cfg.zoom + 10));
      else if (e.key === '-') onZoom(clampZoom(cfg.zoom - 10));
      else if (e.key === '0') onZoom(KIOSK_DEFAULTS.zoom);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const nowMs = now.getTime();
  const lost = lostAt != null && nowMs - lostAt > LOST_MS;
  const stale = dataAt > 0 && (lost || nowMs - dataAt > STALE_MS);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const { down, attention: trouble, maintenance: maint, up } = sum;
  // a screen that cannot vouch for its data must not glow green
  // "all operational" only when every monitor is up or in maintenance: monitors without a result yet (unknown) keep it neutral
  const waiting = down === 0 && trouble === 0 && sum.other > 0;
  const tone = sum.total === 0 ? 'bg-slate-700' : down > 0 ? 'bg-red-700' : trouble > 0 ? 'bg-amber-600' : stale || waiting ? 'bg-slate-700' : maint > 0 ? 'bg-sky-700' : 'bg-emerald-700';
  const headline = sum.total === 0 ? (presetName || t('kiosk.title')) : down > 0 ? t(down === 1 ? 'kiosk.oneDown' : 'kiosk.someDown', { n: down }) : trouble > 0 ? t('kiosk.trouble', { n: trouble }) : waiting ? t('kiosk.waiting') : maint > 0 ? t('kiosk.maintenance') : t('kiosk.allUp');
  const lat = sorted.filter((m) => viewStatus(m) === 'up' && m.latencyMs != null);
  const avgLat = lat.length ? lat.reduce((a, m) => a + (m.latencyMs ?? 0), 0) / lat.length : null;
  const active = cfg.incidents ? incidents : [];
  const ctx: DisplayCtx = { t, cfg, look, dark, now: nowMs, z, groupPath, hourLabel: (d) => d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) };
  const chip = (n: number, label: string, cls: string) => n > 0 && <span className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold', cls)}>{n} {label}</span>;

  return (
    <div className={cx('flex h-screen flex-col overflow-hidden', look.root, idle && 'cursor-none')}>
      <header className={cx('px-6 py-4 text-white', tone)} role="status" aria-live="polite">
        <div className="flex items-center gap-4">
          {down > 0 || trouble > 0 ? <TriangleAlert className="h-10 w-10 shrink-0" aria-hidden /> : waiting ? <Hourglass className="h-10 w-10 shrink-0" aria-hidden /> : maint > 0 ? <Wrench className="h-10 w-10 shrink-0" aria-hidden /> : <CheckCircle2 className="h-10 w-10 shrink-0" aria-hidden />}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-bold sm:text-4xl">{headline}</h1>
            <div className="mt-1 hidden flex-wrap items-center gap-2 sm:flex">
              {chip(up, t('status.up'), 'bg-white/20')}{chip(down, t('status.down'), 'bg-white/25')}{chip(trouble, t('status.pending'), 'bg-white/20')}{chip(maint, t('status.maintenance'), 'bg-white/20')}{chip(sum.other, t('status.unknown'), 'bg-white/20')}
              {sum.uptime24 != null && <span className="text-sm text-white/85">{t('kiosk.uptime24')} {fmtPct(sum.uptime24, 2)}</span>}
              {avgLat != null && <span className="text-sm text-white/85">· {t('kiosk.avgLatency')} {fmtMs(avgLat)}</span>}
            </div>
          </div>
          {cfg.clock && (
            <time className="hidden text-right sm:block" dateTime={now.toISOString()}>
              <div className="text-4xl font-semibold tabular-nums">{now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</div>
              <div className="text-sm text-white/85">{now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
            </time>
          )}
          <div className={cx('flex shrink-0 gap-1.5', idle && !hold && 'opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100')}>
            {onSettings && <Button size="sm" onClick={onSettings} aria-label={t('kiosk.settings')} title={`${t('kiosk.settings')} (S)`}><Settings2 className="h-4 w-4" /></Button>}
            <Button size="sm" onClick={toggleFull} aria-label={t(full ? 'kiosk.exitFullscreen' : 'kiosk.fullscreen')} title={`${t(full ? 'kiosk.exitFullscreen' : 'kiosk.fullscreen')} (F)`}>{full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button>
            {onExit && <Button size="sm" onClick={onExit} aria-label={t('kiosk.exit')} title={`${t('kiosk.exit')} (Esc)`}><LogOut className="h-4 w-4" /><span className="hidden lg:inline">{t('kiosk.exit')}</span></Button>}
          </div>
        </div>
      </header>

      {stale && (
        <div role="alert" className="flex items-center gap-3 bg-amber-400 px-6 py-2 text-lg font-semibold text-slate-950">
          <WifiOff className="h-6 w-6 shrink-0" aria-hidden />
          <span className="truncate">{t('kiosk.stale', { time: clock(dataAt) })} · {t(lost ? 'kiosk.stale.lost' : 'kiosk.stale.late')}</span>
        </div>
      )}
      {notice}

      {active.length > 0 && (
        <section aria-label={t('kiosk.incidents')} className={cx('flex flex-wrap items-center gap-x-6 gap-y-1 border-b px-6 py-2 text-sm', look.strip, look.stripLine)}>
          <span className={cx('font-semibold uppercase tracking-wide', look.faint)}>{t('kiosk.incidents')}</span>
          {active.map((i) => (
            <span key={i.id} className="inline-flex min-w-0 items-center gap-2">
              <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', i.severity === 'minor' ? 'bg-amber-500' : 'bg-red-500')} aria-hidden />
              <span className="truncate font-medium">{i.title}</span>
              <span className={look.faint}>{t(`incidents.status.${i.status}`)} · {t('kiosk.for', { d: fmtDuration((nowMs - Date.parse(i.startedAt)) / 1000) })}</span>
            </span>
          ))}
        </section>
      )}

      <div className="min-h-0 flex-1 p-4">
        <div ref={body} className="h-full overflow-hidden">
          {monitors === undefined ? <p className={cx('p-8 text-center text-2xl', look.faint)}>{t('common.loading')}</p>
            : sorted.length === 0 ? <p className={cx('p-8 text-center text-2xl', look.faint)}>{emptyText}</p>
            : allClear ? (
              <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                {waiting ? <Hourglass className={cx('h-32 w-32', look.faint)} aria-hidden /> : <CheckCircle2 className="h-32 w-32 text-emerald-500" aria-hidden />}
                <p className="text-5xl font-bold">{t(waiting ? 'kiosk.waiting' : 'kiosk.allUp')}</p>
                <p className={cx('text-2xl tabular-nums', look.muted)}>{t('kiosk.clear.counts', { n: up, total: sum.total })}{maint > 0 && ` · ${t('kiosk.clear.maint', { n: maint })}`}</p>
              </div>
            ) : plan.render(cur, ctx)}
        </div>
      </div>

      <footer className={cx('relative flex items-center justify-between gap-3 px-6 pb-2 pt-1 text-xs', look.faint)}>
        {rotating && <><style>{'@keyframes kiosk-progress{from{width:0}to{width:100%}}'}</style><div key={`${cur}-${cfg.rotate}`} className="absolute inset-x-0 top-0 h-0.5"><div className={cx('h-full motion-reduce:hidden', dark ? 'bg-white/40' : 'bg-slate-400')} style={{ animation: `kiosk-progress ${cfg.rotate}s linear` }} /></div></>}
        <span className="hidden min-w-0 truncate md:inline">{presetName ? <span className="mr-3 font-semibold">{presetName}</span> : null}{t(keyMode ? 'kiosk.hintsKey' : 'kiosk.hints')}</span>
        {pages > 1 ? (
          <nav className="flex items-center gap-2" aria-label={t('kiosk.pages')}>
            {Array.from({ length: pages }, (_, i) => <button key={i} type="button" onClick={() => setPage(i)} aria-label={t('kiosk.page', { n: i + 1 })} aria-current={i === cur} className={cx('h-2.5 rounded-full transition-all', i === cur ? (dark ? 'w-8 bg-white' : 'w-8 bg-slate-800') : (dark ? 'w-2.5 bg-slate-600' : 'w-2.5 bg-slate-300'))} />)}
            <span className="ml-1 tabular-nums">{t('kiosk.pageOf', { n: cur + 1, total: pages })}</span>
          </nav>
        ) : <span />}
        <span className="flex items-center gap-3">
          {pages > 1 && cfg.rotate > 0 && <button type="button" onClick={() => setPaused((p) => !p)} className="inline-flex items-center gap-1 hover:underline" aria-label={t(paused ? 'kiosk.play' : 'kiosk.pause')}>{paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{paused ? t('kiosk.paused') : null}</button>}
          <span className="tabular-nums">{t('kiosk.updated', { when: dataAt ? new Date(dataAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–' })}</span>
        </span>
      </footer>
      {children}
    </div>
  );
}

/** Full-screen message for a screen that cannot show monitors (bad kiosk key, server not reachable yet). */
export function ScreenMessage({ title, body, tone = 'neutral' }: { title: string; body?: string; tone?: 'neutral' | 'error' }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-950 px-8 text-center text-white" role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'error' ? <TriangleAlert className="h-20 w-20 text-amber-400" aria-hidden /> : null}
      <p className="max-w-3xl text-4xl font-semibold">{title}</p>
      {body && <p className="max-w-3xl text-xl text-slate-300">{body}</p>}
    </div>
  );
}
