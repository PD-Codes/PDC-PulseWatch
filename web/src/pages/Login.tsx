import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, ErrorBox, Field, Input } from '../components/ui';
import { ApiError, get } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { useT } from '../lib/i18n';
import { passkeyLogin, passkeysSupported } from '../lib/webauthn';

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
  const [error, setError] = useState<unknown>(params.get('error') ? new Error(t(`auth.error.${params.get('error')}`)) : null);
  const [busy, setBusy] = useState(false);
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: () => get<{ id: number; name: string }[]>('/api/auth/providers/public'), staleTime: 60_000 });
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => get<{ needsSetup: boolean }>('/api/setup/status'), staleTime: 60_000 });
  const from = (loc.state as { from?: string } | null)?.from ?? '/';

  useEffect(() => { document.title = `${t('auth.signIn')} · PulseWatch`; }, [t]);
  if (user) return <Navigate to={from} replace />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await login({ username, password, totp: needTotp ? totp : undefined }); nav(from, { replace: true }); }
    catch (err) { if (err instanceof ApiError && err.code === 'totp_required') setNeedTotp(true); else setError(err); }
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
          <Field label={t('auth.username')}>{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />}</Field>
          <Field label={t('auth.password')}>{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}</Field>
          {needTotp && <Field label={t('auth.totp')} hint={t('auth.totpHelp')}>{(id) => <Input id={id} value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />}</Field>}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>{t('auth.signIn')}</Button>
        </form>
        {(providers.data?.length || passkeysSupported()) ? <div className="my-4 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />{t('auth.or')}<span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" /></div> : null}
        <div className="space-y-2">
          {providers.data?.map((p) => <a key={p.id} href={`/api/auth/oidc/${p.id}/start`} className="btn w-full no-underline">{t('auth.sso', { name: p.name })}</a>)}
          {passkeysSupported() && <Button className="w-full" onClick={withPasskey} disabled={busy}><KeyRound className="h-4 w-4" />{t('auth.passkey')}</Button>}
        </div>
      </div>
    </div>
  );
}
