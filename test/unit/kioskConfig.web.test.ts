import { describe, expect, it } from 'vitest';
import { KIOSK_DEFAULTS, type KioskConfig } from '../../src/core/kiosk';
import type { KioskPreset, KioskPresetList } from '../../web/src/lib/api';
import {
  addressOf, configToParams, effectiveConfig, keyOverrides, kioskKeyFrom, needsPresets, paramsToPartial, resolveKioskState, searchWithoutKey, storedConfig, suggestSlug, validSlug,
} from '../../web/src/lib/kioskConfig';

const q = (s: string) => new URLSearchParams(s);
const preset = (id: number, slug: string, config: Partial<KioskConfig>): KioskPreset => ({ id, slug, name: '', config: { ...KIOSK_DEFAULTS, ...config }, sort: id, updatedAt: '2026-11-20T08:00:00Z' });
const list: KioskPresetList = {
  items: [preset(1, 'all', {}), preset(2, 'wall', { display: 'wall', size: 's', rotate: 20 }), preset(3, 'ops', { display: 'table', groups: [4], show: 'problems', theme: 'nord', mode: 'dark' })],
  defaultId: 2,
};
const resolve = (search: string, stored: string | null = null, presets: KioskPresetList | null = list) => {
  const s = resolveKioskState(q(search), stored, presets);
  return { ...s, ...effectiveConfig(s, presets) };
};

describe('kiosk config resolution', () => {
  it('(a) a known preset is the base and address settings override it', () => {
    const r = resolve('preset=wall&size=l&rotate=0');
    expect(r.presetId).toBe(2);
    expect(r.over).toEqual({ size: 'l', rotate: 0 });
    expect(r.config).toMatchObject({ display: 'wall', size: 'l', rotate: 0 });
  });

  it('(a) an unknown preset is reported and falls through to the address settings or the default preset', () => {
    expect(resolve('preset=nope&size=s')).toMatchObject({ presetId: null, unknownSlug: 'nope', config: { size: 's', display: 'cards' } });
    expect(resolve('preset=nope')).toMatchObject({ presetId: 2, unknownSlug: 'nope' });
  });

  it('(b) settings in the address mean custom settings: address over this browser over defaults', () => {
    const r = resolve('size=s&view=problems', JSON.stringify({ ...KIOSK_DEFAULTS, size: 'l', rotate: 30 }));
    expect(r.presetId).toBeNull();
    expect(r.config).toMatchObject({ size: 's', show: 'problems', rotate: 30, display: 'cards' });
  });

  it('(c) without a preset or settings in the address, the default preset applies', () => {
    expect(resolve('', JSON.stringify({ size: 'l' }))).toMatchObject({ presetId: 2, over: {}, config: { display: 'wall' } });
  });

  it('(d) without a default preset (or without presets at all) custom settings from this browser apply', () => {
    expect(resolve('', JSON.stringify({ size: 'l' }), { ...list, defaultId: null })).toMatchObject({ presetId: null, config: { size: 'l' } });
    expect(resolve('', null, null)).toMatchObject({ presetId: null, config: KIOSK_DEFAULTS });
  });

  it('waits for the preset list only when it can matter', () => {
    expect(needsPresets(q(''))).toBe(true);
    expect(needsPresets(q('preset=x&size=s'))).toBe(true);
    expect(needsPresets(q('size=s'))).toBe(false);
    expect(needsPresets(q('layout=grouped'))).toBe(false);
  });
});

describe('old kiosk links', () => {
  it('reads view, layout, group and the themes from before theme ids', () => {
    expect(paramsToPartial(q('groups=1,2&layout=grouped&view=problems&theme=dark'))).toEqual({ groups: [1, 2], grouped: true, show: 'problems', theme: 'classic', mode: 'dark' });
    expect(paramsToPartial(q('group=7&layout=flat&theme=light'))).toEqual({ groups: [7], grouped: false, theme: 'classic', mode: 'light' });
    expect(paramsToPartial(q('theme=dark&mode=dark'))).toEqual({ theme: 'dark', mode: 'dark' });
    expect(paramsToPartial(q('theme=nord'))).toEqual({ theme: 'nord', mode: 'dark' });
  });

  it('resolves an old link to the same screen as before', () => {
    const r = resolve('groups=1,2&layout=grouped&view=problems&theme=dark');
    expect(r.presetId).toBeNull();
    expect(r.config).toMatchObject({ display: 'cards', grouped: true, show: 'problems', groups: [1, 2], theme: 'classic', mode: 'dark' });
  });

  it('ignores out-of-range numbers instead of clamping them', () => {
    expect(paramsToPartial(q('zoom=999&rotate=-1'))).toEqual({});
    expect(resolve('zoom=999', JSON.stringify({ zoom: 110 })).config.zoom).toBe(110);
    expect(paramsToPartial(q('zoom=137'))).toEqual({ zoom: 135 });
  });

  it('reads what browsers remembered before presets', () => {
    expect(storedConfig(JSON.stringify({ view: 'auto', layout: 'grouped', theme: 'light', size: 's' }))).toMatchObject({ show: 'auto', grouped: true, theme: 'classic', mode: 'light', size: 's' });
    expect(storedConfig('not json')).toEqual(KIOSK_DEFAULTS);
  });
});

describe('address', () => {
  it('custom settings write only what differs from the defaults', () => {
    const r = resolve('size=s&rotate=0&theme=light&view=problems');
    expect(addressOf(r).toString()).toBe('show=problems&size=s&rotate=0&theme=classic&mode=light');
  });

  it('preset mode writes the slug plus the overrides only', () => {
    expect(addressOf(resolve('preset=wall')).toString()).toBe('preset=wall');
    expect(addressOf(resolve('preset=ops&display=heatmap&zoom=120')).toString()).toBe('preset=ops&display=heatmap&zoom=120');
  });

  it('the default preset gets its slug into the address', () => {
    expect(addressOf(resolve('')).toString()).toBe('preset=wall');
  });

  it('round trip: address -> config -> address -> the same config', () => {
    for (const s of ['display=heatmap&show=auto&grouped=1&groups=3,4&tags=db,web&monitors=9&size=l&zoom=150&rotate=5&theme=smooth&mode=light&incidents=0&clock=0&bars=0', 'preset=ops&groups=&show=all&theme=classic&mode=light', 'preset=wall&grouped=1&theme=dark&mode=dark']) {
      const a = resolve(s);
      const b = resolve(addressOf(a).toString());
      expect(b.config).toEqual(a.config);
      expect(b.presetId).toBe(a.presetId);
      expect(addressOf(b).toString()).toBe(addressOf(a).toString());
    }
  });

  it('an override can clear the scope of a preset', () => {
    const r = resolve('preset=ops&groups=');
    expect(r.over).toEqual({ groups: [] });
    expect(r.config.groups).toEqual([]);
  });

  it('a changed theme or mode writes both, a single-mode theme needs no mode', () => {
    expect(configToParams({ ...KIOSK_DEFAULTS, mode: 'light' }, KIOSK_DEFAULTS).toString()).toBe('theme=classic&mode=light');
    expect(configToParams({ ...KIOSK_DEFAULTS, theme: 'nord', mode: 'dark' }, KIOSK_DEFAULTS).toString()).toBe('theme=nord');
    expect(configToParams({ ...KIOSK_DEFAULTS, theme: 'dark', mode: 'dark' }, KIOSK_DEFAULTS).toString()).toBe('theme=dark&mode=dark');
  });

  it('a mode stored for a single-mode theme is no override', () => {
    const r = resolve('preset=ops&mode=light');
    expect(r.over).toEqual({});
  });
});

describe('kiosk key links', () => {
  it('takes the key from the fragment, or from the query as a fallback', () => {
    expect(kioskKeyFrom('#key=pwk_abc', '?preset=wall')).toEqual({ key: 'pwk_abc', inQuery: false });
    expect(kioskKeyFrom('', '?preset=wall&key=pwk_q')).toEqual({ key: 'pwk_q', inQuery: true });
    expect(kioskKeyFrom('#other=1', '')).toBeNull();
    expect(searchWithoutKey('?preset=wall&key=pwk_q')).toBe('?preset=wall');
    expect(searchWithoutKey('?key=pwk_q')).toBe('');
  });

  it('accepts display settings from the address, never the scope', () => {
    expect(keyOverrides(q('display=table&zoom=120&groups=1&tags=x&monitors=2&theme=light&layout=grouped'))).toEqual({ display: 'table', zoom: 120, theme: 'classic', mode: 'light', grouped: true });
  });
});

describe('preset slugs', () => {
  it('suggests a valid slug from a name', () => {
    expect(suggestSlug('Büro Ost / Server')).toBe('buero-ost-server');
    const long = suggestSlug('A very long name for a wall display preset in the lobby');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(validSlug(long)).toBe(true);
    expect(validSlug('-x')).toBe(false);
  });
});
