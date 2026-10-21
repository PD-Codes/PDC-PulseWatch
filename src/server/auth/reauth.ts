import { sql } from 'kysely';
import type { Ctx } from '../context';
import { decrypt, verifyPassword, verifyTotp } from '../crypto';
import { bool } from '../db';

export const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;

/** Counts one failed credential check and locks the account for 15 minutes after MAX_FAILS in a row. Atomic, so parallel guesses cannot dodge the counter. */
export async function countFailure(ctx: Ctx, userId: number): Promise<void> {
  const until = new Date(Date.now() + LOCK_MS);
  // MariaDB evaluates the assignments left to right, so locked_until must be set before failed_logins is reset
  await sql`UPDATE users SET locked_until = IF(failed_logins + 1 >= ${MAX_FAILS}, ${until}, locked_until), failed_logins = IF(failed_logins + 1 >= ${MAX_FAILS}, 0, failed_logins + 1) WHERE id = ${userId}`.execute(ctx.db);
}

/**
 * Re-checks the password (and the authenticator code when 2FA is on) of the signed-in user before a change that could hand out lasting access.
 * Returns an error message, or null when the check passed. Single sign-on accounts have no local credentials, so there is nothing to re-check.
 */
export async function reauthError(ctx: Ctx, userId: number, password?: string, code?: string): Promise<string | null> {
  const u = await ctx.db.selectFrom('users').select(['password_hash', 'totp_enabled', 'totp_secret_enc', 'locked_until']).where('id', '=', userId).executeTakeFirst();
  if (!u) return 'Unknown user';
  if (u.locked_until && u.locked_until > new Date()) return 'Account is temporarily locked after too many failed attempts';
  if (!u.password_hash) return null;
  const ok = !!password && (await verifyPassword(password, u.password_hash)) && (!bool(u.totp_enabled) || (!!code && !!u.totp_secret_enc && verifyTotp(decrypt(u.totp_secret_enc), code)));
  if (ok) return null;
  await countFailure(ctx, userId);
  return 'Password or code is wrong';
}
