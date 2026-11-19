import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { hasOpenLayer } from '../lib/modalStack';
import { visibleNav } from './nav';
import { Modal } from './ui';

const typing = (e: KeyboardEvent) => { const el = e.target as HTMLElement | null; return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)); };

/** "g x" targets that are not menu entries. */
const EXTRA_JUMPS: { key: string; to: string; label: string }[] = [{ key: 'k', to: '/kiosk', label: 'nav.kiosk' }, { key: 'p', to: '/profile', label: 'nav.profile' }];

/** Two-key jumps: the menu entries that have a `key`, plus the extras, limited to what the role may open. */
function useJumps() {
  const { can } = useAuth();
  return [...visibleNav(can).flatMap((g) => g.items).filter((i) => i.key).map((i) => ({ key: i.key!, to: i.to, label: i.label })), ...EXTRA_JUMPS];
}

/** Global keyboard shortcuts: Ctrl/Cmd+K, "/", "n" (editors), "?" and two-key "g x" navigation. They stay quiet while a dialog is open. */
export function useShortcuts({ openPalette, openHelp }: { openPalette: () => void; openHelp: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const jumps = useJumps();
  const pendingG = useRef(0);
  const live = useRef({ jumps, editor: can('editor') });
  live.current = { jumps, editor: can('editor') };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || hasOpenLayer()) { pendingG.current = 0; return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (pendingG.current && Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        const to = live.current.jumps.find((j) => j.key === e.key)?.to;
        if (to) { e.preventDefault(); nav(to); }
        return;
      }
      if (e.key === 'g') pendingG.current = Date.now();
      else if (e.key === '/') { e.preventDefault(); window.dispatchEvent(new Event('pw:focus-search')); }
      else if (e.key === 'n' && live.current.editor) nav('/monitors/new');
      else if (e.key === '?') openHelp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, openPalette, openHelp]);
}

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const jumps = useJumps();
  const rows: [string, string][] = [
    ['Ctrl/⌘ K', t('shortcuts.palette')], ['/', t('shortcuts.search')], ...(can('editor') ? [['n', t('shortcuts.new')] as [string, string]] : []),
    ...jumps.map((j): [string, string] => [`g ${j.key}`, t('palette.go', { name: t(j.label) })]),
    ['?', t('shortcuts.help')],
  ];
  return (
    <Modal open={open} onClose={onClose} title={t('shortcuts.title')} wide>
      <ul className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">{rows.map(([k, d]) => <li key={k} className="flex items-center justify-between gap-4"><span className="min-w-0 truncate">{d}</span><span className="flex shrink-0 items-center gap-1">{k.split(' ').map((x, i) => <span key={i} className="contents">{i > 0 && <span className="text-xs text-slate-400">{t('shortcuts.then')}</span>}<kbd className="kbd">{x}</kbd></span>)}</span></li>)}</ul>
    </Modal>
  );
}
