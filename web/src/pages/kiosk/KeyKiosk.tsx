import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { presetLabel } from '../../components/KioskConfigFields';
import { ApiError, get, type HistoryResponse, type KioskView } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { keyOverrides, partialToParams, presetBase, withOverrides } from '../../lib/kioskConfig';
import { useKioskStream } from '../../lib/kioskStream';
import { Screen, ScreenMessage } from './Screen';

const is401 = (e: unknown) => e instanceof ApiError && e.status === 401;

/**
 * Wall display opened with a kiosk key (#key=pwk_...): no session, only the public kiosk endpoints. The preset on the server
 * decides scope and settings; the address may only change how it looks.
 */
export function KeyKiosk({ kioskKey }: { kioskKey: string }) {
  const t = useT();
  const loc = useLocation();
  const nav = useNavigate();
  const [over, setOver] = useState(() => keyOverrides(new URLSearchParams(loc.search)));
  const headers = useMemo(() => ({ 'x-kiosk-key': kioskKey }), [kioskKey]);
  const viewKey = useMemo(() => ['kiosk-view', kioskKey], [kioskKey]);
  const { connected } = useKioskStream(kioskKey, viewKey);

  // the stream carries status and latency only; uptime and incidents come with the view, so it is always polled (faster while the stream is down)
  const view = useQuery({
    queryKey: viewKey,
    queryFn: ({ signal }) => get<KioskView>('/api/public/kiosk/view', { headers, signal }),
    refetchInterval: (q) => (is401(q.state.error) || connected ? 60_000 : 20_000),
  });
  const cfg = useMemo(() => (view.data ? withOverrides(presetBase(view.data.preset), over) : null), [view.data, over]);
  const history = useQuery({
    queryKey: ['kiosk-history', kioskKey],
    queryFn: ({ signal }) => get<HistoryResponse>('/api/public/kiosk/history?hours=24', { headers, signal }),
    refetchInterval: 60_000, enabled: cfg?.display === 'heatmap',
  });

  // the address shows the local display overrides (zoom keys change them); the fragment with the key stays as it is
  const search = partialToParams(over).toString();
  useEffect(() => {
    const s = search ? `?${search}` : '';
    if (s !== loc.search) nav({ pathname: loc.pathname, search: s, hash: loc.hash }, { replace: true });
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const monitors = useMemo(() => view.data?.monitors.filter((m) => m.active), [view.data]);

  // a revoked key must not leave the last picture on the wall as if it were current
  if (is401(view.error) && view.errorUpdatedAt >= view.dataUpdatedAt) return <ScreenMessage tone="error" title={t('kiosk.keyInvalid')} body={t('kiosk.keyRetry')} />;
  if (!view.data || !cfg) return view.isError ? <ScreenMessage tone="error" title={t('kiosk.unreachable')} body={t('kiosk.retrying')} /> : <ScreenMessage title={t('kiosk.connecting')} />;

  return (
    <Screen
      cfg={cfg} monitors={monitors} emptyText={t('kiosk.empty')} groups={view.data.groups} incidents={cfg.incidents ? view.data.incidents : []}
      history={history.data} dataAt={view.dataUpdatedAt} connected={connected} keyMode presetName={presetLabel(view.data.preset, t)}
      onZoom={(zoom) => setOver(({ zoom: _, ...o }) => (zoom === presetBase(view.data!.preset).zoom ? o : { ...o, zoom }))}
    />
  );
}
