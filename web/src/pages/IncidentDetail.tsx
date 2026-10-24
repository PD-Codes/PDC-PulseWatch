import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, FileText, Globe, Lock, MessageSquare, Pencil, PlayCircle, Search, UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IncidentStatusBadge, INCIDENT_STATUSES, SeverityBadge } from '../components/ops-shared';
import { NO_VERSIONS, Translations, type Versions } from '../components/Translations';
import { Badge, Button, Card, CardHeader, Dl, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea, Toggle, useConfirm, useToast } from '../components/ui';
import { ApiError, del, errorMessage, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtDuration, relTime } from '../lib/format';
import { useT } from '../lib/i18n';

interface Detail {
  id: number; title: string; titleEn: string | null; titleDe: string | null; status: string; severity: string; source: string; startedAt: string; acknowledgedAt: string | null; acknowledgedBy: string | null; resolvedAt: string | null;
  assignee: { id: number; name: string } | null; public: boolean; postmortem: string | null; monitors: { id: number; name: string }[];
  updates: Update[];
}
interface Update { id: number; ts: string; kind: string; status: string | null; body: string | null; bodyEn: string | null; bodyDe: string | null; author: string | null; public: boolean; editedAt: string | null; editable: boolean }
/** Entries that can appear on a status page; the rest is the system's record. */
const PUBLISHABLE = new Set(['note', 'status', 'resolve', 'postmortem']);
const KIND_ICON: Record<string, React.ReactNode> = {
  note: <MessageSquare className="h-4 w-4" />, ack: <Eye className="h-4 w-4" />, resolve: <CheckCircle2 className="h-4 w-4 text-emerald-600" />, assign: <UserCheck className="h-4 w-4" />,
  postmortem: <FileText className="h-4 w-4" />, auto: <PlayCircle className="h-4 w-4 text-red-600" />, status: <PlayCircle className="h-4 w-4" />,
};

/** One timeline entry: its text, whether it is on the status page, and (for people's entries) an inline editor for both. */
function Entry({ u, incidentId, canEdit }: { u: Update; incidentId: number; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(u.body ?? '');
  const [ver, setVer] = useState<Versions>({ en: u.bodyEn ?? '', de: u.bodyDe ?? '' });
  const [shown, setShown] = useState(u.public);
  const save = useMutation({
    mutationFn: () => patch(`/api/incidents/${incidentId}/updates/${u.id}`, { ...(text.trim() && text.trim() !== (u.body ?? '') ? { body: text } : {}), ...(ver.en.trim() !== (u.bodyEn ?? '') ? { bodyEn: ver.en } : {}), ...(ver.de.trim() !== (u.bodyDe ?? '') ? { bodyDe: ver.de } : {}), ...(shown !== u.public ? { public: shown } : {}) }),
    onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ['incidents'] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error'),
  });
  const open = () => { setText(u.body ?? ''); setVer({ en: u.bodyEn ?? '', de: u.bodyDe ?? '' }); setShown(u.public); setEditing(true); };
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 text-slate-500" aria-hidden>{KIND_ICON[u.kind] ?? KIND_ICON.status}</span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-2">
            <Textarea aria-label={t('incidents.entry.edit')} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={10000} className="font-sans" autoFocus />
            <Translations multiline value={ver} onChange={setVer} max={10000} />
            <Toggle checked={shown} onChange={setShown} label={t('incidents.showOnPage')} />
            <div className="flex gap-2"><Button size="sm" variant="primary" loading={save.isPending} disabled={!text.trim()} onClick={() => save.mutate()}>{t('common.save')}</Button><Button size="sm" onClick={() => setEditing(false)}>{t('common.cancel')}</Button></div>
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm">{u.status && u.kind !== 'note' && <span className="mr-2 align-middle"><IncidentStatusBadge status={u.status} /></span>}{u.body}</div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <span>{u.author ?? t('incidents.system')} · <time dateTime={u.ts} title={fmtDateTime(u.ts)}>{relTime(u.ts)}</time></span>
          {u.editedAt && <span title={fmtDateTime(u.editedAt)}>· {t('incidents.entry.edited')}</span>}
          {PUBLISHABLE.has(u.kind) && (u.public ? <Badge tone="blue"><Globe className="h-3 w-3" aria-hidden />{t('incidents.onPage')}</Badge> : <Badge tone="gray"><Lock className="h-3 w-3" aria-hidden />{t('incidents.entry.internal')}</Badge>)}
          {canEdit && u.editable && !editing && <button type="button" className="inline-flex items-center gap-1 underline" onClick={open}><Pencil className="h-3 w-3" aria-hidden />{t('incidents.entry.edit')}</button>}
        </div>
      </div>
    </li>
  );
}

export default function IncidentDetail() {
  const t = useT();
  const id = Number(useParams().id);
  const { can, user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const editor = can('editor');
  const key = ['incidents', id];
  const q = useQuery({ queryKey: key, queryFn: () => get<Detail>(`/api/incidents/${id}`) });
  const users = useQuery({ queryKey: ['users-directory'], queryFn: () => get<{ id: number; displayName: string }[]>('/api/users/directory'), staleTime: 60_000 });
  const [note, setNote] = useState('');
  const [noteV, setNoteV] = useState<Versions>(NO_VERSIONS);
  const [ti, setTi] = useState({ title: '', v: NO_VERSIONS as Versions }); // title and its versions, as edited under "Wording on the status page"
  const [next, setNext] = useState<string | null>(null); // status chosen for the next update, null = unchanged
  const [onPage, setOnPage] = useState(false); // a message without a status change stays internal unless the author marks it for the status page
  const [pm, setPm] = useState('');
  useEffect(() => { if (q.data) setPm(q.data.postmortem ?? ''); }, [q.data?.postmortem]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (q.data) setTi({ title: q.data.title, v: { en: q.data.titleEn ?? '', de: q.data.titleDe ?? '' } }); }, [q.data?.title, q.data?.titleEn, q.data?.titleDe]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['incidents'] }),
    onError: (e) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error'),
  });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return q.error instanceof ApiError && q.error.status === 404 ? <EmptyState title={t('incidents.notFound')} action={<Link className="btn" to="/incidents">{t('common.back')}</Link>} /> : <ErrorBox error={q.error} />;
  const i = q.data;
  const base = new Date(i.startedAt).getTime();
  const mtta = i.acknowledgedAt ? (new Date(i.acknowledgedAt).getTime() - base) / 1000 : null;
  const mttr = i.resolvedAt ? (new Date(i.resolvedAt).getTime() - base) / 1000 : null;
  const upd = (body: Record<string, unknown>) => run.mutate(() => patch(`/api/incidents/${id}`, body));

  return (
    <>
      <PageHeader title={i.title} subtitle={<span className="inline-flex flex-wrap items-center gap-2"><IncidentStatusBadge status={i.status} /><SeverityBadge severity={i.severity} />{t('incidents.startedAgo', { when: relTime(i.startedAt) })}</span>}
        actions={<>
          <Link className="btn" to={`/insights?tab=changes&incidentId=${id}`}><Search className="h-4 w-4" />{t('incidents.whatChanged')}</Link>
          {editor && i.status === 'open' && <Button onClick={() => run.mutate(() => post(`/api/incidents/${id}/ack`))} loading={run.isPending}><Eye className="h-4 w-4" />{t('incidents.ack')}</Button>}
          {editor && i.status !== 'resolved' && <Button variant="primary" onClick={() => run.mutate(() => post(`/api/incidents/${id}/resolve`))} loading={run.isPending}><CheckCircle2 className="h-4 w-4" />{t('incidents.resolve')}</Button>}
        </>} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title={t('incidents.timeline')} />
            <ol className="space-y-3 p-4">
              {i.updates.map((u) => <Entry key={u.id} u={u} incidentId={id} canEdit={editor} />)}
            </ol>
            {editor && (
              <form className="space-y-3 border-t border-slate-200 p-4 dark:border-slate-800" onSubmit={(e) => {
                e.preventDefault();
                const status = next ?? i.status;
                if (!note.trim() && status === i.status) return;
                run.mutate(async () => {
                  if (note.trim()) await post(`/api/incidents/${id}/notes`, { body: note, bodyEn: noteV.en, bodyDe: noteV.de, ...(status !== i.status ? { status } : { public: onPage }) });
                  else await post(`/api/incidents/${id}/status`, { status });
                  setNote(''); setNoteV(NO_VERSIONS); setNext(null); setOnPage(false);
                });
              }}>
                <h3 className="label">{t('incidents.postUpdate')}</h3>
                <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
                  <Field label={t('common.status')}>{(fid) => <Select id={fid} value={next ?? i.status} onChange={(e) => setNext(e.target.value)}>{INCIDENT_STATUSES.map((s) => <option key={s} value={s}>{t(`incidents.status.${s}`)}</option>)}</Select>}</Field>
                  <Field label={t('incidents.addNote')} hint={i.public && (next ?? i.status) !== i.status ? t('incidents.updatePublic') : undefined}>{(fid) => <Textarea id={fid} value={note} onChange={(e) => setNote(e.target.value)} className="font-sans" maxLength={10000} rows={3} />}</Field>
                </div>
                {note.trim() && <Translations multiline value={noteV} onChange={setNoteV} max={10000} />}
                {i.public && (next ?? i.status) === i.status && <Toggle checked={onPage} onChange={setOnPage} label={t('incidents.showOnPage')} />}
                {(next ?? i.status) === 'monitoring' && i.source === 'auto' && <p className="hint">{t('incidents.monitoringHint')}</p>}
                <Button type="submit" variant="primary" disabled={!note.trim() && (next ?? i.status) === i.status} loading={run.isPending}>{t('incidents.postNote')}</Button>
              </form>
            )}
          </Card>

          <Card>
            <CardHeader title={t('incidents.postmortem')} actions={editor && <Button size="sm" variant="primary" disabled={pm === (i.postmortem ?? '')} onClick={() => upd({ postmortem: pm || null })}>{t('common.save')}</Button>} />
            <div className="p-4">
              {editor ? <><Textarea aria-label={t('incidents.postmortem')} value={pm} onChange={(e) => setPm(e.target.value)} rows={8} className="font-sans" maxLength={50000} placeholder={t('incidents.postmortemHint')} />{i.public && <p className="hint">{t('incidents.postmortemPublic')}</p>}</>
                : i.postmortem ? <div className="whitespace-pre-wrap text-sm">{i.postmortem}</div> : <p className="text-sm text-slate-500">{t('incidents.noPostmortem')}</p>}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title={t('common.details')} />
            <div className="space-y-4 p-4">
              <Dl items={[
                [t('incidents.started'), fmtDateTime(i.startedAt)],
                [t('incidents.acknowledged'), i.acknowledgedAt ? `${fmtDateTime(i.acknowledgedAt)}${i.acknowledgedBy ? ` (${i.acknowledgedBy})` : ''}` : '–'],
                [t('incidents.resolved'), fmtDateTime(i.resolvedAt)],
                ['MTTA', fmtDuration(mtta)], ['MTTR', fmtDuration(mttr)],
                [t('incidents.source'), t(i.source === 'auto' ? 'incidents.auto' : 'incidents.manual')],
              ]} />
              <div>
                <label htmlFor="inc-sev" className="label">{t('incidents.field.severity')}</label>
                <Select id="inc-sev" disabled={!editor} value={i.severity} onChange={(e) => upd({ severity: e.target.value })}>{['minor', 'major', 'critical'].map((s) => <option key={s} value={s}>{t(`incidents.severity.${s}`)}</option>)}</Select>
              </div>
              <div>
                <label htmlFor="inc-asg" className="label">{t('incidents.assignee')}</label>
                <Select id="inc-asg" disabled={!editor} value={i.assignee?.id ?? ''} onChange={(e) => upd({ assigneeId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t('incidents.unassigned')}</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.id === user?.id ? ` (${t('incidents.you')})` : ''}</option>)}
                </Select>
                {editor && !i.assignee && user && <button type="button" className="mt-1 text-xs underline" onClick={() => upd({ assigneeId: user.id })}>{t('incidents.assignMe')}</button>}
              </div>
              <div><Toggle disabled={!editor} checked={i.public} onChange={(v) => upd({ public: v })} label={t('incidents.field.public')} /><p className="hint">{t(i.public ? 'incidents.publicOn' : 'incidents.publicOff')}</p></div>
            </div>
          </Card>
          {editor && (
            <Card>
              <CardHeader title={t('incidents.wording')} actions={<Button size="sm" variant="primary" disabled={!ti.title.trim() || (ti.title.trim() === i.title && ti.v.en.trim() === (i.titleEn ?? '') && ti.v.de.trim() === (i.titleDe ?? ''))} onClick={() => upd({ title: ti.title.trim(), titleEn: ti.v.en.trim() || null, titleDe: ti.v.de.trim() || null })}>{t('common.save')}</Button>} />
              <div className="space-y-3 p-4">
                <Field label={t('incidents.field.title')} hint={t('incidents.wordingHint')}>{(fid) => <Input id={fid} value={ti.title} maxLength={255} onChange={(e) => setTi({ ...ti, title: e.target.value })} />}</Field>
                <Translations value={ti.v} onChange={(v) => setTi({ ...ti, v })} max={255} />
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title={t('incidents.affected')} />
            <ul className="space-y-1 p-4 text-sm">{i.monitors.length ? i.monitors.map((m) => <li key={m.id}><Link to={`/monitors/${m.id}`}>{m.name}</Link></li>) : <li className="text-slate-500">{t('incidents.noMonitors')}</li>}</ul>
          </Card>
          {user?.role === 'admin' && <Button variant="danger" className="w-full" onClick={async () => { if (await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: i.title }), danger: true, confirmLabel: t('common.delete') })) { try { await del(`/api/incidents/${id}`); void qc.invalidateQueries({ queryKey: ['incidents'] }); nav('/incidents'); } catch (e) { toast(errorMessage(e), 'error'); } } }}>{t('common.delete')}</Button>}
        </div>
      </div>
    </>
  );
}
