import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { del, errorMessage, get, post } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Textarea, useConfirm, useToast } from './ui';

interface Ca { id: number; name: string; subject: string; issuer: string; fingerprint256: string; validTo: string; expired: boolean }
interface ImportResult { added: number; skipped: string[]; warnings: string[] }

/** Settings > Certificates: CA certificates trusted by every TLS check. */
export function CertsTab() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ca-certs'], queryFn: () => get<Ca[]>('/api/ca-certs') });
  const [pem, setPem] = useState(''); const [name, setName] = useState(''); const [notes, setNotes] = useState<ImportResult | null>(null);
  const add = useMutation({
    mutationFn: () => post<ImportResult>('/api/ca-certs', { pem, name: name || undefined }),
    onSuccess: (r) => { toast(t('certs.added', { n: r.added })); setNotes(r.skipped.length || r.warnings.length ? r : null); if (r.added) { setPem(''); setName(''); } qc.invalidateQueries({ queryKey: ['ca-certs'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/api/ca-certs/${id}`), onSuccess: () => { toast(t('common.deleted')); qc.invalidateQueries({ queryKey: ['ca-certs'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const readFile = async (f?: File) => { if (!f) return; try { setPem(await f.text()); } catch { toast(t('certs.readFailed'), 'error'); } };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('certs.title')} subtitle={t('certs.intro')} />
        <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label={t('certs.pem')} hint={t('certs.pemHelp')}>{(id) => <Textarea id={id} rows={6} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" spellCheck={false} className="font-mono text-xs" />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('certs.file')}>{(id) => <input id={id} type="file" accept=".pem,.crt,.cer,.txt" onChange={(e) => void readFile(e.target.files?.[0])} className="input" />}</Field>
            <Field label={t('certs.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />}</Field>
          </div>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!pem.trim()}><Plus className="h-4 w-4" aria-hidden />{t('certs.import')}</Button>
          {notes && (
            <div role="status" className="space-y-1 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {notes.skipped.length > 0 && <p><strong>{t('certs.skipped')}:</strong> {notes.skipped.join('; ')}</p>}
              {notes.warnings.length > 0 && <p><strong>{t('certs.warnings')}:</strong> {notes.warnings.join('; ')}</p>}
            </div>
          )}
        </form>
      </Card>
      <Card>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? <EmptyState title={t('certs.empty')} body={t('certs.emptyHint')} /> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>{t('certs.subject')}</th><th>{t('certs.issuer')}</th><th>{t('certs.validUntil')}</th><th>{t('certs.fingerprint')}</th><th /></tr></thead>
            <tbody>{q.data.map((c) => (
              <tr key={c.id}>
                <td className="break-all"><div className="font-medium">{c.name}</div><div className="text-xs text-slate-500">{c.subject}</div></td>
                <td className="break-all text-xs">{c.issuer}</td>
                <td className="whitespace-nowrap">{fmtDate(c.validTo)} {c.expired && <Badge tone="red">{t('certs.expired')}</Badge>}</td>
                <td className="break-all font-mono text-xs">{c.fingerprint256}</td>
                <td><Button variant="ghost" aria-label={t('common.delete')} onClick={async () => { if (await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: c.name }), danger: true, confirmLabel: t('common.delete') })) remove.mutate(c.id); }}><Trash2 className="h-4 w-4" aria-hidden /></Button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
