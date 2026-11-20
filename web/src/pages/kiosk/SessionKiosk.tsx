import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { inKioskScope, KIOSK_DEFAULTS, type KioskConfig } from '../../../../src/core/kiosk';
import { presetLabel } from '../../components/KioskConfigFields';
import { useGroupsQ, useTagsQ } from '../../components/ops-shared';
import { useToast } from '../../components/ui';
import { get, type HistoryResponse, type KioskIncident, type KioskPresetList, type MonitorItem } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { addressOf, effectiveConfig, needsPresets, overridesOf, resolveKioskState, STORE_KEY, type KioskState } from '../../lib/kioskConfig';
import { useStreamState } from '../../lib/stream';
import { Screen } from './Screen';
import { SettingsDialog } from './SettingsDialog';

const readStore = () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };

/** Wall display of a signed-in person: settings from a preset or from the address, live updates over the session's stream. */
export function SessionKiosk() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const { connected } = useStreamState();
  const [settings, setSettings] = useState(false);

  const presets = useQuery({ queryKey: ['kiosk-presets'], queryFn: () => get<KioskPresetList>('/api/kiosk/presets'), staleTime: 60_000, retry: false });
  // settings are resolved once, when the presets are known (or failed to load); from then on the page owns them
  const [state, setState] = useState<KioskState | null>(() => (needsPresets(params) ? null : resolveKioskState(params, readStore(), null)));
  const settled = presets.isSuccess || presets.isError;
  useEffect(() => { if (!state && settled) setState(resolveKioskState(params, readStore(), presets.data)); }, [state, settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const eff = useMemo(() => effectiveConfig(state ?? { presetId: null, over: {} }, presets.data), [state, presets.data]);
  const cfg = eff.config;
  const update = (next: KioskConfig) => setState((s) => (s ? { ...s, over: overridesOf(next, eff.base) } : s));

  // an unknown preset in the link is reported for a while, then the screen just shows what it fell back to
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!state?.unknownSlug) return;
    setNotice(state.unknownSlug);
    const timer = setTimeout(() => setNotice(null), 30_000);
    return () => clearTimeout(timer);
  }, [state?.unknownSlug]);

  // the address always shows the current settings, so it can be bookmarked or copied to another screen
  const address = addressOf(eff).toString();
  const custom = !eff.preset;
  const cfgJson = JSON.stringify(cfg);
  useEffect(() => {
    if (!state) return;
    if (custom) { try { localStorage.setItem(STORE_KEY, cfgJson); } catch { /* storage unavailable */ } }
    setParams(new URLSearchParams(address), { replace: true });
    // only on a settings change: setParams changes identity with every address change and would pull the address back to the kiosk after Esc
  }, [address, cfgJson, custom, !!state]); // eslint-disable-line react-hooks/exhaustive-deps

  // the event stream carries status and latency only; uptime, players and the like come with the list, so it is always polled (faster while the stream is down)
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors'), refetchInterval: connected ? 60_000 : 20_000 });
  const groups = useGroupsQ();
  const tags = useTagsQ();
  const incidents = useQuery({ queryKey: ['incidents', 'kiosk'], queryFn: () => get<KioskIncident[]>('/api/incidents?status=active&limit=4'), refetchInterval: connected ? 60_000 : 20_000, enabled: cfg.incidents });
  const history = useQuery({ queryKey: ['monitors-history', 24], queryFn: () => get<HistoryResponse>('/api/monitors/history?hours=24'), refetchInterval: 60_000, enabled: !!state && cfg.display === 'heatmap' });

  const scoped = useMemo(() => (monitors.data ? inKioskScope(monitors.data, groups.data ?? [], cfg) : undefined),
    [monitors.data, groups.data, cfg.groups.join(), cfg.tags.join(), cfg.monitors.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/kiosk${address ? `?${address}` : ''}`); toast(t('kiosk.s.copied')); } catch { toast(t('common.failed'), 'error'); }
  };
  const presetName = eff.preset ? presetLabel(eff.preset, t) : null;

  return (
    <Screen
      cfg={cfg} monitors={state ? scoped : undefined} emptyText={t(monitors.data?.length ? 'kiosk.noMatch' : 'kiosk.empty')}
      groups={groups.data ?? []} incidents={incidents.data ?? []} history={history.data} dataAt={monitors.dataUpdatedAt} connected={connected}
      keyMode={false} presetName={presetName} hold={settings}
      onZoom={(zoom) => update({ ...cfg, zoom })} onSettings={() => setSettings(true)} onExit={() => nav('/dashboard')}
      notice={notice && <p role="status" className="bg-slate-800 px-6 py-1.5 text-sm text-white">{t('kiosk.presetUnknown', { slug: notice })}</p>}
    >
      <SettingsDialog
        open={settings} onClose={() => setSettings(false)} presets={presets.data} preset={eff.preset} base={eff.base} config={cfg}
        onSelect={(id) => { setNotice(null); setState({ presetId: id, over: id == null ? overridesOf(cfg, KIOSK_DEFAULTS) : {}, unknownSlug: null }); }}
        onChange={update} onSaved={(id) => setState({ presetId: id, over: {}, unknownSlug: null })}
        admin={can('admin')} monitors={monitors.data ?? []} groups={groups.data ?? []} tags={tags.data ?? []} onCopyLink={() => void copyLink()} toast={toast}
      />
    </Screen>
  );
}
