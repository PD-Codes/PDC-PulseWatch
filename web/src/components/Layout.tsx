import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Bell, BookOpen, ChartNoAxesCombined, ClipboardList, Command, FolderTree, Globe, LayoutDashboard, LogOut, MapPin, Menu, Monitor, Moon, Plus, ScrollText, Settings, Sun, SunMoon, Users, Wrench, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, type MonitorItem } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { useT } from '../lib/i18n';
import { useStreamState } from '../lib/stream';
import { useTheme } from '../lib/theme';
import { CommandPalette } from './CommandPalette';
import { ShortcutsHelp, useShortcuts } from './Shortcuts';
import { cx } from './ui';

interface Item { to: string; label: string; icon: ReactNode; role?: 'editor' | 'admin'; end?: boolean; badge?: number }

export function Layout() {
  const t = useT();
  const { user, can, logout } = useAuth();
  const meta = useMeta();
  const { connected } = useStreamState();
  const theme = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  useShortcuts({ openPalette: () => setPalette(true), openHelp: () => setHelp(true) });
  useEffect(() => setOpen(false), [loc.pathname]);

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

  const main: Item[] = [
    { to: '/', label: t('nav.dashboard'), icon: <LayoutDashboard className="h-4 w-4" />, end: true },
    { to: '/incidents', label: t('nav.incidents'), icon: <AlertTriangle className="h-4 w-4" />, badge: openIncidents },
    { to: '/maintenance', label: t('nav.maintenance'), icon: <Wrench className="h-4 w-4" /> },
    { to: '/status-pages', label: t('nav.statusPages'), icon: <Globe className="h-4 w-4" /> },
    { to: '/insights', label: t('nav.insights'), icon: <ChartNoAxesCombined className="h-4 w-4" /> },
    { to: '/reports', label: t('nav.reports'), icon: <BookOpen className="h-4 w-4" /> },
  ];
  const manage = ([
    { to: '/notifications', label: t('nav.notifications'), icon: <Bell className="h-4 w-4" />, role: 'editor' },
    { to: '/probes', label: t('nav.probes'), icon: <MapPin className="h-4 w-4" />, role: 'editor' },
    { to: '/groups', label: t('nav.groups'), icon: <FolderTree className="h-4 w-4" />, role: 'editor' },
    { to: '/users', label: t('nav.users'), icon: <Users className="h-4 w-4" />, role: 'admin' },
    { to: '/audit', label: t('nav.audit'), icon: <ScrollText className="h-4 w-4" />, role: 'admin' },
    { to: '/settings', label: t('nav.settings'), icon: <Settings className="h-4 w-4" />, role: 'admin' },
  ] as Item[]).filter((i) => !i.role || can(i.role));

  const link = (i: Item) => (
    <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => cx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition', isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
      {i.icon}{i.label}
      {!!i.badge && <span className="ml-auto rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold leading-none text-white" aria-label={t('nav.openIncidents', { n: i.badge })}>{i.badge > 99 ? '99+' : i.badge}</span>}
    </NavLink>
  );
  const ThemeIcon = theme.pref === 'system' ? SunMoon : theme.dark ? Moon : Sun;
  const cycleTheme = () => theme.set(theme.pref === 'system' ? 'light' : theme.pref === 'light' ? 'dark' : 'system');

  const sidebar = (
    <nav aria-label={t('nav.menu')} className="flex h-full flex-col gap-1 p-3">
      <div className="mb-3 flex items-center gap-2 px-2 py-1.5">
        <img src="/icon.svg" alt="" className="h-7 w-7" />
        <span className="text-lg font-semibold tracking-tight">{meta?.brand.name ?? 'PulseWatch'}</span>
      </div>
      {main.map(link)}
      {manage.length > 0 && <div className="mt-4 px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('nav.manage')}</div>}
      {manage.map(link)}
      <div className="mt-auto space-y-1 border-t border-slate-200 pt-3 dark:border-slate-800">
        {link({ to: '/kiosk', label: t('nav.kiosk'), icon: <Monitor className="h-4 w-4" /> })}
        {link({ to: '/profile', label: t('nav.profile'), icon: <ClipboardList className="h-4 w-4" /> })}
        <button type="button" onClick={() => void logout().then(() => nav('/login'))} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"><LogOut className="h-4 w-4" />{t('nav.logout')}</button>
        <div className="px-3 pt-1 text-xs text-slate-400">v{meta?.version}{meta?.demo ? ' · demo' : ''}</div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded focus:bg-white focus:px-3 focus:py-2 dark:focus:bg-slate-900">{t('nav.skip')}</a>
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 overflow-y-auto bg-white shadow-xl dark:bg-slate-900">
            <button type="button" className="btn btn-ghost btn-sm absolute right-2 top-2" onClick={() => setOpen(false)} aria-label={t('common.close')}><X className="h-4 w-4" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/90 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 sm:px-5">
          <button type="button" className="btn btn-ghost btn-sm lg:hidden" onClick={() => setOpen(true)} aria-label={t('nav.menu')}><Menu className="h-5 w-5" /></button>
          <button type="button" onClick={() => setPalette(true)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 sm:max-w-md">
            <Command className="h-4 w-4 shrink-0" /><span className="truncate">{t('topbar.search')}</span><span className="kbd ml-auto hidden sm:inline">Ctrl K</span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            {can('editor') && <NavLink to="/monitors/new" className="btn btn-primary btn-sm no-underline" title={t('topbar.addMonitor')} aria-label={t('topbar.addMonitor')}><Plus className="h-4 w-4" /></NavLink>}
            <span className={cx('hidden items-center gap-1.5 rounded-full px-2 py-1 text-xs sm:inline-flex', connected ? 'text-emerald-600' : 'text-amber-600')} role="status"><Activity className="h-3.5 w-3.5" />{connected ? t('topbar.live') : t('topbar.offline')}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cycleTheme} title={`${t('topbar.theme')}: ${t(`theme.${theme.pref}`)}`} aria-label={`${t('topbar.theme')}: ${t(`theme.${theme.pref}`)}`}><ThemeIcon className="h-4 w-4" /></button>
            <NavLink to="/profile" className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white" aria-label={t('nav.profile')} title={user?.displayName}>{(user?.displayName ?? '?').slice(0, 1).toUpperCase()}</NavLink>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-7xl p-4 sm:p-6"><Outlet /></main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
