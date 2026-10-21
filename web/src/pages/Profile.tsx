import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, KeyRound, Laptop, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CopyButton } from '../components/settingsParts';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Toggle, useConfirm, useToast } from '../components/ui';
import { del, errorMessage, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useI18n, useT } from '../lib/i18n';
import { useTheme } from '../lib/theme';
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
      {local ? <><PasswordCard /><TotpCard /></> : <p className="rounded-md bg-slate-100 p-3 text-sm dark:bg-slate-800">{t('profile.externalNote')}</p>}
      {passkeysSupported() && <PasskeysCard />}
      <SessionsCard />
      <TokensCard />
    </div>
  );
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
          <Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}</Field>
        </div>
        <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
      </form>
    </Card>
  );
}

function PrefsCard() {
  const t = useT(); const toast = useToast(); const { user, refresh } = useAuth();
  const { setLocale } = useI18n(); const theme = useTheme();
  const persist = useMutation({ mutationFn: (b: Record<string, unknown>) => patch('/api/auth/me', b), onSuccess: () => refresh(), onError: (e) => toast(errorMessage(e), 'error') });
  if (!user) return null;
  return (
    <Card>
      <CardHeader title={t('profile.prefs')} />
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label={t('profile.language')}>{(id) => (
          <Select id={id} value={user.locale ?? 'auto'} onChange={(e) => { const l = e.target.value === 'auto' ? null : (e.target.value as 'en' | 'de'); setLocale(l); persist.mutate({ locale: l }); }}>
            <option value="auto">{t('profile.langAuto')}</option><option value="en">English</option><option value="de">Deutsch</option>
          </Select>
        )}</Field>
        <Field label={t('profile.theme')}>{(id) => (
          <Select id={id} value={theme.pref} onChange={(e) => { const v = e.target.value as 'light' | 'dark' | 'system'; theme.set(v); persist.mutate({ theme: v }); }}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </Select>
        )}</Field>
      </div>
    </Card>
  );
}

/* ---------- password ---------- */

function PasswordCard() {
  const t = useT(); const toast = useToast();
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('');
  const save = useMutation({
    mutationFn: () => { if (next !== again) throw new Error(t('profile.mismatch')); return post('/api/auth/password', { current: cur, next }); },
    onSuccess: () => { toast(t('profile.passwordChanged')); setCur(''); setNext(''); setAgain(''); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Card>
      <CardHeader title={t('profile.password')} />
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t('profile.current')}>{(id) => <Input id={id} type="password" required autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('profile.next')} hint={t('profile.passwordHint')}>{(id) => <Input id={id} type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
          <Field label={t('profile.confirm')}>{(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />}</Field>
        </div>
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
      <Modal open={!!recovery} onClose={() => setRecovery(null)} title={t('profile.recovery')} footer={<Button variant="primary" onClick={() => setRecovery(null)}>{t('common.close')}</Button>}>
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
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {q.data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div className="text-xs text-slate-500">{fmtDateTime(p.createdAt)}</div></div>
              <Button size="sm" variant="danger" aria-label={`${t('common.delete')} ${p.name}`} onClick={async () => { if (await confirm({ title: t('common.delete'), body: p.name, danger: true, confirmLabel: t('common.delete') })) remove.mutate(p.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul>
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
  const revoke = useMutation({ mutationFn: (id: number) => del(`/api/auth/sessions/${id}`), onSuccess: () => { toast(t('profile.revoked')); qc.invalidateQueries({ queryKey: ['sessions'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Laptop className="h-4 w-4" aria-hidden />{t('profile.sessions')}</span>} subtitle={t('profile.sessionsHelp')} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {q.data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="truncate text-sm font-medium" title={s.user_agent ?? ''}>{s.user_agent ?? '–'}</span>{s.current && <Badge tone="green">{t('profile.thisSession')}</Badge>}</div>
                <div className="text-xs text-slate-500">{s.ip ?? '–'} · {t('profile.lastSeen')}: {fmtDateTime(s.last_seen_at)} · {t('profile.expires')}: {fmtDateTime(s.expires_at)}</div>
              </div>
              {!s.current && <Button size="sm" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>{t('profile.revoke')}</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------- API tokens ---------- */

interface Token { id: number; name: string; token_prefix: string; scopes: string[]; created_at: string; last_used_at: string | null; expires_at: string | null }

function TokensCard() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient(); const { user } = useAuth();
  const q = useQuery({ queryKey: ['tokens'], queryFn: () => get<Token[]>('/api/tokens') });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(''); const [scope, setScope] = useState('read'); const [days, setDays] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(''); setScope('read'); setDays(''); } }, [open]);
  const inv = () => qc.invalidateQueries({ queryKey: ['tokens'] });
  const create = useMutation({
    mutationFn: () => post<{ token: string }>('/api/tokens', { name: name.trim(), scopes: [scope], ...(days ? { expiresInDays: Number(days) } : {}) }),
    onSuccess: (d) => { setOpen(false); setCreated(d.token); inv(); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/api/tokens/${id}`), onSuccess: () => { toast(t('common.deleted')); inv(); }, onError: (e) => toast(errorMessage(e), 'error') });
  // The server enforces the same limits; hiding them just avoids a guaranteed 403.
  const scopes = ['read', ...(user?.role !== 'viewer' ? ['write'] : []), ...(user?.role === 'admin' ? ['admin'] : [])];
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden />{t('profile.tokens')}</span>} subtitle={t('profile.tokensHelp')}
        actions={<Button variant="primary" size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />{t('profile.tokenAdd')}</Button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? <EmptyState title={t('profile.tokensEmpty')} /> : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {q.data.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium">{k.name}</span>{k.scopes.map((s) => <Badge key={s} tone={s === 'admin' ? 'red' : s === 'write' ? 'amber' : 'blue'}>{s}</Badge>)}</div>
                <div className="text-xs text-slate-500"><code>{k.token_prefix}…</code> · {t('profile.tokenUsed')}: {fmtDateTime(k.last_used_at)} · {t('profile.expires')}: {k.expires_at ? fmtDateTime(k.expires_at) : '–'}</div>
              </div>
              <Button size="sm" variant="danger" aria-label={`${t('common.delete')} ${k.name}`} onClick={async () => { if (await confirm({ title: t('common.delete'), body: k.name, danger: true, confirmLabel: t('common.delete') })) remove.mutate(k.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={t('profile.tokenAdd')} footer={<><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>{t('common.create')}</Button></>}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <Field label={t('profile.tokenName')}>{(id) => <Input id={id} required maxLength={128} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t('profile.tokenScopes')}>{(id) => <Select id={id} value={scope} onChange={(e) => setScope(e.target.value)}>{scopes.map((s) => <option key={s} value={s}>{t(`profile.scope.${s}`)}</option>)}</Select>}</Field>
          <Field label={t('profile.tokenExpiry')} hint={t('profile.tokenExpiryHelp')}>{(id) => <Input id={id} type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
        </form>
      </Modal>
      <Modal open={!!created} onClose={() => setCreated(null)} title={t('profile.tokenCreated')} footer={<Button variant="primary" onClick={() => setCreated(null)}>{t('common.close')}</Button>}>
        <p className="mb-3 text-sm">{t('profile.tokenShown')}</p>
        <code className="block break-all rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">{created}</code>
        <div className="mt-3">{created && <CopyButton text={created} />}</div>
      </Modal>
    </Card>
  );
}
