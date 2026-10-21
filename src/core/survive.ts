/**
 * A bug in one check must not take monitoring down: log stray errors and carry on. A flood of them (more than 20 in a minute) means the
 * process is in a bad state, so exit and let the supervisor restart it.
 */
export function installCrashBackstop(log: (kind: string, e: unknown) => void): void {
  const seen: number[] = [];
  const handle = (kind: string) => (e: unknown) => {
    log(kind, e);
    const now = Date.now();
    seen.push(now);
    while (seen.length && now - seen[0] > 60_000) seen.shift();
    if (seen.length > 20) process.exit(1);
  };
  process.on('uncaughtException', handle('uncaughtException'));
  process.on('unhandledRejection', handle('unhandledRejection'));
}
