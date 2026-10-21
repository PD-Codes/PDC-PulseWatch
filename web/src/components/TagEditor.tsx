import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, post, type Tag, type TagInfo } from '../lib/api';
import { useT } from '../lib/i18n';
import { Button, Input, Modal, Select, useToast } from './ui';

/** One row of the name + value tag editor; empty rows are dropped on save. */
export interface TagValueRow { tagId: number | null; value: string }

const NEW = '__new__';

/** "name" for a plain tag, "name: value" for a tag with a value. */
export const tagText = (t: { name: string; value?: string }) => (t.value ? `${t.name}: ${t.value}` : t.name);

/** Rows to send to the API: complete rows only. */
export const toTagValues = (rows: TagValueRow[]) => rows.filter((r) => r.tagId && r.value.trim()).map((r) => ({ tagId: r.tagId!, value: r.value.trim() }));

/** Editor for tags with a name and a value. Both fields are dropdowns that end with "Add new...", which opens a small dialog. */
export function TagValueEditor({ tags, rows, onChange }: { tags: TagInfo[]; rows: TagValueRow[]; onChange: (rows: TagValueRow[]) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  // values typed into "Add new..." that no monitor uses yet, so the dropdown keeps offering them
  const [extra, setExtra] = useState<Record<number, string[]>>({});
  const [dlg, setDlg] = useState<{ kind: 'tag' | 'value'; row: number } | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [text, setText] = useState('');

  const options = (tagId: number | null, current: string) => {
    const used = tags.find((x) => x.id === tagId)?.values.map((v) => v.value) ?? [];
    return [...new Set([...used, ...(tagId ? extra[tagId] ?? [] : []), ...(current ? [current] : [])])].sort((a, b) => a.localeCompare(b));
  };
  const patch = (i: number, p: Partial<TagValueRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const open = (kind: 'tag' | 'value', row: number) => { setName(''); setText(''); setColor('#6366f1'); setDlg({ kind, row }); };

  const createTag = useMutation({
    mutationFn: () => post<Tag>('/api/tags', { name: name.trim(), color }),
    onSuccess: async (tg) => {
      await qc.invalidateQueries({ queryKey: ['tags'] });
      // a different tag has other known values, so the old value no longer fits
      if (dlg) patch(dlg.row, { tagId: tg.id, value: '' });
      setDlg(null);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const addValue = () => {
    const v = text.trim();
    const row = dlg && rows[dlg.row];
    if (!v || !row?.tagId) return;
    setExtra((x) => ({ ...x, [row.tagId!]: [...(x[row.tagId!] ?? []), v] }));
    patch(dlg!.row, { value: v });
    setDlg(null);
  };

  const submit = () => (dlg?.kind === 'tag' ? name.trim() && createTag.mutate() : addValue());

  return (
    <fieldset>
      <legend className="label">{t('tags.extended')}</legend>
      <p className="mb-2 text-xs text-slate-500">{t('tags.extendedHint')}</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2" data-testid="tag-value-row">
            <Select className="w-44 py-1 text-sm" aria-label={t('tags.name')} value={r.tagId ?? ''} onChange={(e) => { if (e.target.value === NEW) open('tag', i); else patch(i, { tagId: e.target.value ? Number(e.target.value) : null, value: '' }); }}>
              <option value="">{t('tags.pickName')}</option>
              {tags.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              <option value={NEW}>{t('tags.addNew')}</option>
            </Select>
            <Select className="w-44 py-1 text-sm" aria-label={t('tags.value')} disabled={!r.tagId} value={r.value} onChange={(e) => { if (e.target.value === NEW) open('value', i); else patch(i, { value: e.target.value }); }}>
              <option value="">{t('tags.pickValue')}</option>
              {options(r.tagId, r.value).map((v) => <option key={v} value={v}>{v}</option>)}
              <option value={NEW}>{t('tags.addNew')}</option>
            </Select>
            <Button size="sm" variant="ghost" aria-label={t('common.remove')} onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button size="sm" onClick={() => onChange([...rows, { tagId: null, value: '' }])}><Plus className="h-4 w-4" />{t('tags.addRow')}</Button>
      </div>

      <Modal open={!!dlg} onClose={() => setDlg(null)} title={dlg?.kind === 'tag' ? t('tags.newTag') : t('tags.newValue')}
        footer={<><Button onClick={() => setDlg(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={createTag.isPending} disabled={dlg?.kind === 'tag' ? !name.trim() : !text.trim()} onClick={submit}>{t('common.add')}</Button></>}>
        {dlg?.kind === 'tag' ? (
          <div className="space-y-3">
            <label className="block text-sm">{t('tags.name')}<Input className="mt-1" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} /></label>
            <label className="block text-sm">{t('tags.color')}<input type="color" className="ml-2 h-8 w-12 cursor-pointer rounded border border-slate-300 align-middle dark:border-slate-700" value={color} onChange={(e) => setColor(e.target.value)} /></label>
          </div>
        ) : (
          <label className="block text-sm">{t('tags.value')}<Input className="mt-1" maxLength={255} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} /></label>
        )}
      </Modal>
    </fieldset>
  );
}
