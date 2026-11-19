// Automatic reload of the wall display after a server update, with a budget: two instances with different versions
// behind one load balancer would otherwise make it reload every minute, forever.

export const RELOAD_KEY = 'pw.kiosk.reloads';
/** Pause after attempt 1 and 2; after three attempts only one more every 6 hours. */
const STEPS = [2 * 60_000, 10 * 60_000];
export const GIVE_UP_MS = 6 * 3_600_000;
/** Attempts older than this are forgotten: a new update a day later starts with a fresh budget. */
const FORGET_MS = 24 * 3_600_000;

export interface ReloadState { n: number; at: number }

export function parseReloads(raw: string | null, now: number): ReloadState {
  try { const v = JSON.parse(raw ?? ''); if (Number.isInteger(v?.n) && Number.isFinite(v?.at) && now - v.at < FORGET_MS) return { n: v.n, at: v.at }; } catch { /* none or damaged */ }
  return { n: 0, at: 0 };
}

/** How long to wait before the next reload, given the attempts so far; `rand` (0..1) spreads several screens apart. */
export function reloadDelay(s: ReloadState, now: number, rand = Math.random()): number {
  if (s.n === 0) return 5_000 + rand * 25_000;
  const step = STEPS[s.n - 1] ?? GIVE_UP_MS;
  return Math.max(5_000, s.at + step - now) + rand * 5_000;
}
