import type { KioskConfig } from '../../../../src/core/kiosk';
import type { ServerInfo } from '../../lib/api';
import { fmtDuration } from '../../lib/format';
import { isThemeId, themeInfo } from '../../lib/theme';
import { summarize, viewStatus, type ViewMonitor, type ViewStatus } from '../../lib/viewModel';
import { STATUS_COLOR } from '../../components/status';
import { cx } from '../../components/ui';

/** A monitor as the wall display draws it: MonitorItem (signed in) and KioskMonitor (kiosk key) both fit. */
export type ScreenMonitor = ViewMonitor & { message: string | null; info: Pick<ServerInfo, 'players' | 'maxPlayers'> | null };

export type T = (key: string, vars?: Record<string, string | number>) => string;

/** Effective brightness: themes with a single mode fix it, the others follow the chosen mode. */
export const isDark = (c: Pick<KioskConfig, 'theme' | 'mode'>): boolean => {
  const modes = isThemeId(c.theme) ? themeInfo(c.theme).modes : ['dark', 'light'];
  return modes.length === 1 ? modes[0] === 'dark' : c.mode === 'dark';
};

// the whole look is described here once; the light variant is for bright rooms and projectors
export const LOOKS = {
  dark: {
    root: 'bg-slate-950 text-white', muted: 'text-slate-300', faint: 'text-slate-400', strong: 'text-white', neutral: 'border-slate-600 bg-slate-900', line: 'border-slate-700', strip: 'bg-slate-900 text-white', stripLine: 'border-slate-800',
    tile: { down: 'border-red-500 bg-red-950/60', pending: 'border-amber-500 bg-amber-950/50', suppressed: 'border-violet-500 bg-violet-950/50', maintenance: 'border-sky-500 bg-sky-950/50', up: 'border-emerald-800 bg-emerald-950/40' } as Partial<Record<ViewStatus, string>>,
    // status wall: problems are solid blocks, readable across the room; healthy tiles stay quiet
    wall: { down: 'bg-red-600 text-white', pending: 'bg-amber-500 text-slate-950', suppressed: 'bg-violet-600 text-white', maintenance: 'bg-sky-700 text-white', up: 'border-2 border-emerald-800 bg-emerald-950/40 text-white' } as Partial<Record<ViewStatus, string>>,
    row: { down: 'bg-red-950/60', pending: 'bg-amber-950/50', suppressed: 'bg-violet-950/40' } as Partial<Record<ViewStatus, string>>,
    downText: 'text-red-400', zebra: 'odd:bg-white/[0.03]', okHead: 'bg-emerald-900/70 text-white',
  },
  light: {
    root: 'bg-slate-100 text-slate-900', muted: 'text-slate-600', faint: 'text-slate-500', strong: 'text-slate-900', neutral: 'border-slate-300 bg-white', line: 'border-slate-300', strip: 'bg-white text-slate-900', stripLine: 'border-slate-200',
    tile: { down: 'border-red-500 bg-red-50', pending: 'border-amber-400 bg-amber-50', suppressed: 'border-violet-400 bg-violet-50', maintenance: 'border-sky-400 bg-sky-50', up: 'border-emerald-400 bg-white' } as Partial<Record<ViewStatus, string>>,
    wall: { down: 'bg-red-600 text-white', pending: 'bg-amber-400 text-slate-950', suppressed: 'bg-violet-600 text-white', maintenance: 'bg-sky-600 text-white', up: 'border-2 border-emerald-400 bg-white text-slate-900' } as Partial<Record<ViewStatus, string>>,
    row: { down: 'bg-red-100', pending: 'bg-amber-100', suppressed: 'bg-violet-100' } as Partial<Record<ViewStatus, string>>,
    downText: 'text-red-700', zebra: 'odd:bg-slate-900/[0.03]', okHead: 'bg-emerald-100 text-emerald-950',
  },
};
export type Look = (typeof LOOKS)['dark'];

/** Color of the worst status of a group, for its marker or header. */
export const WORST_BG: Record<ViewStatus, string> = { down: 'bg-red-600 text-white', pending: 'bg-amber-500 text-slate-950', suppressed: 'bg-violet-600 text-white', maintenance: 'bg-sky-700 text-white', unknown: 'bg-slate-600 text-white', up: 'bg-emerald-700 text-white', paused: 'bg-slate-600 text-white' };
export const WORST_DOT: Record<ViewStatus, string> = { down: 'bg-red-500', pending: 'bg-amber-500', suppressed: 'bg-violet-500', maintenance: 'bg-sky-500', unknown: 'bg-slate-400', up: 'bg-emerald-500', paused: 'bg-slate-400' };

/** Everything a display needs to draw a page. */
export interface DisplayCtx { t: T; cfg: KioskConfig; look: Look; dark: boolean; now: number; z: number; groupPath: Map<number, string>; hourLabel: (d: Date) => string }

/** "for 3m 10s" since the status changed, or null when unknown. */
export const sinceText = (m: Pick<ViewMonitor, 'statusSince'>, ctx: Pick<DisplayCtx, 't' | 'now'>): string | null =>
  m.statusSince ? ctx.t('kiosk.for', { d: fmtDuration((ctx.now - Date.parse(m.statusSince)) / 1000) }) : null;

/** Heading of a group: worst-status marker, path, "n of m up". Used by the tile displays, the list and the heatmap. */
export function GroupHead({ items, label, cont, ctx, className, as: Tag = 'li', style }: { items: ScreenMonitor[]; label: string | null; cont: boolean; ctx: DisplayCtx; className?: string; as?: 'li' | 'div'; style?: React.CSSProperties }) {
  const s = summarize(items);
  return (
    <Tag className={cx('flex items-center gap-3 border-b', ctx.look.line, className)} style={style}>
      <span className={cx('h-3 w-3 shrink-0 rounded-full', WORST_DOT[s.worst ?? 'unknown'])} aria-hidden />
      <h2 className="min-w-0 truncate text-xl font-semibold">{label ?? ctx.t('kiosk.noGroup')}{cont && <span className={cx('ml-2 text-sm font-normal', ctx.look.faint)}>{ctx.t('kiosk.groupCont')}</span>}</h2>
      <span className={cx('ml-auto shrink-0 text-sm', s.down ? cx('font-semibold', ctx.look.downText) : ctx.look.faint)}>{ctx.t('kiosk.groupUp', { n: s.up, total: s.total })}</span>
    </Tag>
  );
}

export const statusOf = (m: ScreenMonitor): ViewStatus => viewStatus(m);

/**
 * Status dot whose ring, dot and pulse all take the size given in `className` (em or rem), so it stays round and centered in a
 * grown tile. StatusDot in components/status has a fixed inner dot.
 */
export function KioskDot({ status, className }: { status: ViewStatus; className?: string }) {
  return (
    <span className={cx('relative inline-flex shrink-0', className)} aria-hidden>
      {status === 'down' && <span className="absolute inset-0 animate-ping rounded-full bg-red-400 opacity-60 motion-reduce:hidden" />}
      <span className={cx('relative h-full w-full rounded-full', status === 'paused' ? 'border-2 border-slate-400 bg-transparent dark:border-slate-500' : STATUS_COLOR[status])} />
    </span>
  );
}
