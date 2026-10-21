import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../lib/i18n';
import { Button, cx } from './ui';

export interface MultiOption<T> { value: T; label: string; icon?: ReactNode }

/** Dropdown with a checkbox per option. Nothing selected means "no filter". */
export function MultiSelect<T extends string | number>({ label, allLabel, options, value, onChange }: { label: string; allLabel: string; options: MultiOption<T>[]; value: T[]; onChange: (v: T[]) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const picked = options.filter((o) => value.includes(o.value));
  const toggle = (v: T) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div ref={root} className="relative">
      <button type="button" aria-label={label} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}
        className={cx('input inline-flex w-auto items-center gap-1.5 py-1 pr-2 text-xs', picked.length > 0 && 'border-indigo-400 dark:border-indigo-500')}>
        <span>{picked.length ? picked.map((o) => o.label).join(', ') : allLabel}</span><ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <div role="group" aria-label={label} className="absolute right-0 z-20 mt-1 min-w-[11rem] rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {options.map((o) => (
            <label key={String(o.value)} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />{o.icon}{o.label}
            </label>
          ))}
          <div className="mt-1 border-t border-slate-100 pt-1 dark:border-slate-800"><Button size="sm" variant="ghost" className="w-full" disabled={!value.length} onClick={() => onChange([])}>{t('filter.clear')}</Button></div>
        </div>
      )}
    </div>
  );
}
