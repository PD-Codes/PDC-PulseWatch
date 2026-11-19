#!/usr/bin/env node
// Generates palettes.css (CSS variables for every theme/mode) and checks WCAG contrast.
// Usage: node web/src/themes/build-palettes.mjs [--report]
// Ramps are written as "R G B" channels so Tailwind's opacity modifiers keep working.
// Shades that are used as text get nudged in OKLCH lightness until they reach 4.5:1 on their usual backgrounds.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

// ---- color math (sRGB <-> OKLCH, WCAG luminance) ----
const hex2rgb = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };
const rgb2hex = (c) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLin = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function rgb2oklch(rgb) {
  const [r, g, b] = rgb.map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}
function oklch2rgbRaw([L, C, H]) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(fromLin);
}
const inGamut = (c) => c.every((v) => v >= -0.0005 && v <= 1.0005);
/** OKLCH to sRGB; lowers chroma until the color fits. */
function oklch2rgb([L, C, H]) {
  let c = oklch2rgbRaw([L, C, H]);
  if (inGamut(c)) return c;
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklch2rgbRaw([L, mid, H]))) lo = mid; else hi = mid; }
  return oklch2rgbRaw([L, lo, H]);
}
const lum = (hex) => { const [r, g, b] = hex2rgb(hex).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const blend = (fg, bg, alpha) => rgb2hex(hex2rgb(fg).map((v, i) => v * alpha + hex2rgb(bg)[i] * (1 - alpha)));
const chan = (hex) => hex2rgb(hex).map((v) => Math.round(v * 255)).join(' ');

// ---- ramp builders ----
const TW = {
  slate: ['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1e293b', '#0f172a', '#020617'],
  indigo: ['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b'],
  emerald: ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22'],
  red: ['#fef2f2', '#fee2e2', '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d', '#450a0a'],
  amber: ['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#78350f', '#451a03'],
  sky: ['#f0f9ff', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985', '#0c4a6e', '#082f49'],
  violet: ['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065'],
  orange: ['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412', '#7c2d12', '#431407'],
  lime: ['#f7fee7', '#ecfccb', '#d9f99d', '#bef264', '#a3e635', '#84cc16', '#65a30d', '#4d7c0f', '#3f6212', '#365314', '#1a2e05'],
  neutral: ['#fafafa', '#f5f5f5', '#e5e5e5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#404040', '#262626', '#171717', '#0a0a0a'],
};
const L_CURVE = [0.975, 0.945, 0.9, 0.84, 0.76, 0.67, 0.585, 0.51, 0.44, 0.38, 0.29];
const C_CURVE = [0.12, 0.25, 0.45, 0.7, 0.9, 1, 1, 0.92, 0.8, 0.68, 0.5];
/** Ramp from a hue and peak chroma; optional lightness curve. */
const ramp = (h, c, l = L_CURVE, cf = C_CURVE) => SHADES.map((_, i) => rgb2hex(oklch2rgb([l[i], c * cf[i], h])));
/** Ramp that keeps the hue/chroma of an anchor color. */
const like = (hex, l, cf) => { const [, c, h] = rgb2oklch(hex2rgb(hex)); return ramp(h, c, l, cf); };
/** Neutral ramp from explicit lightness values (dark themes want their own steps). */
const neutral = (h, c, l) => ramp(h, c, l, SHADES.map(() => 1));
/** Replace single shades of a ramp: pin(r, { 900: '#2e3440' }). */
const pin = (r, map) => r.map((v, i) => map[SHADES[i]] ?? v);

// ---- themes ----
// families: slate (neutral), brand, emerald (up), red (down), amber (pending), sky (maintenance), violet (suppressed), orange, lime.
const F = ['slate', 'brand', 'emerald', 'red', 'amber', 'sky', 'violet', 'orange', 'lime'];
const STATUS = ['brand', 'emerald', 'red', 'amber', 'sky', 'violet'];

const tw = { slate: TW.slate, brand: TW.indigo, emerald: TW.emerald, red: TW.red, amber: TW.amber, sky: TW.sky, violet: TW.violet, orange: TW.orange, lime: TW.lime };

const THEMES = [
  { id: 'classic', mode: 'light', sel: ':root, [data-theme="classic"]', white: '#ffffff', ...tw },
  { id: 'classic', mode: 'dark', sel: ':root.dark:not([data-theme]), [data-theme="classic"].dark', white: '#ffffff', ...tw },
  {
    id: 'dark', mode: 'dark', sel: '[data-theme="dark"]', white: '#f4f4f5',
    slate: neutral(260, 0.006, [0.975, 0.94, 0.87, 0.8, 0.72, 0.64, 0.47, 0.37, 0.29, 0.225, 0.185]),
    brand: like('#4f8ff7'), emerald: like('#2fbf7f'), red: like('#ef5350'), amber: like('#f0a83a'), sky: like('#3fb6d9'), violet: like('#a87ef0'), orange: like('#f28c3a'), lime: like('#9ccc3a'),
  },
  {
    id: 'smooth', mode: 'light', sel: '[data-theme="smooth"]', white: '#fffefc',
    slate: neutral(70, 0.008, [0.972, 0.95, 0.91, 0.855, 0.68, 0.58, 0.5, 0.43, 0.36, 0.3, 0.24]),
    brand: like('#7b6fd6'), emerald: like('#4fae8c'), red: like('#e0707a'), amber: like('#e9a84a'), sky: like('#5aa9d6'), violet: like('#b07fd6'), orange: like('#ec9a6a'), lime: like('#9cc463'),
  },
  {
    id: 'smooth', mode: 'dark', sel: '[data-theme="smooth"].dark', white: '#fbf9ff',
    slate: neutral(295, 0.014, [0.97, 0.935, 0.88, 0.81, 0.74, 0.66, 0.5, 0.4, 0.33, 0.265, 0.225]),
    brand: like('#a99ef0'), emerald: like('#7fd1b4'), red: like('#f0959b'), amber: like('#f0c27a'), sky: like('#8cc4ea'), violet: like('#cfa3ee'), orange: like('#f2ad86'), lime: like('#b9dc8a'),
  },
  {
    id: 'mono', mode: 'light', sel: '[data-theme="mono"]', white: '#ffffff',
    slate: TW.neutral, brand: pin(TW.neutral, { 500: '#525252', 600: '#262626', 700: '#171717' }), emerald: TW.emerald, red: TW.red, amber: TW.amber, sky: TW.sky, violet: TW.violet, orange: TW.orange, lime: TW.lime,
  },
  {
    id: 'mono', mode: 'dark', sel: '[data-theme="mono"].dark', white: '#ffffff',
    slate: TW.neutral, brand: pin(TW.neutral, { 400: '#d4d4d4', 600: '#525252', 700: '#404040' }), emerald: TW.emerald, red: TW.red, amber: TW.amber, sky: TW.sky, violet: TW.violet, orange: TW.orange, lime: TW.lime,
  },
  {
    id: 'nord', mode: 'dark', sel: '[data-theme="nord"]', white: '#eceff4',
    slate: pin(neutral(265, 0.022, [0.97, 0.955, 0.93, 0.89, 0.78, 0.68, 0.56, 0.45, 0.39, 0.324, 0.285]), { 50: '#f3f5f8', 100: '#eceff4', 200: '#e5e9f0', 300: '#d8dee9', 700: '#434c5e', 800: '#3b4252', 900: '#2e3440', 950: '#242933' }),
    brand: like('#88c0d0'), emerald: like('#a3be8c'), red: like('#bf616a'), amber: like('#ebcb8b'), sky: like('#81a1c1'), violet: like('#b48ead'), orange: like('#d08770'), lime: like('#8fbcbb'),
  },
  {
    id: 'cyberpunk', mode: 'dark', sel: '[data-theme="cyberpunk"]', white: '#fbf7ff',
    slate: neutral(305, 0.03, [0.97, 0.93, 0.86, 0.79, 0.7, 0.6, 0.42, 0.33, 0.26, 0.19, 0.145]),
    brand: ramp(345, 0.3), emerald: ramp(150, 0.26), red: ramp(22, 0.25), amber: ramp(105, 0.2, [0.985, 0.97, 0.95, 0.93, 0.91, 0.87, 0.72, 0.6, 0.5, 0.42, 0.32]), sky: ramp(205, 0.17), violet: ramp(300, 0.27), orange: ramp(50, 0.22), lime: ramp(130, 0.24),
  },
  {
    id: 'scifi', mode: 'dark', sel: '[data-theme="scifi"]', white: '#e9f6fc',
    slate: neutral(245, 0.04, [0.97, 0.93, 0.87, 0.8, 0.72, 0.62, 0.45, 0.35, 0.28, 0.215, 0.165]),
    brand: ramp(215, 0.14), emerald: ramp(170, 0.14), red: ramp(18, 0.19), amber: ramp(80, 0.15), sky: ramp(250, 0.14), violet: ramp(295, 0.16), orange: ramp(55, 0.16), lime: ramp(130, 0.16),
  },
  {
    id: 'lcars', mode: 'dark', sel: '[data-theme="lcars"]', white: '#fff4e6',
    slate: neutral(60, 0.012, [0.97, 0.93, 0.87, 0.8, 0.72, 0.62, 0.45, 0.34, 0.26, 0.17, 0.08]),
    brand: like('#ff9933'), emerald: like('#7fd87f'), red: like('#ff5f5a'), amber: like('#ffcc66'), sky: like('#9999ff'), violet: like('#cc99cc'), orange: like('#ff7700'), lime: like('#c9e86a'),
  },
  {
    id: 'terminal', mode: 'dark', sel: '[data-theme="terminal"]', white: '#d8ffe2',
    slate: neutral(145, 0.06, [0.97, 0.94, 0.9, 0.86, 0.8, 0.7, 0.5, 0.36, 0.26, 0.17, 0.1]),
    brand: ramp(145, 0.22), emerald: ramp(150, 0.2), red: ramp(25, 0.21), amber: ramp(75, 0.17), sky: ramp(215, 0.13), violet: ramp(310, 0.17), orange: ramp(55, 0.17), lime: ramp(125, 0.2),
  },
  {
    id: 'contrast', mode: 'light', sel: '[data-theme="contrast"]', white: '#ffffff',
    slate: pin(TW.slate, { 300: '#6b7280', 400: '#3f4756', 500: '#2b3240', 600: '#1f2530', 700: '#151a22', 800: '#0b0e13', 900: '#05070a' }),
    brand: pin(TW.indigo, { 500: '#2f2bd0', 600: '#1d1bb3', 700: '#15138a' }), emerald: TW.emerald, red: TW.red, amber: TW.amber, sky: TW.sky, violet: TW.violet, orange: TW.orange, lime: TW.lime,
    aaa: true,
  },
  {
    id: 'contrast', mode: 'dark', sel: '[data-theme="contrast"].dark', white: '#ffffff',
    slate: pin(TW.slate, { 100: '#ffffff', 200: '#f5f7fa', 300: '#e6e9ee', 400: '#d0d5dd', 500: '#bcc3ce', 600: '#8a94a3', 700: '#6b7484', 800: '#2a2f38', 900: '#000000', 950: '#000000' }),
    brand: pin(ramp(95, 0.18, [0.99, 0.97, 0.95, 0.93, 0.9, 0.86, 0.5, 0.42, 0.36, 0.3, 0.24]), {}), emerald: TW.emerald, red: TW.red, amber: TW.amber, sky: TW.sky, violet: TW.violet, orange: TW.orange, lime: TW.lime,
    aaa: true,
  },
];

// ---- contrast constraints ----
const idx = (s) => SHADES.indexOf(s);
const L = (hex) => rgb2oklch(hex2rgb(hex));
function setL(r, s, l) { const [, c, h] = L(r[idx(s)]); r[idx(s)] = rgb2hex(oklch2rgb([Math.min(0.995, Math.max(0.02, l)), c, h])); }
/** Keeps the ramp ordered after a shade moved: darker shades stay darker by a small step. */
function keepOrder(r, s, dir) {
  const STEP = 0.02;
  if (dir < 0) for (let i = idx(s) + 1; i < SHADES.length; i++) { const p = L(r[i - 1])[0], q = L(r[i])[0]; if (q > p - STEP) setL(r, SHADES[i], p - STEP); }
  else for (let i = idx(s) - 1; i >= 0; i--) { const p = L(r[i + 1])[0], q = L(r[i])[0]; if (q < p + STEP) setL(r, SHADES[i], p + STEP); }
}
/** Moves shade s darker (dir -1) or lighter (+1) until test() passes. */
function nudge(r, s, dir, test) {
  for (let n = 0; n < 200 && !test(r[idx(s)]); n++) setL(r, s, L(r[idx(s)])[0] + dir * 0.004);
  keepOrder(r, s, dir);
}

function solve(t) {
  const p = Object.fromEntries(F.map((f) => [f, [...t[f]]]));
  const min = t.aaa ? 7 : 4.5, M = 0.03; // small margin against rounding
  const ok = (bgs, ratio = min) => (fg) => bgs().every((bg) => contrast(fg, bg) >= ratio + M);
  const N = (s) => p.slate[idx(s)];
  const X = (f, s) => p[f][idx(s)];
  if (t.mode === 'light') {
    const surf = () => [t.white, N(50)];
    for (const s of [400, 500, 600, 700, 800, 900]) nudge(p.slate, s, -1, ok(surf, s === 400 && !t.aaa ? 4.5 : min));
    for (const s of [500, 600, 700]) nudge(p.slate, s, -1, ok(() => [N(100)]));
    for (const f of STATUS) {
      for (const s of [600, 700]) nudge(p[f], s, -1, ok(surf));
      nudge(p[f], 600, -1, ok(() => [t.white]));
      for (const s of [700, 800]) nudge(p[f], s, -1, ok(() => [X(f, 100), X(f, 50)]));
      nudge(p[f], 900, -1, ok(() => [X(f, 50), X(f, 100)]));
    }
  } else {
    const surf = () => [N(900), N(950)];
    for (const s of [500, 400, 300, 200, 100]) nudge(p.slate, s, +1, ok(surf));
    for (const s of [300, 400]) nudge(p.slate, s, +1, ok(() => [N(800)]));
    for (const f of STATUS) {
      for (const s of [400, 300, 200]) nudge(p[f], s, +1, ok(surf));
      for (const s of [300, 200]) nudge(p[f], s, +1, ok(() => [X(f, 950), blend(X(f, 900), N(900), 0.4)]));
      // light-text-on-tint pairs (active nav, info boxes): brand-100 on brand-700/20..30 over the card
      nudge(p[f], 100, +1, ok(() => [blend(X(f, 700), N(900), 0.3), blend(X(f, 700), N(950), 0.3)]));
    }
    // 600 is also used as text without a dark variant; lift it where no white text sits on it.
    for (const f of ['emerald', 'amber', 'sky', 'violet']) nudge(p[f], 600, +1, ok(() => [N(900)]));
    // white text on brand/red buttons and badges
    for (const f of ['brand', 'red']) { nudge(p[f], 600, -1, ok(() => [t.white])); nudge(p[f], 700, -1, ok(() => [t.white])); }
  }
  return p;
}

// ---- output ----
const results = THEMES.map((t) => ({ t, p: solve(t) }));
const css = [
  '/* Generated by build-palettes.mjs - edit the script, not this file. R G B channels per shade; contrast-checked. */',
  ...results.map(({ t, p }) => {
    const lines = [`/* ${t.id} · ${t.mode} */`, `${t.sel} {`];
    for (const f of F) lines.push('  ' + SHADES.map((s, i) => `--pw-${f}-${s}: ${chan(p[f][i])};`).join(' '));
    const dark = t.mode === 'dark';
    const N = (s) => p.slate[idx(s)];
    lines.push(`  --pw-white: ${chan(t.white)}; --pw-black: 0 0 0;`);
    lines.push(`  --pw-chart-line: ${p.brand[idx(dark ? 400 : 500)]}; --pw-chart-area: ${p.brand[idx(dark ? 400 : 500)]}2e; --pw-chart-grid: ${N(dark ? 800 : 200)}; --pw-chart-text: ${N(dark ? 400 : 500)};`);
    lines.push(`  --pw-status-up: ${p.emerald[idx(500)]}; --pw-status-down: ${p.red[idx(500)]}; --pw-status-pending: ${p.amber[idx(500)]}; --pw-status-maintenance: ${p.sky[idx(500)]}; --pw-status-suppressed: ${p.violet[idx(400)]}; --pw-status-paused: ${N(dark ? 600 : 300)};`);
    lines.push('}');
    return lines.join('\n');
  }),
].join('\n') + '\n';
const here = import.meta.dirname;
writeFileSync(path.join(here, 'palettes.css'), css);

if (process.argv.includes('--report')) {
  // primary button text/background as the theme CSS draws it (some themes use dark text on a bright accent)
  const BTN = { cyberpunk: (X) => ['#000000', X('brand', 400)], terminal: (X) => ['#000000', X('brand', 400)], lcars: (X) => ['#000000', X('brand', 400)], scifi: (X) => [X('brand', 100), blend(X('brand', 400), X('slate', 900), 0.16)] };
  const rows = [['theme', 'text', 'muted', 'faint', 'up', 'down', 'pending', 'maint', 'suppr', 'badge', 'btn']];
  for (const { t, p } of results) {
    const dark = t.mode === 'dark';
    const X = (f, s) => p[f][idx(s)];
    const card = dark ? X('slate', 900) : t.white;
    const fmt = (v) => v.toFixed(1);
    rows.push([
      `${t.id}/${t.mode}`,
      fmt(contrast(dark ? X('slate', 100) : X('slate', 900), card)),
      fmt(contrast(dark ? X('slate', 400) : X('slate', 500), card)),
      fmt(contrast(dark ? X('slate', 500) : X('slate', 400), card)),
      ...['emerald', 'red', 'amber', 'sky', 'violet'].map((f) => fmt(contrast(X(f, dark ? 400 : 600), card))),
      fmt(Math.min(...['emerald', 'red', 'amber', 'sky', 'violet'].map((f) => (dark ? contrast(X(f, 300), X(f, 950)) : contrast(X(f, 800), X(f, 100)))))),
      fmt(BTN[t.id] ? contrast(...BTN[t.id](X)) : t.id === 'contrast' && dark ? contrast('#000000', X('brand', 400)) : contrast(t.white, X('brand', 600))),
    ]);
  }
  console.log(rows.map((r) => r.map((c, i) => String(c).padEnd(i ? 8 : 20)).join('')).join('\n'));
}
