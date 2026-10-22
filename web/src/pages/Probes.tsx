import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, KeyRound, Pencil, Plus, Radio, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CopyButton } from '../components/settingsParts';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Toggle, useConfirm, useToast } from '../components/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { useT } from '../lib/i18n';
import { relTime } from '../lib/format';

interface Probe { id: number; name: string; location: string | null; version: string | null; lastSeenAt: string | null; lastIp: string | null; enabled: boolean; createdAt: string; online: boolean; monitorCount: number }
const IMAGE = 'pulsewatch-probe:latest'; // image name is a placeholder until the probe image is published

/** Plain-language introduction: open while there are no probes, folded away afterwards. */
function Explainer({ open }: { open: boolean }) {
  const t = useT();
  const steps = [1, 2, 3] as const;
  return (
    <Card className="mb-4">
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3">
          <span><span className="block text-sm font-semibold">{t('probes.guide.title')}</span><span className="block text-xs text-slate-500">{t('probes.guide.intro')}</span></span>
          <span className="text-xs text-slate-500 group-open:hidden">▾</span><span className="hidden text-xs text-slate-500 group-open:inline">▴</span>
        </summary>
        <div className="space-y-4 border-t border-slate-200 p-4 dark:border-slate-800">
          <ol className="grid gap-4 md:grid-cols-3">
            {steps.map((n) => (
              <li key={n} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white" aria-hidden>{n}</span>
                <div><div className="text-sm font-semibold">{t(`probes.guide.s${n}.title`)}</div><p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{t(`probes.guide.s${n}.body`)}</p></div>
              </li>
            ))}
          </ol>
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800/50 dark:text-slate-300"><strong className="font-semibold">{t('probes.quorumTitle')}.</strong> {t('probes.quorum')}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {(['know', 'off'] as const).map((k) => (
              <div key={k}>
                <h3 className="text-sm font-semibold">{t(`probes.guide.${k}.title`)}</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">{[1, 2, 3, 4].map((i) => <li key={i}>{t(`probes.guide.${k}.${i}`)}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </details>
    </Card>
  );
}

function Snippets({ token, url }: { token: string; url: string }) {
  const t = useT();
  const run = `docker run -d --name pulsewatch-probe --restart unless-stopped \\\n  -e PW_SERVER_URL=${url} \\\n  -e PW_PROBE_TOKEN=${token} \\\n  ${IMAGE}`;
  const compose = `services:\n  probe:\n    image: ${IMAGE}\n    restart: unless-stopped\n    environment:\n      PW_SERVER_URL: ${url}\n      PW_PROBE_TOKEN: ${token}`;
  return (
    <div className="space-y-3">
      {[['docker run', run], ['docker compose', compose]].map(([label, text]) => (
        <div key={label}>
          <div className="mb-1 flex items-center justify-between"><span className="label mb-0">{label}</span><CopyButton text={text} /></div>
          <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100" tabIndex={0}>{text}</pre>
        </div>
      ))}
      <p className="hint">{t('probes.httpsNote')}</p>
    </div>
  );
}

export default function Probes() {
  const t = useT();
  const { can, user } = useAuth();
  const admin = user?.role === 'admin' && can('admin');
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['probes'], queryFn: () => get<Probe[]>('/api/probes'), refetchInterval: 30_000 });
  const [form, setForm] = useState<{ id?: number; name: string; location: string } | null>(null);
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(null);
  const [guide, setGuide] = useState(false);
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['probes'] });

  const save = useMutation({
    mutationFn: async (v: NonNullable<typeof form>) => {
      if (v.id) { await patch(`/api/probes/${v.id}`, { name: v.name.trim(), location: v.location.trim() || null }); return null; }
      return post<{ id: number; token: string }>('/api/probes', { name: v.name.trim(), location: v.location.trim() || undefined });
    },
    onSuccess: (r, v) => { refresh(); setForm(null); if (r) setSecret({ name: v.name, token: r.token }); else toast(t('common.saved')); },
    onError: fail,
  });
  const toggle = useMutation({ mutationFn: (p: Probe) => patch(`/api/probes/${p.id}`, { enabled: !p.enabled }), onSuccess: refresh, onError: fail });
  const rotate = async (p: Probe) => {
    if (!(await confirm({ title: t('probes.rotate'), body: t('probes.rotateConfirm', { name: p.name }), danger: true, confirmLabel: t('probes.rotate') }))) return;
    try { const r = await post<{ token: string }>(`/api/probes/${p.id}/rotate`); setSecret({ name: p.name, token: r.token }); } catch (e) { fail(e); }
  };
  const remove = async (p: Probe) => {
    if (!(await confirm({ title: t('common.delete'), body: <><p>{t('common.deleteConfirm', { name: p.name })}</p>{p.monitorCount > 0 && <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{t('probes.deleteUsed', { n: p.monitorCount })}</p>}</>, danger: true, confirmLabel: t('common.delete') }))) return;
    try { await del(`/api/probes/${p.id}`); refresh(); toast(t('common.deleted')); } catch (e) { fail(e); }
  };

  return (
    <>
      <PageHeader title={t('nav.probes')} subtitle={t('probes.subtitle')} actions={admin && <><Button onClick={() => setGuide(true)}><BookOpen className="h-4 w-4" />{t('probes.guide.setup')}</Button><Button variant="primary" onClick={() => setForm({ name: '', location: '' })}><Plus className="h-4 w-4" />{t('probes.new')}</Button></>} />
      <Explainer open={!q.isLoading && !q.data?.length} />
      <Card>
        {q.isLoading ? <Loading /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !q.data?.length ? (
          <EmptyState icon={<Radio className="h-6 w-6" />} title={t('probes.empty')} body={t('probes.emptyBody')} />
        ) : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>{t('common.name')}</th><th title={t('probes.statusHelp')}>{t('common.status')}</th><th className="hidden sm:table-cell">{t('probes.location')}</th><th className="hidden md:table-cell">{t('probes.usedBy')}</th><th className="hidden md:table-cell">{t('probes.version')}</th><th>{t('probes.lastSeen')}</th>{admin && <th><span className="sr-only">{t('common.actions')}</span></th>}</tr></thead>
            <tbody>{q.data.map((p) => (
              <tr key={p.id}>
                <td className="font-medium">{p.name}</td>
                <td>{!p.enabled ? <Badge tone="gray">{t('common.disabled')}</Badge> : <Badge tone={p.online ? 'green' : 'red'}>{t(p.online ? 'probes.online' : 'probes.offline')}</Badge>}</td>
                <td className="hidden sm:table-cell">{p.location ?? '–'}</td>
                <td className="hidden md:table-cell">{p.monitorCount === 0 ? <span className="text-slate-400">–</span> : p.monitorCount === 1 ? t('probes.usedBy1') : t('probes.usedByN', { n: p.monitorCount })}</td>
                <td className="hidden md:table-cell">{p.version ?? '–'}</td>
                <td className="whitespace-nowrap" title={p.lastIp ?? undefined}>{p.lastSeenAt ? relTime(p.lastSeenAt) : t('common.never')}</td>
                {admin && <td className="whitespace-nowrap text-right">
                  <Toggle checked={p.enabled} onChange={() => toggle.mutate(p)} label={<span className="sr-only">{t('common.enabled')}</span>} />
                  <Button size="sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setForm({ id: p.id, name: p.name, location: p.location ?? '' })}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={t('probes.rotate')} onClick={() => void rotate(p)}><KeyRound className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove(p)}><Trash2 className="h-4 w-4" /></Button>
                </td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? t('probes.edit') : t('probes.new')} footer={<><Button onClick={() => setForm(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} disabled={!form.name.trim()} onClick={() => save.mutate(form)}>{t('common.save')}</Button></>}>
          <div className="space-y-4">
            <Field label={t('common.name')}>{(id) => <Input id={id} value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label={t('probes.location')} hint={t('probes.locationHint')}>{(id) => <Input id={id} value={form.location} maxLength={80} placeholder="Frankfurt, DE" onChange={(e) => setForm({ ...form, location: e.target.value })} />}</Field>
          </div>
        </Modal>
      )}

      {guide && (
        <Modal open onClose={() => setGuide(false)} title={t('probes.guide.setupTitle')} wide footer={<Button variant="primary" onClick={() => setGuide(false)}>{t('common.close')}</Button>}>
          <div className="space-y-4"><p className="text-sm text-slate-600 dark:text-slate-300">{t('probes.guide.setupBody')}</p><Snippets token="pwp_YOUR_TOKEN" url={meta?.baseUrl ?? 'https://pulsewatch.example.com'} /></div>
        </Modal>
      )}

      {secret && (
        <Modal open onClose={() => setSecret(null)} title={t('probes.tokenTitle', { name: secret.name })} wide footer={<Button variant="primary" onClick={() => setSecret(null)}>{t('common.close')}</Button>}>
          <div className="space-y-4">
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="alert">{t('probes.tokenOnce')}</p>
            <div><div className="mb-1 flex items-center justify-between"><span className="label mb-0">{t('probes.token')}</span><CopyButton text={secret.token} /></div><code className="block break-all rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-800">{secret.token}</code></div>
            <Snippets token={secret.token} url={meta?.baseUrl ?? 'https://pulsewatch.example.com'} />
          </div>
        </Modal>
      )}
    </>
  );
}
