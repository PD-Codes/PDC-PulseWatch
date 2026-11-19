import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react';
import { Fragment, useState } from 'react';
import { KeysetPager } from '../components/KeysetPager';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Loading, PageHeader } from '../components/ui';
import { get, qs } from '../lib/api';
import { fmtDateTime, relTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { useKeysetPages } from '../lib/keysetPages';

interface Entry { id: number; ts: string; actor: string; userId: number | null; action: string; entityType: string | null; entityId: string | null; ip: string | null; details: string | null }

const pretty = (d: string | null) => { if (!d) return ''; try { return JSON.stringify(JSON.parse(d), null, 2); } catch { return d; } };
const tone = (a: string) => (a.includes('failed') || a.includes('deleted') ? 'red' : a.startsWith('login') ? 'blue' : 'gray');

export default function Audit() {
  const t = useT();
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [applied, setApplied] = useState({ action: '', actor: '' });
  const [open, setOpen] = useState<Set<number>>(new Set());

  const q = useKeysetPages<Entry>({
    queryKey: ['audit', applied], sizeKey: 'audit', resetKey: applied,
    fetchPage: (before, limit, signal) => get<Entry[]>(`/api/audit${qs({ limit, before, action: applied.action.trim(), actor: applied.actor.trim() })}`, { signal }),
  });
  const rows = q.rows;
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });

  return (
    <>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setApplied({ action, actor }); setOpen(new Set()); }}>
        <div className="min-w-[10rem] flex-1 sm:max-w-xs"><label className="label" htmlFor="au-action">{t('audit.action')}</label><Input id="au-action" value={action} onChange={(e) => setAction(e.target.value)} placeholder="login, user., monitor." /></div>
        <div className="min-w-[10rem] flex-1 sm:max-w-xs"><label className="label" htmlFor="au-actor">{t('audit.actor')}</label><Input id="au-actor" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="admin" /></div>
        <Button type="submit" variant="primary">{t('common.apply')}</Button>
        {(applied.action || applied.actor) && <Button onClick={() => { setAction(''); setActor(''); setApplied({ action: '', actor: '' }); }}>{t('common.reset')}</Button>}
      </form>
      <Card>
        {q.isLoading ? <Loading /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : rows.length === 0 ? <EmptyState icon={<ScrollText className="h-6 w-6" />} title={t('audit.empty')} /> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th className="w-8"><span className="sr-only">{t('common.details')}</span></th><th>{t('audit.time')}</th><th>{t('audit.actor')}</th><th>{t('audit.action')}</th><th>{t('audit.entity')}</th><th>IP</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td>{r.details && <button type="button" className="btn btn-ghost btn-sm !p-1" aria-expanded={open.has(r.id)} aria-label={t('common.details')} onClick={() => toggle(r.id)}>{open.has(r.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>}</td>
                      <td className="whitespace-nowrap"><span title={fmtDateTime(r.ts)}>{relTime(r.ts)}</span><div className="text-xs text-slate-400">{fmtDateTime(r.ts)}</div></td>
                      <td>{r.actor}</td>
                      <td><Badge tone={tone(r.action)}>{r.action}</Badge></td>
                      <td className="text-slate-500">{r.entityType ? `${r.entityType}${r.entityId ? ` #${r.entityId}` : ''}` : '–'}</td>
                      <td className="font-mono text-xs text-slate-500">{r.ip ?? '–'}</td>
                    </tr>
                    {open.has(r.id) && <tr><td /><td colSpan={5}><pre className="max-h-64 overflow-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-800">{pretty(r.details)}</pre></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <KeysetPager {...q.pager} />
      </Card>
    </>
  );
}
