import { describe, expect, it } from 'vitest';
import { clock, isAccountLockedMessage, isLocked, isReauthError, isSetupTokenError, lockoutSeconds, lockWait, parseSecretRefusal, waitParts } from '../../web/src/lib/adminErrors';

const err = (status: number, code: string, body?: unknown, message = '') => Object.assign(new Error(message), { status, code, body });

describe('auth error helpers', () => {
  it('reads the wait from a 429 locked answer', () => {
    const e = err(429, 'locked', { error: 'locked', retryAfter: 42 });
    expect(isLocked(e)).toBe(true);
    expect(lockWait(e)).toBe(42);
  });
  it('has no wait for a locked account without retryAfter, and for other errors', () => {
    expect(lockWait(err(429, 'locked', {}))).toBeNull();
    expect(lockWait(err(401, 'invalid_credentials'))).toBeNull();
    expect(isLocked(new Error('x'))).toBe(false);
    expect(isLocked(null)).toBe(false);
  });
  it('recognizes the setup token and re-auth errors', () => {
    expect(isSetupTokenError(err(403, 'invalid_setup_token'))).toBe(true);
    expect(isSetupTokenError(err(403, 'forbidden'))).toBe(false);
    expect(isReauthError(err(400, 'invalid_credentials'))).toBe(true);
    expect(isReauthError(err(401, 'invalid_credentials'))).toBe(false);
  });
  it('parses the lockout wording of the server', () => {
    expect(lockoutSeconds('Too many failed attempts, try again in 3 minutes')).toBe(180);
    expect(lockoutSeconds('Too many failed attempts, try again in 20 seconds')).toBe(20);
    expect(lockoutSeconds('Too many failed attempts')).toBe(0);
    expect(lockoutSeconds('Password or code is wrong')).toBeNull();
    expect(isAccountLockedMessage('Account is temporarily locked after too many failed attempts')).toBe(true);
  });
  it('splits waits into a readable unit and formats a countdown', () => {
    expect(waitParts(45)).toEqual({ unit: 's', n: 45 });
    expect(waitParts(100)).toEqual({ unit: 'm', n: 2 });
    expect(waitParts(7200)).toEqual({ unit: 'h', n: 2 });
    expect(waitParts(0)).toEqual({ unit: 's', n: 1 });
    expect(clock(83)).toBe('1:23');
    expect(clock(-5)).toBe('0:00');
  });
});

describe('parseSecretRefusal', () => {
  const fields = [{ key: 'url', label: 'URL', kind: 'text' }, { key: 'token', label: 'Bot token', kind: 'secret' }, { key: 'secret', label: 'Signing secret', kind: 'secret' }, { key: 'headers', label: 'Headers', kind: 'kv', secretValues: true }];
  it('finds the secret fields named in the message', () => {
    const r = parseSecretRefusal(['URL changed: enter Bot token, Headers again, a stored secret is only reused for the same target'], fields);
    expect(r).toEqual({ keys: ['token', 'headers'], changed: 'URL' });
  });
  it('falls back to all secret fields when no label matches', () => {
    expect(parseSecretRefusal(['Host changed: enter Passphrase again, a stored secret is only reused for the same target'], fields)?.keys).toEqual(['token', 'secret', 'headers']);
  });
  it('ignores other messages', () => { expect(parseSecretRefusal(['name must be string'], fields)).toBeNull(); });
});
