import type { Ctx } from '../context';

export interface MonitorDefaults {
  intervalS: number; timeoutS: number; retries: number; retryIntervalS: number;
  upThreshold: number; flapWindow: number; flapThreshold: number;
}

// Like Uptime Kuma: the timeout is 80% of the interval (48 s at 60 s) and a retry comes as often as a regular check.
export const BUILT_IN_DEFAULTS: MonitorDefaults = { intervalS: 60, timeoutS: 48, retries: 0, retryIntervalS: 60, upThreshold: 1, flapWindow: 10, flapThreshold: 6 };

/** The longest timeout that still leaves room for the next check: 80% of the interval, as in Uptime Kuma. */
export const maxTimeoutS = (intervalS: number) => Math.max(1, Math.floor(intervalS * 0.8));

/** Allowed range per number field, shared by monitor validation and the settings endpoint. */
export const DEFAULT_LIMITS: Record<keyof MonitorDefaults, [number, number]> = {
  intervalS: [5, 86400], timeoutS: [1, 300], retries: [0, 100], retryIntervalS: [5, 3600],
  upThreshold: [1, 20], flapWindow: [4, 60], flapThreshold: [0, 60],
};

/** Retries needed to match an old "failure rounds in a row" setting: `threshold` rounds of `retries` retries each. Used for old settings and exports. */
export const retriesFromThreshold = (retries: number, threshold: number) => Math.min(DEFAULT_LIMITS.retries[1], Math.max(0, threshold * (retries + 1) - 1));

const KEY = 'monitor.defaults';

/** Instance-wide defaults for new monitors (admin setting), merged over the built-in values. */
export async function monitorDefaults(ctx: Pick<Ctx, 'settings'>): Promise<MonitorDefaults> {
  const stored = { ...(await ctx.settings.get<Partial<MonitorDefaults> & { downThreshold?: number }>(KEY, {})) };
  // saved before "report as down after X retries": fold the old failure threshold into the retries
  if (Number.isInteger(stored.downThreshold) && stored.downThreshold! > 1) stored.retries = retriesFromThreshold(Number.isInteger(stored.retries) ? stored.retries! : 0, stored.downThreshold!);
  const out = { ...BUILT_IN_DEFAULTS };
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof MonitorDefaults)[]) {
    const v = stored[k];
    const [min, max] = DEFAULT_LIMITS[k];
    if (Number.isInteger(v) && (v as number) >= min && (v as number) <= max) out[k] = v as number;
  }
  return out;
}

export const saveMonitorDefaults = (ctx: Pick<Ctx, 'settings'>, d: MonitorDefaults) => ctx.settings.set(KEY, d);
export const resetMonitorDefaults = (ctx: Pick<Ctx, 'settings'>) => ctx.settings.delete(KEY);
