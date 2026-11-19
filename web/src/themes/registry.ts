// Theme registry. The palettes live in ./themes.css; theme-init.js keeps a copy of the id/mode lists (keep in sync).

export type ThemeId = 'classic' | 'dark' | 'smooth' | 'mono' | 'nord' | 'cyberpunk' | 'scifi' | 'lcars' | 'terminal' | 'contrast';
export type ThemeTone = 'light' | 'dark';

export interface ThemeInfo {
  id: ThemeId;
  /** Modes the theme supports; a single entry means the mode is fixed. */
  modes: ThemeTone[];
  /** Preview colors: page, surface, accent, second accent, text. */
  swatch: string[];
  /** Preview colors for the dark variant of two-mode themes. */
  swatchDark?: string[];
  /** Browser UI color (meta theme-color) per mode. */
  chrome: Partial<Record<ThemeTone, string>>;
}

export const THEMES: ThemeInfo[] = [
  { id: 'classic', modes: ['light', 'dark'], swatch: ['#f8fafc', '#ffffff', '#4f46e5', '#10b981', '#1e293b'], swatchDark: ['#020617', '#0f172a', '#818cf8', '#34d399', '#e2e8f0'], chrome: { light: '#4f46e5', dark: '#0f172a' } },
  { id: 'dark', modes: ['dark'], swatch: ['#111315', '#1a1c1f', '#82b2ff', '#56cb91', '#d2d4d8'], chrome: { dark: '#111315' } },
  { id: 'smooth', modes: ['light', 'dark'], swatch: ['#f9f5f0', '#fffefc', '#6e62c9', '#4aaa88', '#403c39'], swatchDark: ['#1c1b22', '#26242b', '#afa6f0', '#7ac2a8', '#d8d6e0'], chrome: { light: '#f9f5f0', dark: '#1c1b22' } },
  { id: 'mono', modes: ['light', 'dark'], swatch: ['#fafafa', '#ffffff', '#262626', '#10b981', '#262626'], swatchDark: ['#0a0a0a', '#171717', '#d4d4d4', '#34d399', '#e5e5e5'], chrome: { light: '#fafafa', dark: '#0a0a0a' } },
  { id: 'nord', modes: ['dark'], swatch: ['#242933', '#2e3440', '#89bac9', '#a2ba8e', '#e5e9f0'], chrome: { dark: '#242933' } },
  { id: 'cyberpunk', modes: ['dark'], swatch: ['#0d0714', '#17101f', '#ff12bb', '#00c8d8', '#d5cce1'], chrome: { dark: '#0d0714' } },
  { id: 'scifi', modes: ['dark'], swatch: ['#00101e', '#071b2b', '#2cc5e3', '#6fb6fe', '#bfd8ed'], chrome: { dark: '#00101e' } },
  { id: 'lcars', modes: ['dark'], swatch: ['#030100', '#130e0a', '#f49843', '#e1bde1', '#dad3cd'], chrome: { dark: '#030100' } },
  { id: 'terminal', modes: ['dark'], swatch: ['#000500', '#001502', '#4bd059', '#44d070', '#c6e9c6'], chrome: { dark: '#000500' } },
  { id: 'contrast', modes: ['light', 'dark'], swatch: ['#f8fafc', '#ffffff', '#1d1bb3', '#10b981', '#0b0e13'], swatchDark: ['#000000', '#000000', '#ffdc4e', '#34d399', '#f5f7fa'], chrome: { light: '#ffffff', dark: '#000000' } },
];

export const THEME_IDS = THEMES.map((x) => x.id);
export const isThemeId = (v: unknown): v is ThemeId => typeof v === 'string' && (THEME_IDS as string[]).includes(v);
export const themeInfo = (id: ThemeId): ThemeInfo => THEMES.find((x) => x.id === id) ?? THEMES[0];
