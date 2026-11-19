import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { MonitorItem } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { pushLayer } from '../lib/modalStack';
import { getRecentMonitors } from '../lib/recent';
import { useTheme } from '../lib/theme';
import { visibleNav } from './nav';
import { displayStatus, StatusDot } from './status';
import { cx } from './ui';

interface Entry { id: string; label: string; hint?: string; group: string; keywords?: string; run: () => void; status?: ReturnType<typeof displayStatus> }

/** Monitor hits shown at once; the rest is announced in the list instead of being cut off silently. */
const MAX_MONITORS = 30;
const RECENT_SHOWN = 6;

export function CommandPalette({ open, onClose, onHelp }: { open: boolean; onClose: () => void; onHelp?: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const theme = useTheme();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const listId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  // the palette is an overlay like a modal: the page behind it is inert
  useLayoutEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const layer = pushLayer(backdrop.current);
    // Escape works wherever the focus is inside (a click on the list moves it off the input)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && layer.isTop()) { e.preventDefault(); e.stopPropagation(); closeRef.current(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); layer.release(); if (document.activeElement === document.body) prev?.focus(); };
  }, [open]);

  const commands = useMemo<Entry[]>(() => {
    const cmd = t('palette.commands');
    const go = (id: string, name: string, to: string, group: string): Entry => ({ id: `go:${id}`, label: t('palette.go', { name }), group, keywords: name, run: () => nav(to) });
    const list: Entry[] = [];
    if (can('editor')) list.push({ id: 'new', label: t('palette.newMonitor'), group: cmd, keywords: 'add create', run: () => nav('/monitors/new') });
    list.push(go('kiosk', t('nav.kiosk'), '/kiosk', cmd), go('profile', t('nav.profile'), '/profile', cmd));
    list.push(
      // themes with a fixed look have no light/dark switch
      ...(theme.info.modes.length > 1 ? [{ id: 'theme', label: t('palette.toggleTheme'), group: cmd, run: () => theme.setMode(theme.dark ? 'light' : 'dark') }] : []),
      { id: 'lang', label: `${t('palette.language')} (${locale === 'en' ? 'Deutsch' : 'English'})`, group: cmd, run: () => setLocale(locale === 'en' ? 'de' : 'en') },
    );
    if (onHelp) list.push({ id: 'help', label: t('shortcuts.title'), group: cmd, keywords: '?', run: onHelp });
    // menu entries come from the same definition as the sidebar (already filtered by role)
    for (const g of visibleNav(can)) for (const i of g.items) list.push(go(i.to, t(i.label), i.to, t(g.label)));
    return list;
  }, [t, nav, can, theme.dark, theme.info.modes.length, theme.setMode, locale, setLocale, onHelp]);

  const { shown, more } = useMemo(() => {
    const monitors = qc.getQueryData<MonitorItem[]>(['monitors']) ?? [];
    const monitorEntry = (m: MonitorItem, group: string): Entry => ({ id: `m:${m.id}`, label: m.name, hint: m.type, group, status: displayStatus(m), run: () => nav(`/monitors/${m.id}`) });
    const needle = q.trim().toLowerCase();
    if (!needle) {
      // nothing typed: the monitors you looked at last, then every command
      const byId = new Map(monitors.map((m) => [m.id, m]));
      const recent = getRecentMonitors().map((id) => byId.get(id)).filter((m): m is MonitorItem => !!m).slice(0, RECENT_SHOWN).map((m) => monitorEntry(m, t('shell.palette.recent')));
      return { shown: [...recent, ...commands], more: 0 };
    }
    const words = needle.split(/\s+/);
    const hit = (e: { label: string; hint?: string; keywords?: string }) => { const hay = `${e.label} ${e.hint ?? ''} ${e.keywords ?? ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); };
    const rank = (e: Entry) => (e.label.toLowerCase().startsWith(needle) ? 0 : 1);
    const cmds = commands.filter(hit);
    const mons = monitors.filter((m) => hit({ label: m.name, hint: m.type })).map((m) => monitorEntry(m, t('palette.monitors'))).sort((a, b) => rank(a) - rank(b));
    return { shown: [...cmds, ...mons.slice(0, MAX_MONITORS)], more: Math.max(0, mons.length - MAX_MONITORS) };
  }, [commands, q, t, qc, nav, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setIdx(0), [q]);
  useEffect(() => { if (open) document.getElementById(`${listId}-${idx}`)?.scrollIntoView({ block: 'nearest' }); }, [idx, open, listId]);

  if (!open) return null;
  const run = (e?: Entry) => { if (!e) return; onClose(); e.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'PageDown') { e.preventDefault(); setIdx((i) => Math.min(i + 8, shown.length - 1)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setIdx((i) => Math.max(i - 8, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[idx]); }
  };

  return createPortal(
    <div ref={backdrop} className="pw-palette fixed inset-0 z-[65] flex items-start justify-center bg-slate-900/50 p-4 pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('topbar.search')} className="pw-modal card w-full max-w-xl overflow-hidden">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={shown[idx] ? `${listId}-${idx}` : undefined}
          placeholder={t('palette.placeholder')} className="w-full border-0 border-b border-slate-200 bg-transparent px-4 py-3 text-base outline-none focus:ring-0 dark:border-slate-800" />
        <ul id={listId} role="listbox" onMouseDown={(e) => e.preventDefault()} className="max-h-[min(24rem,60vh)] overflow-y-auto p-1">
          {shown.length === 0 && <li role="presentation" className="px-3 py-6 text-center text-sm text-slate-500">{t('palette.empty')}</li>}
          {shown.map((e, i) => (
            <li key={e.id} role="presentation" className="contents">
              {(i === 0 || shown[i - 1]!.group !== e.group) && <div role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{e.group}</div>}
              <div id={`${listId}-${i}`} role="option" aria-selected={i === idx} onMouseMove={() => setIdx(i)} onClick={() => run(e)}
                className={cx('flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm', i === idx && 'bg-brand-50 dark:bg-brand-700/20')}>
                {e.status && <StatusDot status={e.status} />}
                <span className="truncate">{e.label}</span>
                {e.hint && <span className="ml-auto shrink-0 text-xs text-slate-400">{e.hint}</span>}
              </div>
            </li>
          ))}
          {more > 0 && <li role="presentation" className="px-3 py-2 text-xs text-slate-500">{t('shell.palette.more', { n: more })}</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
