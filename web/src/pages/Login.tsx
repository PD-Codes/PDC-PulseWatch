import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, ErrorBox, Field, Input } from '../components/ui';
import { clock, isLocked, lockWait } from '../lib/adminErrors';
import { ApiError, get } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { useT } from '../lib/i18n';
import { passkeyLogin, passkeysSupported } from '../lib/webauthn';

// the redirect brings a code in the URL: only known ones are shown by key, anything else gets the general message
const SSO_ERRORS = ['no_access', 'not_allowed', 'provider_unavailable', 'provider_unreachable', 'sso_failed', 'state_expired'];

export default function Login() {
  const t = useT();
  const { user, login, afterLogin } = useAuth();
  const meta = useMeta();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<unknown>(params.get('error') ? new Error(t(SSO_ERRORS.includes(params.get('error')!) ? `auth.error.${params.get('error')}` : 'auth.error.sso_failed')) : null);
  const [busy, setBusy] = useState(false);
  // too many attempts: the server says how long to wait; the button stays off until then
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [lockNoWait, setLockNoWait] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const remaining = lockUntil ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0;
  useEffect(() => {
    if (!lockUntil) return;
    const id = setInterval(() => { const n = Date.now(); setNow(n); if (n >= lockUntil) setLockUntil(null); }, 1000);
    return () => clearInterval(id);
  }, [lockUntil]);
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: () => get<{ id: number; kind: 'oidc' | 'saml'; name: string }[]>('/api/auth/providers/public'), staleTime: 60_000 });
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => get<{ needsSetup: boolean }>('/api/setup/status'), staleTime: 60_000 });
  const from = (loc.state as { from?: string } | null)?.from ?? '/dashboard';

  useEffect(() => { document.title = `${t('auth.signIn')} · PulseWatch`; }, [t]);
  if (user) return <Navigate to={from} replace />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null); setLockNoWait(false);
    try { await login({ username, password, totp: needTotp ? totp : undefined }); nav(from, { replace: true }); }
    catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') setNeedTotp(true);
      else if (err instanceof ApiError && err.code === 'no_access') { const to = err.body?.redirect as string | null | undefined; if (to) nav(to, { replace: true }); else setError(new Error(t('auth.error.no_access'))); } // not in an allowed group: open status page or notice
      else if (isLocked(err)) { const w = lockWait(err); setNow(Date.now()); if (w) setLockUntil(Date.now() + w * 1000); else setLockNoWait(true); }
      else setError(err);
    }
    finally { setBusy(false); }
  };
  const withPasskey = async () => {
    setBusy(true); setError(null);
    try { await afterLogin(await passkeyLogin()); nav(from, { replace: true }); } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6 flex flex-col items-center gap-2"><img src="/icon.svg" alt="" className="h-12 w-12" /><h1 className="text-xl font-semibold">{meta?.brand.name ?? 'PulseWatch'}</h1></div>
        <form onSubmit={submit} className="space-y-4">
          {error ? <ErrorBox error={error} /> : null}
          {(remaining > 0 || lockNoWait) && <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{remaining > 0 ? t('ux.login.locked', { wait: clock(remaining) }) : t('ux.login.lockedAccount')}</div>}
          <Field label={t('auth.username')}>{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />}</Field>
          <Field label={t('auth.password')}>{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}</Field>
          {needTotp && <Field label={t('auth.totp')} hint={t('auth.totpHelp')}>{(id) => <Input id={id} value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />}</Field>}
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={remaining > 0}>{remaining > 0 ? t('ux.login.retryIn', { wait: clock(remaining) }) : t('auth.signIn')}</Button>
        </form>
        {(providers.data?.length || passkeysSupported()) ? <div className="my-4 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />{t('auth.or')}<span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" /></div> : null}
        <div className="space-y-2">
          {providers.data?.map((p) => <a key={p.id} href={`/api/auth/${p.kind}/${p.id}/start`} className="btn w-full no-underline">{t('auth.sso', { name: p.name })}</a>)}
          {passkeysSupported() && <Button className="w-full" onClick={withPasskey} disabled={busy}><KeyRound className="h-4 w-4" />{t('auth.passkey')}</Button>}
        </div>
      </div>
    </div>
  );
}
