import path from 'node:path';

// Absolute globs: Tailwind resolves relative ones against the working directory, which is the repo root for builds.
const here = import.meta.dirname;

// Every color family the app uses reads its shades from CSS variables (R G B channels) set per theme in
// src/themes/palettes.css, so existing classes, opacity modifiers (bg-slate-900/50) and dark: variants follow the theme.
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const v = (name) => `rgb(var(--pw-${name}) / <alpha-value>)`;
const family = (f) => Object.fromEntries(SHADES.map((s) => [s, v(`${f}-${s}`)]));
const slate = family('slate'), brand = family('brand'), emerald = family('emerald'), red = family('red'), amber = family('amber');
const sky = family('sky'), violet = family('violet'), orange = family('orange'), lime = family('lime');
// radius scale: --pw-radius is the "lg" step, the others keep Tailwind's proportions
const r = (k) => `calc(var(--pw-radius) * ${k})`;

/** @type {import('tailwindcss').Config} */
export default {
  content: [path.join(here, 'index.html'), path.join(here, 'src/**/*.{ts,tsx}')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        white: v('white'), black: v('black'),
        slate, gray: slate, brand, indigo: brand, emerald, green: emerald, red, amber, yellow: amber,
        sky, blue: sky, violet, purple: violet, orange, lime,
      },
      borderRadius: { sm: r(0.25), DEFAULT: r(0.5), md: r(0.75), lg: r(1), xl: r(1.5), '2xl': r(2), '3xl': r(3) },
      boxShadow: { sm: 'var(--pw-shadow-sm)', DEFAULT: 'var(--pw-shadow)', md: 'var(--pw-shadow-md)', lg: 'var(--pw-shadow-lg)', xl: 'var(--pw-shadow-xl)', '2xl': 'var(--pw-shadow-2xl)' },
      fontFamily: { sans: ['var(--pw-font-sans)'], mono: ['var(--pw-font-mono)'], display: ['var(--pw-font-display)'] },
    },
  },
  plugins: [],
};
