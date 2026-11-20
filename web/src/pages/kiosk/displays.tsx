import type { ReactNode } from 'react';
import type { KioskConfig, Size } from '../../../../src/core/kiosk';
import { PlayersLine } from '../../components/ServerInfo';
import { HeartbeatBar, uptimeTone } from '../../components/status';
import { cx } from '../../components/ui';
import type { HistoryResponse } from '../../lib/api';
import { fmtMs, fmtPct } from '../../lib/format';
import { cardFit, chunk, packColumns, packPages, perPage, wallFit, wallFitGrouped, type Row, type Section } from '../../lib/kiosk-layout';
import { cellsOf, groupSections, HEAT_LOOK, heatLevel, hourStarts, rowUptime, type GroupLike, type ViewSection } from '../../lib/viewModel';
import { GroupHead, KioskDot, sinceText, statusOf, WORST_BG, type DisplayCtx, type ScreenMonitor } from './shared';

/** A display cut into pages for the current screen size; `render` draws one page. */
export interface Plan { pages: number; render: (page: number, ctx: DisplayCtx) => ReactNode }
export interface PlanInput { cfg: KioskConfig; list: ScreenMonitor[]; groups: GroupLike[]; w: number; h: number; z: number; history?: HistoryResponse }

const px = (n: number) => `${n}px`;
const sizeOf = <V,>(m: Record<Size, V>, s: Size): V => m[s];

/** Grouped layouts: problems first, monitors without a group last. Items keep the urgency order of `list`. */
const viewSections = (list: ScreenMonitor[], groups: GroupLike[]): ViewSection<ScreenMonitor>[] => groupSections(list, groups, { order: 'problems', ungrouped: 'last' });
const sectionsOf = (list: ScreenMonitor[], groups: GroupLike[]): Section<ScreenMonitor>[] =>
  viewSections(list, groups).map((s) => ({ key: s.key, id: s.group?.id ?? null, label: s.path, items: s.items }));
const headLabel = (sec: Section<ScreenMonitor>) => (sec.id == null ? null : sec.label);

export function planDisplay(i: PlanInput): Plan {
  switch (i.cfg.display) {
    case 'wall': return planWall(i);
    case 'groups': return planGroups(i);
    case 'table': return planTable(i);
    case 'heatmap': return planHeatmap(i);
    default: return planCards(i);
  }
}

/* ---------------------------------- cards ---------------------------------- */

const TILE: Record<Size, [number, number]> = { s: [210, 124], m: [270, 156], l: [350, 196] };
// sizes inside a tile are in em of the tile's font size, so a grown tile scales its text with it
const NAME_CLS: Record<Size, string> = { s: 'text-[1em]', m: 'text-[1.25em]', l: 'text-[1.5em]' };
const BIG_CLS: Record<Size, string> = { s: 'text-[1.125em]', m: 'text-[1.5em]', l: 'text-[1.875em]' };
const CARD_GROW = 2.5;
const HEAD_H = 48; // heading row of the tile displays: 2.25rem plus the 0.75rem gap

function Card({ m, ctx, grouped, scale = 1 }: { m: ScreenMonitor; ctx: DisplayCtx; grouped: boolean; scale?: number }) {
  const { t, cfg, look } = ctx;
  const s = statusOf(m);
  const group = !grouped && m.groupId != null ? ctx.groupPath.get(m.groupId) : undefined;
  // the error text replaces the group line, so a crowded tile keeps what matters
  const message = s === 'down' ? m.message : null;
  return (
    <li className={cx('flex min-h-0 min-w-0 flex-col justify-between gap-[0.25em] overflow-hidden rounded-[1em] border-2 p-[0.75em]', look.tile[s] ?? look.neutral)} style={{ fontSize: `${scale}rem` }}>
      <div className="shrink-0">
        <div className="flex items-start gap-[0.5em]"><KioskDot status={s} className="mt-[0.3em] h-[0.75em] w-[0.75em]" /><span className={cx('min-w-0 flex-1 truncate font-semibold leading-tight', NAME_CLS[cfg.size])}>{m.name}</span></div>
        {group && !message && <div className={cx('truncate pl-[1.25em] text-[0.75em] leading-tight', look.faint)}>{group}</div>}
      </div>
      {/* one full line of its own height: as a shrinking flex item with overflow hidden it would be cut through */}
      {message && <p className={cx('h-[1.25em] shrink-0 truncate text-[0.875em] font-medium leading-[1.25em]', look.downText)} title={message}>{message}</p>}
      {/* the history bar is what gives way when a tile gets crowded (between half and full height) */}
      {cfg.bars && <div className={cx('min-h-[0.5em] flex-1', cfg.size === 's' ? 'max-h-[1em]' : 'max-h-[1.5em]')}><HeartbeatBar beats={m.recent} count={cfg.size === 's' ? 24 : 32} height="h-full" interactive={false} /></div>}
      <div className={cx('flex shrink-0 items-end justify-between gap-[0.5em]', look.muted)}>
        <span className={cx('font-bold leading-tight tabular-nums', BIG_CLS[cfg.size], look.strong)}>{s === 'up' ? fmtMs(m.latencyMs) : t(`status.${s}`)}</span>
        <span className="flex flex-col items-end text-[0.875em] leading-tight">
          {m.info?.players !== undefined && <PlayersLine info={m.info} short className="font-semibold" />}
          <span>{s !== 'up' && m.statusSince ? sinceText(m, ctx) : <><span className="sr-only">{t('monitors.uptime')} 24h </span>{fmtPct(m.uptime.h24, 2)}</>}</span>
        </span>
      </div>
    </li>
  );
}

function headRow(r: Extract<Row<ScreenMonitor>, { kind: 'head' }>, ctx: DisplayCtx) {
  return <GroupHead key={`h-${r.sec.key}-${r.cont}`} items={r.sec.items} label={headLabel(r.sec)} cont={r.cont} ctx={ctx} className="col-span-full h-9" />;
}

function planCards({ cfg, list, groups, w, h, z }: PlanInput): Plan {
  const [tw0, th0] = sizeOf(TILE, cfg.size);
  const tw = tw0 * z, th = th0 * z;
  const cols = Math.max(1, Math.floor(w / tw));
  if (!cfg.grouped) {
    // few monitors grow to fill the screen (up to CARD_GROW times the chosen size); many are paged at the chosen size
    const f = cardFit(list.length, w, h, tw, th, 12 * z, CARD_GROW);
    const pages = chunk(list, f.perPage);
    const grid = f.tile
      ? { gridTemplateColumns: `repeat(${f.cols}, ${px(f.tile.w)})`, gridTemplateRows: `repeat(${f.rows}, ${px(f.tile.h)})`, justifyContent: 'center', alignContent: 'center' }
      : { gridTemplateColumns: `repeat(${f.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${f.rows}, minmax(0, 1fr))` };
    return {
      pages: pages.length,
      render: (p, ctx) => (
        <ul className="grid h-full gap-3" style={grid}>
          {(pages[p] ?? []).map((m) => <Card key={m.id} m={m} ctx={ctx} grouped={false} scale={f.scale} />)}
        </ul>
      ),
    };
  }
  // grouped pages are packed by height: a heading row is low, a tile row is a full tile high, and a heading never ends a page alone
  const pages = packPages(sectionsOf(list, groups), cols, h, th, HEAD_H * z);
  return {
    pages: Math.max(1, pages.length),
    render: (p, ctx) => (
      <ul className="grid h-full content-start gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: (pages[p] ?? []).map((r) => (r.kind === 'head' ? '2.25rem' : px(th - 12 * z))).join(' ') }}>
        {(pages[p] ?? []).flatMap((r) => (r.kind === 'head' ? [headRow(r, ctx)] : r.items.map((m) => <Card key={m.id} m={m} ctx={ctx} grouped />)))}
      </ul>
    ),
  };
}

/* ---------------------------------- status wall ---------------------------------- */

/** Smallest tile per size at 100 % zoom; larger screens or fewer monitors get larger tiles. */
const WALL_MIN: Record<Size, [number, number]> = { s: [150, 58], m: [190, 74], l: [250, 96] };
const WALL_TEXT: Record<Size, number> = { s: 0.95, m: 1.15, l: 1.45 };
const WALL_GAP = 8;
const WALL_SCALE_MAX = 2.5;

function WallTile({ m, ctx, scale }: { m: ScreenMonitor; ctx: DisplayCtx; scale: number }) {
  const { t, cfg, look } = ctx;
  const s = statusOf(m);
  const f = WALL_TEXT[cfg.size] * Math.min(scale, WALL_SCALE_MAX);
  const since = s === 'up' ? null : sinceText(m, ctx);
  return (
    <li className={cx('flex min-h-0 min-w-0 flex-col justify-center gap-0.5 overflow-hidden rounded-xl px-3 py-1', look.wall[s] ?? cx('border-2', look.neutral))}>
      <span className="truncate font-semibold leading-tight" style={{ fontSize: `${f}rem` }}>{m.name}</span>
      <span className={cx('truncate tabular-nums leading-tight', s === 'up' && 'opacity-75')} style={{ fontSize: `${f * 0.8}rem` }}>
        {s === 'up' ? <><span className="sr-only">{t('status.up')} </span>{fmtMs(m.latencyMs)}</> : <><span className="font-semibold">{t(`status.${s}`)}</span>{since && ` · ${since}`}</>}
      </span>
    </li>
  );
}

function planWall({ cfg, list, groups, w, h, z }: PlanInput): Plan {
  const [mw, mh] = sizeOf(WALL_MIN, cfg.size);
  const gap = WALL_GAP * z;
  if (!cfg.grouped) {
    const f = wallFit(list.length, w, h, mw * z, mh * z, gap);
    const pages = chunk(list, f.perPage);
    return {
      pages: pages.length,
      render: (p, ctx) => (
        <ul className="grid h-full gap-2" style={{ gridTemplateColumns: `repeat(${f.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${f.rows}, minmax(0, 1fr))` }}>
          {(pages[p] ?? []).map((m) => <WallTile key={m.id} m={m} ctx={ctx} scale={f.scale} />)}
        </ul>
      ),
    };
  }
  const g = wallFitGrouped(sectionsOf(list, groups), w, h, mw * z, mh * z, gap, 36 * z + gap);
  return {
    pages: Math.max(1, g.pages.length),
    render: (p, ctx) => (
      <ul className="grid h-full content-start gap-2" style={{ gridTemplateColumns: `repeat(${g.cols}, minmax(0, 1fr))`, gridTemplateRows: (g.pages[p] ?? []).map((r) => (r.kind === 'head' ? '2.25rem' : px(g.rowH - gap))).join(' ') }}>
        {(g.pages[p] ?? []).flatMap((r) => (r.kind === 'head' ? [headRow(r, ctx)] : r.items.map((m) => <WallTile key={m.id} m={m} ctx={ctx} scale={g.scale} />)))}
      </ul>
    ),
  };
}

/* ---------------------------------- group overview ---------------------------------- */

const G_COL: Record<Size, number> = { s: 300, m: 380, l: 480 };
const G_ROW: Record<Size, number> = { s: 30, m: 38, l: 50 };
const G_HEAD: Record<Size, number> = { s: 44, m: 52, l: 64 };
const G_TEXT: Record<Size, string> = { s: 'text-base', m: 'text-lg', l: 'text-2xl' };
const G_HEAD_TEXT: Record<Size, string> = { s: 'text-lg', m: 'text-xl', l: 'text-2xl' };
const G_GAP = 12;

function planGroups({ cfg, list, groups, w, h, z }: PlanInput): Plan {
  const gap = G_GAP * z, rowH = sizeOf(G_ROW, cfg.size) * z, headH = sizeOf(G_HEAD, cfg.size) * z;
  const cols = Math.max(1, Math.floor((w + gap) / (sizeOf(G_COL, cfg.size) * z + gap)));
  // the block border (2 px) counts with the header, so packed blocks never overflow their column
  const pages = packColumns(viewSections(list, groups), cols, h, headH + 2, rowH, gap);
  return {
    pages: pages.length,
    render: (p, ctx) => (
      // a page with fewer blocks than columns uses fewer, wider columns
      <div className="grid h-full items-start gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(1, (pages[p] ?? []).length)}, minmax(0, 1fr))` }}>
        {(pages[p] ?? []).map((col, ci) => (
          <div key={ci} className="flex min-w-0 flex-col gap-3">
            {col.map((piece) => {
              const sec = piece.block;
              const sum = sec.summary;
              const worst = sum.worst ?? 'unknown';
              const head = worst === 'up' ? ctx.look.okHead : WORST_BG[worst];
              return (
                <section key={`${sec.key}-${piece.cont}`} className={cx('overflow-hidden rounded-xl border', ctx.look.line)}>
                  <header className={cx('flex items-center gap-3 px-3', head)} style={{ height: px(headH) }}>
                    <h2 className={cx('min-w-0 flex-1 truncate font-semibold', G_HEAD_TEXT[ctx.cfg.size])}>{sec.group ? sec.path : ctx.t('kiosk.noGroup')}{piece.cont && <span className="ml-2 text-sm font-normal opacity-80">{ctx.t('kiosk.groupCont')}</span>}</h2>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{ctx.t('kiosk.groupUp', { n: sum.up, total: sum.total })}</span>
                  </header>
                  <ul>
                    {piece.items.map((m) => {
                      const s = statusOf(m);
                      return (
                        <li key={m.id} className={cx('flex items-center gap-3 border-t px-3', ctx.look.line, ctx.look.row[s], G_TEXT[ctx.cfg.size])} style={{ height: px(rowH) }}>
                          <KioskDot status={s} className="h-3 w-3" />
                          <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                          <span className={cx('shrink-0 tabular-nums', s === 'up' ? ctx.look.muted : 'font-semibold')}>{s === 'up' ? fmtMs(m.latencyMs) : sinceText(m, ctx) ?? ctx.t(`status.${s}`)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        ))}
      </div>
    ),
  };
}

/* ---------------------------------- list ---------------------------------- */

const T_ROW: Record<Size, number> = { s: 36, m: 46, l: 60 };
const T_TEXT: Record<Size, string> = { s: 'text-base', m: 'text-lg', l: 'text-2xl' };
const T_COLS: Record<Size, { status: string; value: string; up: string }> = { s: { status: '8rem', value: '10rem', up: '6rem' }, m: { status: '10rem', value: '12rem', up: '7rem' }, l: { status: '12rem', value: '15rem', up: '9rem' } };
const COL_HEAD = 32, GROUP_HEAD = 44;

/** Rows of the list and the heatmap per page: flat, or with a heading row per group (one item per row). */
function listPages(cfg: KioskConfig, list: ScreenMonitor[], groups: GroupLike[], avail: number, rowH: number, headH: number): Row<ScreenMonitor>[][] {
  if (cfg.grouped) return packPages(sectionsOf(list, groups), 1, avail, rowH, headH);
  const sec: Section<ScreenMonitor> = { key: 'all', id: null, label: '', items: [] };
  return chunk(list, perPage(avail, rowH)).map((items) => items.map((m) => ({ kind: 'tiles' as const, sec, items: [m] })));
}

function planTable({ cfg, list, groups, h, z }: PlanInput): Plan {
  const rowH = T_ROW[cfg.size] * z, headH = GROUP_HEAD * z;
  // collapsed table borders may add a pixel per row: reserve it, so the last row is never cut off
  const pages = listPages(cfg, list, groups, h - COL_HEAD * z - 1, rowH + 1, headH + 1);
  const c = T_COLS[cfg.size];
  const cols = 4 + (cfg.grouped ? 0 : 1) + (cfg.bars ? 1 : 0);
  return {
    pages: Math.max(1, pages.length),
    render: (p, ctx) => {
      const { t, look } = ctx;
      const th = cx('truncate px-3 text-left text-xs font-semibold uppercase tracking-wide', look.faint);
      return (
        <table className={cx('w-full table-fixed border-collapse', T_TEXT[cfg.size])}>
          <colgroup>
            <col style={{ width: c.status }} /><col />{!cfg.grouped && <col style={{ width: '24%' }} />}<col style={{ width: c.value }} /><col style={{ width: c.up }} />{cfg.bars && <col style={{ width: '24%' }} />}
          </colgroup>
          <thead>
            <tr className={cx('border-b', look.line)} style={{ height: px(COL_HEAD * z) }}>
              <th className={th}>{t('kiosk.col.status')}</th><th className={th}>{t('kiosk.col.name')}</th>{!cfg.grouped && <th className={th}>{t('kiosk.col.group')}</th>}
              <th className={cx(th, 'text-right')}>{t('kiosk.col.state')}</th><th className={cx(th, 'text-right')}>{t('kiosk.uptime24')}</th>{cfg.bars && <th className={th}>{t('kiosk.col.history')}</th>}
            </tr>
          </thead>
          <tbody>
            {(pages[p] ?? []).map((r) => {
              if (r.kind === 'head') return <tr key={`h-${r.sec.key}-${r.cont}`} style={{ height: px(headH) }}><td colSpan={cols} className="p-0 align-bottom"><GroupHead as="div" items={r.sec.items} label={headLabel(r.sec)} cont={r.cont} ctx={ctx} className="h-10 px-3" /></td></tr>;
              const m = r.items[0]!;
              const s = statusOf(m);
              return (
                <tr key={m.id} className={cx('border-b', look.line, look.row[s] ?? look.zebra)} style={{ height: px(rowH) }}>
                  <td className="px-3"><span className={cx('flex items-center gap-2 font-semibold', s === 'down' && look.downText)}><KioskDot status={s} className="h-3 w-3" /><span className="truncate">{t(`status.${s}`)}</span></span></td>
                  <td className="truncate px-3 font-medium">{m.name}</td>
                  {!cfg.grouped && <td className={cx('truncate px-3', look.muted)}>{m.groupId != null ? ctx.groupPath.get(m.groupId) ?? '' : ''}</td>}
                  <td className={cx('truncate px-3 text-right tabular-nums', s === 'up' ? look.muted : 'font-semibold')}>{s === 'up' ? fmtMs(m.latencyMs) : sinceText(m, ctx) ?? '–'}</td>
                  <td className={cx('px-3 text-right tabular-nums', uptimeTone(m.uptime.h24))}>{fmtPct(m.uptime.h24, 2)}</td>
                  {cfg.bars && <td className="px-3"><HeartbeatBar beats={m.recent} count={30} height={cfg.size === 'l' ? 'h-7' : cfg.size === 'm' ? 'h-5' : 'h-4'} interactive={false} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    },
  };
}

/* ---------------------------------- 24-hour heatmap ---------------------------------- */

const H_ROW: Record<Size, number> = { s: 26, m: 34, l: 46 };
const H_NAME: Record<Size, string> = { s: '13rem', m: '17rem', l: '22rem' };
const H_UP: Record<Size, string> = { s: '5.5rem', m: '7rem', l: '9rem' };
const LABEL_H = 28, H_GROUP_HEAD = 44;

function planHeatmap({ cfg, list, groups, h, z, history }: PlanInput): Plan {
  const rowH = H_ROW[cfg.size] * z, headH = H_GROUP_HEAD * z;
  const pages = listPages(cfg, list, groups, h - LABEL_H * z, rowH, headH);
  const hours = history?.hours ?? 24;
  const starts = history ? hourStarts(history) : [];
  const grid = { display: 'grid', gridTemplateColumns: `${H_NAME[cfg.size]} repeat(${hours}, minmax(0, 1fr)) ${H_UP[cfg.size]}`, columnGap: '3px', alignItems: 'stretch' } as const;
  return {
    pages: Math.max(1, pages.length),
    render: (p, ctx) => {
      const { t, look } = ctx;
      return (
        <div className={cx('flex h-full flex-col', T_TEXT[cfg.size])}>
          <div style={{ ...grid, height: px(LABEL_H * z) }} className={cx('items-end text-xs tabular-nums', look.faint)} aria-hidden>
            <span />
            {Array.from({ length: hours }, (_, i) => <span key={i} className="overflow-visible whitespace-nowrap">{i % 3 === 0 && starts[i] ? ctx.hourLabel(starts[i]!) : ''}</span>)}
            <span className="text-right">{t('kiosk.heat.window')}</span>
          </div>
          <ul>
            {(pages[p] ?? []).map((r) => {
              if (r.kind === 'head') return <GroupHead key={`h-${r.sec.key}-${r.cont}`} items={r.sec.items} label={headLabel(r.sec)} cont={r.cont} ctx={ctx} className="items-end pb-1" style={{ height: px(headH) }} />;
              const m = r.items[0]!;
              const s = statusOf(m);
              const cells = history ? cellsOf(history, m.id) : Array.from({ length: hours }, () => null);
              const up = rowUptime(cells);
              return (
                <li key={m.id} style={{ ...grid, height: px(rowH), paddingBlock: px(3 * z) }}>
                  <span className="flex min-w-0 items-center gap-2 pr-2"><KioskDot status={s} className="h-3 w-3" /><span className="truncate font-medium">{m.name}</span><span className="sr-only">{t(`status.${s}`)}</span></span>
                  {cells.map((c, i) => { const l = HEAT_LOOK[heatLevel(c)]; return <span key={i} aria-hidden className={cx('rounded-sm', l.cls)} style={l.style} />; })}
                  <span className={cx('self-center text-right font-semibold tabular-nums', uptimeTone(up))}>{fmtPct(up, 2)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      );
    },
  };
}
