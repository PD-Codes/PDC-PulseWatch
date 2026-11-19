import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

/** `color` of the first series is replaced by --pw-chart-line when the theme defines it. */
export interface ChartSeries { label: string; color: string; fill?: boolean; width?: number; dash?: number[] }

/** Chart colors from the active theme (CSS variables on <html>), with the built-in light/dark values as fallback. */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const dark = document.documentElement.classList.contains('dark');
  return { line: v('--pw-chart-line'), area: v('--pw-chart-area'), grid: v('--pw-chart-grid') || (dark ? '#1e293b' : '#e2e8f0'), text: v('--pw-chart-text') || (dark ? '#94a3b8' : '#64748b') };
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * Time series chart (uPlot). `x` is in epoch seconds, each entry of `ys` lines up with `x` and `series`.
 * Optional `bands` shade time ranges (e.g. outages): [startSec, endSec, cssColor].
 * Axis labels, legend and numbers follow the UI language; colors follow the theme and the chart redraws on `pw:theme`.
 */
export function TimeChart({ x, ys, series, height = 220, unit = 'ms', bands = [], className, onSelect }: { x: number[]; ys: (number | null)[][]; series: ChartSeries[]; height?: number; unit?: string; bands?: [number, number, string][]; className?: string; onSelect?: (fromSec: number, toSec: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const pick = useRef(onSelect);
  pick.current = onSelect; // read at drag end, so a new callback does not rebuild the chart
  const brush = !!onSelect;
  const { locale, t } = useI18n();
  const [themeTick, setThemeTick] = useState(0);
  // the theme sets its variables after it announces itself: redraw on the next frame
  useEffect(() => {
    const h = () => requestAnimationFrame(() => setThemeTick((n) => n + 1));
    window.addEventListener('pw:theme', h);
    return () => window.removeEventListener('pw:theme', h);
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = themeColors();
    const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    const hm = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    const hms = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
    const month = new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit' });
    // time axis: the format follows the tick spacing; the first tick after midnight carries the date
    const timeTicks = (_u: uPlot, splits: number[], _axis: number, _space: number, incr: number) => splits.map((s) => {
      const d = new Date(s * 1000);
      if (incr >= 86400 * 28) return month.format(d);
      if (incr >= 86400) return day.format(d);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      if (midnight) return day.format(d);
      return incr < 60 ? hms.format(d) : hm.format(d);
    });
    const valueText = (n: number) => (unit === 'ms' ? (n >= 1000 ? `${num.format(n / 1000)} s` : `${num.format(Math.round(n))} ms`) : `${num.format(n)} ${unit}`);
    const colorOf = (s: ChartSeries, i: number) => (i === 0 && c.line ? c.line : s.color);
    const fillOf = (s: ChartSeries, i: number) => {
      if (!s.fill) return undefined;
      if (i === 0 && c.area) return c.area;
      const col = colorOf(s, i);
      return HEX6.test(col) ? `${col}22` : undefined;
    };
    const opts: uPlot.Options = {
      width: el.clientWidth || 600, height, padding: [8, 8, 0, 0], cursor: { drag: { x: true, y: false, setScale: !brush } },
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(10, max * 1.15)] } },
      axes: [
        { stroke: c.text, grid: { stroke: c.grid, width: 1 }, ticks: { stroke: c.grid }, values: timeTicks },
        { stroke: c.text, grid: { stroke: c.grid, width: 1 }, ticks: { stroke: c.grid }, size: 60, values: (_u, v) => v.map(valueText) },
      ],
      series: [
        { label: t('shell.chart.time'), value: (_u, v) => (v == null ? '–' : fmtDateTime(v * 1000)) },
        ...series.map((s, i) => ({ label: s.label, stroke: colorOf(s, i), width: s.width ?? 1.5, dash: s.dash, fill: fillOf(s, i), spanGaps: false, points: { show: x.length < 80 }, value: (_u: uPlot, v: number | null) => (v == null ? '–' : valueText(v)) })),
      ],
      hooks: {
        // dragging across the chart hands the time span to the caller (which loads that window) instead of only zooming locally
        setSelect: [(u) => {
          if (!pick.current || u.select.width < 8) return;
          const a = u.posToVal(u.select.left, 'x'), b = u.posToVal(u.select.left + u.select.width, 'x');
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          pick.current(Math.floor(a), Math.ceil(b));
        }],
        drawClear: [(u) => {
          const { ctx, bbox } = u;
          for (const [a, b, col] of bands) {
            const x0 = Math.max(bbox.left, u.valToPos(a, 'x', true)), x1 = Math.min(bbox.left + bbox.width, u.valToPos(b, 'x', true));
            if (x1 > x0) { ctx.save(); ctx.fillStyle = col; ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height); ctx.restore(); }
          }
        }],
      },
    };
    const plot = new uPlot(opts, [x, ...ys] as uPlot.AlignedData, el);
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => { ro.disconnect(); plot.destroy(); };
  }, [x, ys, series, height, unit, bands, brush, locale, t, themeTick]);

  return <div ref={host} className={className} role="img" aria-label={series.map((s) => s.label).join(', ')} />;
}
