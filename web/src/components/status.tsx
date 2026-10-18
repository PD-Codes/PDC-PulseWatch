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
      <span className={cx('relative inline-flex h-2.5 w-2.5 rounded-full', STATUS_COLOR[status])} />
    </span>
  );
}

export function StatusBadge({ status }: { status: DisplayStatus }) {
  const t = useT();
  return <Badge tone={TONE[status]}><StatusDot status={status} className="h-2 w-2" />{t(`status.${status}`)}</Badge>;
}

const BEAT_COLOR = (s: number) => (s === 1 ? 'bg-emerald-500' : s === 3 ? 'bg-sky-500' : s === 2 ? 'bg-amber-500' : 'bg-red-500');

/** Strip of the most recent checks. Each bar is one heartbeat; the strip is padded on the left when history is short. */
export function HeartbeatBar({ beats, count = 40, className, height = 'h-6' }: { beats: Beat[]; count?: number; className?: string; height?: string }) {
  const t = useT();
  const shown = beats.slice(-count);
  const pad = count - shown.length;
  const up = shown.filter((b) => b[1] === 1).length;
  return (
    <div className={cx('flex items-stretch gap-[2px]', height, className)} role="img" aria-label={t('monitors.beatsLabel', { up, total: shown.length })}>
      {Array.from({ length: pad }, (_, i) => <span key={`p${i}`} className="w-full min-w-[2px] max-w-[8px] flex-1 rounded-sm bg-slate-200 dark:bg-slate-800" />)}
      {shown.map((b) => <span key={b[0]} title={`${fmtDateTime(b[0] * 1000)} · ${b[1] === 1 ? fmtMs(b[2]) : t(b[1] === 3 ? 'status.maintenance' : 'status.down')}`} className={cx('w-full min-w-[2px] max-w-[8px] flex-1 rounded-sm', BEAT_COLOR(b[1]))} />)}
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
