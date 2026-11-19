import { useSyncExternalStore } from 'react';
import { get, type Meta } from './api';
import { subscribeStream } from './stream';

/** Version this bundle was built with (empty when not injected, e.g. in unit tests: then no mismatch is ever reported). */
export const BUILD_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

/** Id of this build (equals the version when the build set no PW_BUILD_ID). */
export const BUILD_ID: string = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : BUILD_VERSION;

const INTERVAL = 10 * 60_000;
const MIN_GAP = 30_000; // checks triggered by reconnects or tab focus are coalesced
let mismatch = false;
let lastCheck = 0;
const listeners = new Set<() => void>();

/** Compare the running bundle with the version the server reports; a difference is sticky until the page reloads. */
export async function checkVersion(): Promise<void> {
  if (!BUILD_ID || mismatch || Date.now() - lastCheck < MIN_GAP) return;
  lastCheck = Date.now();
  try {
    const m = await get<Meta>('/api/meta', { timeoutMs: 10_000 });
    // build ids when both sides have one (this bundle without PW_BUILD_ID, e.g. in development, only knows its version)
    const differs = m?.build && BUILD_ID !== BUILD_VERSION ? m.build !== BUILD_ID : !!m?.version && m.version !== BUILD_VERSION;
    if (differs) { mismatch = true; for (const l of listeners) l(); }
  } catch { /* offline or restarting: the next trigger tries again */ }
}

// One shared checker, running only while something displays or uses the result.
let stop: (() => void) | null = null;
function start() {
  void checkVersion();
  const timer = setInterval(() => void checkVersion(), INTERVAL);
  const off = subscribeStream('reconnect', () => void checkVersion());
  const onVisible = () => { if (document.visibilityState === 'visible') void checkVersion(); };
  document.addEventListener('visibilitychange', onVisible);
  stop = () => { clearInterval(timer); off(); document.removeEventListener('visibilitychange', onVisible); };
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (listeners.size === 1) start();
  return () => { listeners.delete(fn); if (!listeners.size) { stop?.(); stop = null; } };
}

/** True once the server runs a different version than this page was built with (checked on mount, on stream reconnect, on focus and every 10 minutes). */
export const useVersionMismatch = (): boolean => useSyncExternalStore(subscribe, () => mismatch, () => false);
