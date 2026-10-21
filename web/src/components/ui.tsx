import { X, Loader2, Inbox } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useT } from '../lib/i18n';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Spinner({ className }: { className?: string }) { return <Loader2 className={cx('h-4 w-4 animate-spin', className)} aria-hidden />; }
export function Loading({ label }: { label?: string }) { const t = useT(); return <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500" role="status"><Spinner />{label ?? t('common.loading')}</div>; }

export function Button({ variant = 'default', size = 'md', loading, className, children, disabled, type = 'button', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button type={type} disabled={disabled || loading} className={cx('btn', variant === 'primary' && 'btn-primary', variant === 'danger' && 'btn-danger', variant === 'ghost' && 'btn-ghost', size === 'sm' && 'btn-sm', className)} {...p}>
      {loading && <Spinner />}{children}
    </button>
  );
}

export function Card({ className, children, ...p }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) { return <div className={cx('card', className)} {...p}>{children}</div>; }
export function CardHeader({ title, actions, subtitle }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
      <div><h2 className="text-sm font-semibold">{title}</h2>{subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  useEffect(() => { if (typeof title === 'string') document.title = `${title} · PulseWatch`; }, [title]);
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h1 className="truncate text-2xl font-semibold">{title}</h1>{subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  gray: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', blue: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300', brand: 'bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100',
};
export type Tone = keyof typeof TONES;
export function Badge({ tone = 'gray', children, className }: { tone?: Tone; children: ReactNode; className?: string }) { return <span className={cx('badge', TONES[tone], className)}>{children}</span>; }

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="rounded-full bg-slate-100 p-3 text-slate-400 dark:bg-slate-800">{icon ?? <Inbox className="h-6 w-6" aria-hidden />}</div>
      <h3 className="text-base font-semibold">{title}</h3>
      {body && <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{body}</p>}
      {action}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">{error instanceof Error ? error.message : String(error)}</div>;
}

/* ---------------------------------- forms ---------------------------------- */
export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={className}>
      {label && <label htmlFor={id} className="label">{label}</label>}
      {children(id)}
      {error ? <p className="mt-1 text-xs text-red-600" role="alert">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cx('input', className)} {...p} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cx('input font-mono', className)} rows={4} {...p} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cx('input pr-8', className)} {...p}>{children}</select>;

export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-60')}>
      <button type="button" role="switch" id={id} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={cx('relative h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-700')}>
        <span className={cx('absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition', checked && 'translate-x-4')} />
      </button>
      {label}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', value === t.id ? 'border-brand-600 text-brand-700 dark:text-brand-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>{t.label}</button>
      ))}
    </div>
  );
}

/* ----------------------------------- modal ----------------------------------- */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // pages pass a fresh onClose on every render; depending on it would re-run the effect and steal focus on each keystroke
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); }
      if (e.key === 'Tab' && node) { // keep focus inside the dialog
        const f = [...node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx('card flex max-h-[92vh] w-full flex-col rounded-b-none sm:rounded-b-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button data-close type="button" onClick={onClose} className="btn btn-ghost btn-sm" aria-label={t('common.close')}><X className="h-4 w-4" /></button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------- toasts, confirm ------------------------------- */
interface Toast { id: number; tone: 'ok' | 'error' | 'info'; text: string }
const Ui = createContext<{ toast: (text: string, tone?: Toast['tone']) => void; confirm: (o: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) => Promise<boolean> }>(null as any);

export function UiProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<{ title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((l) => [...l.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  const confirm = useCallback((o: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve })), []);
  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null); };
  return (
    <Ui.Provider value={{ toast, confirm }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} role={x.tone === 'error' ? 'alert' : 'status'} className={cx('pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg', x.tone === 'error' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800')}>{x.text}</div>
        ))}
      </div>
      <Modal open={!!dlg} onClose={() => close(false)} title={dlg?.title ?? ''} footer={<><Button onClick={() => close(false)}>{t('common.cancel')}</Button><Button variant={dlg?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{dlg?.confirmLabel ?? t('common.confirm')}</Button></>}>
        {dlg?.body ?? null}
      </Modal>
    </Ui.Provider>
  );
}
export const useToast = () => useContext(Ui).toast;
export const useConfirm = () => useContext(Ui).confirm;

/** Skeleton block for loading states. */
export const Skeleton = ({ className }: { className?: string }) => <div className={cx('animate-pulse rounded bg-slate-200 dark:bg-slate-800', className)} aria-hidden />;

/** Simple key/value list. */
export function Dl({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">{items.map(([k, v], i) => <div key={i} className="contents"><dt className="text-slate-500">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}</dl>;
}
