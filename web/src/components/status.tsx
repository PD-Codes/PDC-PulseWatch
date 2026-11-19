import { useRef, useState } from 'react';
import type { Beat, MonitorItem, Overlay, Status } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtDateTime, fmtMs } from '../lib/format';
import { Badge, cx, type Tone } from './ui';

export type DisplayStatus = 'up' | 'down' | 'pending' | 'unknown' | 'maintenance' | 'suppressed' | 'paused';

export const displayStatus = (m: Pick<MonitorItem, 'status' | 'overlay' | 'active'>): DisplayStatus => (!m.active ? 'paused' : m.overlay !== 'none' ? m.overlay : m.status);

export const STATUS_COLOR: Record<DisplayStatus, string> = { up: 'bg-emerald-500', down: 'bg-red-500', pending: 'bg-amber-500', unknown: 'bg-slate-400', maintenance: 'bg-sky-500', suppressed: 'bg-violet-400', paused: 'bg-slate-300 dark:bg-slate-600' };
const TONE: Record<DisplayStatus, Tone> = { up: 'green', down: 'red', pending: 'amber', unknown: 'gray', maintenance: 'blue', suppressed: 'violet', paused: 'gray' };

export function StatusDot({ status, className, pulse }: { status: DisplayStatus; className?: string; pulse?: boolean }) {
  return (
    <span className={cx('relative inline-flex h-2.5 w-2.5 shrink-0', className)} aria-hidden>
      {pulse && status === 'down' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60 motion-reduce:hidden" />}
      <span className={cx('relative inline-flex h-2.5 w-2.5 rounded-full', status === 'paused' ? 'border-2 border-slate-400 bg-transparent dark:border-slate-500' : STATUS_COLOR[status])} />
    </span>
  );
}

export function StatusBadge({ status }: { status: DisplayStatus }) {
  const t = useT();
  return <Badge tone={TONE[status]}><StatusDot status={status} className="h-2 w-2" />{t(`status.${status}`)}</Badge>;
}

// Stored heartbeat status: 0 down, 1 up, 2 pending (failed, a retry follows: the yellow block), 3 maintenance, 4 suppressed.
const BEAT_STATUS = ['down', 'up', 'pending', 'maintenance', 'suppressed'] as const;
export type BeatKind = (typeof BEAT_STATUS)[number] | 'none';
const beatStatus = (s: number): (typeof BEAT_STATUS)[number] => BEAT_STATUS[s] ?? 'down';

// Every state differs in form as well as in color: down has a dark foot, pending is half height, maintenance is hatched,
// suppressed is dotted, "none" (no data / paused) is an empty outline. Colors come from currentColor so a theme only has to set `text-*`.
const HATCH = 'repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 4px)';
const DOTS = 'radial-gradient(currentColor 1.1px, transparent 1.4px) 0 0 / 4px 4px';
const BEAT_LOOK: Record<BeatKind, { cls: string; style?: React.CSSProperties }> = {
  up: { cls: 'bg-emerald-500' },
  down: { cls: 'bg-red-500', style: { boxShadow: 'inset 0 -3px 0 rgb(0 0 0 / 0.35)' } },
  pending: { cls: 'bg-amber-500 self-end !h-1/2' },
  maintenance: { cls: 'bg-sky-500/20 text-sky-500', style: { backgroundImage: HATCH } },
  suppressed: { cls: 'bg-violet-400/15 text-violet-400', style: { backgroundImage: DOTS } },
  none: { cls: 'border border-dashed border-slate-300 bg-transparent dark:border-slate-600' },
};
const BEAT_BASE = 'w-full min-w-[2px] max-w-[8px] flex-1 rounded-sm';

/** One swatch in the look of a heartbeat bar; used by the bar and the legend. */
export function BeatSwatch({ kind, className }: { kind: BeatKind; className?: string }) {
  const l = BEAT_LOOK[kind];
  return <span aria-hidden className={cx('inline-block h-4 w-2 shrink-0 rounded-sm', l.cls, className)} style={l.style} />;
}

/** Explains the bar states (form and color). Pass `kinds` to show only some. */
export function HeartbeatLegend({ className, kinds = ['up', 'down', 'pending', 'maintenance', 'suppressed', 'none'] }: { className?: string; kinds?: BeatKind[] }) {
  const t = useT();
  return (
    <ul className={cx('pw-heartbeat-legend flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400', className)} aria-label={t('shell.beats.legend')}>
      {kinds.map((k) => <li key={k} className="inline-flex items-center gap-1.5"><BeatSwatch kind={k} />{k === 'none' ? t('shell.beats.none') : t(`status.${k}`)}</li>)}
    </ul>
  );
}

/**
 * Strip of the most recent checks. Each bar is one heartbeat; the strip is padded on the left when history is short.
 * The strip is one tab stop: arrow keys step through the checks (Home/End jump, Escape hides), pointer or tap shows the details of a bar.
 */
export function HeartbeatBar({ beats, count = 40, className, height = 'h-6', interactive = true }: { beats: Beat[]; count?: number; className?: string; height?: string; interactive?: boolean }) {
  const t = useT();
  const shown = beats.slice(-count);
  const pad = count - shown.length;
  const up = shown.filter((b) => b[1] === 1).length;
  const [active, setActive] = useState<number | null>(null); // index into `shown`
  const cur = active != null ? shown[Math.min(active, shown.length - 1)] : undefined;
  const detail = (b: Beat) => `${fmtDateTime(b[0] * 1000)} · ${t(`status.${beatStatus(b[1])}`)}${b[1] === 1 && b[2] != null ? ` · ${fmtMs(b[2])}` : ''}`;
  const strip = useRef<HTMLDivElement>(null);
  // the bars are capped in width, so the strip can be wider than they are: find the bar under the pointer (or the nearest one) in the DOM
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const own = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (own) return Number(own.dataset.i);
    let best: number | null = null, dist = 6; // only gaps between bars count, not empty space beside them
    for (const b of e.currentTarget.querySelectorAll<HTMLElement>('[data-i]')) {
      const r = b.getBoundingClientRect();
      const d = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0;
      if (d < dist) { dist = d; best = Number(b.dataset.i); }
    }
    return best;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!shown.length) return;
    const last = shown.length - 1;
    const i = active ?? last + 1;
    const next = e.key === 'ArrowLeft' ? Math.max(0, i - 1) : e.key === 'ArrowRight' ? Math.min(last, i + 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (e.key === 'Escape') { setActive(null); return; }
    if (next == null) return;
    e.preventDefault();
    setActive(next);
  };
  // tooltip anchor: the real position of the active bar
  const bar = cur ? strip.current?.querySelector<HTMLElement>(`[data-i="${shown.indexOf(cur)}"]`) : null;
  const x = bar ? bar.offsetLeft + bar.offsetWidth / 2 : 0, w = strip.current?.clientWidth ?? 0;
  return (
    <div ref={strip} className={cx('pw-heartbeat relative flex items-stretch gap-[2px] rounded-sm', height, className)} role={interactive ? 'group' : 'img'} tabIndex={interactive ? 0 : undefined} aria-label={interactive ? `${t('monitors.beatsLabel', { up, total: shown.length })}. ${t('shell.beats.hint')}` : t('monitors.beatsLabel', { up, total: shown.length })}
      onKeyDown={interactive ? onKey : undefined} onFocus={(e) => { if (active == null && shown.length && e.currentTarget === e.target && e.target.matches(':focus-visible')) setActive(shown.length - 1); }} onBlur={() => setActive(null)}
      onPointerMove={interactive ? (e) => { if (e.pointerType === 'mouse') setActive(at(e)); } : undefined} onPointerLeave={interactive ? (e) => { if (e.pointerType === 'mouse') setActive(null); } : undefined} onPointerDown={interactive ? (e) => { if (e.pointerType !== 'mouse') setActive(at(e)); } : undefined}>
      {Array.from({ length: pad }, (_, i) => <span key={`p${i}`} aria-hidden className={cx(BEAT_BASE, 'bg-slate-200 dark:bg-slate-800')} />)}
      {shown.map((b, i) => { const k = beatStatus(b[1]); const l = BEAT_LOOK[k]; return <span key={b[0]} data-i={i} aria-hidden className={cx(BEAT_BASE, l.cls, active === i && 'outline outline-2 outline-offset-1 outline-slate-900 dark:outline-white')} style={l.style} />; })}
      <span className="sr-only" aria-live="polite">{cur ? detail(cur) : ''}</span>
      {cur && <span role="presentation" className="pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-slate-100 dark:text-slate-900" style={{ left: x, transform: `translateX(${x < 90 ? '-8px' : x > w - 90 ? 'calc(-100% + 8px)' : '-50%'})` }}>{detail(cur)}</span>}
    </div>
  );
}

/** Tiny response-time line without dependencies. */
export function Sparkline({ beats, width = 96, height = 28, className }: { beats: Beat[]; width?: number; height?: number; className?: string }) {
  const pts = beats.filter((b) => b[1] === 1 && b[2] != null) as [number, number, number][];
  if (pts.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;
  const lat = pts.map((p) => p[2]);
  const max = Math.max(...lat), min = Math.min(...lat), span = max - min || 1;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], dt = t1 - t0 || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(((p[0] - t0) / dt) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((p[2] - min) / span) * (height - 4)).toFixed(1)}`).join('');
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx('text-brand-500', className)} aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export const uptimeTone = (v: number | null): string => (v == null ? 'text-slate-400' : v >= 99.9 ? 'text-emerald-600 dark:text-emerald-400' : v >= 99 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400');

export type { Status, Overlay };
