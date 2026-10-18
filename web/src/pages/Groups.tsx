import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, FolderTree, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useGroupsQ, useMonitorsQ, useTagsQ } from '../components/ops-shared';
import { Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, useConfirm, useToast } from '../components/ui';
import { ApiError, del, patch, post, type Group } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';

type GroupForm = { id?: number; name: string; parentId: number | null };
const HEX = /^#[0-9a-f]{6}$/i;

export default function Groups() {
  const t = useT();
  const { can } = useAuth();
  const editor = can('editor');
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const groups = useGroupsQ(); const tags = useTagsQ(); const monitors = useMonitorsQ();
  const [gf, setGf] = useState<GroupForm | null>(null);
  const [tf, setTf] = useState({ name: '', color: '#6366f1' });
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : t('common.failed'), 'error');
  const refreshG = () => { void qc.invalidateQueries({ queryKey: ['groups'] }); void qc.invalidateQueries({ queryKey: ['monitors'] }); };
  const refreshT = () => { void qc.invalidateQueries({ queryKey: ['tags'] }); void qc.invalidateQueries({ queryKey: ['monitors'] }); };

  const { children, counts } = useMemo(() => {
    const children = new Map<number | null, Group[]>();
    for (const g of groups.data ?? []) children.set(g.parentId, [...(children.get(g.parentId) ?? []), g]);
    const counts = new Map<number | null, number>();
    for (const m of monitors.data ?? []) counts.set(m.groupId, (counts.get(m.groupId) ?? 0) + 1);
    return { children, counts };
  }, [groups.data, monitors.data]);
  const tagUse = useMemo(() => { const c = new Map<number, number>(); for (const m of monitors.data ?? []) for (const x of m.tags) c.set(x.id, (c.get(x.id) ?? 0) + 1); return c; }, [monitors.data]);

  /** A group may not be moved below itself, so exclude it and its descendants from the parent picker. */
  const descendants = (id: number): Set<number> => { const out = new Set([id]); const walk = (p: number) => (children.get(p) ?? []).forEach((c) => { out.add(c.id); walk(c.id); }); walk(id); return out; };
  const flat = (parent: number | null, depth: number, skip?: Set<number>): { g: Group; depth: number }[] => (children.get(parent) ?? []).filter((g) => !skip?.has(g.id)).flatMap((g) => [{ g, depth }, ...flat(g.id, depth + 1, skip)]);

  const saveGroup = useMutation({
    mutationFn: (v: GroupForm) => v.id ? patch(`/api/groups/${v.id}`, { name: v.name.trim(), parentId: v.parentId }) : post('/api/groups', { name: v.name.trim(), parentId: v.parentId ?? undefined }),
    onSuccess: () => { refreshG(); setGf(null); toast(t('common.saved')); }, onError: fail,
  });
  const saveTag = useMutation({ mutationFn: () => post('/api/tags', { name: tf.name.trim(), color: tf.color }), onSuccess: () => { refreshT(); setTf({ ...tf, name: '' }); toast(t('common.saved')); }, onError: fail });
  const removeGroup = async (g: Group) => {
    if (!(await confirm({ title: t('common.delete'), body: t('groups.deleteConfirm', { name: g.name }), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await del(`/api/groups/${g.id}`); refreshG(); toast(t('common.deleted')); } catch (e) { fail(e); }
  };
  const removeTag = async (g: { id: number; name: string }) => {
    if (!(await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: g.name }), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await del(`/api/tags/${g.id}`); refreshT(); toast(t('common.deleted')); } catch (e) { fail(e); }
  };

  const Node = ({ g }: { g: Group }) => (
    <li>
      <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <FolderTree className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
        <span className="text-xs text-slate-500">{t('groups.monitorCount', { n: counts.get(g.id) ?? 0 })}</span>
        {editor && <span className="flex shrink-0">
          <Button size="sm" variant="ghost" aria-label={t('groups.addChild')} onClick={() => setGf({ name: '', parentId: g.id })}><FolderPlus className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setGf({ id: g.id, name: g.name, parentId: g.parentId })}><Pencil className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void removeGroup(g)}><Trash2 className="h-4 w-4" /></Button>
        </span>}
      </div>
      {(children.get(g.id)?.length ?? 0) > 0 && <ul className="ml-4 border-l border-slate-200 pl-2 dark:border-slate-700">{children.get(g.id)!.map((c) => <Node key={c.id} g={c} />)}</ul>}
    </li>
  );

  const parentOptions = gf ? flat(null, 0, gf.id ? descendants(gf.id) : undefined) : [];
  return (
    <>
      <PageHeader title={t('nav.groups')} subtitle={t('groups.subtitle')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('groups.groups')} actions={editor && <Button size="sm" variant="primary" onClick={() => setGf({ name: '', parentId: null })}><Plus className="h-4 w-4" />{t('groups.new')}</Button>} />
          {groups.isLoading ? <Loading /> : groups.error ? <div className="p-4"><ErrorBox error={groups.error} /></div> : !groups.data?.length ? <EmptyState icon={<FolderTree className="h-6 w-6" />} title={t('groups.empty')} body={t('groups.emptyBody')} /> : (
            <ul className="p-2">
              {(children.get(null) ?? []).map((g) => <Node key={g.id} g={g} />)}
              {(counts.get(null) ?? 0) > 0 && <li className="px-2 py-1.5 text-xs text-slate-500">{t('groups.ungrouped', { n: counts.get(null) ?? 0 })}</li>}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={t('groups.tags')} />
          {editor && (
            <form className="flex flex-wrap items-end gap-2 border-b border-slate-200 p-3 dark:border-slate-800" onSubmit={(e) => { e.preventDefault(); if (tf.name.trim() && HEX.test(tf.color)) saveTag.mutate(); }}>
              <Field label={t('common.name')} className="min-w-[10rem] flex-1">{(id) => <Input id={id} value={tf.name} maxLength={40} onChange={(e) => setTf({ ...tf, name: e.target.value })} />}</Field>
              <Field label={t('groups.color')}>{(id) => <input id={id} type="color" value={tf.color} onChange={(e) => setTf({ ...tf, color: e.target.value })} className="h-9 w-14 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700" />}</Field>
              <Button type="submit" variant="primary" loading={saveTag.isPending} disabled={!tf.name.trim()}><Plus className="h-4 w-4" />{t('common.add')}</Button>
            </form>
          )}
          {tags.isLoading ? <Loading /> : tags.error ? <div className="p-4"><ErrorBox error={tags.error} /></div> : !tags.data?.length ? <EmptyState icon={<Tags className="h-6 w-6" />} title={t('groups.noTags')} body={t('groups.noTagsBody')} /> : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {tags.data.map((g) => (
                <li key={g.id} className="flex items-center gap-3 px-4 py-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: g.color }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
                  <span className="text-xs text-slate-500">{t('groups.monitorCount', { n: tagUse.get(g.id) ?? 0 })}</span>
                  {editor && <>
                    <input type="color" aria-label={`${t('groups.color')}: ${g.name}`} value={g.color} onChange={(e) => post('/api/tags', { name: g.name, color: e.target.value }).then(refreshT, fail)} className="h-7 w-9 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700" />
                    <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void removeTag(g)}><Trash2 className="h-4 w-4" /></Button>
                  </>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {gf && (
        <Modal open onClose={() => setGf(null)} title={gf.id ? t('groups.edit') : t('groups.new')} footer={<><Button onClick={() => setGf(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={saveGroup.isPending} disabled={!gf.name.trim()} onClick={() => saveGroup.mutate(gf)}>{t('common.save')}</Button></>}>
          <div className="space-y-4">
            <Field label={t('common.name')}>{(id) => <Input id={id} value={gf.name} maxLength={120} onChange={(e) => setGf({ ...gf, name: e.target.value })} />}</Field>
            <Field label={t('groups.parent')}>{(id) => (
              <Select id={id} value={gf.parentId ?? ''} onChange={(e) => setGf({ ...gf, parentId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t('groups.root')}</option>
                {parentOptions.map(({ g, depth }) => <option key={g.id} value={g.id}>{'  '.repeat(depth)}{g.name}</option>)}
              </Select>
            )}</Field>
          </div>
        </Modal>
      )}
    </>
  );
}
