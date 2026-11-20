import { useQueryClient } from '@tanstack/react-query';
import { Link2, RotateCcw, Save } from 'lucide-react';
import { useState } from 'react';
import { kioskConfigDiff, NAME_MAX, SLUG_MAX, type KioskConfig } from '../../../../src/core/kiosk';
import { KioskConfigFields, presetLabel } from '../../components/KioskConfigFields';
import { Button, Field, Input, Modal, Select } from '../../components/ui';
import { ApiError, errorMessage, patch, post, type Group, type KioskPreset, type KioskPresetList, type MonitorItem } from '../../lib/api';
import { overridesOf, suggestSlug, validSlug } from '../../lib/kioskConfig';
import { useT } from '../../lib/i18n';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  presets: KioskPresetList | undefined;
  preset: KioskPreset | null;
  base: KioskConfig;
  config: KioskConfig;
  /** Switch to a preset (id) or to custom settings (null). */
  onSelect: (presetId: number | null) => void;
  onChange: (next: KioskConfig) => void;
  /** After saving: the preset now holds exactly the shown settings. */
  onSaved: (presetId: number) => void;
  admin: boolean;
  monitors: MonitorItem[];
  groups: Group[];
  tags: { name: string }[];
  onCopyLink: () => void;
  toast: (msg: string, kind?: 'error') => void;
}

/** Display settings of a signed-in wall display: preset, local overrides, and for admins saving them as a preset. */
export function SettingsDialog({ open, onClose, presets, preset, base, config, onSelect, onChange, onSaved, admin, monitors, groups, tags, onCopyLink, toast }: SettingsDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const [saveAs, setSaveAs] = useState<{ name: string; slug: string; slugTouched: boolean; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = preset ? Object.keys(overridesOf(config, base)).length : 0;

  const create = async () => {
    if (!saveAs) return;
    const name = saveAs.name.trim(), slug = saveAs.slug.trim();
    if (!name) { setSaveAs({ ...saveAs, error: t('kiosk.s.nameMissing') }); return; }
    if (!validSlug(slug)) { setSaveAs({ ...saveAs, error: t('kiosk.s.slugInvalid') }); return; }
    setBusy(true);
    try {
      const r = await post<{ id: number }>('/api/kiosk/presets', { slug, name, config: kioskConfigDiff(config) });
      await qc.invalidateQueries({ queryKey: ['kiosk-presets'] });
      setSaveAs(null);
      onSaved(r.id);
      toast(t('kiosk.s.created'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setSaveAs({ ...saveAs, error: t('kiosk.s.slugTaken', { slug }) });
      else setSaveAs({ ...saveAs, error: errorMessage(e) });
    } finally { setBusy(false); }
  };

  const update = async () => {
    if (!preset) return;
    setBusy(true);
    try {
      await patch(`/api/kiosk/presets/${preset.id}`, { config });
      await qc.invalidateQueries({ queryKey: ['kiosk-presets'] });
      onSaved(preset.id);
      toast(t('kiosk.s.updatedPreset'));
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('kiosk.s.title')} wide footer={<><Button onClick={onCopyLink}><Link2 className="h-4 w-4" />{t('kiosk.s.link')}</Button><Button variant="primary" onClick={onClose}>{t('common.close')}</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('kiosk.s.preset')} className="min-w-[14rem] flex-1">{(id) => (
            <Select id={id} value={preset ? String(preset.id) : 'custom'} onChange={(e) => { setSaveAs(null); onSelect(e.target.value === 'custom' ? null : Number(e.target.value)); }}>
              {(presets?.items ?? []).map((p) => <option key={p.id} value={p.id}>{presetLabel(p, t)}{p.id === presets?.defaultId ? ` (${t('kiosk.s.default')})` : ''}</option>)}
              <option value="custom">{t('kiosk.s.custom')}</option>
            </Select>)}
          </Field>
          {preset && changed > 0 && <Button onClick={() => onChange(base)}><RotateCcw className="h-4 w-4" />{t('kiosk.s.reset')}</Button>}
          {admin && preset && changed > 0 && <Button onClick={() => void update()} loading={busy && !saveAs}><Save className="h-4 w-4" />{t('kiosk.s.update')}</Button>}
          {admin && !saveAs && <Button onClick={() => setSaveAs({ name: '', slug: '', slugTouched: false, error: null })}>{t('kiosk.s.saveNew')}</Button>}
        </div>
        <p className="hint -mt-2">{preset ? (changed > 0 ? t('kiosk.s.overrides', { n: changed }) : t('kiosk.s.presetHint')) : t('kiosk.s.customHint')}</p>

        {saveAs && (
          <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end dark:border-slate-700">
            <Field label={t('kiosk.s.name')}>{(id) => <Input id={id} value={saveAs.name} maxLength={NAME_MAX} autoFocus onChange={(e) => setSaveAs({ ...saveAs, name: e.target.value, slug: saveAs.slugTouched ? saveAs.slug : suggestSlug(e.target.value), error: null })} />}</Field>
            <Field label={t('kiosk.s.slug')} hint={t('kiosk.s.slugHint')}>{(id) => <Input id={id} value={saveAs.slug} maxLength={SLUG_MAX} className="font-mono" onChange={(e) => setSaveAs({ ...saveAs, slug: e.target.value.toLowerCase(), slugTouched: true, error: null })} />}</Field>
            <div className="flex gap-2 sm:pb-6">
              <Button variant="primary" loading={busy} onClick={() => void create()}>{t('common.create')}</Button>
              <Button onClick={() => setSaveAs(null)}>{t('common.cancel')}</Button>
            </div>
            {saveAs.error && <p role="alert" className="text-sm text-red-600 sm:col-span-3 dark:text-red-400">{saveAs.error}</p>}
          </div>
        )}

        <KioskConfigFields value={config} onChange={onChange} monitors={monitors} groups={groups} tags={tags} scope />
        <p className="hint">{t('kiosk.s.linkHint')}</p>
      </div>
    </Modal>
  );
}
