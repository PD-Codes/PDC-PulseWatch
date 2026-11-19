import { CircleAlert, Inbox, Loader2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useMeta } from '../lib/auth';
import { useT } from '../lib/i18n';
import { pushLayer } from '../lib/modalStack';

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
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  const brand = useMeta()?.brand.name ?? 'PulseWatch';
  useEffect(() => { if (typeof title === 'string') document.title = `${title} · ${brand}`; }, [title, brand]);
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
export interface FieldAria { 'aria-invalid'?: true; 'aria-describedby'?: string }
const FieldCtx = createContext<{ id: string; aria: FieldAria } | null>(null);

/**
 * Label, control, hint and error. `children` receives the control id and, as a second argument, aria props for a raw control;
 * Input, Select and Textarea pick them up on their own when they use that id. An error sets aria-invalid and is linked via aria-describedby.
 */
export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: (id: string, aria: FieldAria) => ReactNode; className?: string }) {
  const id = useId();
  const msgId = `${id}-msg`;
  const aria: FieldAria = { ...(error ? { 'aria-invalid': true as const } : {}), ...(error || hint ? { 'aria-describedby': msgId } : {}) };
  return (
    <div className={className}>
      {label && <label htmlFor={id} className="label">{label}</label>}
      <FieldCtx.Provider value={{ id, aria }}>{children(id, aria)}</FieldCtx.Provider>
      {error ? <p id={msgId} className="mt-1 flex items-start gap-1 text-xs text-red-600 dark:text-red-400" role="alert"><CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{error}</p> : hint ? <p id={msgId} className="hint">{hint}</p> : null}
    </div>
  );
}
const INVALID = 'aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-red-500';
function useFieldAria(id?: string): FieldAria { const f = useContext(FieldCtx); return f && id && f.id === id ? f.aria : {}; }
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cx('input', INVALID, className)} {...useFieldAria(p.id)} {...p} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cx('input font-mono', INVALID, className)} rows={4} {...useFieldAria(p.id)} {...p} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cx('input pr-8', INVALID, className)} {...useFieldAria(p.id)} {...p}>{children}</select>;

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

/* ----------------------------------- tabs ----------------------------------- */
/**
 * Tab strip with roving tabindex and arrow-key navigation (Left/Right/Home/End; the focused tab is selected).
 * With `idPrefix`, tabs get ids and aria-controls that match <TabPanel idPrefix=… />.
 */
export function Tabs<T extends string>({ tabs, value, onChange, idPrefix, label, className }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; idPrefix?: string; label?: string; className?: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = tabs.length;
    const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    const next = tabs[j]!;
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  // a value that matches no tab must not leave the strip without a tab stop
  const active = tabs.some((x) => x.id === value) ? value : tabs[0]?.id;
  return (
    <div role="tablist" aria-label={label} className={cx('flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800', className ?? 'mb-4')}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[t.id] = el; }} role="tab" type="button" id={idPrefix ? `${idPrefix}-tab-${t.id}` : undefined} aria-controls={idPrefix ? `${idPrefix}-panel-${t.id}` : undefined}
          aria-selected={value === t.id} tabIndex={active === t.id ? 0 : -1} onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}
          className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', value === t.id ? 'border-brand-600 text-brand-700 dark:text-brand-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>{t.label}</button>
      ))}
    </div>
  );
}
/** Content of one tab; renders nothing while another tab is selected. */
export function TabPanel({ idPrefix, id, value, children, className }: { idPrefix: string; id: string; value: string; children: ReactNode; className?: string }) {
  if (value !== id) return null;
  return <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className={className}>{children}</div>;
}

/** Tab state kept in the URL (?tab=…), so reload, back and shared links keep the tab. Selecting the fallback removes the parameter. */
export function useTabParam<T extends string = string>(name: string, fallback: T, valid?: readonly T[]): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name);
  const value = (raw && (!valid || valid.includes(raw as T)) ? raw : fallback) as T;
  const set = useCallback((v: T) => setParams((p) => { const n = new URLSearchParams(p); if (v === fallback) n.delete(name); else n.set(name, v); return n; }, { replace: true }), [name, fallback, setParams]);
  return [value, set];
}

/* ----------------------------------- modal ----------------------------------- */
const ModalCtx = createContext<{ requestClose: () => void } | null>(null);
/** Close function of the surrounding Modal: asks first when the modal is `dirty`. Use it for the footer's Cancel button. */
export const useModalClose = (): (() => void) => useContext(ModalCtx)?.requestClose ?? (() => {});

/**
 * Dialog rendered into document.body. Only the topmost modal reacts to Escape and traps focus; the page and any modal beneath are inert.
 * With `dirty`, a click on the backdrop does nothing and Escape / the close button ask before discarding.
 */
export function Modal({ open, onClose, title, children, footer, wide, dirty }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; dirty?: boolean }) {
  const t = useT();
  const ui = useContext(Ui);
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [nudge, setNudge] = useState(false);
  // pages pass fresh callbacks on every render; reading them through a ref keeps the effect from re-running and stealing focus on each keystroke
  const latest = useRef({ onClose, dirty: !!dirty, t, confirm: ui?.confirm });
  latest.current = { onClose, dirty: !!dirty, t, confirm: ui?.confirm };
  const asking = useRef(false);
  const requestClose = useCallback(() => {
    const l = latest.current;
    if (!l.dirty) { l.onClose(); return; }
    if (asking.current) return;
    asking.current = true;
    const ask = l.confirm ?? (async (o: { title: string }) => window.confirm(o.title));
    void ask({ title: l.t('shell.discard.title'), body: l.t('shell.discard.body'), confirmLabel: l.t('shell.discard.confirm'), danger: true }).then((ok) => { asking.current = false; if (ok) latest.current.onClose(); });
  }, []);
  const ctx = useMemo(() => ({ requestClose }), [requestClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const layer = pushLayer(backdrop.current);
    (node?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])') ?? node)?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (e.key === 'Escape') { if (e.defaultPrevented) return; e.preventDefault(); e.stopPropagation(); requestClose(); }
      if (e.key === 'Tab' && node) { // keep focus inside the dialog
        const f = [...node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); layer.release(); prev?.focus(); };
  }, [open, requestClose]);

  if (!open) return null;
  const onBackdrop = (e: MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (latest.current.dirty) { setNudge(true); setTimeout(() => setNudge(false), 450); return; } // unsaved input: point at the dialog instead of closing it
    latest.current.onClose();
  };
  return createPortal(
    <div ref={backdrop} className="pw-modal-backdrop fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={onBackdrop}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cx('pw-modal card flex max-h-[92vh] w-full flex-col rounded-b-none transition-shadow sm:rounded-b-xl', nudge && 'ring-2 ring-amber-500', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button data-close type="button" onClick={requestClose} className="btn btn-ghost btn-sm" aria-label={t('common.close')}><X className="h-4 w-4" /></button>
        </div>
        <ModalCtx.Provider value={ctx}><div className="overflow-y-auto p-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">{footer}</div>}</ModalCtx.Provider>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------- toasts, confirm ------------------------------- */
interface Toast { id: number; tone: 'ok' | 'error' | 'info'; text: string }
interface ConfirmOptions { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }
const Ui = createContext<{ toast: (text: string, tone?: Toast['tone']) => void; confirm: (o: ConfirmOptions) => Promise<boolean> } | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const dlgRef = useRef(dlg);
  dlgRef.current = dlg;
  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((l) => [...l.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => { dlgRef.current?.resolve(false); setDlg({ ...o, resolve }); }), []);
  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null); };
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);
  return (
    <Ui.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
          {toasts.map((x) => (
            <div key={x.id} role={x.tone === 'error' ? 'alert' : 'status'} className={cx('pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg', x.tone === 'error' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800')}>{x.text}</div>
          ))}
        </div>,
        document.body,
      )}
      <Modal open={!!dlg} onClose={() => close(false)} title={dlg?.title ?? ''} footer={<><Button onClick={() => close(false)}>{t('common.cancel')}</Button><Button variant={dlg?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{dlg?.confirmLabel ?? t('common.confirm')}</Button></>}>
        {dlg?.body ?? null}
      </Modal>
    </Ui.Provider>
  );
}
export const useToast = () => useContext(Ui)!.toast;
export const useConfirm = () => useContext(Ui)!.confirm;

/** Skeleton block for loading states. */
export const Skeleton = ({ className }: { className?: string }) => <div className={cx('animate-pulse rounded bg-slate-200 dark:bg-slate-800', className)} aria-hidden />;

/** Simple key/value list. */
export function Dl({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">{items.map(([k, v], i) => <div key={i} className="contents"><dt className="text-slate-500">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}</dl>;
}
