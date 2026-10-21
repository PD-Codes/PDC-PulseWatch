import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useTheme } from '../lib/theme';

export interface ChartSeries { label: string; color: string; fill?: boolean; width?: number; dash?: number[] }

/**
 * Time series chart (uPlot). `x` is in epoch seconds, each entry of `ys` lines up with `x` and `series`.
 * Optional `bands` shade time ranges (e.g. outages): [startSec, endSec, cssColor].
 */
export function TimeChart({ x, ys, series, height = 220, unit = 'ms', bands = [], className, onSelect }: { x: number[]; ys: (number | null)[][]; series: ChartSeries[]; height?: number; unit?: string; bands?: [number, number, string][]; className?: string; onSelect?: (fromSec: number, toSec: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const pick = useRef(onSelect);
  pick.current = onSelect; // read at drag end, so a new callback does not rebuild the chart
  const brush = !!onSelect;
  const { dark } = useTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const axis = dark ? '#94a3b8' : '#64748b', grid = dark ? '#1e293b' : '#e2e8f0';
    const opts: uPlot.Options = {
      width: el.clientWidth || 600, height, padding: [8, 8, 0, 0], cursor: { drag: { x: true, y: false, setScale: !brush } },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [0, Math.max(10, max * 1.15)] } },
      axes: [
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 56, values: (_u, v) => v.map((n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}s` : `${Math.round(n)}${unit === 'ms' ? 'ms' : unit}`)) },
      ],
      series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, width: s.width ?? 1.5, dash: s.dash, fill: s.fill ? `${s.color}22` : undefined, spanGaps: false, points: { show: x.length < 80 } }))],
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
          for (const [a, b, c] of bands) {
            const x0 = Math.max(bbox.left, u.valToPos(a, 'x', true)), x1 = Math.min(bbox.left + bbox.width, u.valToPos(b, 'x', true));
            if (x1 > x0) { ctx.save(); ctx.fillStyle = c; ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height); ctx.restore(); }
          }
        }],
      },
    };
    const plot = new uPlot(opts, [x, ...ys] as uPlot.AlignedData, el);
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => { ro.disconnect(); plot.destroy(); };
  }, [x, ys, series, height, unit, bands, dark, brush]);

  return <div ref={host} className={className} role="img" aria-label={series.map((s) => s.label).join(', ')} />;
}
