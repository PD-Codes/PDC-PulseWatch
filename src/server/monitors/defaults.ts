import type { Ctx } from '../context';

export interface MonitorDefaults {
  intervalS: number; timeoutS: number; retries: number; retryIntervalS: number;
  upThreshold: number; downThreshold: number; flapWindow: number; flapThreshold: number;
  /** Instance-wide rule, applied live to every monitor that has no value of its own. */
  downAfterS: number;
}

export const BUILT_IN_DEFAULTS: MonitorDefaults = { intervalS: 60, timeoutS: 10, retries: 0, retryIntervalS: 20, upThreshold: 1, downThreshold: 1, flapWindow: 10, flapThreshold: 6, downAfterS: 0 };

/** Allowed range per field, shared by monitor validation and the settings endpoint. */
export const DEFAULT_LIMITS: Record<keyof MonitorDefaults, [number, number]> = {
  intervalS: [5, 86400], timeoutS: [1, 300], retries: [0, 20], retryIntervalS: [5, 3600],
  upThreshold: [1, 20], downThreshold: [1, 20], flapWindow: [4, 60], flapThreshold: [0, 60], downAfterS: [0, 86400],
};

const KEY = 'monitor.defaults';

/** Instance-wide defaults for new monitors (admin setting), merged over the built-in values. */
export async function monitorDefaults(ctx: Pick<Ctx, 'settings'>): Promise<MonitorDefaults> {
  const stored = await ctx.settings.get<Partial<MonitorDefaults>>(KEY, {});
  const out = { ...BUILT_IN_DEFAULTS };
  for (const k of Object.keys(out) as (keyof MonitorDefaults)[]) {
    const v = stored[k];
    const [min, max] = DEFAULT_LIMITS[k];
    if (Number.isInteger(v) && (v as number) >= min && (v as number) <= max) out[k] = v as number;
  }
  return out;
}

export const saveMonitorDefaults = (ctx: Pick<Ctx, 'settings'>, d: MonitorDefaults) => ctx.settings.set(KEY, d);
export const resetMonitorDefaults = (ctx: Pick<Ctx, 'settings'>) => ctx.settings.delete(KEY);
