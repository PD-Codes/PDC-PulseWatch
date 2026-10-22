import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, KeyRound, Pencil, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CertsTab } from '../components/CertsTab';
import { DefaultsTab } from '../components/DefaultsTab';
import { ReportView, type Report } from '../components/ImportReport';
import { KumaImport } from '../components/KumaImport';
import { CopyButton, EMAIL_RE, FieldsForm, splitList } from '../components/settingsParts';
import { Badge, Button, Card, CardHeader, Dl, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, Toggle, useConfirm, useToast } from '../components/ui';
import { del, download, errorMessage, get, post, put, qs } from '../lib/api';
import { useMeta } from '../lib/auth';
import { useT } from '../lib/i18n';
import type { FieldDef } from '../../../src/core/types';

const TABS = ['network', 'defaults', 'certificates', 'incidents', 'digest', 'auth', 'backup', 'about'] as const;
type Tab = (typeof TABS)[number];

export default function Settings() {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const meta = useMeta();
  // the daily digest is mailed, so its tab only exists when SMTP is configured
  const tabs = TABS.filter((id) => id !== 'digest' || meta?.smtp);
  const raw = sp.get('tab') as Tab | null;
  const tab: Tab = raw && tabs.includes(raw) ? raw : 'network';
  return (
    <div className="space-y-6">
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="overflow-x-auto">
        <Tabs tabs={tabs.map((id) => ({ id, label: t(`settings.tab.${id}`) }))} value={tab} onChange={(v) => setSp({ tab: v }, { replace: true })} />
      </div>
      {tab === 'network' && <NetworkTab />}
      {tab === 'defaults' && <DefaultsTab />}
      {tab === 'certificates' && <CertsTab />}
      {tab === 'incidents' && <IncidentsTab />}
      {tab === 'digest' && <DigestTab />}
      {tab === 'auth' && <AuthTab />}
      {tab === 'backup' && <BackupTab />}
      {tab === 'about' && <AboutTab />}
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

function DigestTab() {
  const t = useT(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'digest'], queryFn: () => get<Digest>('/api/settings/digest') });
  const [f, setF] = useState<Digest | null>(null);
  const [rec, setRec] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => { if (q.data) { setF(q.data); setRec(q.data.recipients.join('\n')); } }, [q.data]);
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
  const inv = () => qc.invalidateQueries({ queryKey: ['auth', 'providers'] });
  const save = useMutation({
    mutationFn: (d: Draft) => (d.id ? put(`/api/auth/providers/${d.id}`, d) : post('/api/auth/providers', d)),
    onSuccess: () => { toast(t('common.saved')); setDraft(null); inv(); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/api/auth/providers/${id}`), onSuccess: () => { toast(t('common.deleted')); inv(); }, onError: (e) => toast(errorMessage(e), 'error') });
  const toggle = useMutation({ mutationFn: (p: Provider) => put(`/api/auth/providers/${p.id}`, { ...p, enabled: !p.enabled }), onSuccess: inv, onError: (e) => toast(errorMessage(e), 'error') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  const fields = draft ? d.fields[draft.kind] : [];
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden />{t('settings.auth.title')}</span>} subtitle={t('settings.auth.intro')}
        actions={<Button variant="primary" size="sm" onClick={() => setDraft({ kind: 'oidc', name: '', enabled: true, config: defaults(d.fields.oidc) })}><Plus className="h-4 w-4" />{t('settings.auth.add')}</Button>} />
      <div className="space-y-3 border-b border-slate-200 p-4 text-sm dark:border-slate-800">
        <div className="label">{t('settings.auth.redirect')}</div>
        <div className="flex flex-wrap items-center gap-2"><code className="break-all rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">{d.redirectUri}</code><CopyButton text={d.redirectUri} /></div>
      </div>
      {d.items.length === 0 ? <EmptyState icon={<KeyRound className="h-8 w-8" />} title={t('settings.auth.empty')} body={t('settings.auth.emptyBody')} /> : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {d.items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><Badge tone="violet">{p.kind.toUpperCase()}</Badge></div>
              <Toggle checked={p.enabled} onChange={() => toggle.mutate(p)} label={p.enabled ? t('common.enabled') : t('common.disabled')} />
              <Button size="sm" aria-label={`${t('common.edit')} ${p.name}`} onClick={() => setDraft({ ...p, config: { ...defaults(d.fields[p.kind]), ...p.config } })}><Pencil className="h-3.5 w-3.5" />{t('common.edit')}</Button>
              <Button size="sm" variant="danger" aria-label={`${t('common.delete')} ${p.name}`} onClick={async () => { if (await confirm({ title: t('common.delete'), body: p.name, danger: true, confirmLabel: t('common.delete') })) remove.mutate(p.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!draft} onClose={() => setDraft(null)} wide title={draft?.id ? t('settings.auth.editTitle') : t('settings.auth.newTitle')}
        footer={<><Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} onClick={() => draft && save.mutate(draft)}>{t('common.save')}</Button></>}>
        {draft && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.auth.kind')}>{(id) => <Select id={id} value={draft.kind} disabled={!!draft.id} onChange={(e) => { const kind = e.target.value as Draft['kind']; setDraft({ ...draft, kind, config: defaults(d.fields[kind]) }); }}><option value="oidc">OpenID Connect</option><option value="ldap">LDAP</option><option value="saml">{t('settings.auth.saml.kind')}</option></Select>}</Field>
              <Field label={t('common.name')}>{(id) => <Input id={id} required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
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
            <FieldsForm fields={fields} value={draft.config} onChange={(config) => setDraft({ ...draft, config })} />
            <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('common.enabled')} />
          </form>
        )}
      </Modal>
    </Card>
  );
}

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


function BackupTab() {
  const t = useT();
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
  const [secrets, setSecrets] = useState(false);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('settings.backup.export')} subtitle={t('settings.backup.exportIntro')} />
        <div className="space-y-4 p-4">
          <Field label={t('settings.backup.format')}>{(id) => <Select id={id} value={format} onChange={(e) => setFormat(e.target.value as 'yaml' | 'json')}><option value="yaml">YAML</option><option value="json">JSON</option></Select>}</Field>
          <Toggle checked={secrets} onChange={setSecrets} label={t('settings.backup.secrets')} />
          {secrets && <div role="alert" className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('settings.backup.secretsWarn')}</div>}
          <Button variant="primary" onClick={() => download(`/api/config/export${qs({ format, secrets: secrets || undefined })}`)}><Download className="h-4 w-4" />{t('settings.backup.download')}</Button>
        </div>
      </Card>
      <ImportCard title={t('settings.backup.import')} intro={t('settings.backup.importIntro')} endpoint="/api/config/import" accept=".yaml,.yml,.json,application/json" />
      <KumaImport />
      <ImportCard title={t('settings.backup.kuma')} intro={t('settings.backup.kumaIntro')} endpoint="/api/import/kuma" accept=".json,application/json" />
      <Card>
        <CardHeader title={t('settings.backup.dbTitle')} subtitle={t('settings.backup.dbBody')} />
        <pre className="m-4 overflow-x-auto rounded-md bg-slate-100 p-3 text-xs dark:bg-slate-800">{'docker compose exec mariadb sh -c \'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines pulsewatch\' > pulsewatch.sql'}</pre>
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
