// Pure helpers that read the shape of API errors (no DOM, no React), so they can be unit-tested.
// They look at status / code / body like ApiError carries them, without importing it.

const asErr = (e: unknown): { status?: number; code?: string; message?: string; body?: any } => (e && typeof e === 'object' ? (e as any) : {});

/** 429 `locked` (login, password change, status page unlock): too many attempts or a temporarily locked account. */
export const isLocked = (e: unknown): boolean => { const x = asErr(e); return x.status === 429 && x.code === 'locked'; };

/** Seconds to wait from a 429 `locked` answer (`retryAfter` in the body), or null when the server gave none (e.g. a locked account). */
export function lockWait(e: unknown): number | null {
  if (!isLocked(e)) return null;
  const n = Number(asErr(e).body?.retryAfter);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

/** 403 `invalid_setup_token` from POST /api/setup. */
export const isSetupTokenError = (e: unknown): boolean => { const x = asErr(e); return x.status === 403 && x.code === 'invalid_setup_token'; };

/** 400 `invalid_credentials` from the re-authentication of tokens and exports. */
export const isReauthError = (e: unknown): boolean => { const x = asErr(e); return x.status === 400 && x.code === 'invalid_credentials'; };

/** The server's lockout wording ("Too many failed attempts, try again in 3 minutes"): the wait in seconds, 0 when it names none, null when it is not a lockout message. */
export function lockoutSeconds(message: string | undefined): number | null {
  if (!message || !/^too many failed attempts/i.test(message)) return null;
  const m = /in (\d+) (minutes?|seconds?)/i.exec(message);
  if (!m) return 0;
  return Number(m[1]) * (m[2]!.toLowerCase().startsWith('m') ? 60 : 1);
}

/** A temporarily locked account, as the server words it. */
export const isAccountLockedMessage = (message: string | undefined): boolean => !!message && /temporarily locked/i.test(message);

/** Wait split into the largest sensible unit: 45 s, 3 minutes (rounded up), 2 hours. */
export function waitParts(seconds: number): { unit: 's' | 'm' | 'h'; n: number } {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return { unit: 's', n: s };
  if (s < 5400) return { unit: 'm', n: Math.ceil(s / 60) };
  return { unit: 'h', n: Math.ceil(s / 3600) };
}

/** m:ss for a running countdown. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------- a stored secret that may not follow a changed target ------------------- */

/** Minimal field description (what the server sends in FieldDef). */
export interface SecretFieldLike { key: string; label: string; kind: string; secretValues?: boolean }

/**
 * The server refuses to reuse a stored secret for another target: "<Field> changed: enter <Secret> again, a stored secret is only reused for the same target".
 * Returns the keys of the secret fields to clear and the names of the fields that changed, or null when the messages are of another kind.
 */
export function parseSecretRefusal(messages: string[], fields: SecretFieldLike[]): { keys: string[]; changed: string } | null {
  for (const raw of messages) {
    const m = /^(.+?) changed: enter (.+) again, a stored secret is only reused/i.exec(String(raw).trim());
    if (!m) continue;
    const named = m[2]!;
    const secrets = fields.filter((f) => f.kind === 'secret' || (f.kind === 'kv' && f.secretValues));
    const keys = secrets.filter((f) => named.includes(f.label)).map((f) => f.key);
    return { keys: keys.length ? keys : secrets.map((f) => f.key), changed: m[1]! };
  }
  return null;
}
