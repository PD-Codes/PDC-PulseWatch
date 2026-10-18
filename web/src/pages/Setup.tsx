import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, ErrorBox, Field, Input } from '../components/ui';
import { get, post } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { useT } from '../lib/i18n';

export default function Setup() {
  const t = useT();
  const meta = useMeta();
  const { afterLogin } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ username: 'admin', displayName: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => get<{ needsSetup: boolean }>('/api/setup/status') });
  if (setup.data && !setup.data.needsSetup) return <Navigate to="/login" replace />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await post<{ csrf: string }>('/api/setup', { username: f.username, password: f.password, displayName: f.displayName || undefined, email: f.email || undefined }); await afterLogin(r.csrf); nav('/', { replace: true }); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-md p-6">
        <div className="mb-5 flex flex-col items-center gap-2 text-center"><img src="/icon.svg" alt="" className="h-12 w-12" /><h1 className="text-xl font-semibold">{t('auth.setupTitle', { name: meta?.brand.name ?? 'PulseWatch' })}</h1><p className="text-sm text-slate-500">{t('auth.setupBody')}</p></div>
        <form onSubmit={submit} className="space-y-4">
          {error ? <ErrorBox error={error} /> : null}
          <Field label={t('auth.username')}>{(id) => <Input id={id} value={f.username} onChange={set('username')} autoComplete="username" required minLength={3} pattern="[A-Za-z0-9._@\-]+" />}</Field>
          <Field label={t('auth.displayName')}>{(id) => <Input id={id} value={f.displayName} onChange={set('displayName')} />}</Field>
          <Field label={`${t('auth.email')} (${t('common.optional')})`}>{(id) => <Input id={id} type="email" value={f.email} onChange={set('email')} autoComplete="email" />}</Field>
          <Field label={t('auth.password')} hint={t('auth.passwordHint')}>{(id) => <Input id={id} type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required minLength={10} />}</Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>{t('auth.createAdmin')}</Button>
        </form>
      </div>
    </div>
  );
}
