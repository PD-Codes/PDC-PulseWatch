import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { FormAlert, useFieldErrors, useUsernameRule } from '../components/ops-shared';
import { CopyButton } from '../components/settingsParts';
import { Button, Field, Input } from '../components/ui';
import { isSetupTokenError } from '../lib/adminErrors';
import { get, post } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { focusFirstError } from '../lib/formErrors';
import { useT } from '../lib/i18n';

const FIELDS = { username: ['user name'], displayName: ['display name'], email: [], password: [] };
const LOG_COMMAND = 'docker compose logs app | grep -i "setup token"';

export default function Setup() {
  const t = useT();
  const meta = useMeta();
  const { afterLogin } = useAuth();
  const nav = useNavigate();
  const rule = useUsernameRule();
  const [f, setF] = useState({ username: 'admin', displayName: '', email: '', password: '', setupToken: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => get<{ needsSetup: boolean; setupTokenRequired?: boolean }>('/api/setup/status') });
  // a wrong token is the person's mistake at one field, everything else is a message for the whole form
  const tokenWrong = isSetupTokenError(error);
  const { fieldErrors: fe, rest } = useFieldErrors(tokenWrong ? null : error, FIELDS);
  useEffect(() => { if (tokenWrong) focusFirstError(); }, [tokenWrong, error]);
  if (setup.data && !setup.data.needsSetup) return <Navigate to="/login" replace />;
  const needToken = !!setup.data?.setupTokenRequired;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await post<{ csrf: string }>('/api/setup', { username: f.username, password: f.password, displayName: f.displayName || undefined, email: f.email || undefined, ...(needToken ? { setupToken: f.setupToken.trim() } : {}) }); await afterLogin(r.csrf); nav('/dashboard', { replace: true }); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-md p-6">
        <div className="mb-5 flex flex-col items-center gap-2 text-center"><img src="/icon.svg" alt="" className="h-12 w-12" /><h1 className="text-xl font-semibold">{t('auth.setupTitle', { name: meta?.brand.name ?? 'PulseWatch' })}</h1><p className="text-sm text-slate-500">{t('auth.setupBody')}</p></div>
        <form onSubmit={submit} className="space-y-4">
          <FormAlert messages={tokenWrong && !needToken ? [t('ux.setup.tokenWrong')] : rest} />
          {needToken && (
            <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
              <Field label={t('ux.setup.token')} error={tokenWrong ? t('ux.setup.tokenWrong') : undefined}>{(id) => <Input id={id} value={f.setupToken} onChange={(e) => { setF({ ...f, setupToken: e.target.value }); if (tokenWrong) setError(null); }} autoComplete="off" spellCheck={false} autoFocus required className="font-mono" />}</Field>
              <p className="text-xs text-slate-700 dark:text-slate-300">{t('ux.setup.tokenWhere')}</p>
              <div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all rounded bg-white/70 px-2 py-1 text-xs dark:bg-slate-900/60">{LOG_COMMAND}</code><CopyButton text={LOG_COMMAND} /></div>
            </div>
          )}
          <Field label={t('auth.username')} error={fe.username}>{(id) => <Input id={id} value={f.username} onChange={set('username')} autoComplete="username" required minLength={3} {...rule} />}</Field>
          <Field label={t('auth.displayName')} error={fe.displayName}>{(id) => <Input id={id} value={f.displayName} onChange={set('displayName')} />}</Field>
          <Field label={`${t('auth.email')} (${t('common.optional')})`} error={fe.email}>{(id) => <Input id={id} type="email" value={f.email} onChange={set('email')} autoComplete="email" />}</Field>
          <Field label={t('auth.password')} hint={t('auth.passwordHint')} error={fe.password}>{(id) => <Input id={id} type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required minLength={10} />}</Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>{t('auth.createAdmin')}</Button>
        </form>
      </div>
    </div>
  );
}
