import { useMemo } from 'react';
import { isAccountLockedMessage, isLocked, isReauthError, lockoutSeconds, lockWait, waitParts } from '../lib/adminErrors';
import { useFocusFirstError } from '../lib/formErrors';
import { useT } from '../lib/i18n';
import { ErrorBox, Field, Input } from './ui';

/** "2 min" for a wait in seconds. */
export function useWaitText() {
  const t = useT();
  return (seconds: number) => { const { unit, n } = waitParts(seconds); return t(`ux.wait.${unit}`, { n }); };
}

/** What a failed re-authentication (password, 2FA code) means for the form: a message at the password field, a lock notice, or another error. */
export function useReauthProblem(error: unknown): { field?: string; lock?: string; other?: unknown } {
  const t = useT();
  const wait = useWaitText();
  return useMemo(() => {
    if (!error) return {};
    const msg = error instanceof Error ? error.message : '';
    const locked = (sec: number | null) => ({ lock: sec ? t('ux.reauth.locked', { wait: wait(sec) }) : t('ux.reauth.lockedNoWait') });
    if (isLocked(error)) { const w = lockWait(error); return w ? locked(w) : { lock: t('ux.reauth.accountLocked') }; }
    if (isReauthError(error)) {
      const w = lockoutSeconds(msg);
      if (w !== null) return locked(w);
      return isAccountLockedMessage(msg) ? { lock: t('ux.reauth.accountLocked') } : { field: t('ux.reauth.wrong') };
    }
    return { other: error };
  }, [error, t]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Password (and, with two-factor authentication, the current code) asked again before a sensitive action.
 * Single sign-on accounts have no local password: render nothing for them (`needPassword` false).
 */
export function ReauthFields({ needPassword, needCode, password, code, onPassword, onCode, error }: { needPassword: boolean; needCode: boolean; password: string; code: string; onPassword: (v: string) => void; onCode: (v: string) => void; error: unknown }) {
  const t = useT();
  const p = useReauthProblem(error);
  // memoised on the error itself, not the text: a second wrong attempt has the same text but must move focus again
  const invalid = useMemo(() => (p.field ? { password: p.field } : null), [error]); // eslint-disable-line react-hooks/exhaustive-deps
  useFocusFirstError(invalid);
  if (!needPassword && !needCode) return null;
  return (
    <div className="space-y-3">
      {p.lock && <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{p.lock}</div>}
      {p.other ? <ErrorBox error={p.other} /> : null}
      {needPassword && <Field label={t('profile.current')} hint={t('ux.reauth.hint')} error={p.field}>{(id) => <Input id={id} type="password" required autoComplete="current-password" value={password} onChange={(e) => onPassword(e.target.value)} />}</Field>}
      {needCode && <Field label={t('profile.2faCode')}>{(id) => <Input id={id} required inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => onCode(e.target.value)} />}</Field>}
    </div>
  );
}
