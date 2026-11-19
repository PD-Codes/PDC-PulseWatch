import { BellOff, BellRing, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n, useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/format';
import { fmtUntil, nextMorning, sameDay, snoozeActive, snoozeBody, type SnoozeBody, type SnoozePreset } from '../lib/monitorExtras';
import { Button, cx } from './ui';

const PRESETS: SnoozePreset[] = ['h1', 'h4', 'morning'];

/** Button label of a preset; the morning preset names its day ("until 08:00" tonight, "until tomorrow 08:00" otherwise). */
function usePresetLabel() {
  const t = useT();
  const { locale } = useI18n();
  return (p: SnoozePreset) => {
    if (p !== 'morning') return t(`mux.snooze.${p}`);
    const now = new Date();
    const at = nextMorning(now);
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
    return t(sameDay(at, now) ? 'mux.snooze.untilToday' : 'mux.snooze.untilTomorrow', { time });
  };
}

/** "Muted until 14:30" with the full date as tooltip; nothing while the monitor is not snoozed. */
export function SnoozeBadge({ until, className, short }: { until: string | null | undefined; className?: string; short?: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  if (!until || !snoozeActive({ snoozedUntil: until })) return null;
  const label = t('mux.snooze.until', { when: fmtUntil(until, locale) });
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400', className)} title={t('mux.snooze.tooltip', { when: fmtDateTime(until) })}>
      <BellOff className="h-3.5 w-3.5 shrink-0" aria-hidden />{short ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}

/**
 * Snooze notifications. `inline` shows the presets as buttons (one click), `menu` folds them into a dropdown for crowded headers.
 * While a snooze runs it shows until when and offers to end it.
 */
export function SnoozeControl({ until, onSnooze, onClear, busy, variant = 'menu', disabled }: { until: string | null | undefined; onSnooze: (b: SnoozeBody) => void; onClear?: () => void; busy?: boolean; variant?: 'menu' | 'inline'; disabled?: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const label = usePresetLabel();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const active = snoozeActive({ snoozedUntil: until });
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  // menu keys: arrows and Home/End move, Escape closes and returns to the button, Tab closes and moves on
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? (i + 1) % items.length : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (to >= 0) { e.preventDefault(); items[to]?.focus(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); return; }
    if (e.key === 'Tab') setOpen(false);
  };
  const pick = (p: SnoozePreset) => { setOpen(false); button.current?.focus(); onSnooze(snoozeBody(p)); };
  const clear = active && onClear && <Button size="sm" variant="ghost" onClick={onClear} disabled={busy || disabled}><BellRing className="h-4 w-4" />{t('mux.snooze.clear')}</Button>;

  if (variant === 'inline') {
    return (
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('mux.snooze.title')}>
        {active ? <SnoozeBadge until={until} className="mr-1 text-sm" /> : <span className="mr-1 inline-flex items-center gap-1 text-xs text-slate-500"><BellOff className="h-3.5 w-3.5" aria-hidden />{t('mux.snooze.title')}</span>}
        {PRESETS.map((p) => <Button key={p} size="sm" disabled={busy || disabled} onClick={() => pick(p)}>{label(p)}</Button>)}
        {clear}
      </div>
    );
  }
  return (
    <div ref={root} className="relative inline-flex items-center gap-1">
      <button ref={button} type="button" aria-haspopup="menu" aria-expanded={open} disabled={busy || disabled} onClick={() => setOpen(!open)} title={t('mux.snooze.hint')}
        className={cx('btn btn-sm', active && 'border-amber-400 text-amber-800 dark:border-amber-600 dark:text-amber-300')}>
        <BellOff className="h-4 w-4" />{active && until ? t('mux.snooze.until', { when: fmtUntil(until, locale) }) : t('mux.snooze.title')}<ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label={t('mux.snooze.title')} onKeyDown={onMenuKey} className="card absolute right-0 top-full z-30 mt-1 w-56 p-1 shadow-lg">
          <p className="px-3 py-1.5 text-xs text-slate-500">{t('mux.snooze.hint')}</p>
          {PRESETS.map((p) => <button key={p} type="button" role="menuitem" tabIndex={-1} onClick={() => pick(p)} className="block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-slate-100 focus-visible:bg-slate-100 dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800">{label(p)}</button>)}
          {active && onClear && <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); button.current?.focus(); onClear(); }} className="mt-1 block w-full rounded-md border-t border-slate-100 px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-800">{t('mux.snooze.clear')}</button>}
        </div>
      )}
    </div>
  );
}
