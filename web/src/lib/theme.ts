import { useEffect, useState } from 'react';
import { isThemeId, themeInfo, THEMES, type ThemeId, type ThemeInfo } from '../themes/registry';

export { THEMES, isThemeId, themeInfo };
export type { ThemeId, ThemeInfo };

/** Light/dark preference; 'system' follows the OS. Kept as ThemePref for older callers. */
export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemePref = ThemeMode;

// Per-device storage. theme-init.js reads the same keys before first paint.
const MODE_KEY = 'pw.theme';
const ID_KEY = 'pw.theme.id';
const DEFAULT_KEY = 'pw.theme.default'; // cached instance default, so the next load paints it without a flash

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const readMode = (): ThemeMode => { const v = store.get(MODE_KEY); return v === 'light' || v === 'dark' ? v : 'system'; };
const readDefault = (): ThemeId => { const v = store.get(DEFAULT_KEY); return isThemeId(v) ? v : 'classic'; };
const readId = (): ThemeId => { const v = store.get(ID_KEY); return isThemeId(v) ? v : readDefault(); };
const systemDark = () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Public pages (status pages) start neutral; the page applies its own theme once loaded. theme-init.js does the same. */
export const isPublicPath = (p: string) => /^\/status\//.test(p);

/** Temporary override from applyTheme(id, mode); not stored. */
let forced: { id?: ThemeId; mode?: ThemeMode } | null =
  typeof location !== 'undefined' && isPublicPath(location.pathname) ? { id: 'classic', mode: 'system' } : null;

export interface ThemeState { themeId: ThemeId; mode: ThemeMode; dark: boolean }

/** Effective theme: the override wins, then the device choice, then the instance default. */
function resolve(): ThemeState {
  const themeId = forced?.id ?? readId();
  const mode = forced?.mode ?? readMode();
  const modes = themeInfo(themeId).modes;
  const dark = modes.length === 1 ? modes[0] === 'dark' : mode === 'dark' || (mode === 'system' && systemDark());
  return { themeId, mode, dark };
}

function render(): ThemeState {
  const s = resolve();
  const root = document.documentElement;
  root.dataset.theme = s.themeId;
  root.classList.toggle('dark', s.dark);
  root.style.colorScheme = s.dark ? 'dark' : 'light';
  const color = themeInfo(s.themeId).chrome[s.dark ? 'dark' : 'light'];
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && color) meta.content = color;
  return s;
}

function emit(s: ThemeState) { window.dispatchEvent(new CustomEvent<ThemeState>('pw:theme', { detail: s })); }

// One OS listener for the whole app: follows light/dark changes while the mode is 'system'.
let watching = false;
function watchSystem() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => emit(render()));
}

/** Choose the theme for this device. */
export function setThemeId(id: ThemeId) { store.set(ID_KEY, id); emit(render()); }

/** Choose light/dark/system for this device (only matters for themes with both modes). */
export function setMode(mode: ThemeMode) { store.set(MODE_KEY, mode); emit(render()); }

/** Compatibility: sets the light/dark/system mode (as before themes existed). */
export function setTheme(pref: ThemePref) { setMode(pref); }

/**
 * Applies a theme without storing it (kiosk, public pages with a fixed look). Missing parts come from the device choice.
 * Call without arguments to drop the override and return to the device choice.
 */
export function applyTheme(id?: ThemeId | null, mode?: ThemeMode | null) {
  forced = id || mode ? { id: id ?? undefined, mode: mode ?? undefined } : null;
  emit(render());
}

/** Instance default (from /api/meta.defaultTheme); used only while this device has no own choice. */
export function setDefaultTheme(id: ThemeId | null | undefined) {
  const next = isThemeId(id) ? id : null;
  if ((store.get(DEFAULT_KEY) ?? null) === next) return;
  store.set(DEFAULT_KEY, next);
  if (!store.get(ID_KEY)) emit(render());
}

// Paint once on load (theme-init.js normally did this already) and follow OS light/dark app-wide, also on pages without useTheme.
if (typeof document !== 'undefined') { render(); watchSystem(); }

/** Current effective theme, without subscribing. */
export const getTheme = (): ThemeState => resolve();

export function useTheme() {
  const [s, setS] = useState<ThemeState>(resolve);
  useEffect(() => {
    const sync = () => setS(resolve());
    sync();
    window.addEventListener('pw:theme', sync);
    return () => window.removeEventListener('pw:theme', sync);
  }, []);
  return {
    themeId: s.themeId,
    mode: s.mode,
    dark: s.dark,
    /** Theme info of the effective theme (modes, swatch). */
    info: themeInfo(s.themeId),
    setTheme: setThemeId,
    setMode,
    /** @deprecated use mode */
    pref: s.mode,
    /** @deprecated use setMode */
    set: setMode,
  };
}
