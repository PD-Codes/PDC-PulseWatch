import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../lib/i18n';
import { Modal } from './ui';

const typing = (e: KeyboardEvent) => { const el = e.target as HTMLElement | null; return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)); };

/** Global keyboard shortcuts: Ctrl/Cmd+K, "/", "n", "?" and two-key "g x" navigation. */
export function useShortcuts({ openPalette, openHelp }: { openPalette: () => void; openHelp: () => void }) {
  const nav = useNavigate();
  const pendingG = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (pendingG.current && Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        const to = ({ d: '/dashboard', i: '/incidents', m: '/maintenance', s: '/status-pages', n: '/notifications', r: '/reports' } as Record<string, string>)[e.key];
        if (to) { e.preventDefault(); nav(to); }
        return;
      }
      if (e.key === 'g') pendingG.current = Date.now();
      else if (e.key === '/') { e.preventDefault(); window.dispatchEvent(new Event('pw:focus-search')); }
      else if (e.key === 'n') nav('/monitors/new');
      else if (e.key === '?') openHelp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, openPalette, openHelp]);
}

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const rows: [string, string][] = [['Ctrl/⌘ K', t('shortcuts.palette')], ['/', t('shortcuts.search')], ['n', t('shortcuts.new')], ['g d', t('shortcuts.goDash')], ['g i', t('shortcuts.goInc')], ['g m', t('shortcuts.goMaint')], ['g s', t('shortcuts.goStatus')], ['?', t('shortcuts.help')]];
  return (
    <Modal open={open} onClose={onClose} title={t('shortcuts.title')}>
      <ul className="space-y-2 text-sm">{rows.map(([k, d]) => <li key={k} className="flex items-center justify-between gap-4"><span>{d}</span><span className="flex gap-1">{k.split(' ').map((x, i) => <kbd key={i} className="kbd">{x}</kbd>)}</span></li>)}</ul>
    </Modal>
  );
}
