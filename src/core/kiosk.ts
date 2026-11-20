// Wall display (kiosk) settings as a preset stores them. Shared by the server, which validates what is saved and decides
// what a screen with a kiosk key may see, and by the web app, which reads links and draws the screens.

/** How the monitors are drawn: tiles with history, group blocks, a list, a dense status wall, or a 24-hour heatmap. */
export const DISPLAYS = ['cards', 'groups', 'table', 'wall', 'heatmap'] as const;
export type Display = (typeof DISPLAYS)[number];
/** Which monitors: all of them, only the problems while there are any, or only the problems. */
export const SHOWS = ['all', 'auto', 'problems'] as const;
export type Show = (typeof SHOWS)[number];
export const SIZES = ['s', 'm', 'l'] as const;
export type Size = (typeof SIZES)[number];
export const MODES = ['dark', 'light'] as const;
export type Mode = (typeof MODES)[number];
/** Offered intervals of the page switch in seconds (0: never). Links may carry any whole number up to ROTATE_MAX. */
export const ROTATIONS = [0, 5, 8, 12, 20, 30, 60] as const;
export const ROTATE_MAX = 300;
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;

export interface KioskConfig {
  display: Display;
  show: Show;
  /** One heading per group for cards, table, wall and heatmap. The group display is grouped anyway. */
  grouped: boolean;
  /** Scope: groups (including their subgroups), tag names, picked monitors. Empty means no restriction. */
  groups: number[];
  tags: string[];
  monitors: number[];
  size: Size;
  zoom: number;
  rotate: number;
  theme: string;
  mode: Mode;
  incidents: boolean;
  clock: boolean;
  bars: boolean;
  /**
   * Error texts of failing checks for screens opened with a kiosk key; they can name internal hosts, so they are off unless a preset
   * turns them on. Signed-in screens always show them (their viewers can open the monitors anyway).
   */
  messages: boolean;
}

/** Do not mutate: spread it into a new object. */
export const KIOSK_DEFAULTS: Readonly<KioskConfig> = {
  display: 'cards', show: 'all', grouped: false, groups: [], tags: [], monitors: [], size: 'm', zoom: 100, rotate: 12,
  theme: 'classic', mode: 'dark', incidents: true, clock: true, bars: true, messages: false,
};

/** Name of a preset in links (/kiosk?preset=<slug>): lower-case letters, digits and inner dashes, 1 to 32 characters. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const SLUG_MAX = 32;
export const NAME_MAX = 64;
/** Presets every installation starts with (migration 022). While their name is empty the app shows a translated name. */
export const BUILTIN_SLUGS = ['all', 'wall', 'groups', 'problems', 'history'] as const;
/** Prefix of kiosk keys, so a leaked one is recognizable (and secret scanners can match it). */
export const KIOSK_KEY_PREFIX = 'pwk_';

export const clampZoom = (n: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n / 5) * 5));

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ids = (v: unknown, max: number): number[] => (Array.isArray(v) ? [...new Set(v.filter((n): n is number => Number.isInteger(n) && n > 0 && n <= 4_294_967_295))].slice(0, max) : []);
const names = (v: unknown, max: number): string[] => (Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 64))].slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (typeof v === 'string' && (ok as readonly string[]).includes(v) ? (v as T) : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/**
 * A complete and valid config from whatever was stored or sent. Unknown keys are dropped; a missing or invalid value takes the
 * value of `base`. `themes` lists the theme ids this build knows, another theme falls back to `base.theme`.
 */
export function normalizeKioskConfig(raw: unknown, themes: readonly string[], base: Readonly<KioskConfig> = KIOSK_DEFAULTS): KioskConfig {
  const r = isObj(raw) ? raw : {};
  const has = (k: keyof KioskConfig) => Object.prototype.hasOwnProperty.call(r, k);
  return {
    display: oneOf(r.display, DISPLAYS, base.display),
    show: oneOf(r.show, SHOWS, base.show),
    grouped: bool(r.grouped, base.grouped),
    groups: has('groups') ? ids(r.groups, 200) : [...base.groups],
    tags: has('tags') ? names(r.tags, 100) : [...base.tags],
    monitors: has('monitors') ? ids(r.monitors, 2000) : [...base.monitors],
    size: oneOf(r.size, SIZES, base.size),
    zoom: typeof r.zoom === 'number' && Number.isFinite(r.zoom) ? clampZoom(r.zoom) : base.zoom,
    rotate: typeof r.rotate === 'number' && Number.isInteger(r.rotate) && r.rotate >= 0 && r.rotate <= ROTATE_MAX ? r.rotate : base.rotate,
    theme: typeof r.theme === 'string' && themes.includes(r.theme) ? r.theme : base.theme,
    mode: oneOf(r.mode, MODES, base.mode),
    incidents: bool(r.incidents, base.incidents),
    clock: bool(r.clock, base.clock),
    bars: bool(r.bars, base.bars),
    messages: bool(r.messages, base.messages),
  };
}

const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b);

/** The settings that differ from `base`: what a preset or a link has to carry. */
export function kioskConfigDiff(c: KioskConfig, base: Readonly<KioskConfig> = KIOSK_DEFAULTS): Partial<KioskConfig> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(c) as (keyof KioskConfig)[]) if (!same(c[k], base[k])) out[k] = c[k];
  return out as Partial<KioskConfig>;
}

export interface ScopeMonitor { id: number; groupId: number | null; active: boolean; tags: readonly { name: string }[] }

/**
 * The monitors a screen draws before the problem filter: active ones inside the scope. A group includes its subgroups, tags match
 * by name (any of them), picked monitors narrow the result further. The server applies the same rule to screens with a kiosk key.
 */
export function inKioskScope<T extends ScopeMonitor>(list: readonly T[], groups: readonly { id: number; parentId: number | null }[], c: Pick<KioskConfig, 'groups' | 'tags' | 'monitors'>): T[] {
  let out = list.filter((m) => m.active);
  if (c.groups.length) {
    const inside = new Set(c.groups);
    for (let grew = true; grew;) {
      grew = false;
      for (const g of groups) if (g.parentId != null && inside.has(g.parentId) && !inside.has(g.id)) { inside.add(g.id); grew = true; }
    }
    out = out.filter((m) => m.groupId != null && inside.has(m.groupId));
  }
  if (c.tags.length) { const want = new Set(c.tags); out = out.filter((m) => m.tags.some((x) => want.has(x.name))); }
  if (c.monitors.length) { const want = new Set(c.monitors); out = out.filter((m) => want.has(m.id)); }
  return out;
}
