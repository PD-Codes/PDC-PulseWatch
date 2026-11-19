import net from 'node:net';
import { sql } from 'kysely';
import type { Ctx } from '../context';
import { decrypt, totpStep, verifyPassword } from '../crypto';
import { bool } from '../db';

/** Failures one client may make before delays start; the delay then doubles with every further failure up to MAX_DELAY_MS. */
export const FREE_FAILS = 5;
const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;
/** A client's counter starts over after this long without a failure. */
const FORGET_MS = 15 * 60_000;
/** Account-wide limit across all clients (distributed guessing): this many failures within ACCOUNT_WINDOW_MS lock the account for ACCOUNT_LOCK_MS. */
export const ACCOUNT_MAX = 50;
const ACCOUNT_WINDOW_MS = 15 * 60_000;
const ACCOUNT_LOCK_MS = 5 * 60_000;

/** Page-wide brake for status page passwords (shared by every reader): a short delay after many failures from all addresses, never a long lock. */
const BRAKE_FREE = 20;
const BRAKE_FIRST_MS = 2_000;
const BRAKE_MAX_MS = 60_000;
export const brakeAfter = (n: number): number => (n < BRAKE_FREE ? 0 : Math.min(BRAKE_MAX_MS, BRAKE_FIRST_MS * 2 ** (n - BRAKE_FREE)));

/**
 * Counter key of a client address: an IPv6 client usually owns a whole /64, so it counts as one client (otherwise rotating addresses would reset its delays).
 * Other keys (session ids) pass through.
 */
export function clientKey(client: string): string {
  const ip = client.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!net.isIPv6(ip)) return ip.slice(0, 80);
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':')}::/64`;
}

export type FailScope = 'login' | 'reauth' | 'status';

/** Delay after the n-th failure of one client: none for the first FREE_FAILS, then 30 s, 1 min, 2 min, ... capped at 15 min. */
export const delayAfter = (n: number): number => (n < FREE_FAILS ? 0 : Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (n - FREE_FAILS)));

/** Subject key for a sign-in name; local and LDAP logins share it, unknown names are throttled the same way so a lock does not reveal which names exist. */
export const loginSubject = (username: string) => `u:${username.trim().toLowerCase().slice(0, 180)}`;

/** Milliseconds the client still has to wait (its own delay or the account-wide lock), 0 when it may try. */
export async function failureWait(ctx: Ctx, scope: FailScope, subject: string, client: string, accountWide = true): Promise<number> {
  const c = clientKey(client);
  const rows = await ctx.db.selectFrom('auth_failures').select(['client', 'locked_until']).where('scope', '=', scope).where('subject', '=', subject)
    .where('client', 'in', accountWide ? [c, ''] : [c]).execute();
  const now = Date.now();
  return Math.max(0, ...rows.map((r) => (r.locked_until ? r.locked_until.getTime() - now : 0)));
}

/**
 * Counts one failure for (scope, subject, client) and for the subject as a whole. Atomic upserts, so parallel guesses cannot dodge the counters.
 * Subject-wide: 'lock' (accounts) locks for ACCOUNT_LOCK_MS after ACCOUNT_MAX failures; 'brake' (status pages) answers with growing short delays; 'off' skips it.
 * Returns the wait the client now faces. `onAccountLock` runs when the account-wide lock is set (mirrors it to users.locked_until).
 */
export async function recordFailure(ctx: Ctx, scope: FailScope, subject: string, client: string, opts: { subjectWide?: 'lock' | 'brake' | 'off'; onAccountLock?: (until: Date) => Promise<unknown> } = {}): Promise<number> {
  const db = ctx.db;
  const c = clientKey(client);
  const now = new Date();
  const forget = new Date(now.getTime() - FORGET_MS);
  // MariaDB applies the assignments left to right, so first_at sees the new failures value (1 = counter started over)
  await sql`INSERT INTO auth_failures (scope, subject, client, failures, first_at, last_at) VALUES (${scope}, ${subject}, ${c}, 1, ${now}, ${now})
    ON DUPLICATE KEY UPDATE failures = IF(last_at < ${forget}, 1, failures + 1), first_at = IF(failures = 1, ${now}, first_at), locked_until = IF(failures = 1, NULL, locked_until), last_at = ${now}`.execute(db);
  const row = await db.selectFrom('auth_failures').select('failures').where('scope', '=', scope).where('subject', '=', subject).where('client', '=', c).executeTakeFirst();
  const delay = delayAfter(Number(row?.failures ?? 1));
  let wait = 0;
  if (delay) {
    const until = new Date(now.getTime() + delay);
    await sql`UPDATE auth_failures SET locked_until = GREATEST(COALESCE(locked_until, ${until}), ${until}) WHERE scope = ${scope} AND subject = ${subject} AND client = ${c}`.execute(db);
    wait = delay;
  }
  if (opts.subjectWide === 'brake') {
    await sql`INSERT INTO auth_failures (scope, subject, client, failures, first_at, last_at) VALUES (${scope}, ${subject}, '', 1, ${now}, ${now})
      ON DUPLICATE KEY UPDATE failures = IF(last_at < ${forget}, 1, failures + 1), first_at = IF(failures = 1, ${now}, first_at), locked_until = IF(failures = 1, NULL, locked_until), last_at = ${now}`.execute(db);
    const all = await db.selectFrom('auth_failures').select('failures').where('scope', '=', scope).where('subject', '=', subject).where('client', '=', '').executeTakeFirst();
    const brake = brakeAfter(Number(all?.failures ?? 1));
    if (brake) {
      const until = new Date(now.getTime() + brake);
      await sql`UPDATE auth_failures SET locked_until = GREATEST(COALESCE(locked_until, ${until}), ${until}) WHERE scope = ${scope} AND subject = ${subject} AND client = ''`.execute(db);
      wait = Math.max(wait, brake);
    }
  } else if (opts.subjectWide !== 'off') {
    const windowStart = new Date(now.getTime() - ACCOUNT_WINDOW_MS);
    await sql`INSERT INTO auth_failures (scope, subject, client, failures, first_at, last_at) VALUES (${scope}, ${subject}, '', 1, ${now}, ${now})
      ON DUPLICATE KEY UPDATE failures = IF(first_at < ${windowStart}, 1, failures + 1), first_at = IF(failures = 1, ${now}, first_at), last_at = ${now}`.execute(db);
    const acct = await db.selectFrom('auth_failures').select(['failures', 'locked_until']).where('scope', '=', scope).where('subject', '=', subject).where('client', '=', '').executeTakeFirst();
    if (Number(acct?.failures ?? 0) >= ACCOUNT_MAX && !(acct?.locked_until && acct.locked_until > now)) {
      const until = new Date(now.getTime() + ACCOUNT_LOCK_MS);
      // the window starts over once the lock is set, so the next lock needs another ACCOUNT_MAX failures
      await db.updateTable('auth_failures').set({ locked_until: until, failures: 0, first_at: now }).where('scope', '=', scope).where('subject', '=', subject).where('client', '=', '').execute();
      await opts.onAccountLock?.(until);
      ctx.log.warn({ scope, subject }, 'account locked for a few minutes after too many failed attempts from several clients');
      wait = Math.max(wait, ACCOUNT_LOCK_MS);
    }
  }
  // shortcut: opportunistic cleanup instead of a housekeeping job; old rows only matter for the next 15 minutes
  if (Math.random() < 0.02) await db.deleteFrom('auth_failures').where('last_at', '<', new Date(now.getTime() - 86_400_000)).execute().catch(() => {});
  return wait;
}

/** A successful check forgets the client's failures (not the account-wide counter: a distributed attack must not be reset by the owner signing in). */
export async function clearFailures(ctx: Ctx, scope: FailScope, subject: string, client: string): Promise<void> {
  await ctx.db.deleteFrom('auth_failures').where('scope', '=', scope).where('subject', '=', subject).where('client', '=', clientKey(client)).execute();
}

/** Admin "unlock": every counter of the account. */
export async function clearAccountFailures(ctx: Ctx, userId: number, username: string): Promise<void> {
  await ctx.db.deleteFrom('auth_failures').where((eb) => eb.or([eb.and([eb('scope', '=', 'login'), eb('subject', '=', loginSubject(username))]), eb.and([eb('scope', '=', 'reauth'), eb('subject', '=', `u:${userId}`)])])).execute();
}

export const waitMessage = (ms: number) => `Too many failed attempts, try again in ${ms >= 90_000 ? `${Math.ceil(ms / 60_000)} minutes` : `${Math.ceil(ms / 1000)} seconds`}`;

/** Accepts a TOTP code once: the step is stored atomically, the same or an older step is refused (replay of an observed code). */
export async function acceptTotp(ctx: Ctx, userId: number, secretEnc: string | null, code: string | undefined): Promise<boolean> {
  if (!secretEnc || !code) return false;
  const step = totpStep(decrypt(secretEnc), code);
  if (step === null) return false;
  const r = await sql`UPDATE users SET totp_last_step = ${step} WHERE id = ${userId} AND (totp_last_step IS NULL OR totp_last_step < ${step})`.execute(ctx.db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

/**
 * Re-checks the password (and the authenticator code when 2FA is on) of the signed-in user before a change that could hand out lasting access.
 * Returns an error message, or null when the check passed. Single sign-on accounts have no local credentials, so there is nothing to re-check.
 * `client` keys the failure counter: the session id, so a hijacked session cannot get unlimited guesses by switching IP addresses.
 */
export async function reauthError(ctx: Ctx, userId: number, password?: string, code?: string, client = ''): Promise<string | null> {
  const u = await ctx.db.selectFrom('users').select(['password_hash', 'totp_enabled', 'totp_secret_enc', 'locked_until']).where('id', '=', userId).executeTakeFirst();
  if (!u) return 'Unknown user';
  if (u.locked_until && u.locked_until > new Date()) return 'Account is temporarily locked after too many failed attempts';
  if (!u.password_hash) return null;
  const subject = `u:${userId}`;
  const wait = await failureWait(ctx, 'reauth', subject, client);
  if (wait) return waitMessage(wait);
  const ok = !!password && (await verifyPassword(password, u.password_hash)) && (!bool(u.totp_enabled) || (await acceptTotp(ctx, userId, u.totp_secret_enc, code)));
  if (ok) { await clearFailures(ctx, 'reauth', subject, client); return null; }
  await recordFailure(ctx, 'reauth', subject, client, { onAccountLock: (until) => ctx.db.updateTable('users').set({ locked_until: until }).where('id', '=', userId).execute() });
  return 'Password or code is wrong';
}
