import { BUILTIN_SLUGS, clampZoom, DISPLAYS, ROTATIONS, SHOWS, SIZES, ZOOM_MAX, ZOOM_MIN, type KioskConfig } from '../../../src/core/kiosk';
import type { Group, MonitorItem } from '../lib/api';
import { useT } from '../lib/i18n';
import { THEMES, themeInfo, type ThemeId } from '../lib/theme';
import { MultiSelect } from './MultiSelect';
import { MonitorPicker } from './ops-shared';
import { Field, Select, Toggle } from './ui';

/** Name of a preset as shown: built-in presets keep an empty name (translated here) until someone renames them. */
export const presetLabel = (p: { slug: string; name: string }, t: (key: string) => string): string =>
  p.name || ((BUILTIN_SLUGS as readonly string[]).includes(p.slug) ? t(`kioskcfg.preset.${p.slug}`) : p.slug);

export interface KioskConfigFieldsProps {
  value: KioskConfig;
  onChange: (next: KioskConfig) => void;
  /** Lists for the scope pickers (groups, tags, monitors). */
  monitors?: MonitorItem[];
  groups?: Group[];
  tags?: { name: string }[];
  /** Show the scope pickers. Off where the scope is fixed. */
  scope?: boolean;
  /** Show the switch for error texts, which only matters for screens opened with a kiosk key (the preset editor). */
  showMessages?: boolean;
}

/**
 * The settings of a wall display as form fields: used by the display settings of the kiosk page and by the preset editor in
 * Settings, so both always offer the same choices.
 */
export function KioskConfigFields({ value: c, onChange, monitors = [], groups = [], tags = [], scope = true, showMessages = false }: KioskConfigFieldsProps) {
  const t = useT();
  const set = <K extends keyof KioskConfig>(k: K, v: KioskConfig[K]) => onChange({ ...c, [k]: v });
  const theme = THEMES.some((x) => x.id === c.theme) ? (c.theme as ThemeId) : THEMES[0]!.id;
  const rotations: number[] = (ROTATIONS as readonly number[]).includes(c.rotate) ? [...ROTATIONS] : [...ROTATIONS, c.rotate].sort((a, b) => a - b);
  const tagNames = [...new Set(tags.map((x) => x.name))];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('kioskcfg.display')}>{(id) => (
        <Select id={id} value={c.display} onChange={(e) => set('display', e.target.value as KioskConfig['display'])}>
          {DISPLAYS.map((d) => <option key={d} value={d}>{t(`kioskcfg.display.${d}`)}</option>)}
        </Select>)}
      </Field>
      <Field label={t('kioskcfg.show')}>{(id) => (
        <Select id={id} value={c.show} onChange={(e) => set('show', e.target.value as KioskConfig['show'])}>
          {SHOWS.map((s) => <option key={s} value={s}>{t(`kioskcfg.show.${s}`)}</option>)}
        </Select>)}
      </Field>
      <Field label={t('kioskcfg.size')}>{(id) => (
        <Select id={id} value={c.size} onChange={(e) => set('size', e.target.value as KioskConfig['size'])}>
          {SIZES.map((s) => <option key={s} value={s}>{t(`kioskcfg.size.${s}`)}</option>)}
        </Select>)}
      </Field>
      <Field label={t('kioskcfg.zoom', { n: c.zoom })}>{(id) => (
        <input id={id} type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={5} value={c.zoom} onChange={(e) => set('zoom', clampZoom(Number(e.target.value)))} className="w-full accent-brand-600" />)}
      </Field>
      <Field label={t('kioskcfg.rotate')}>{(id) => (
        <Select id={id} value={c.rotate} onChange={(e) => set('rotate', Number(e.target.value))}>
          {rotations.map((n) => <option key={n} value={n}>{n === 0 ? t('kioskcfg.rotate.off') : t('kioskcfg.rotate.n', { n })}</option>)}
        </Select>)}
      </Field>
      <Field label={t('kioskcfg.theme')}>{(id) => (
        <div className="flex gap-2">
          <Select id={id} value={theme} onChange={(e) => set('theme', e.target.value)}>{THEMES.map((x) => <option key={x.id} value={x.id}>{t(`themes.name.${x.id}`)}</option>)}</Select>
          {themeInfo(theme).modes.length > 1 && (
            <Select aria-label={t('themes.mode')} className="w-auto" value={c.mode} onChange={(e) => set('mode', e.target.value as KioskConfig['mode'])}>
              <option value="dark">{t('kioskcfg.mode.dark')}</option><option value="light">{t('kioskcfg.mode.light')}</option>
            </Select>
          )}
        </div>)}
      </Field>
      {scope && (
        <>
          <Field label={t('kioskcfg.groups')}>{() => <MultiSelect label={t('kioskcfg.groups')} allLabel={t('kioskcfg.groups.all')} options={groups.map((g) => ({ value: g.id, label: g.name }))} value={c.groups} onChange={(v) => set('groups', v)} />}</Field>
          <Field label={t('kioskcfg.tags')}>{() => <MultiSelect label={t('kioskcfg.tags')} allLabel={t('kioskcfg.tags.all')} options={tagNames.map((n) => ({ value: n, label: n }))} value={c.tags} onChange={(v) => set('tags', v)} />}</Field>
          <div className="sm:col-span-2">
            <span className="label">{t('kioskcfg.monitors')}</span>
            <MonitorPicker monitors={monitors.filter((m) => m.active)} groups={groups} value={c.monitors} onChange={(v) => set('monitors', v)} />
            <p className="hint mt-2">{t('kioskcfg.monitors.hint')}</p>
          </div>
        </>
      )}
      <div className="flex flex-col items-start gap-3 sm:col-span-2 sm:grid sm:grid-cols-2">
        {c.display !== 'groups' && <Toggle checked={c.grouped} onChange={(v) => set('grouped', v)} label={t('kioskcfg.grouped')} />}
        {(c.display === 'cards' || c.display === 'table') && <Toggle checked={c.bars} onChange={(v) => set('bars', v)} label={t('kioskcfg.bars')} />}
        <Toggle checked={c.incidents} onChange={(v) => set('incidents', v)} label={t('kioskcfg.incidents')} />
        <Toggle checked={c.clock} onChange={(v) => set('clock', v)} label={t('kioskcfg.clock')} />
        {showMessages && (
          <div className="sm:col-span-2">
            <Toggle checked={c.messages} onChange={(v) => set('messages', v)} label={t('kioskcfg.messages')} />
            <p className="hint mt-1">{t('kioskcfg.messages.hint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
