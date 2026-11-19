import { useSyncExternalStore } from 'react';

// One shared clock for many components (cards, rows): a single interval, and each subscriber re-renders once per tick,
// even when it is wrapped in React.memo and its props did not change.
const TICK_MS = 30_000;
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) { now = Date.now(); timer = setInterval(() => { now = Date.now(); for (const l of listeners) l(); }, TICK_MS); }
  return () => { listeners.delete(fn); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
}

/** Current time in ms, refreshed every 30 seconds (for "3 minutes ago", overdue checks, running snoozes). */
export const useNow = (): number => useSyncExternalStore(subscribe, () => now, () => now);
