const FLAG = 'pw.reloadedAt';
const WINDOW_MS = 60_000;

/**
 * Reload the page once to pick up a new deployment. A flag in sessionStorage keeps a persistently broken page from reloading in a loop:
 * within a minute of the last automatic reload this returns false and does nothing.
 */
export function reloadOnce(): boolean {
  try {
    const at = Number(sessionStorage.getItem(FLAG));
    if (at && Date.now() - at < WINDOW_MS) return false;
    sessionStorage.setItem(FLAG, String(Date.now()));
  } catch { return false; } // without storage there is no loop guard
  location.reload();
  return true;
}

/** Does this error come from a lazy chunk that no longer exists (typically after a deployment)? */
export const isChunkError = (e: unknown): boolean => /dynamically imported module|importing a module script failed|error loading dynamically|failed to fetch dynamically/i.test(e instanceof Error ? e.message : String(e));
