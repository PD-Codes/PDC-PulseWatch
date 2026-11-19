import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, KeyRound, Pencil, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CertsTab } from '../components/CertsTab';
import { DefaultsTab } from '../components/DefaultsTab';
import { ReportView, type Report } from '../components/ImportReport';
import { KumaImport } from '../components/KumaImport';
import { CancelButton, FormAlert } from '../components/ops-shared';
import { Pager } from '../components/Pager';
import { ReauthFields } from '../components/ReauthFields';
import { clearSecrets, CopyButton, EMAIL_RE, FieldsForm, isEmptySecret, splitList } from '../components/settingsParts';
import { Badge, Button, Card, CardHeader, Dl, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, TabPanel, Tabs, Textarea, Toggle, cx, useConfirm, useTabParam, useToast } from '../components/ui';
import { parseSecretRefusal } from '../lib/adminErrors';
import { del, download, errorMessage, get, post, put, qs } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { useDirty } from '../lib/dirty';
import { mapApiError, serverErrors, useFocusFirstError, type MappedErrors } from '../lib/formErrors';
import { useT } from '../lib/i18n';
import { setDefaultTheme, THEMES, type ThemeId } from '../lib/theme';
import { useUnsavedChangesGuard } from '../lib/useUnsavedGuard';
import { usePagedList } from '../lib/usePagedList';
import type { FieldDef } from '../../../src/core/types';

const TABS = ['network', 'defaults', 'certificates', 'incidents', 'languages', 'appearance', 'digest', 'auth', 'backup', 'about'] as const;
type Tab = (typeof TABS)[number];

export default function Settings() {
  const t = useT();
  const meta = useMeta();
  // the daily digest is mailed, so its tab only exists when SMTP is configured
  const tabs = useMemo(() => TABS.filter((id) => id !== 'digest' || meta?.smtp), [meta?.smtp]);
  const [tab, setTab] = useTabParam<Tab>('tab', 'network', tabs);
  const label = (id: Tab) => t(id === 'appearance' ? 'ux.settings.tab.appearance' : `settings.tab.${id}`);
  return (
    <div className="space-y-6">
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <Tabs<Tab> idPrefix="settings" label={t('settings.title')} className="-mt-3 mb-0" tabs={tabs.map((id) => ({ id, label: label(id) }))} value={tab} onChange={setTab} />
      <TabPanel idPrefix="settings" id="network" value={tab}><NetworkTab /></TabPanel>
      <TabPanel idPrefix="settings" id="defaults" value={tab}><DefaultsTab /></TabPanel>
      <TabPanel idPrefix="settings" id="certificates" value={tab}><CertsTab /></TabPanel>
      <TabPanel idPrefix="settings" id="incidents" value={tab}><IncidentsTab /></TabPanel>
      <TabPanel idPrefix="settings" id="languages" value={tab}><LanguagesTab /></TabPanel>
      <TabPanel idPrefix="settings" id="appearance" value={tab}><AppearanceTab /></TabPanel>
      <TabPanel idPrefix="settings" id="digest" value={tab}><DigestTab /></TabPanel>
      <TabPanel idPrefix="settings" id="auth" value={tab}><AuthTab /></TabPanel>
      <TabPanel idPrefix="settings" id="backup" value={tab}><BackupTab /></TabPanel>
      <TabPanel idPrefix="settings" id="about" value={tab}><AboutTab /></TabPanel>
    </div>
  );
}

/* ---------------- network security ---------------- */

interface Ssrf { mode: 'allow-private' | 'public-only'; allow: string[]; deny: string[]; builtinDeny: string[]; source: 'environment' | 'ui' }

function NetworkTab() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'ssrf'], queryFn: () => get<Ssrf>('/api/settings/ssrf') });
  const [mode, setMode] = useState<Ssrf['mode']>('allow-private');
  const [allow, setAllow] = useState(''); const [deny, setDeny] = useState('');
  const load = (d: Ssrf) => { setMode(d.mode); setAllow(d.allow.join('\n')); setDeny(d.deny.join('\n')); };
  useEffect(() => { if (q.data) load(q.data); }, [q.data]);
  useUnsavedChangesGuard(!!q.data && (mode !== q.data.mode || allow !== q.data.allow.join('\n') || deny !== q.data.deny.join('\n')));
  const done = (d?: Ssrf) => { toast(t('settings.ssrf.saved')); if (d) qc.setQueryData(['settings', 'ssrf'], d); else qc.invalidateQueries({ queryKey: ['settings', 'ssrf'] }); };
  const save = useMutation({ mutationFn: () => put<Ssrf>('/api/settings/ssrf', { mode, allow: splitList(allow), deny: splitList(deny) }), onSuccess: (d) => done(d?.mode ? d : undefined), onError: (e) => toast(errorMessage(e), 'error') });
  const reset = useMutation({ mutationFn: () => del('/api/settings/ssrf'), onSuccess: () => done(), onError: (e) => toast(errorMessage(e), 'error') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden />{t('settings.ssrf.title')}</span>} subtitle={t('settings.ssrf.intro')}
        actions={<Badge tone={q.data.source === 'ui' ? 'brand' : 'gray'}>{t('settings.ssrf.source')}: {t(`settings.ssrf.source.${q.data.source}`)}</Badge>} />
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t('settings.ssrf.mode')} hint={mode === 'public-only' ? t('settings.ssrf.publicOnlyHelp') : undefined}>
          {(id) => <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as Ssrf['mode'])}><option value="allow-private">{t('settings.ssrf.allowPrivate')}</option><option value="public-only">{t('settings.ssrf.publicOnly')}</option></Select>}
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('settings.ssrf.allow')} hint={t('settings.ssrf.allowHelp')}>{(id) => <Textarea id={id} rows={6} value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="10.0.0.0/8" spellCheck={false} />}</Field>
          <Field label={t('settings.ssrf.deny')} hint={t('settings.ssrf.denyHelp')}>{(id) => <Textarea id={id} rows={6} value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="192.0.2.15" spellCheck={false} />}</Field>
        </div>
        <div>
          <div className="label">{t('settings.ssrf.builtin')}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">{q.data.builtinDeny.map((c) => <span key={c} className="kbd">{c}</span>)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
          {q.data.source === 'ui' && <Button loading={reset.isPending} onClick={async () => { if (await confirm({ title: t('settings.ssrf.reset'), body: t('settings.ssrf.resetConfirm'), confirmLabel: t('common.reset') })) reset.mutate(); }}>{t('settings.ssrf.reset')}</Button>}
        </div>
      </form>
    </Card>
  );
}

/* ---------------- daily digest ---------------- */

interface Digest { enabled: boolean; hour: number; timezone: string; recipients: string[]; smtpConfigured: boolean }
interface Preview { subject: string; text: string; html?: string }

function IncidentsTab() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings-incidents'], queryFn: () => get<{ autoPublish: boolean }>('/api/settings/incidents') });
  const save = useMutation({
    mutationFn: (autoPublish: boolean) => put('/api/settings/incidents', { autoPublish }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings-incidents'] }); toast(t('common.saved')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  return (
    <Card>
      <CardHeader title={t('settings.incidents.title')} subtitle={t('settings.incidents.intro')} />
      <div className="p-4"><Toggle checked={q.data.autoPublish} onChange={(v) => save.mutate(v)} disabled={save.isPending} label={t('settings.incidents.autoPublish')} /></div>
    </Card>
  );
}

/** One language for everything the instance writes and shows, or both with a choice per page, visitor and person. */
function LanguagesTab() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings-languages'], queryFn: () => get<{ mode: 'both' | 'en' | 'de' }>('/api/settings/languages') });
  const save = useMutation({
    mutationFn: (mode: string) => put('/api/settings/languages', { mode }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings-languages'] }); void qc.invalidateQueries({ queryKey: ['meta'] }); void qc.invalidateQueries({ queryKey: ['notification-language'] }); toast(t('common.saved')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  return (
    <Card>
      <CardHeader title={t('settings.languages.title')} subtitle={t('settings.languages.intro')} />
      <div className="space-y-3 p-4">
        <Field label={t('settings.languages.mode')} hint={t(`settings.languages.hint.${q.data.mode}`)} className="max-w-md">
          {(id) => <Select id={id} value={q.data.mode} disabled={save.isPending} onChange={(e) => save.mutate(e.target.value)}>{['both', 'en', 'de'].map((m) => <option key={m} value={m}>{t(`settings.languages.${m}`)}</option>)}</Select>}
        </Field>
      </div>
    </Card>
  );
}

/** The theme everyone gets who has not picked one in the profile or on the device. Saved on click, like the language. */
function AppearanceTab() {
  const t = useT(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'appearance'], queryFn: () => get<{ defaultTheme: ThemeId }>('/api/settings/appearance') });
  const save = useMutation({
    mutationFn: (defaultTheme: ThemeId) => put<{ defaultTheme: ThemeId }>('/api/settings/appearance', { defaultTheme }),
    onSuccess: (r, id) => { qc.setQueryData(['settings', 'appearance'], { defaultTheme: r?.defaultTheme ?? id }); setDefaultTheme(id); void qc.invalidateQueries({ queryKey: ['meta'] }); toast(t('common.saved')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const cur = q.data.defaultTheme;
  return (
    <Card>
      <CardHeader title={t('ux.settings.appearance.title')} subtitle={t('ux.settings.appearance.intro')} />
      <div className="space-y-3 p-4">
        <div role="radiogroup" aria-label={t('ux.settings.appearance.title')} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {THEMES.map((x) => (
            <label key={x.id} className={cx('relative flex cursor-pointer flex-col gap-1.5 rounded-lg border p-2 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500', cur === x.id ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-700/20' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800', save.isPending && 'opacity-60')}>
              <input type="radio" name="default-theme" className="sr-only" checked={cur === x.id} disabled={save.isPending} onChange={() => save.mutate(x.id)} />
              <span className="flex h-6 overflow-hidden rounded ring-1 ring-slate-900/10 dark:ring-white/15" aria-hidden>
                {x.swatch.slice(0, 4).map((c, i) => <span key={i} className={i === 0 ? 'w-2/5' : 'w-1/5'} style={{ background: c }} />)}
              </span>
              <span className="text-sm font-medium">{t(`themes.name.${x.id}`)}</span>
              <span className="line-clamp-2 text-xs leading-snug text-slate-500 dark:text-slate-400">{t(`themes.desc.${x.id}`)}</span>
            </label>
          ))}
        </div>
        <p className="hint">{t('ux.settings.appearance.hint')}</p>
      </div>
    </Card>
  );
}

function DigestTab() {
  const t = useT(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'digest'], queryFn: () => get<Digest>('/api/settings/digest') });
  const [f, setF] = useState<Digest | null>(null);
  const [rec, setRec] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => { if (q.data) { setF(q.data); setRec(q.data.recipients.join('\n')); } }, [q.data]);
  const d0 = q.data;
  useUnsavedChangesGuard(!!d0 && !!f && (f.enabled !== d0.enabled || f.hour !== d0.hour || f.timezone !== d0.timezone || rec !== d0.recipients.join('\n')));
  const save = useMutation({
    mutationFn: () => {
      const recipients = splitList(rec); const bad = recipients.find((r) => !EMAIL_RE.test(r));
      if (bad) throw new Error(t('settings.digest.badRecipients', { value: bad }));
      return put('/api/settings/digest', { enabled: f!.enabled, hour: f!.hour, timezone: f!.timezone, recipients });
    },
    onSuccess: () => { toast(t('common.saved')); qc.invalidateQueries({ queryKey: ['settings', 'digest'] }); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  const prev = useMutation({
    mutationFn: (send: boolean) => post<Preview>('/api/settings/digest/preview', { send }),
    onSuccess: (d, send) => { setPreview(d); if (send) toast(t('settings.digest.sent')); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isLoading || !f) return q.error ? <ErrorBox error={q.error} /> : <Loading />;
  const set = (p: Partial<Digest>) => setF({ ...f, ...p });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('settings.digest.title')} subtitle={t('settings.digest.intro')} />
        <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Toggle checked={f.enabled} onChange={(v) => set({ enabled: v })} label={t('settings.digest.enabled')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('settings.digest.hour')}>{(id) => <Select id={id} value={f.hour} onChange={(e) => set({ hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select>}</Field>
            <Field label={t('settings.digest.timezone')}>{(id) => <Input id={id} value={f.timezone} onChange={(e) => set({ timezone: e.target.value })} placeholder="Europe/Berlin" />}</Field>
          </div>
          <Field label={t('settings.digest.recipients')} hint={t('settings.digest.recipientsHelp')}>{(id) => <Textarea id={id} rows={3} value={rec} onChange={(e) => setRec(e.target.value)} placeholder="ops@example.com" spellCheck={false} />}</Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
            <Button loading={prev.isPending && prev.variables === false} onClick={() => prev.mutate(false)}>{t('settings.digest.preview')}</Button>
            <Button disabled={!f.smtpConfigured} loading={prev.isPending && prev.variables === true} onClick={() => prev.mutate(true)}>{t('settings.digest.sendMe')}</Button>
          </div>
        </form>
      </Card>
      {preview && (
        <Card>
          <CardHeader title={preview.subject} />
          {/* Sandboxed without scripts: the HTML comes from the server but is still rendered inert. */}
          {preview.html ? <iframe title={preview.subject} sandbox="" srcDoc={preview.html} className="h-96 w-full rounded-b-lg bg-white" /> : <pre className="overflow-auto whitespace-pre-wrap p-4 text-sm">{preview.text}</pre>}
        </Card>
      )}
    </div>
  );
}

/* ---------------- authentication providers ---------------- */

interface Provider { id: number; kind: 'oidc' | 'ldap' | 'saml'; name: string; enabled: boolean; config: Record<string, any>; urls?: { acs: string; metadata: string; entityId: string } }
interface Providers { items: Provider[]; redirectUri: string; fields: { oidc: FieldDef[]; ldap: FieldDef[]; saml: FieldDef[] } }
interface Draft { id?: number; kind: 'oidc' | 'ldap' | 'saml'; name: string; enabled: boolean; config: Record<string, any>; urls?: Provider['urls'] }

const defaults = (fs: FieldDef[]) => Object.fromEntries(fs.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));

function AuthTab() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['auth', 'providers'], queryFn: () => get<Providers>('/api/auth/providers') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [refused, setRefused] = useState<{ keys: string[]; changed: string } | null>(null);
  const dirty = useDirty(draft);
  const { pageRows, pagerProps } = usePagedList(q.data?.items ?? [], { key: 'settings-providers' });
  const inv = () => qc.invalidateQueries({ queryKey: ['auth', 'providers'] });
  const fields = draft && q.data ? q.data.fields[draft.kind] : NO_FIELDS;
  const save = useMutation({
    mutationFn: (d: Draft) => (d.id ? put(`/api/auth/providers/${d.id}`, d) : post('/api/auth/providers', d)),
    onMutate: () => { setSaveErr(null); setRefused(null); },
    onSuccess: () => { toast(t('common.saved')); setDraft(null); inv(); },
    onError: (e, v) => {
      // a stored secret is not reused for another target: empty the field and ask again, right at the field
      const r = parseSecretRefusal(serverErrors(e), q.data?.fields[v.kind] ?? []);
      if (r) { setRefused(r); setDraft((cur) => (cur ? { ...cur, config: clearSecrets(cur.config, r.keys) } : cur)); } else setSaveErr(e);
    },
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/api/auth/providers/${id}`), onSuccess: () => { toast(t('common.deleted')); inv(); }, onError: (e) => toast(errorMessage(e), 'error') });
  const toggle = useMutation({ mutationFn: (p: Provider) => put(`/api/auth/providers/${p.id}`, { ...p, enabled: !p.enabled }), onSuccess: inv, onError: (e) => toast(errorMessage(e), 'error') });
  // field name -> words that identify it in a server message
  const mapped = useMemo<MappedErrors>(() => (saveErr ? mapApiError(saveErr, { name: [], ...Object.fromEntries(fields.map((x) => [x.key, [x.label]])) }) : NO_ERRORS), [saveErr]); // eslint-disable-line react-hooks/exhaustive-deps
  const errors = useMemo(() => {
    const e: Record<string, string> = { ...mapped.fieldErrors };
    if (refused && draft) for (const k of refused.keys) if (isEmptySecret(draft.config[k])) e[k] = t('ux.secret.again', { changed: refused.changed });
    return e;
  }, [mapped, refused, draft, t]);
  // focus the first invalid field once per failed save, not on every keystroke afterwards
  const trigger = useMemo(() => (Object.keys(mapped.fieldErrors).length || refused ? { go: 1 } : null), [mapped, refused]);
  useFocusFirstError(trigger);
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  const open = (v: Draft) => { setSaveErr(null); setRefused(null); setDraft(v); };
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden />{t('settings.auth.title')}</span>} subtitle={t('settings.auth.intro')}
        actions={<Button variant="primary" size="sm" onClick={() => open({ kind: 'oidc', name: '', enabled: true, config: defaults(d.fields.oidc) })}><Plus className="h-4 w-4" />{t('settings.auth.add')}</Button>} />
      <div className="space-y-3 border-b border-slate-200 p-4 text-sm dark:border-slate-800">
        <div className="label">{t('settings.auth.redirect')}</div>
        <div className="flex flex-wrap items-center gap-2"><code className="break-all rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">{d.redirectUri}</code><CopyButton text={d.redirectUri} /></div>
      </div>
      {d.items.length === 0 ? <EmptyState icon={<KeyRound className="h-8 w-8" />} title={t('settings.auth.empty')} body={t('settings.auth.emptyBody')} /> : (
        <>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {pageRows.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div className="mt-1 flex flex-wrap gap-1.5"><Badge tone="violet">{p.kind.toUpperCase()}</Badge>{(p.config.allowedGroups || p.config.allowedGroupDns) && <Badge tone="amber">{t('settings.auth.access.badge')}</Badge>}</div></div>
                <Toggle checked={p.enabled} onChange={() => toggle.mutate(p)} label={p.enabled ? t('common.enabled') : t('common.disabled')} />
                <Button size="sm" aria-label={`${t('common.edit')} ${p.name}`} onClick={() => open({ ...p, config: { ...defaults(d.fields[p.kind]), ...p.config } })}><Pencil className="h-3.5 w-3.5" />{t('common.edit')}</Button>
                <Button size="sm" variant="danger" aria-label={`${t('common.delete')} ${p.name}`} onClick={async () => { if (await confirm({ title: t('common.delete'), body: p.name, danger: true, confirmLabel: t('common.delete') })) remove.mutate(p.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </li>
            ))}
          </ul>
          <Pager {...pagerProps} />
        </>
      )}
      <Modal open={!!draft} onClose={() => setDraft(null)} dirty={dirty} wide title={draft?.id ? t('settings.auth.editTitle') : t('settings.auth.newTitle')}
        footer={<><CancelButton /><Button variant="primary" loading={save.isPending} onClick={() => draft && save.mutate(draft)}>{t('common.save')}</Button></>}>
        {draft && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            <FormAlert messages={mapped.rest} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.auth.kind')}>{(id) => <Select id={id} value={draft.kind} disabled={!!draft.id} onChange={(e) => { const kind = e.target.value as Draft['kind']; setDraft({ ...draft, kind, config: defaults(d.fields[kind]) }); }}><option value="oidc">OpenID Connect</option><option value="ldap">LDAP</option><option value="saml">{t('settings.auth.saml.kind')}</option></Select>}</Field>
              <Field label={t('common.name')} error={errors.name}>{(id, aria) => <Input id={id} {...aria} required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
            </div>
            {draft.id && fields.some((f) => f.kind === 'secret') && <p className="hint">{t('settings.auth.secretKept')}</p>}
            {draft.kind === 'saml' && (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
                <div className="label">{t('settings.auth.saml.urls')}</div>
                {draft.urls ? ([['settings.auth.saml.acs', draft.urls.acs], ['settings.auth.saml.entityId', draft.urls.entityId], ['settings.auth.saml.metadata', draft.urls.metadata]] as const).map(([k, val]) => (
                  <div key={k}><div className="text-xs text-slate-500">{t(k)}</div><div className="flex flex-wrap items-center gap-2"><code className="break-all rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">{val}</code><CopyButton text={val} /></div></div>
                )) : <p className="text-slate-500">{t('settings.auth.saml.saveFirst')}</p>}
                <p className="hint">{t('settings.auth.saml.help')}</p>
              </div>
            )}
            {fields.some((f) => f.key === 'allowedGroups' || f.key === 'allowedGroupDns') && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-800/40"><div className="font-medium">{t('settings.auth.access.title')}</div><p className="mt-1 text-slate-600 dark:text-slate-300">{t('settings.auth.access.body')}</p></div>
            )}
            <FieldsForm fields={fields} value={draft.config} onChange={(config) => setDraft({ ...draft, config })} errors={errors} />
            <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('common.enabled')} />
          </form>
        )}
      </Modal>
    </Card>
  );
}

const NO_FIELDS: FieldDef[] = [];
const NO_ERRORS: MappedErrors = { fieldErrors: {}, rest: [] };

/* ---------------- backup & import ---------------- */

function ImportCard({ title, intro, endpoint, accept }: { title: string; intro: string; endpoint: string; accept: string }) {
  const t = useT(); const toast = useToast();
  const [content, setContent] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => post<Report>(endpoint, { content, dryRun }),
    onSuccess: (r) => { setReport(r); toast(t(r.dryRun ? 'settings.backup.dryDone' : 'settings.backup.applied')); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  const onFile = async (f?: File) => {
    setReport(null);
    if (!f) { setContent(null); setName(''); return; }
    try { setContent(await f.text()); setName(f.name); } catch { setContent(null); toast(t('settings.backup.readFailed'), 'error'); }
  };
  const clean = !!report?.dryRun && report.errors.length === 0; // apply is only offered after a clean dry run
  return (
    <Card>
      <CardHeader title={title} subtitle={intro} />
      <div className="space-y-4 p-4">
        <Field label={t('settings.backup.file')}>{(id) => <input id={id} type="file" accept={accept} className="input" disabled={run.isPending} onChange={(e) => onFile(e.target.files?.[0])} />}</Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!content} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>{t('settings.backup.dryRun')}</Button>
          <Button variant="primary" disabled={!content || !clean} loading={run.isPending && run.variables === false} onClick={() => run.mutate(false)}><Upload className="h-4 w-4" />{t('settings.backup.apply')}</Button>
          {content && !report && <span className="hint">{name}: {t('settings.backup.dryHint')}</span>}
        </div>
        {report && <ReportView report={report} />}
      </div>
    </Card>
  );
}


/** Saves text the page already holds as a file (the export with secrets cannot be a plain link). */
function saveAs(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Exporting with secrets hands out every stored credential: password (and 2FA code) again, then the file arrives as a download. */
function ExportDialog({ format, needPassword, needCode, onClose }: { format: 'yaml' | 'json'; needPassword: boolean; needCode: boolean; onClose: () => void }) {
  const t = useT(); const toast = useToast();
  const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const run = useMutation({
    mutationFn: () => post<unknown>('/api/config/export', { format, secrets: true, ...(needPassword ? { password } : {}), ...(needCode ? { code: code.trim() } : {}) }),
    onSuccess: (data) => {
      // YAML arrives as text; JSON is parsed by the client, so write it back readable
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      saveAs(`pulsewatch-config-${new Date().toISOString().slice(0, 10)}.${format}`, text, format === 'json' ? 'application/json' : 'application/yaml');
      toast(t('ux.export.done')); onClose();
    },
  });
  const nothing = !needPassword && !needCode;
  return (
    <Modal open onClose={onClose} title={t('ux.export.title')} footer={<><CancelButton /><Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}><Download className="h-4 w-4" />{t('settings.backup.download')}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <div role="alert" className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('settings.backup.secretsWarn')}</div>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t(nothing ? 'ux.export.confirmNoPassword' : 'ux.export.intro')}</p>
        <ReauthFields needPassword={needPassword} needCode={needCode} password={password} code={code} onPassword={setPassword} onCode={setCode} error={run.error} />
        {nothing && run.error ? <ErrorBox error={run.error} /> : null}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

function BackupTab() {
  const t = useT();
  const { user } = useAuth();
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
  const [secrets, setSecrets] = useState(false);
  const [ask, setAsk] = useState(false);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('settings.backup.export')} subtitle={t('settings.backup.exportIntro')} />
        <div className="space-y-4 p-4">
          <Field label={t('settings.backup.format')} className="max-w-xs">{(id) => <Select id={id} value={format} onChange={(e) => setFormat(e.target.value as 'yaml' | 'json')}><option value="yaml">YAML</option><option value="json">JSON</option></Select>}</Field>
          <Toggle checked={secrets} onChange={setSecrets} label={t('settings.backup.secrets')} />
          {secrets && <div role="alert" className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('settings.backup.secretsWarn')}</div>}
          {/* with secrets the server wants the password again, so there is no plain download link for that */}
          <Button variant="primary" onClick={() => (secrets ? setAsk(true) : download(`/api/config/export${qs({ format })}`))}><Download className="h-4 w-4" />{secrets ? t('ux.export.withSecrets') : t('settings.backup.download')}</Button>
        </div>
      </Card>
      {ask && <ExportDialog format={format} needPassword={user?.authSource === 'local'} needCode={!!user?.totpEnabled} onClose={() => setAsk(false)} />}
      <ImportCard title={t('settings.backup.import')} intro={t('settings.backup.importIntro')} endpoint="/api/config/import" accept=".yaml,.yml,.json,application/json" />
      <KumaImport />
      <ImportCard title={t('settings.backup.kuma')} intro={t('settings.backup.kumaIntro')} endpoint="/api/import/kuma" accept=".json,application/json" />
      <Card>
        <CardHeader title={t('settings.backup.dbTitle')} subtitle={t('settings.backup.dbBody')} />
        <pre className="m-4 overflow-x-auto rounded-md bg-slate-100 p-3 text-xs dark:bg-slate-800">{'docker compose exec mariadb sh -c \'mariadb-dump -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" --single-transaction --routines "$MARIADB_DATABASE"\' > pulsewatch.sql'}</pre>
      </Card>
    </div>
  );
}

/* ---------------- about ---------------- */

function AboutTab() {
  const t = useT(); const meta = useMeta();
  if (!meta) return <Loading />;
  const links: [string, string][] = [['settings.about.swagger', '/api/docs'], ['settings.about.openapi', '/api/openapi.json'], ['settings.about.metrics', '/metrics'], ['settings.about.heartbeat', '/heartbeat']];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title={meta.brand.name} />
        <div className="p-4"><Dl items={[
          [t('settings.about.version'), meta.version], [t('settings.about.baseUrl'), meta.baseUrl], [t('settings.about.role'), meta.role],
          [t('settings.about.smtp'), <Badge key="s" tone={meta.smtp ? 'green' : 'gray'}>{t(meta.smtp ? 'settings.about.configured' : 'settings.about.notConfigured')}</Badge>],
          [t('settings.about.demo'), t(meta.demo ? 'common.yes' : 'common.no')],
        ]} /></div>
      </Card>
      <Card>
        <CardHeader title={t('settings.about.links')} />
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {links.map(([k, href]) => <li key={href} className="flex items-center justify-between gap-3 p-3 text-sm"><a className="text-brand-600 hover:underline dark:text-brand-400" href={href} target="_blank" rel="noopener noreferrer">{t(k)}</a><code className="text-xs text-slate-500">{href}</code></li>)}
        </ul>
      </Card>
    </div>
  );
}
