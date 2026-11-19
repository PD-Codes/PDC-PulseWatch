import { useQuery } from '@tanstack/react-query';
import { Activity, Command, Keyboard, LogOut, Menu, Monitor, Plus, UserRound, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, type MonitorItem } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { useBrowserAlerts } from '../lib/browserAlerts';
import { useT } from '../lib/i18n';
import { pushLayer } from '../lib/modalStack';
import { recordRecentMonitor } from '../lib/recent';
import { useStreamState } from '../lib/stream';
import { BUILD_VERSION, useVersionMismatch } from '../lib/useVersionCheck';
import { CommandPalette } from './CommandPalette';
import { visibleNav, type NavItem } from './nav';
import { ShortcutsHelp, useShortcuts } from './Shortcuts';
import { ThemePicker } from './ThemePicker';
import { cx } from './ui';

const ITEM = 'pw-nav-item flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm font-medium transition';
const ITEM_ON = 'bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100';
const ITEM_OFF = 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800';

const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** Slide-in menu below the lg breakpoint: a real modal layer (focus moves in and is trapped, Escape closes, the page behind is inert). */
function MobileMenu({ open, onClose, returnTo, children }: { open: boolean; onClose: () => void; returnTo: RefObject<HTMLElement | null>; children: ReactNode }) {
  const t = useT();
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const layer = pushLayer(backdrop.current);
    const focusables = () => [...(panel.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])].filter((el) => !el.closest('[data-menu-close]'));
    (focusables()[0] ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (e.key === 'Escape') { e.preventDefault(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const f = [...(panel.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])];
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); layer.release(); returnTo.current?.focus(); };
  }, [open, returnTo]);
  if (!open) return null;
  return createPortal(
    <div ref={backdrop} className="pw-menu-layer fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('nav.menu')}>
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <aside ref={panel} tabIndex={-1} className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl dark:bg-slate-900">
        <button type="button" data-menu-close className="btn btn-ghost btn-sm absolute right-2 top-2 z-10" onClick={onClose} aria-label={t('common.close')}><X className="h-4 w-4" /></button>
        {children}
      </aside>
    </div>,
    document.body,
  );
}

/** Profile, sign out and version behind the avatar. */
function AvatarMenu({ onLogout }: { onLogout: () => void }) {
  const t = useT();
  const { user } = useAuth();
  const meta = useMeta();
  const mismatch = useVersionMismatch();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', down);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); return; }
    if (e.key === 'Tab') { setOpen(false); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const name = user?.displayName ?? '?';
  const row = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800';
  return (
    <div ref={wrap} className="relative ml-1" onKeyDown={onKey}>
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={name} aria-label={`${t('shell.account')}: ${name}`}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">{name.slice(0, 1).toUpperCase()}</button>
      {open && (
        <div role="menu" aria-label={t('shell.account')} className="card absolute right-0 top-full z-40 mt-2 w-60 p-1 shadow-lg">
          <div className="px-3 py-2">
            <div className="truncate text-sm font-semibold">{name}</div>
            <div className="truncate text-xs text-slate-500">{user?.username}{user?.role ? ` · ${t(`users.role.${user.role}`)}` : ''}</div>
          </div>
          <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
          <NavLink to="/profile" role="menuitem" className={cx(row, 'no-underline')}><UserRound className="h-4 w-4" />{t('nav.profile')}</NavLink>
          <button type="button" role="menuitem" onClick={onLogout} className={row}><LogOut className="h-4 w-4" />{t('nav.logout')}</button>
          <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
          <div className="px-3 py-1.5 text-xs text-slate-400">
            {meta?.brand.name ?? 'PulseWatch'} v{meta?.version ?? BUILD_VERSION}{meta?.demo ? ' · demo' : ''}
            {mismatch && <button type="button" role="menuitem" onClick={() => location.reload()} className="mt-1 block text-brand-600 underline dark:text-brand-400">{t('shell.update.reload')}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Quiet notice that the server runs a newer version than this page. */
function UpdateBanner() {
  const t = useT();
  const mismatch = useVersionMismatch();
  const [hidden, setHidden] = useState(false);
  if (!mismatch || hidden) return null;
  return (
    <div role="status" className="pw-update-banner flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-brand-200 bg-brand-50 px-3 py-1.5 text-sm text-brand-800 dark:border-brand-700/40 dark:bg-brand-700/15 dark:text-brand-100">
      <span>{t('shell.update.available')}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => location.reload()}>{t('shell.update.reload')}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHidden(true)} aria-label={t('common.close')}><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

export function Layout() {
  const t = useT();
  const { can, logout } = useAuth();
  const meta = useMeta();
  const { connected } = useStreamState();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  useShortcuts({ openPalette: () => setPalette(true), openHelp: () => setHelp(true) });
  useBrowserAlerts(); // desktop notifications on status changes (settings on the profile page)
  useEffect(() => setOpen(false), [loc.pathname]);
  // opened monitors feed the "recent" list of the command palette
  useEffect(() => { const m = /^\/monitors\/(\d+)(?:\/|$)/.exec(loc.pathname); if (m) recordRecentMonitor(Number(m[1])); }, [loc.pathname]);

  // the monitor list powers the dashboard, the palette and live updates, so it is loaded once here
  useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors'), staleTime: 30_000 });

  // open and not yet acknowledged incidents; the SSE stream invalidates the 'incidents' key on every change
  const openIncidents = useQuery({ queryKey: ['incidents', 'open-count'], queryFn: () => get<{ count: number }>('/api/incidents/open-count'), staleTime: 30_000 }).data?.count ?? 0;
  useEffect(() => {
    const el = document.querySelector('title');
    if (!el) return;
    const apply = () => {
      const base = document.title.replace(/^\(\d+\) /, '');
      const want = openIncidents ? `(${openIncidents}) ${base}` : base;
      if (document.title !== want) document.title = want;
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    return () => mo.disconnect();
  }, [openIncidents]);

  const groups = useMemo(() => visibleNav(can), [can]);
  const badge = (i: NavItem) => (i.badge === 'incidents' ? openIncidents : 0);
  const link = (i: NavItem) => {
    const n = badge(i);
    return (
      <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => cx(ITEM, isActive ? ITEM_ON : ITEM_OFF)}>
        <i.icon className="h-4 w-4 shrink-0" aria-hidden />{t(i.label)}
        {!!n && <span className="ml-auto rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold leading-none text-white" aria-label={t('nav.openIncidents', { n })}>{n > 99 ? '99+' : n}</span>}
      </NavLink>
    );
  };

  // brand and footer stay put, only the menu in between scrolls (small screens, many entries)
  const sidebar = (
    <div className="pw-sidebar flex h-full min-h-0 flex-col">
      <div className="pw-brand flex shrink-0 items-center gap-2 px-5 py-3">
        <img src="/icon.svg" alt="" className="h-7 w-7" />
        <span className="truncate text-lg font-semibold tracking-tight">{meta?.brand.name ?? 'PulseWatch'}</span>
      </div>
      <nav aria-label={t('nav.menu')} className="pw-nav min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {groups.map((g) => (
          <div key={g.id} role="group" aria-labelledby={`nav-${g.id}`} className="pw-nav-section">
            <div id={`nav-${g.id}`} className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{t(g.label)}</div>
            <div className="space-y-0.5">{g.items.map(link)}</div>
          </div>
        ))}
      </nav>
      <div className="pw-sidebar-footer shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
        <button type="button" onClick={() => setHelp(true)} className={cx(ITEM, ITEM_OFF, 'w-full text-xs')}><Keyboard className="h-4 w-4 shrink-0" aria-hidden />{t('shortcuts.title')}<span className="kbd ml-auto">?</span></button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded focus:bg-white focus:px-3 focus:py-2 dark:focus:bg-slate-900">{t('nav.skip')}</a>
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:block">{sidebar}</aside>
      <MobileMenu open={open} onClose={() => setOpen(false)} returnTo={menuBtn}>{sidebar}</MobileMenu>
      <div className="lg:pl-60">
        <header className="pw-topbar sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/90 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 sm:px-5">
          <button ref={menuBtn} type="button" className="btn btn-ghost btn-sm lg:hidden" onClick={() => setOpen(true)} aria-label={t('nav.menu')}><Menu className="h-5 w-5" /></button>
          <button type="button" onClick={() => setPalette(true)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 sm:max-w-md">
            <Command className="h-4 w-4 shrink-0" /><span className="truncate">{t('topbar.search')}</span><span className="kbd ml-auto hidden sm:inline">{IS_MAC ? '⌘ K' : 'Ctrl K'}</span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            {can('editor') && <NavLink to="/monitors/new" className="btn btn-primary btn-sm no-underline" title={t('topbar.addMonitor')} aria-label={t('topbar.addMonitor')}><Plus className="h-4 w-4" /></NavLink>}
            <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs', connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')} role="status" title={connected ? t('topbar.live') : t('topbar.offline')}>
              <Activity className="h-3.5 w-3.5" /><span className="hidden sm:inline">{connected ? t('topbar.live') : t('topbar.offline')}</span><span className="sr-only sm:hidden">{connected ? t('topbar.live') : t('topbar.offline')}</span>
            </span>
            <NavLink to="/kiosk" className="btn btn-ghost btn-sm no-underline" title={t('nav.kiosk')} aria-label={t('nav.kiosk')}><Monitor className="h-4 w-4" /></NavLink>
            <ThemePicker variant="compact" />
            <AvatarMenu onLogout={() => void logout().then(() => nav('/login'))} />
          </div>
        </header>
        <UpdateBanner />
        <main id="main" tabIndex={-1} className="pw-main mx-auto max-w-[1700px] p-4 sm:p-6"><Outlet /></main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} onHelp={() => setHelp(true)} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
