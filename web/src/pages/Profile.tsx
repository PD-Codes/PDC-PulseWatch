import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Fingerprint, KeyRound, Laptop, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CancelButton, FormAlert, useFieldErrors } from '../components/ops-shared';
import { Pager } from '../components/Pager';
import { ReauthFields, useReauthProblem } from '../components/ReauthFields';
import { CopyButton } from '../components/settingsParts';
import { ThemePicker } from '../components/ThemePicker';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Toggle, cx, useConfirm, useToast } from '../components/ui';
import { isLocked, isReauthError } from '../lib/adminErrors';
import { ApiError, del, errorMessage, get, patch, post } from '../lib/api';
import { clearDeviceTheme, rememberProfileTheme, useAuth } from '../lib/auth';
import { playAlertSound, showBrowserAlert, useBrowserAlertSettings, type BrowserAlertMode } from '../lib/browserAlerts';
import { useDirty } from '../lib/dirty';
import { focusFirstError } from '../lib/formErrors';
import { fmtDateTime } from '../lib/format';
import { useI18n, useT } from '../lib/i18n';
import type { ThemeId, ThemeMode } from '../lib/theme';
import { usePagedList } from '../lib/usePagedList';
import { passkeyRegister, passkeysSupported } from '../lib/webauthn';

export default function Profile() {
  const t = useT(); const { user } = useAuth();
  if (!user) return <Loading />;
  const local = user.authSource === 'local';
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />
      <AccountCard />
      <PrefsCard />
      <BrowserAlertsCard />
      {local ? <><PasswordCard /><TotpCard /></> : <p className="rounded-md bg-slate-100 p-3 text-sm dark:bg-slate-800">{t('profile.externalNote')}</p>}
      {passkeysSupported() && <PasskeysCard />}
      <SessionsCard />
      <TokensCard />
    </div>
  );
}

const PASSWORD_FIELDS = { current: [], next: ['new password'] };

/** Moves focus to the first invalid field when `error` appears (for errors that are not mapped by useFieldErrors). */
function useFocusWrong(error: unknown) {
  useEffect(() => { if (error) focusFirstError(); }, [error]);
}

/* ---------- account + preferences ---------- */

function AccountCard() {
  const t = useT(); const toast = useToast(); const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.displayName ?? ''); const [email, setEmail] = useState(user?.email ?? '');
  const save = useMutation({
    mutationFn: () => patch('/api/auth/me', { displayName: name, email: email.trim() || null }),
    onSuccess: async () => { await refresh(); toast(t('common.saved')); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!user) return null;
  return (
    <Card>
      <CardHeader title={t('profile.account')} actions={<Badge tone="brand">{user.role}</Badge>} />
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('profile.username')}>{(id) => <Input id={id} value={user.username} readOnly disabled />}</Field>
          <Field label={t('profile.source')}>{(id) => <Input id={id} value={user.authSource} readOnly disabled />}</Field>
          <Field label={t('common.name')}>{(id) => <Input id={id} required maxLength={128} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t('auth.email')}>{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}</Field>
        </div>
        <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
      </form>
    </Card>
  );
}

function PrefsCard() {
  const t = useT(); const toast = useToast(); const { user, refresh } = useAuth();
  const { setLocale } = useI18n();
  const persist = useMutation({ mutationFn: (b: Record<string, unknown>) => patch('/api/auth/me', b), onSuccess: () => refresh(), onError: (e) => toast(errorMessage(e), 'error') });
  // Theme picks apply on the device at once, but are saved once after the last pick and strictly one after the other,
  // so a slow answer to an earlier pick cannot overwrite a later one (with a stale uiTheme coming back from /me).
  const pending = useRef<{ themeId: ThemeId; mode: ThemeMode } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const send = (body: Record<string, unknown>, after?: () => void) => {
    chain.current = chain.current.then(() => patch('/api/auth/me', body)).then(() => { after?.(); return refresh(); }).catch((e) => toast(errorMessage(e), 'error'));
  };
  const flush = () => {
    clearTimeout(timer.current);
    const v = pending.current; pending.current = null;
    if (v) send({ uiTheme: v.themeId, theme: v.mode }, () => rememberProfileTheme(v.themeId, v.mode));
  };
  const flushRef = useRef(flush); flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []); // leaving the page does not lose the last pick
  const pick = (v: { themeId: ThemeId; mode: ThemeMode }) => { pending.current = v; clearTimeout(timer.current); timer.current = setTimeout(flush, 600); };
  const useDefault = () => { clearTimeout(timer.current); pending.current = null; clearDeviceTheme(); send({ uiTheme: null }, () => toast(t('ux.profile.themeDefaultDone'))); };
  if (!user) return null;
  return (
    <Card>
      <CardHeader title={t('profile.prefs')} />
      <div className="space-y-4 p-4">
        <Field label={t('profile.language')} hint={t('profile.languageHint')} className="max-w-sm">{(id) => (
          <Select id={id} value={user.locale ?? 'auto'} onChange={(e) => { const l = e.target.value === 'auto' ? null : (e.target.value as 'en' | 'de'); setLocale(l); persist.mutate({ locale: l }); }}>
            <option value="auto">{t('profile.langAuto')}</option><option value="en">English</option><option value="de">Deutsch</option>
          </Select>
        )}</Field>
        <div>
          <div className="label">{t('profile.theme')}</div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="hint">{t('ux.profile.themeHint')}</p>
            <Button size="sm" onClick={useDefault}>{t('ux.profile.themeDefault')}</Button>
          </div>
          {/* the device keeps the choice at once; the profile keeps it for the next device */}
          <ThemePicker variant="full" onChange={pick} />
        </div>
      </div>
    </Card>
  );
}

/* ---------- browser notifications ---------- */

function BrowserAlertsCard() {
  const t = useT(); const toast = useToast();
  const b = useBrowserAlertSettings();
  const modes: BrowserAlertMode[] = ['off', 'down', 'all'];
  const perm = { granted: ['green', 'ux.profile.browser.granted'], denied: ['red', 'ux.profile.browser.denied'], default: ['amber', 'ux.profile.browser.default'] } as const;
  const [tone, label] = perm[b.permission];
  const test = () => { showBrowserAlert(t('ux.profile.browser.testTitle'), t('ux.profile.browser.testBody'), { tag: 'pw-test' }); if (b.sound === 'on') playAlertSound('down'); toast(t('ux.profile.browser.testSent')); };
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Bell className="h-4 w-4" aria-hidden />{t('ux.profile.browser.title')}</span>} subtitle={t('ux.profile.browser.intro')} actions={b.supported ? <Badge tone={tone}>{t(label)}</Badge> : undefined} />
      {!b.supported ? <p className="p-4 text-sm text-slate-500">{t('ux.profile.browser.unsupported')}</p> : (
        <div className="space-y-4 p-4">
          <div role="radiogroup" aria-label={t('ux.profile.browser.title')} className="grid gap-2 sm:grid-cols-3">
            {modes.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={b.mode === m} onClick={() => b.setMode(m)}
                className={cx('rounded-lg border p-2.5 text-left transition', b.mode === m ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-700/20' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800')}>
                <span className="block text-sm font-medium">{t(`ux.profile.browser.mode.${m}`)}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">{t(`ux.profile.browser.mode.${m}Hint`)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Toggle checked={b.sound === 'on'} onChange={(v) => b.setSound(v ? 'on' : 'off')} disabled={b.mode === 'off'} label={t('ux.profile.browser.sound')} />
            {b.permission === 'default' && <Button size="sm" variant="primary" onClick={() => void b.request()}>{t('ux.profile.browser.request')}</Button>}
            {b.permission === 'granted' && b.mode !== 'off' && <Button size="sm" onClick={test}>{t('ux.profile.browser.test')}</Button>}
          </div>
          {b.permission === 'denied' && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">{t('ux.profile.browser.deniedHelp')}</p>}
          {b.permission === 'default' && b.mode !== 'off' && <p className="hint">{t('ux.profile.browser.needsPermission')}</p>}
          <p className="hint">{t('ux.profile.browser.device')}</p>
        </div>
      )}
    </Card>
  );
}

/* ---------- password ---------- */

function PasswordCard() {
  const t = useT(); const toast = useToast(); const qc = useQueryClient();
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [revoked, setRevoked] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: () => post<{ ok: boolean; revokedTokens?: number }>('/api/auth/password', { current: cur, next }),
    onSuccess: (r) => {
      toast(t('profile.passwordChanged')); setCur(''); setNext(''); setAgain('');
      const n = r?.revokedTokens ?? 0;
      setRevoked(n);
      if (n > 0) void qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  // a wrong current password or a lockout belongs to the first field; format problems to the new one
  const wrongCurrent = save.error instanceof ApiError && save.error.code === 'invalid_password';
  const problem = useReauthProblem(isLocked(save.error) ? save.error : null);
  const { fieldErrors: fe, rest } = useFieldErrors(save.error && !wrongCurrent && !isLocked(save.error) ? save.error : null, PASSWORD_FIELDS);
  useFocusWrong(wrongCurrent ? save.error : null);
  const submit = () => { setRevoked(null); if (next !== again) { setMismatch(true); return; } setMismatch(false); save.mutate(); };
  return (
    <Card>
      <CardHeader title={t('profile.password')} />
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {revoked !== null && revoked > 0 && <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{t(revoked === 1 ? 'ux.profile.tokensRevoked.one' : 'ux.profile.tokensRevoked', { n: revoked })}</div>}
        {problem.lock && <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{problem.lock}</div>}
        <FormAlert messages={rest} />
        <Field label={t('profile.current')} error={wrongCurrent ? t('ux.reauth.wrongPassword') : fe.current}>{(id) => <Input id={id} type="password" required autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('profile.next')} hint={t('profile.passwordHint')} error={fe.next}>{(id) => <Input id={id} type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={next} onChange={(e) => { setNext(e.target.value); setMismatch(false); }} />}</Field>
          <Field label={t('profile.confirm')} error={mismatch ? t('profile.mismatch') : undefined}>{(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={again} onChange={(e) => { setAgain(e.target.value); setMismatch(false); }} />}</Field>
        </div>
        <p className="hint">{t('ux.profile.passwordRevokesTokens')}</p>
        <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
      </form>
    </Card>
  );
}

/* ---------- two-factor ---------- */

function TotpCard() {
  const t = useT(); const toast = useToast(); const { user, refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState(''); const [pw, setPw] = useState(''); const [disabling, setDisabling] = useState(false);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const start = useMutation({ mutationFn: () => post<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup'), onSuccess: (d) => { setSetup(d); setCode(''); }, onError: (e) => toast(errorMessage(e), 'error') });
  const enable = useMutation({
    mutationFn: () => post<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', { code: code.trim() }),
    onSuccess: async (d) => { setSetup(null); setCode(''); setRecovery(d.recoveryCodes); await refresh(); toast(t('profile.2faEnabled')); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  const disable = useMutation({
    mutationFn: () => post('/api/auth/2fa/disable', { password: pw, code: code.trim() }),
    onSuccess: async () => { setDisabling(false); setPw(''); setCode(''); await refresh(); toast(t('profile.2faDisabled')); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!user) return null;
  const on = user.totpEnabled;
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden />{t('profile.2fa')}</span>} actions={<Badge tone={on ? 'green' : 'gray'}>{on ? t('common.enabled') : t('common.disabled')}</Badge>} />
      <div className="space-y-4 p-4">
        <p className="text-sm">{on ? t('profile.2faOn') : t('profile.2faOff')}</p>
        {!on && !setup && <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>{t('profile.2faStart')}</Button>}
        {on && !disabling && <Button variant="danger" onClick={() => { setDisabling(true); setCode(''); }}>{t('profile.2faDisable')}</Button>}
        {setup && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
            <p className="hint">{t('profile.2faHelp')}</p>
            <div className="label">{t('profile.2faSecret')}</div>
            <div className="flex flex-wrap items-center gap-2"><code className="break-all rounded bg-slate-100 px-2 py-1 text-sm dark:bg-slate-800">{setup.secret}</code><CopyButton text={setup.secret} /></div>
            <a className="text-sm text-brand-600 hover:underline dark:text-brand-400" href={setup.otpauthUrl}>{t('profile.2faOpen')}</a>
            <Field label={t('profile.2faCode')}>{(id) => <Input id={id} required inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <div className="flex gap-2"><Button type="submit" variant="primary" loading={enable.isPending}>{t('profile.2faEnable')}</Button><Button onClick={() => setSetup(null)}>{t('common.cancel')}</Button></div>
          </form>
        )}
        {disabling && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
            <p className="hint">{t('profile.2faDisableHelp')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('profile.current')}>{(id) => <Input id={id} type="password" required autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
              <Field label={t('profile.2faCode')}>{(id) => <Input id={id} required inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            </div>
            <div className="flex gap-2"><Button type="submit" variant="danger" loading={disable.isPending}>{t('profile.2faDisable')}</Button><Button onClick={() => setDisabling(false)}>{t('common.cancel')}</Button></div>
          </form>
        )}
      </div>
      <Modal open={!!recovery} dirty onClose={() => setRecovery(null)} title={t('profile.recovery')} footer={<Button variant="primary" onClick={() => setRecovery(null)}>{t('common.close')}</Button>}>
        <p className="mb-3 text-sm">{t('profile.recoveryHelp')}</p>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm">{recovery?.map((c) => <li key={c} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">{c}</li>)}</ul>
        <div className="mt-3"><CopyButton text={(recovery ?? []).join('\n')} /></div>
      </Modal>
    </Card>
  );
}

/* ---------- passkeys ---------- */

interface Passkey { id: number; name: string; createdAt: string }

function PasskeysCard() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['passkeys'], queryFn: () => get<Passkey[]>('/api/auth/passkeys') });
  const { user } = useAuth();
  const [name, setName] = useState(''); const [pw, setPw] = useState(''); const [code, setCode] = useState('');
  const inv = () => qc.invalidateQueries({ queryKey: ['passkeys'] });
  const list = usePagedList(q.data ?? [], { key: 'profile.passkeys', sizes: [10, 20, 50, 100] });
  const add = useMutation({
    mutationFn: () => passkeyRegister(name.trim() || t('profile.passkeyDefault'), pw, code.trim() || undefined),
    onSuccess: () => { setName(''); setPw(''); setCode(''); toast(t('profile.passkeyAdded')); inv(); },
    onError: (e) => { if ((e as Error).name !== 'NotAllowedError') toast(errorMessage(e), 'error'); }, // the user dismissed the browser prompt
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/api/auth/passkeys/${id}`), onSuccess: () => { toast(t('common.deleted')); inv(); }, onError: (e) => toast(errorMessage(e), 'error') });
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Fingerprint className="h-4 w-4" aria-hidden />{t('profile.passkeys')}</span>} subtitle={t('profile.passkeysHelp')} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? <p className="p-4 text-sm text-slate-500">{t('profile.passkeysEmpty')}</p> : (
        <><ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {list.pageRows.map((p) => (
            <li key={p.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div className="text-xs text-slate-500">{fmtDateTime(p.createdAt)}</div></div>
              <Button size="sm" variant="danger" aria-label={`${t('common.delete')} ${p.name}`} onClick={async () => { if (await confirm({ title: t('common.delete'), body: p.name, danger: true, confirmLabel: t('common.delete') })) remove.mutate(p.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul><Pager {...list.pagerProps} /></>
      )}
      <form className="flex flex-wrap items-end gap-2 border-t border-slate-200 p-4 dark:border-slate-800" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Field label={t('profile.passkeyName')} className="min-w-0 flex-1">{(id) => <Input id={id} maxLength={64} value={name} placeholder={t('profile.passkeyDefault')} onChange={(e) => setName(e.target.value)} />}</Field>
        {user?.authSource === 'local' && <Field label={t('profile.current')} className="min-w-0 flex-1">{(id) => <Input id={id} type="password" required autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>}
        {user?.totpEnabled && <Field label={t('profile.2faCode')} className="w-36">{(id) => <Input id={id} required inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>}
        <Button type="submit" variant="primary" loading={add.isPending}><Plus className="h-4 w-4" />{t('profile.passkeyAdd')}</Button>
      </form>
    </Card>
  );
}

/* ---------- sessions ---------- */

interface Session { id: number; created_at: string; last_seen_at: string; expires_at: string; ip: string | null; user_agent: string | null; current: boolean }

function SessionsCard() {
  const t = useT(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => get<Session[]>('/api/auth/sessions') });
  const list = usePagedList(q.data ?? [], { key: 'profile.sessions', sizes: [10, 20, 50, 100] });
  const revoke = useMutation({ mutationFn: (id: number) => del(`/api/auth/sessions/${id}`), onSuccess: () => { toast(t('profile.revoked')); qc.invalidateQueries({ queryKey: ['sessions'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Laptop className="h-4 w-4" aria-hidden />{t('profile.sessions')}</span>} subtitle={t('profile.sessionsHelp')} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <><ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {list.pageRows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="truncate text-sm font-medium" title={s.user_agent ?? ''}>{s.user_agent ?? '–'}</span>{s.current && <Badge tone="green">{t('profile.thisSession')}</Badge>}</div>
                <div className="text-xs text-slate-500">{s.ip ?? '–'} · {t('profile.lastSeen')}: {fmtDateTime(s.last_seen_at)} · {t('profile.expires')}: {fmtDateTime(s.expires_at)}</div>
              </div>
              {!s.current && <Button size="sm" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>{t('profile.revoke')}</Button>}
            </li>
          ))}
        </ul><Pager {...list.pagerProps} /></>
      )}
    </Card>
  );
}

/* ---------- API tokens ---------- */

interface Token { id: number; name: string; token_prefix: string; scopes: string[]; created_at: string; last_used_at: string | null; expires_at: string | null }

const TOKEN_FIELDS = { name: ['name'], scopes: ['scopes', 'scope'], expiresInDays: ['expiresInDays', 'expiry'] };

function TokensCard() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient(); const { user } = useAuth();
  const q = useQuery({ queryKey: ['tokens'], queryFn: () => get<Token[]>('/api/tokens') });
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const list = usePagedList(q.data ?? [], { key: 'profile.tokens', sizes: [10, 20, 50, 100] });
  const inv = () => qc.invalidateQueries({ queryKey: ['tokens'] });
  const remove = useMutation({ mutationFn: (id: number) => del(`/api/tokens/${id}`), onSuccess: () => { toast(t('common.deleted')); inv(); }, onError: (e) => toast(errorMessage(e), 'error') });
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden />{t('profile.tokens')}</span>} subtitle={t('profile.tokensHelp')}
        actions={<Button variant="primary" size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />{t('profile.tokenAdd')}</Button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? <EmptyState title={t('profile.tokensEmpty')} /> : (
        <><ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {list.pageRows.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium">{k.name}</span>{k.scopes.map((s) => <Badge key={s} tone={s === 'admin' ? 'red' : s === 'write' ? 'amber' : 'blue'}>{s}</Badge>)}</div>
                <div className="text-xs text-slate-500"><code>{k.token_prefix}…</code> · {t('profile.tokenUsed')}: {fmtDateTime(k.last_used_at)} · {t('profile.expires')}: {k.expires_at ? fmtDateTime(k.expires_at) : '–'}</div>
              </div>
              <Button size="sm" variant="danger" aria-label={`${t('common.delete')} ${k.name}`} onClick={async () => { if (await confirm({ title: t('common.delete'), body: k.name, danger: true, confirmLabel: t('common.delete') })) remove.mutate(k.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul><Pager {...list.pagerProps} /></>
      )}
      {open && <TokenDialog admin={user?.role === 'admin'} viewer={user?.role === 'viewer'} needPassword={user?.authSource === 'local'} needCode={!!user?.totpEnabled} onClose={() => setOpen(false)} onCreated={(tok) => { setOpen(false); setCreated(tok); inv(); }} />}
      <Modal open={!!created} dirty onClose={() => setCreated(null)} title={t('profile.tokenCreated')} footer={<Button variant="primary" onClick={() => setCreated(null)}>{t('common.close')}</Button>}>
        <p className="mb-3 text-sm">{t('profile.tokenShown')}</p>
        <code className="block break-all rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">{created}</code>
        <div className="mt-3">{created && <CopyButton text={created} />}</div>
      </Modal>
    </Card>
  );
}

/** Creating a token is lasting access: the server wants the password (and the 2FA code) again. Mounted only while open, so the form starts clean. */
function TokenDialog({ admin, viewer, needPassword, needCode, onClose, onCreated }: { admin: boolean; viewer: boolean; needPassword: boolean; needCode: boolean; onClose: () => void; onCreated: (token: string) => void }) {
  const t = useT();
  const [f, setF] = useState({ name: '', scope: 'read', days: '', password: '', code: '' });
  const set = (p: Partial<typeof f>) => setF((c) => ({ ...c, ...p }));
  const dirty = useDirty({ name: f.name, scope: f.scope, days: f.days }); // the secrets alone do not make it worth a question
  const create = useMutation({
    mutationFn: () => post<{ token: string }>('/api/tokens', { name: f.name.trim(), scopes: [f.scope], ...(f.days ? { expiresInDays: Number(f.days) } : {}), ...(needPassword ? { password: f.password } : {}), ...(needCode ? { code: f.code.trim() } : {}) }),
    onSuccess: (d) => onCreated(d.token),
  });
  const reauth = create.error && (isReauthError(create.error) || isLocked(create.error)) ? create.error : null;
  const { fieldErrors: fe, rest } = useFieldErrors(create.error && !reauth ? create.error : null, TOKEN_FIELDS);
  // The server enforces the same limits; hiding them just avoids a guaranteed 403.
  const scopes = ['read', ...(!viewer ? ['write'] : []), ...(admin ? ['admin'] : [])];
  const submit = () => { if (f.name.trim()) create.mutate(); };
  return (
    <Modal open onClose={onClose} dirty={dirty} title={t('profile.tokenAdd')} footer={<><CancelButton /><Button variant="primary" loading={create.isPending} disabled={!f.name.trim()} onClick={submit}>{t('common.create')}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormAlert messages={rest} />
        <Field label={t('profile.tokenName')} error={fe.name}>{(id, aria) => <Input id={id} {...aria} required maxLength={128} value={f.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('profile.tokenScopes')} error={fe.scopes}>{(id, aria) => <Select id={id} {...aria} value={f.scope} onChange={(e) => set({ scope: e.target.value })}>{scopes.map((s) => <option key={s} value={s}>{t(`profile.scope.${s}`)}</option>)}</Select>}</Field>
          <Field label={t('profile.tokenExpiry')} hint={t('profile.tokenExpiryHelp')} error={fe.expiresInDays}>{(id, aria) => <Input id={id} {...aria} type="number" min={1} max={3650} value={f.days} onChange={(e) => set({ days: e.target.value })} />}</Field>
        </div>
        <ReauthFields needPassword={needPassword} needCode={needCode} password={f.password} code={f.code} onPassword={(v) => set({ password: v })} onCode={(v) => set({ code: v })} error={reauth} />
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
