import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Moon, Palette, Sun, SunMoon } from 'lucide-react';
import { THEMES, useTheme, type ThemeId, type ThemeInfo, type ThemeMode } from '../lib/theme';
import { useT } from '../lib/i18n';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const MODES: { id: ThemeMode; icon: typeof Sun }[] = [{ id: 'light', icon: Sun }, { id: 'dark', icon: Moon }, { id: 'system', icon: SunMoon }];

/** Swatch of the variant that would show: the dark one when the chosen mode resolves to dark. */
const swatchOf = (x: ThemeInfo, preferDark: boolean) => (preferDark && x.swatchDark ? x.swatchDark : x.swatch);
const prefersDark = (mode: ThemeMode) => mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

/** Arrow/Home/End keys move focus and selection inside a radio group (roving tabindex). */
function onRadioKeys(e: KeyboardEvent<HTMLElement>, ids: ThemeId[], current: ThemeId, pick: (id: ThemeId) => void) {
  const i = ids.indexOf(current);
  const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % ids.length
    : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? (i - 1 + ids.length) % ids.length
    : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  pick(ids[next]);
  e.currentTarget.querySelector<HTMLElement>(`[data-theme-id="${ids[next]}"]`)?.focus();
}

/** Light/dark/system switch (radio group: arrow keys, only the chosen entry is in the tab order); only for themes with both modes. */
function ModeSwitch({ mode, onChange, size = 'sm' }: { mode: ThemeMode; onChange: (m: ThemeMode) => void; size?: 'sm' | 'md' }) {
  const t = useT();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = MODES.findIndex((m) => m.id === mode);
    const n = MODES.length;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation(); // keep the theme list's arrow handling out of it
    onChange(MODES[next].id);
    e.currentTarget.querySelector<HTMLElement>(`[data-mode="${MODES[next].id}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={t('themes.mode')} onKeyDown={onKey} className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
      {MODES.map(({ id, icon: Icon }) => (
        <button key={id} type="button" role="radio" aria-checked={mode === id} tabIndex={mode === id ? 0 : -1} data-mode={id} onClick={() => onChange(id)} title={t(`themes.mode.${id}`)}
          className={cx('inline-flex items-center gap-1.5 rounded-md font-medium transition', size === 'sm' ? 'px-2 py-1 text-xs' : 'px-2.5 py-1.5 text-sm',
            mode === id ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
          <Icon className="h-3.5 w-3.5" aria-hidden />{t(`themes.mode.${id}`)}
        </button>
      ))}
    </div>
  );
}

function Swatch({ colors, className }: { colors: string[]; className?: string }) {
  return (
    <span className={cx('inline-flex h-5 w-9 shrink-0 overflow-hidden rounded-sm ring-1 ring-slate-900/15 dark:ring-white/20', className)} aria-hidden>
      <span className="w-1/2" style={{ background: colors[0] }} />
      <span className="w-1/4" style={{ background: colors[2] }} />
      <span className="w-1/4" style={{ background: colors[3] }} />
    </span>
  );
}

/** Miniature page: sidebar, top bar, a card with accent and text lines. */
function Preview({ colors }: { colors: string[] }) {
  const [page, surface, accent, accent2, text] = colors;
  return (
    <span className="flex h-16 w-full overflow-hidden rounded-md ring-1 ring-slate-900/10 dark:ring-white/15" style={{ background: page }} aria-hidden>
      <span className="flex w-1/4 flex-col gap-1 p-1.5" style={{ background: surface }}>
        <span className="h-1.5 w-full rounded-full" style={{ background: accent }} />
        <span className="h-1 w-3/4 rounded-full opacity-50" style={{ background: text }} />
        <span className="h-1 w-2/3 rounded-full opacity-50" style={{ background: text }} />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-1.5">
        <span className="h-1.5 w-1/2 rounded-full" style={{ background: text }} />
        <span className="flex flex-1 flex-col justify-center gap-1 rounded-sm px-1.5" style={{ background: surface }}>
          <span className="flex gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: accent2 }} /><span className="h-1.5 flex-1 rounded-full opacity-60" style={{ background: text }} /></span>
          <span className="flex gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} /><span className="h-1.5 w-2/3 rounded-full opacity-60" style={{ background: text }} /></span>
        </span>
      </span>
    </span>
  );
}

/**
 * Theme chooser. `compact`: icon button with a popover list (topbar). `full`: grid of preview tiles (profile page).
 * Choices are stored per device and apply immediately; `onChange` lets a caller also persist them elsewhere.
 */
export function ThemePicker({ variant = 'compact', onChange }: { variant?: 'compact' | 'full'; onChange?: (s: { themeId: ThemeId; mode: ThemeMode }) => void }) {
  const t = useT();
  const theme = useTheme();
  const ids = THEMES.map((x) => x.id);
  const twoModes = theme.info.modes.length > 1;
  const dk = prefersDark(theme.mode);
  const pickTheme = (id: ThemeId) => { theme.setTheme(id); onChange?.({ themeId: id, mode: theme.mode }); };
  const pickMode = (m: ThemeMode) => { theme.setMode(m); onChange?.({ themeId: theme.themeId, mode: m }); };
  const name = (id: ThemeId) => t(`themes.name.${id}`);

  if (variant === 'full') {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {twoModes ? <ModeSwitch mode={theme.mode} onChange={pickMode} size="md" /> : <span className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400"><Moon className="h-4 w-4" aria-hidden />{t('themes.darkOnly')}</span>}
          <span className="text-xs text-slate-500 dark:text-slate-400">{t('themes.device')}</span>
        </div>
        <div role="radiogroup" aria-label={t('themes.title')} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" onKeyDown={(e) => onRadioKeys(e, ids, theme.themeId, pickTheme)}>
          {THEMES.map((x) => {
            const on = x.id === theme.themeId;
            return (
              <button key={x.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-theme-id={x.id} onClick={() => pickTheme(x.id)}
                className={cx('group flex flex-col gap-1.5 rounded-lg border p-2 text-left transition', on ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-700/20' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-800')}>
                <Preview colors={swatchOf(x, dk)} />
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {name(x.id)}
                  {x.modes.length === 1 && <Moon className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" aria-label={t('themes.darkOnly')} />}
                  {on && <Check className="ml-auto h-4 w-4 text-brand-600 dark:text-brand-400" aria-hidden />}
                </span>
                <span className="line-clamp-2 text-xs leading-snug text-slate-500 dark:text-slate-400">{t(`themes.desc.${x.id}`)}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  return <CompactPicker ids={ids} theme={theme} dk={dk} twoModes={twoModes} name={name} pickTheme={pickTheme} pickMode={pickMode} />;
}

function CompactPicker({ ids, theme, dk, twoModes, name, pickTheme, pickMode }: {
  ids: ThemeId[]; theme: ReturnType<typeof useTheme>; dk: boolean; twoModes: boolean; name: (id: ThemeId) => string; pickTheme: (id: ThemeId) => void; pickMode: (m: ThemeMode) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const popId = useId();
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    // focus the chosen theme so arrow keys work right away
    list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const label = t('themes.current', { name: name(theme.themeId) });
  return (
    <div ref={wrap} className="relative" onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }}
      onBlur={(e) => { if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button ref={trigger} type="button" className="btn btn-ghost btn-sm" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined}
        title={label} aria-label={`${t('themes.open')} (${label})`} onClick={() => setOpen((o) => !o)}>
        <Palette className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div id={popId} role="dialog" aria-label={t('themes.title')} className="pw-modal absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-1.5 text-slate-800 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          {twoModes && <div className="flex justify-center border-b border-slate-200 p-1 pb-2 dark:border-slate-700"><ModeSwitch mode={theme.mode} onChange={pickMode} /></div>}
          <div ref={list} role="radiogroup" aria-label={t('themes.title')} className={cx('flex flex-col', twoModes && 'pt-1')} onKeyDown={(e) => onRadioKeys(e, ids, theme.themeId, pickTheme)}>
            {THEMES.map((x) => {
              const on = x.id === theme.themeId;
              return (
                <button key={x.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-theme-id={x.id}
                  onClick={() => pickTheme(x.id)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); close(); } }}
                  className={cx('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition', on ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-700/25 dark:text-brand-100' : 'hover:bg-slate-100 dark:hover:bg-slate-800')}>
                  <Swatch colors={swatchOf(x, dk)} />
                  <span className="flex-1 truncate">{name(x.id)}</span>
                  {x.modes.length === 1 && <Moon className="h-3.5 w-3.5 shrink-0 opacity-60" aria-label={t('themes.darkOnly')} />}
                  {on && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
