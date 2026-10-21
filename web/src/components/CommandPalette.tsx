import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MonitorItem } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { setTheme, useTheme } from '../lib/theme';
import { displayStatus, StatusDot } from './status';
import { cx } from './ui';

interface Entry { id: string; label: string; hint?: string; group: string; run: () => void; status?: ReturnType<typeof displayStatus> }

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const theme = useTheme();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const go = (name: string, to: string): Entry => ({ id: `go:${to}`, label: t('palette.go', { name }), group: t('palette.commands'), run: () => nav(to) });
    const list: Entry[] = [
      ...(can('editor') ? [{ id: 'new', label: t('palette.newMonitor'), group: t('palette.commands'), run: () => nav('/monitors/new') }] : []),
      go(t('nav.dashboard'), '/dashboard'), go(t('nav.incidents'), '/incidents'), go(t('nav.maintenance'), '/maintenance'), go(t('nav.statusPages'), '/status-pages'), go(t('nav.insights'), '/insights'),
      go(t('nav.reports'), '/reports'), go(t('nav.notifications'), '/notifications'), go(t('nav.kiosk'), '/kiosk'), go(t('nav.profile'), '/profile'),
      { id: 'theme', label: t('palette.toggleTheme'), group: t('palette.commands'), run: () => setTheme(theme.dark ? 'light' : 'dark') },
      { id: 'lang', label: `${t('palette.language')} (${locale === 'en' ? 'Deutsch' : 'English'})`, group: t('palette.commands'), run: () => setLocale(locale === 'en' ? 'de' : 'en') },
    ];
    for (const m of qc.getQueryData<MonitorItem[]>(['monitors']) ?? []) list.push({ id: `m:${m.id}`, label: m.name, hint: m.type, group: t('palette.monitors'), status: displayStatus(m), run: () => nav(`/monitors/${m.id}`) });
    return list;
  }, [t, nav, qc, can, theme.dark, locale, setLocale, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (needle ? entries.filter((e) => `${e.label} ${e.hint ?? ''}`.toLowerCase().includes(needle)) : entries.filter((e) => e.group !== t('palette.monitors'))).slice(0, 40);
  }, [entries, q, t]);
  useEffect(() => setIdx(0), [q]);

  if (!open) return null;
  const run = (e?: Entry) => { if (!e) return; onClose(); e.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[idx]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-slate-900/50 p-4 pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('topbar.search')} className="card w-full max-w-xl overflow-hidden">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={shown[idx] ? `${listId}-${idx}` : undefined}
          placeholder={t('palette.placeholder')} className="w-full border-0 border-b border-slate-200 bg-transparent px-4 py-3 text-base outline-none focus:ring-0 dark:border-slate-800" />
        <ul id={listId} role="listbox" className="max-h-80 overflow-y-auto p-1">
          {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">{t('palette.empty')}</li>}
          {shown.map((e, i) => (
            <li key={e.id} id={`${listId}-${i}`} role="option" aria-selected={i === idx} onMouseMove={() => setIdx(i)} onClick={() => run(e)}
              className={cx('flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm', i === idx && 'bg-brand-50 dark:bg-brand-700/20')}>
              {e.status && <StatusDot status={e.status} />}
              <span className="truncate">{e.label}</span>
              <span className="ml-auto shrink-0 text-xs text-slate-400">{e.hint ?? e.group}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
