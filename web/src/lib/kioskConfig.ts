// Wall display settings between the address, this browser's memory and the presets on the server. Pure functions, so the
// resolution order and the old link formats can be unit tested.
import { DISPLAYS, KIOSK_DEFAULTS, kioskConfigDiff, normalizeKioskConfig, ROTATE_MAX, SHOWS, SIZES, SLUG_MAX, SLUG_RE, ZOOM_MAX, ZOOM_MIN, clampZoom, type KioskConfig, type Mode } from '../../../src/core/kiosk';
import { THEME_IDS, isThemeId, themeInfo } from '../themes/registry';
import type { KioskPreset, KioskPresetList } from './api';
import { slugify } from './format';

/** Where a browser remembers its own (custom) wall display settings. */
export const STORE_KEY = 'pw.kiosk';
export const THEMES_KNOWN: readonly string[] = THEME_IDS;

/** Address parameters that carry settings, plus names older links used (view, layout, group). */
export const CONFIG_PARAMS = ['display', 'show', 'grouped', 'groups', 'tags', 'monitors', 'size', 'zoom', 'rotate', 'theme', 'mode', 'incidents', 'clock', 'bars'] as const;
const LEGACY_PARAMS = ['view', 'layout', 'group'] as const;
/** What a screen with a kiosk key may change by address: the look, never the scope (that comes from the server). */
export const DISPLAY_KEYS = ['display', 'show', 'grouped', 'size', 'zoom', 'rotate', 'theme', 'mode', 'clock', 'bars', 'incidents'] as const satisfies readonly (keyof KioskConfig)[];

export const hasConfigParams = (p: URLSearchParams): boolean => [...CONFIG_PARAMS, ...LEGACY_PARAMS].some((k) => p.has(k));

/** The resolution has to wait for the preset list: the address names a preset, or the default preset may apply. */
export const needsPresets = (p: URLSearchParams): boolean => p.has('preset') || !hasConfigParams(p);

/**
 * Theme from `theme` and `mode`. Links from before themes carried `theme=dark|light` without `mode`: that is classic dark/light.
 * Because "dark" is also a theme id, links to that theme always carry `mode=dark`. A mode alone changes only the mode.
 */
export function themeFrom(theme: unknown, mode: unknown): Partial<Pick<KioskConfig, 'theme' | 'mode'>> | null {
  const md: Mode | null = mode === 'dark' || mode === 'light' ? mode : null;
  if ((theme === 'dark' || theme === 'light') && !md) return { theme: 'classic', mode: theme };
  if (isThemeId(theme)) { const modes = themeInfo(theme).modes; return { theme, mode: md ?? (modes.length === 1 ? modes[0]! : 'dark') }; }
  return md ? { mode: md } : null;
}

/** A theme with a single mode fixes it, so a stored or linked other mode does not count as a difference. */
function fixMode(c: KioskConfig): KioskConfig {
  const modes = isThemeId(c.theme) ? themeInfo(c.theme).modes : [];
  return modes.length === 1 && c.mode !== modes[0] ? { ...c, mode: modes[0]! } : c;
}

/** A complete config from anything (a preset, stored JSON); invalid parts come from `base`. */
export const cleanConfig = (raw: unknown, base: Readonly<KioskConfig> = KIOSK_DEFAULTS): KioskConfig => fixMode(normalizeKioskConfig(raw, THEMES_KNOWN, base));
export const presetBase = (p: Pick<KioskPreset, 'config'>): KioskConfig => cleanConfig(p.config);
/** `base` with the overrides on top, validated. */
export const withOverrides = (base: KioskConfig, over: Partial<KioskConfig>): KioskConfig => cleanConfig({ ...base, ...over }, base);
/** The settings that differ from `base`, after validation. */
export const overridesOf = (c: KioskConfig, base: KioskConfig): Partial<KioskConfig> => kioskConfigDiff(fixMode(c), base);

/** The settings an address carries, only the valid ones. Out-of-range numbers are ignored rather than clamped, as before. */
export function paramsToPartial(p: URLSearchParams): Partial<KioskConfig> {
  const out: Partial<KioskConfig> = {};
  // a present but empty list ("groups=") clears the scope: a preset override back to "all"
  const ints = (k: string) => { const s = p.get(k); return s === null ? null : s.split(',').filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0); };
  const one = <T extends string>(v: string | null, ok: readonly T[]) => ((ok as readonly string[]).includes(v ?? '') ? (v as T) : undefined);
  const flag = (k: 'incidents' | 'clock' | 'bars') => { const v = p.get(k); if (v !== null) out[k] = v !== '0'; };

  const display = one(p.get('display'), DISPLAYS); if (display) out.display = display;
  const show = one(p.get('show'), SHOWS) ?? one(p.get('view'), SHOWS); if (show) out.show = show;
  const grouped = p.get('grouped');
  if (grouped === '1' || grouped === '0') out.grouped = grouped === '1';
  else { const layout = p.get('layout'); if (layout === 'grouped' || layout === 'flat') out.grouped = layout === 'grouped'; }
  const single = Number(p.get('group')); // older links carried a single group
  const groups = ints('groups') ?? (Number.isInteger(single) && single > 0 ? [single] : null); if (groups) out.groups = groups;
  const tags = p.get('tags'); if (tags !== null) out.tags = tags.split(',').filter(Boolean);
  const monitors = ints('monitors'); if (monitors) out.monitors = monitors;
  const size = one(p.get('size'), SIZES); if (size) out.size = size;
  const zoom = p.get('zoom') ? Number(p.get('zoom')) : NaN;
  if (Number.isFinite(zoom) && zoom >= ZOOM_MIN && zoom <= ZOOM_MAX) out.zoom = clampZoom(zoom);
  const rotate = p.get('rotate') ? Number(p.get('rotate')) : NaN;
  if (Number.isInteger(rotate) && rotate >= 0 && rotate <= ROTATE_MAX) out.rotate = rotate;
  Object.assign(out, themeFrom(p.get('theme'), p.get('mode')) ?? {});
  flag('incidents'); flag('clock'); flag('bars');
  return out;
}

/** Address parameters for settings in canonical form; theme and mode go together so old-style readers get them right. */
export function partialToParams(d: Partial<KioskConfig>, p = new URLSearchParams()): URLSearchParams {
  if (d.display !== undefined) p.set('display', d.display);
  if (d.show !== undefined) p.set('show', d.show);
  if (d.grouped !== undefined) p.set('grouped', d.grouped ? '1' : '0');
  if (d.groups !== undefined) p.set('groups', d.groups.join(','));
  if (d.tags !== undefined) p.set('tags', d.tags.join(','));
  if (d.monitors !== undefined) p.set('monitors', d.monitors.join(','));
  if (d.size !== undefined) p.set('size', d.size);
  if (d.zoom !== undefined) p.set('zoom', String(d.zoom));
  if (d.rotate !== undefined) p.set('rotate', String(d.rotate));
  if (d.theme !== undefined) p.set('theme', d.theme);
  // a single-mode theme needs no mode, except "dark": without a mode, theme=dark reads as the old classic dark
  if (d.mode !== undefined && (d.theme === undefined || d.theme === 'dark' || !isThemeId(d.theme) || themeInfo(d.theme).modes.length > 1)) p.set('mode', d.mode);
  for (const k of ['incidents', 'clock', 'bars'] as const) if (d[k] !== undefined) p.set(k, d[k] ? '1' : '0');
  return p;
}

/** Only what differs from `base` goes into the address, so links stay short. A changed theme or mode writes both. */
export function configToParams(c: KioskConfig, base: KioskConfig, p = new URLSearchParams()): URLSearchParams {
  const d = overridesOf(c, base);
  if ('theme' in d || 'mode' in d) { d.theme = c.theme; d.mode = c.mode; }
  delete d.messages; // never set by address
  return partialToParams(d, p);
}

/** What this browser remembered; also reads the format from before presets (view, layout, theme dark|light). */
export function storedConfig(raw: string | null): KioskConfig {
  let s: Record<string, unknown> = {};
  try { const v = JSON.parse(raw ?? '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) s = v; } catch { /* damaged: defaults */ }
  const legacy: Record<string, unknown> = {};
  if (s.show === undefined && typeof s.view === 'string') legacy.show = s.view;
  if (s.grouped === undefined && (s.layout === 'grouped' || s.layout === 'flat')) legacy.grouped = s.layout === 'grouped';
  const theme = themeFrom(s.theme, s.mode);
  return cleanConfig({ ...s, ...legacy, theme: theme?.theme ?? KIOSK_DEFAULTS.theme, mode: theme?.mode ?? KIOSK_DEFAULTS.mode });
}

/** Settings of a signed-in screen: a preset (by id) plus local overrides, or custom settings (overrides of the defaults). */
export interface KioskState { presetId: number | null; over: Partial<KioskConfig>; unknownSlug: string | null }

/**
 * Resolution order: (a) ?preset=<slug> names a known preset: it is the base, address settings override it; an unknown slug is
 * reported and falls through. (b) The address carries settings: custom (address over this browser's memory over defaults).
 * (c) The default preset. (d) Custom from this browser's memory or the defaults.
 */
export function resolveKioskState(p: URLSearchParams, stored: string | null, presets: KioskPresetList | null | undefined): KioskState {
  const slug = p.get('preset');
  const items = presets?.items ?? [];
  let unknownSlug: string | null = null;
  if (slug) {
    const preset = items.find((x) => x.slug === slug);
    if (preset) { const base = presetBase(preset); return { presetId: preset.id, over: overridesOf(withOverrides(base, paramsToPartial(p)), base), unknownSlug }; }
    unknownSlug = slug;
  }
  const custom = (): KioskState => ({ presetId: null, over: overridesOf(withOverrides(storedConfig(stored), paramsToPartial(p)), KIOSK_DEFAULTS), unknownSlug });
  if (hasConfigParams(p)) return custom();
  const def = presets?.defaultId != null ? items.find((x) => x.id === presets.defaultId) : undefined;
  if (def) return { presetId: def.id, over: {}, unknownSlug };
  return custom();
}

export interface Effective { preset: KioskPreset | null; base: KioskConfig; config: KioskConfig }

/** The config a state stands for. A preset that disappeared leaves its overrides on top of the defaults. */
export function effectiveConfig(s: Pick<KioskState, 'presetId' | 'over'>, presets: KioskPresetList | null | undefined): Effective {
  const preset = s.presetId != null ? presets?.items.find((x) => x.id === s.presetId) ?? null : null;
  const base = preset ? presetBase(preset) : { ...KIOSK_DEFAULTS };
  return { preset, base, config: withOverrides(base, s.over) };
}

/** The address of a state: preset=<slug> plus only the overrides, or only what differs from the defaults. */
export function addressOf(e: Effective): URLSearchParams {
  const p = new URLSearchParams();
  if (e.preset) p.set('preset', e.preset.slug);
  return configToParams(e.config, e.preset ? e.base : KIOSK_DEFAULTS, p);
}

/** Address overrides a screen with a kiosk key accepts: display settings only. */
export function keyOverrides(p: URLSearchParams): Partial<KioskConfig> {
  const all = paramsToPartial(p) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of DISPLAY_KEYS) if (all[k] !== undefined) out[k] = all[k];
  return out as Partial<KioskConfig>;
}

/** The key of a wall display link: from the fragment (#key=...), or from the query as a fallback that should be moved. */
export function kioskKeyFrom(hash: string, search: string): { key: string; inQuery: boolean } | null {
  const h = new URLSearchParams(hash.replace(/^#/, '')).get('key');
  if (h) return { key: h, inQuery: false };
  const q = new URLSearchParams(search).get('key');
  return q ? { key: q, inQuery: true } : null;
}

/** The query without the key, for moving a key from the query into the fragment. */
export function searchWithoutKey(search: string): string {
  const p = new URLSearchParams(search);
  p.delete('key');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Slug suggested for a preset name: the slug rules of presets, cut to their maximum length. */
export const suggestSlug = (name: string): string => slugify(name).slice(0, SLUG_MAX).replace(/-+$/, '');
export const validSlug = (s: string): boolean => SLUG_RE.test(s);
