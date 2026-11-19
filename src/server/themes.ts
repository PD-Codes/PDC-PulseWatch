import { Type } from '@sinclair/typebox';
import type { Ctx } from './context';

/** Color themes of the web interface and the status pages; keep in sync with web/src/themes/registry.ts (a unit test compares them). */
export const THEME_IDS = ['classic', 'dark', 'smooth', 'mono', 'nord', 'cyberpunk', 'scifi', 'lcars', 'terminal', 'contrast'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = 'classic';
/** Request schema for a theme id. */
export const ThemeSchema = Type.Union(THEME_IDS.map((t) => Type.Literal(t)));
export const isThemeId = (v: unknown): v is ThemeId => typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);

const KEY = 'appearance.defaultTheme';

/** The instance default (admin setting); an unknown stored value falls back to the built-in default. */
export async function defaultTheme(ctx: Pick<Ctx, 'settings'>): Promise<ThemeId> {
  const v = await ctx.settings.get<string | null>(KEY, null);
  return isThemeId(v) ? v : DEFAULT_THEME;
}
export const saveDefaultTheme = (ctx: Pick<Ctx, 'settings'>, id: ThemeId) => ctx.settings.set(KEY, id);
