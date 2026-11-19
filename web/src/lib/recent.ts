const KEY = 'pw.recentMonitors';
const MAX = 8;

/** Ids of the most recently opened monitors, newest first. */
export function getRecentMonitors(): number[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)).slice(0, MAX) : []; } catch { return []; }
}

export function recordRecentMonitor(id: number) {
  if (!Number.isInteger(id)) return;
  try { localStorage.setItem(KEY, JSON.stringify([id, ...getRecentMonitors().filter((n) => n !== id)].slice(0, MAX))); } catch { /* storage unavailable */ }
}
