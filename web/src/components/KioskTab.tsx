import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { KIOSK_DEFAULTS, kioskConfigDiff, NAME_MAX, SLUG_MAX, SLUG_RE, type KioskConfig } from '../../../src/core/kiosk';
import { ApiError, del, errorMessage, get, patch, post, put, type KioskKey, type KioskPreset, type KioskPresetList } from '../lib/api';
import { fmtDateTime, relTime, slugify } from '../lib/format';
import { useT } from '../lib/i18n';
import { usePagedList } from '../lib/usePagedList';
import { KioskConfigFields, presetLabel } from './KioskConfigFields';
import { CancelButton, FormAlert, useGroupsQ, useMonitorsQ, useTagsQ } from './ops-shared';
import { Pager } from './Pager';
import { CopyButton } from './settingsParts';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Modal, Select, useConfirm, useToast } from './ui';

const PRESETS_KEY = ['kiosk-presets'];
const SETTINGS_KEY = ['kiosk-settings'];
const link = (slug: string) => `${location.origin}/kiosk?preset=${slug}`;
const codeCls = 'rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800';
const errCode = (e: unknown) => (e instanceof ApiError ? e.body?.error ?? e.code : undefined);

/** Settings tab "Wall display": presets with their link shortcut, the default preset and read-only kiosk keys. */
export function KioskTab() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient();
  const list = useQuery({ queryKey: PRESETS_KEY, queryFn: () => get<KioskPresetList>('/api/kiosk/presets') });
  const [edit, setEdit] = useState<KioskPreset | 'new' | null>(null);
  const [keysFor, setKeysFor] = useState<number | null>(null);
  const items = list.data?.items ?? [];
  const defaultId = list.data?.defaultId ?? null;
  const { pageRows, pagerProps } = usePagedList(items, { key: 'kiosk-presets' });
  const saveDefault = useMutation({
    mutationFn: (defaultPreset: number | null) => put('/api/settings/kiosk', { defaultPreset }),
    onSuccess: () => { toast(t('common.saved')); void qc.invalidateQueries({ queryKey: PRESETS_KEY }); void qc.invalidateQueries({ queryKey: SETTINGS_KEY }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/kiosk/presets/${id}`),
    onSuccess: () => { toast(t('common.deleted')); void qc.invalidateQueries({ queryKey: PRESETS_KEY }); void qc.invalidateQueries({ queryKey: SETTINGS_KEY }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (list.isLoading) return <Loading />;
  if (list.error || !list.data) return <ErrorBox error={list.error} />;
  const keysPreset = items.find((p) => p.id === keysFor);
  return (
    <div className="space-y-3">
      <p className="hint">{t('kadmin.help')}</p>
      <Card>
        <CardHeader title={t('kadmin.presets')} actions={<Button variant="primary" size="sm" onClick={() => setEdit('new')}><Plus className="h-4 w-4" />{t('kadmin.new')}</Button>} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
          <label htmlFor="kiosk-default" className="text-sm font-medium">{t('kadmin.default')}</label>
          <Select id="kiosk-default" className="w-auto min-w-[12rem]" value={defaultId ?? ''} disabled={saveDefault.isPending}
            onChange={(e) => saveDefault.mutate(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">{t('kadmin.default.none')}</option>
            {items.map((p) => <option key={p.id} value={p.id}>{presetLabel(p, t)}</option>)}
          </Select>
          <span className="hint">{t('kadmin.default.hint')}</span>
        </div>
        {items.length === 0 ? (
          <EmptyState title={t('kadmin.empty')} body={t('kadmin.empty.body')} action={<Button variant="primary" onClick={() => setEdit('new')}><Plus className="h-4 w-4" />{t('kadmin.new')}</Button>} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-500 dark:border-slate-800">
                  <th className="px-4 py-2 font-medium">{t('common.name')}</th><th className="px-2 py-2 font-medium">{t('kadmin.shortcut')}</th><th className="px-2 py-2 font-medium">{t('kadmin.display')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('kadmin.keys')}</th><th className="px-4 py-2 text-right font-medium">{t('common.actions')}</th>
                </tr></thead>
                <tbody>
                  {pageRows.map((p) => {
                    const name = presetLabel(p, t);
                    return (
                      <tr key={p.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                        <td className="px-4 py-1.5"><span className="font-medium">{name}</span>{p.id === defaultId && <Badge tone="brand" className="ml-2">{t('kadmin.defaultBadge')}</Badge>}</td>
                        <td className="px-2 py-1.5"><span className="inline-flex items-center gap-2"><code className={codeCls}>?preset={p.slug}</code><CopyButton text={link(p.slug)} label={t('kadmin.copyLink')} /></span></td>
                        <td className="px-2 py-1.5">{t(`kioskcfg.display.${p.config.display}`)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{p.keys ?? 0}</td>
                        <td className="px-4 py-1.5">
                          <span className="flex justify-end gap-1">
                            <a className="btn btn-sm" href={link(p.slug)} target="_blank" rel="noopener noreferrer" aria-label={`${t('kadmin.open')} ${name}`} title={t('kadmin.open')}><ExternalLink className="h-3.5 w-3.5" /></a>
                            <Button size="sm" aria-label={`${t('common.edit')} ${name}`} title={t('common.edit')} onClick={() => setEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button size="sm" aria-label={`${t('kadmin.keys')} ${name}`} title={t('kadmin.keys')} onClick={() => setKeysFor(p.id)}><KeyRound className="h-3.5 w-3.5" /></Button>
                            <Button size="sm" variant="danger" aria-label={`${t('common.delete')} ${name}`} title={t('common.delete')}
                              onClick={async () => { if (await confirm({ title: t('kadmin.delete.title'), body: t('kadmin.delete.body', { name }), danger: true, confirmLabel: t('common.delete') })) remove.mutate(p.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager {...pagerProps} />
          </>
        )}
      </Card>
      {edit && <PresetEditor preset={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {keysPreset && <KeysModal preset={keysPreset} onClose={() => setKeysFor(null)} />}
    </div>
  );
}

/** Create or edit a preset. The slug follows the name until the person edits the slug field. */
function PresetEditor({ preset, onClose }: { preset: KioskPreset | null; onClose: () => void }) {
  const t = useT(); const toast = useToast(); const qc = useQueryClient();
  const monitors = useMonitorsQ(), groups = useGroupsQ(), tags = useTagsQ();
  const [name, setName] = useState(preset ? presetLabel(preset, t) : ''); // a built-in preset with an empty name gets a real one on save
  const [slug, setSlug] = useState(preset?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!preset);
  const [config, setConfig] = useState<KioskConfig>({ ...KIOSK_DEFAULTS, ...(preset?.config ?? {}) });
  const [slugTaken, setSlugTaken] = useState(false);
  const [rest, setRest] = useState<string[]>([]);
  const nameErr = name.trim().length === 0 ? t('kadmin.name.required') : name.length > NAME_MAX ? t('kadmin.name.long', { n: NAME_MAX }) : '';
  const slugErr = slugTaken ? t('kadmin.slug.taken') : !SLUG_RE.test(slug) ? t('kadmin.slug.invalid', { n: SLUG_MAX }) : '';
  const [shown, setShown] = useState(false); // show validation only after the first save attempt or edit of the field
  const dirty = !!name || !!slug || !!preset;
  const save = useMutation({
    mutationFn: () => {
      const body = { slug, name: name.trim(), config: kioskConfigDiff(config) };
      return preset ? patch(`/api/kiosk/presets/${preset.id}`, body) : post('/api/kiosk/presets', body);
    },
    onSuccess: () => { toast(t('common.saved')); void qc.invalidateQueries({ queryKey: PRESETS_KEY }); void qc.invalidateQueries({ queryKey: SETTINGS_KEY }); onClose(); },
    onError: (e) => { if (errCode(e) === 'slug_taken') { setSlugTaken(true); setShown(true); } else setRest([errorMessage(e)]); },
  });
  const submit = () => { setShown(true); setRest([]); if (!nameErr && !slugErr) save.mutate(); };
  return (
    <Modal open onClose={onClose} wide dirty={dirty} title={preset ? t('kadmin.edit.title') : t('kadmin.new.title')}
      footer={<><CancelButton /><Button variant="primary" loading={save.isPending} onClick={submit}>{t('common.save')}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormAlert messages={rest} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.name')} error={shown ? nameErr : ''}>{(id, aria) => (
            <Input id={id} {...aria} autoFocus maxLength={NAME_MAX + 16} value={name} placeholder={t('kadmin.name.ph')}
              onChange={(e) => { setName(e.target.value); if (!slugTouched) { setSlug(slugify(e.target.value).slice(0, SLUG_MAX).replace(/-+$/, '')); setSlugTaken(false); } }} />)}
          </Field>
          <Field label={t('kadmin.shortcut')} error={shown || slugTouched ? slugErr : ''}
            hint={<>{t('kadmin.link')}: <code className={codeCls}>{link(slug || '…')}</code></>}>{(id, aria) => (
            <Input id={id} {...aria} className="font-mono" value={slug} maxLength={SLUG_MAX + 8} spellCheck={false} autoCapitalize="none"
              onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); setSlugTaken(false); }} />)}
          </Field>
        </div>
        <KioskConfigFields value={config} onChange={setConfig} monitors={monitors.data} groups={groups.data} tags={tags.data} scope showMessages />
      </form>
    </Modal>
  );
}

/** Keys of one preset. A new key is shown once; closing the box drops it from memory. */
function KeysModal({ preset, onClose }: { preset: KioskPreset; onClose: () => void }) {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['kiosk-keys', preset.id], queryFn: () => get<KioskKey[]>(`/api/kiosk/presets/${preset.id}/keys`) });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const { pageRows, pagerProps } = usePagedList(rows, { key: 'kiosk-keys' });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['kiosk-keys', preset.id] }); void qc.invalidateQueries({ queryKey: PRESETS_KEY }); };
  const create = useMutation({
    gcTime: 0, // the result holds the key: do not keep it in the mutation cache after the box is closed
    mutationFn: () => post<{ id: number; key: string }>(`/api/kiosk/presets/${preset.id}/keys`, { name: name.trim() }),
    onSuccess: (r) => { setFresh({ key: r.key, name: name.trim() }); setName(''); refresh(); },
    onError: (e) => toast(errCode(e) === 'too_many_keys' ? t('kadmin.keys.tooMany') : errorMessage(e), 'error'),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => del(`/api/kiosk/keys/${id}`),
    onSuccess: () => { toast(t('kadmin.keys.revoked')); refresh(); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  const label = presetLabel(preset, t);
  return (
    <Modal open onClose={onClose} wide title={t('kadmin.keys.title', { name: label })} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="space-y-3">
        {fresh && (
          <div role="status" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
            <p className="font-medium">{t('kadmin.fresh.title', { name: fresh.name })}</p>
            <code className="block break-all rounded bg-white px-2 py-1.5 font-mono text-xs dark:bg-slate-900">{fresh.key}</code>
            <p>{t('kadmin.fresh.once')} {t('kadmin.fresh.access')}</p>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={fresh.key} label={t('kadmin.fresh.copyKey')} />
              <CopyButton text={`${link(preset.slug)}#key=${fresh.key}`} label={t('kadmin.fresh.copyLink')} />
              <Button size="sm" className="ml-auto" onClick={() => setFresh(null)}>{t('kadmin.fresh.done')}</Button>
            </div>
          </div>
        )}
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <Field label={t('kadmin.keys.name')} className="min-w-[14rem] flex-1">{(id, aria) => <Input id={id} {...aria} maxLength={64} value={name} placeholder={t('kadmin.keys.name.ph')} onChange={(e) => setName(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}><Plus className="h-4 w-4" />{t('kadmin.keys.new')}</Button>
        </form>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700">{t('kadmin.keys.empty')}</p>
        ) : (
          <div className="rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-500 dark:border-slate-800">
                <th className="px-3 py-2 font-medium">{t('common.name')}</th><th className="px-2 py-2 font-medium">{t('kadmin.keys.created')}</th><th className="px-2 py-2 font-medium">{t('kadmin.keys.lastUsed')}</th><th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {pageRows.map((k) => (
                  <tr key={k.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="px-3 py-1.5"><div className="font-medium">{k.name}</div><code className="font-mono text-xs text-slate-500">{k.prefix}…</code></td>
                    <td className="px-2 py-1.5 text-xs" title={fmtDateTime(k.createdAt)}>{k.createdBy ? t('kadmin.keys.by', { user: k.createdBy }) + ', ' : ''}{relTime(k.createdAt)}</td>
                    <td className="px-2 py-1.5 text-xs" title={k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : undefined}>{k.lastUsedAt ? <>{relTime(k.lastUsedAt)}{k.lastIp ? <span className="text-slate-500"> ({k.lastIp})</span> : null}</> : <span className="text-slate-500">{t('kadmin.keys.never')}</span>}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Button size="sm" variant="danger" aria-label={`${t('kadmin.keys.revoke')} ${k.name}`} title={t('kadmin.keys.revoke')}
                        onClick={async () => { if (await confirm({ title: t('kadmin.keys.revoke'), body: t('kadmin.keys.revokeBody', { name: k.name }), danger: true, confirmLabel: t('kadmin.keys.revoke') })) revoke.mutate(k.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager {...pagerProps} />
          </div>
        )}
      </div>
    </Modal>
  );
}
