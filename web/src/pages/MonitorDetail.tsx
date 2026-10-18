import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Copy, Edit3, Pause, Play, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, Dl, EmptyState, ErrorBox, Loading, PageHeader, Select, useConfirm, useToast, cx } from '../components/ui';
import { displayStatus, HeartbeatBar, StatusBadge, StatusDot, uptimeTone } from '../components/status';
import { TimeChart } from '../components/TimeChart';
import { MonitorCopy } from '../components/MonitorCopy';
import { del, errorMessage, get, post, type Beat, type MonitorItem } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { fmtDateTime, fmtDuration, fmtMs, fmtPct, relTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { subscribeStream } from '../lib/stream';

interface Detail extends MonitorItem {
  config: Record<string, unknown>; timeoutS: number; retries: number; retryIntervalS: number;
  locationStates: { locationId: number | null; name: string; ok: boolean; ts: string; latencyMs: number | null; errorKind: string | null; message: string | null }[];
  cert: { subject: string; issuer: string; validFrom: string; validTo: string; daysLeft: number; fingerprint256: string; altNames: string[]; chain: { subject: string; issuer: string; validTo: string }[]; authorized?: boolean; authError?: string } | null;
  anomalyState: { slow: number; fast: number; flagged: boolean } | null;
}
interface ChartData { range: string; resolution: string; points: { t: string; avg: number | null; p50?: number; p95?: number; p99?: number; status?: number }[]; summary: { avg: number | null; min: number | null; max: number | null; p50: number | null; p95: number | null; p99: number | null } }
interface Period { status: string | number; from: string; to: string | null; durationS: number; errorKind: string | null; message: string | null }
interface Hb { id: number; ts: string; status: number; latencyMs: number | null; errorKind: string | null; message: string | null }
interface Ev { id: number; ts: string; type: string; from: string | null; to: string | null; errorKind: string | null; message: string | null }
interface Inc { id: number; title: string; status: string; severity: string; started_at: string; resolved_at: string | null }

const RANGES = ['1h', '24h', '7d', '30d', '90d', '365d'] as const;
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export default function MonitorDetail() {
  const t = useT();
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useAuth();
  const meta = useMeta();
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h');
  const key = ['monitor', id];

  const q = useQuery({ queryKey: key, queryFn: () => get<Detail>(`/api/monitors/${id}`), enabled: Number.isFinite(id) });

  // Live updates: patch the header and append the beat; the lists below refetch.
  useEffect(() => subscribeStream('monitor', (e: any) => {
    if (e.id !== id) return;
    qc.setQueryData<Detail>(key, (o) => o && ({ ...o, status: e.status, overlay: e.overlay, latencyMs: e.latencyMs, errorKind: e.errorKind, message: e.message, lastCheckAt: e.ts, flapping: e.flapping, statusSince: e.statusSince ?? o.statusSince, recent: e.beat ? [...o.recent, e.beat as Beat].slice(-150) : o.recent }));
    void qc.invalidateQueries({ queryKey: ['monitor', id, 'heartbeats'] });
    void qc.invalidateQueries({ queryKey: ['monitor', id, 'events'] });
  }), [id, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  const chart = useQuery({ queryKey: ['monitor', id, 'chart', range], queryFn: () => get<ChartData>(`/api/monitors/${id}/chart?range=${range}`), refetchInterval: 60_000, enabled: Number.isFinite(id) });
  const periods = useQuery({ queryKey: ['monitor', id, 'periods', range], queryFn: () => get<Period[]>(`/api/monitors/${id}/periods?range=${range}`), enabled: Number.isFinite(id) });
  const incidents = useQuery({ queryKey: ['monitor', id, 'incidents'], queryFn: () => get<Inc[]>(`/api/monitors/${id}/incidents`), enabled: Number.isFinite(id) });

  const act = useMutation({
    mutationFn: (a: 'check' | 'pause' | 'resume') => post(`/api/monitors/${id}/${a}`),
    onSuccess: (_r, a) => { toast(t(`monitors.done.${a}`)); void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['monitors'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const chartView = useMemo(() => {
    const pts = chart.data?.points ?? [];
    const x = pts.map((p) => sec(p.t));
    const rollup = pts.some((p) => p.p95 != null);
    const ys = rollup ? [pts.map((p) => p.p50 ?? p.avg), pts.map((p) => p.p95 ?? null), pts.map((p) => p.p99 ?? null)] : [pts.map((p) => (p.status === 1 ? p.avg : null))];
    const series = rollup
      ? [{ label: 'p50', color: '#6366f1', fill: true }, { label: 'p95', color: '#f59e0b' }, { label: 'p99', color: '#ef4444', dash: [4, 4] }]
      : [{ label: t('monitors.latency'), color: '#6366f1', fill: true }];
    const now = Math.floor(Date.now() / 1000);
    const bands = (periods.data ?? []).filter((p) => p.status === 'down' || p.status === 0).map((p): [number, number, string] => [sec(p.from), p.to ? sec(p.to) : now, 'rgba(239,68,68,0.15)']);
    return { x, ys, series, bands };
  }, [chart.data, periods.data, t]);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error('Not found')} />;
  const m = q.data;
  const s = displayStatus(m);
  const editor = can('editor');
  const base = meta?.baseUrl ?? window.location.origin;
  const badge = (f: string) => `${base}/badge/${m.id}/${f}.svg`;
  const pushUrl = m.pushToken ? `${base}/api/push/${m.pushToken}` : '';
  const sum = chart.data?.summary;

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-3"><StatusDot status={s} pulse />{m.name}</span>}
        subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={s} /><span className="font-mono text-xs">{m.type}</span>{m.statusSince && <span>{t('monitors.since', { time: relTime(m.statusSince) })}</span>}{m.flapping && <Badge tone="amber">{t('monitors.flapping')}</Badge>}{m.tags.map((x) => <span key={x.id} className="rounded px-1.5 py-0.5 text-[11px] text-white" style={{ background: x.color }}>{x.name}</span>)}</span>}
        actions={editor ? (
          <>
            <Button size="sm" variant="primary" loading={act.isPending && act.variables === 'check'} onClick={() => act.mutate('check')}><RefreshCw className="h-4 w-4" />{t('monitors.checkNow')}</Button>
            <Button size="sm" onClick={() => act.mutate(m.active ? 'pause' : 'resume')}>{m.active ? <><Pause className="h-4 w-4" />{t('monitors.pause')}</> : <><Play className="h-4 w-4" />{t('monitors.resume')}</>}</Button>
            <Link to={`/monitors/${id}/edit`} className="btn btn-sm no-underline"><Edit3 className="h-4 w-4" />{t('common.edit')}</Link>
            <Link to={`/monitors/new?clone=${id}`} className="btn btn-sm no-underline"><Copy className="h-4 w-4" />{t('monitors.clone')}</Link>
            <Button size="sm" variant="danger" onClick={async () => {
              if (!(await confirm({ title: t('monitors.deleteTitle', { name: m.name }), body: t('monitors.deleteBody'), danger: true, confirmLabel: t('common.delete') }))) return;
              try { await del(`/api/monitors/${id}`); void qc.invalidateQueries({ queryKey: ['monitors'] }); nav('/'); } catch (e) { toast(errorMessage(e), 'error'); }
            }}><Trash2 className="h-4 w-4" />{t('common.delete')}</Button>
          </>
        ) : undefined}
      />
      {m.description && <p className="-mt-2 mb-4 text-sm text-slate-600 dark:text-slate-300">{m.description}</p>}

      {m.status === 'down' && m.message && <div role="alert" className="mb-4 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><div>{m.errorKind && <Badge tone="red" className="mr-2">{m.errorKind}</Badge>}{m.message}</div></div>}
      {(m.anomaly || m.anomalyState?.flagged) && <div role="status" className="mb-4 flex gap-2 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200"><Activity className="mt-0.5 h-4 w-4 shrink-0" /><div><strong>{t('monitors.slowdown')}.</strong> {m.anomalyState ? t('monitors.anomalyBody', { fast: fmtMs(m.anomalyState.fast), slow: fmtMs(m.anomalyState.slow) }) : t('monitors.anomalyGeneric')}</div></div>}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="card p-3"><div className="text-xs text-slate-500">{t('monitors.current')}</div><div className="mt-1 text-xl font-semibold">{fmtMs(m.latencyMs)}</div></div>
        {([['24h', m.uptime.h24], ['7d', m.uptime.d7], ['30d', m.uptime.d30], ['90d', m.uptime.d90], ['365d', m.uptime.d365]] as const).map(([k, v]) => (
          <div key={k} className="card p-3"><div className="text-xs text-slate-500">{t('monitors.uptime')} {k}</div><div className={cx('mt-1 text-xl font-semibold', uptimeTone(v))}>{fmtPct(v, 3)}</div></div>
        ))}
      </div>

      <Card className="mb-4">
        <CardHeader title={t('monitors.responseTime')} actions={<Select aria-label={t('monitors.range')} value={range} onChange={(e) => setRange(e.target.value as typeof range)} className="w-auto">{RANGES.map((r) => <option key={r} value={r}>{t(`monitors.range.${r}`)}</option>)}</Select>} />
        <div className="p-4">
          {chart.isLoading ? <Loading /> : chart.error ? <ErrorBox error={chart.error} /> : chartView.x.length === 0 ? <p className="py-10 text-center text-sm text-slate-500">{t('monitors.noData')}</p> : <TimeChart x={chartView.x} ys={chartView.ys} series={chartView.series} bands={chartView.bands} />}
          {sum && <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">{([['avg', sum.avg], ['min', sum.min], ['max', sum.max], ['p50', sum.p50], ['p95', sum.p95], ['p99', sum.p99]] as const).map(([k, v]) => <div key={k}><dt className="text-slate-400">{k}</dt><dd className="font-semibold">{fmtMs(v)}</dd></div>)}</dl>}
          {chartView.bands.length > 0 && <p className="mt-2 text-xs text-slate-500"><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-red-500/30 align-middle" />{t('monitors.outageBands')}</p>}
        </div>
      </Card>

      <Card className="mb-4 p-4">
        <HeartbeatBar beats={m.recent} count={90} height="h-8" />
        <p className="mt-2 text-xs text-slate-500">{t('monitors.beatsLabel', { up: m.recent.slice(-90).filter((b) => b[1] === 1).length, total: Math.min(90, m.recent.length) })}</p>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('monitors.settings')} />
          <div className="p-4"><Dl items={[
            [t('monitors.interval'), fmtDuration(m.intervalS)], [t('monitors.timeout'), fmtDuration(m.timeoutS)], [t('monitors.retries'), `${m.retries} × ${fmtDuration(m.retryIntervalS)}`],
            [t('monitors.lastCheck'), m.lastCheckAt ? fmtDateTime(m.lastCheckAt) : '–'],
            ...Object.entries(m.config).filter(([, v]) => typeof v === 'string' && v && !String(v).startsWith('••')).slice(0, 4).map(([k, v]): [string, string] => [k, String(v)]),
          ]} /></div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />{t('monitors.tls')}</span>} />
          <div className="p-4">{m.cert ? <>
            <Dl items={[
              [t('monitors.cert.expires'), <span key="e" className={m.cert.daysLeft < 14 ? 'font-semibold text-red-600' : m.cert.daysLeft < 30 ? 'font-semibold text-amber-600' : ''}>{fmtDateTime(m.cert.validTo)} ({t('monitors.cert.days', { n: m.cert.daysLeft })})</span>],
              [t('monitors.cert.subject'), m.cert.subject], [t('monitors.cert.issuer'), m.cert.issuer],
              [t('monitors.cert.sans'), m.cert.altNames.slice(0, 6).join(', ') || '–'],
              [t('monitors.cert.fingerprint'), <code key="f" className="break-all text-xs">{m.cert.fingerprint256}</code>],
              ...(m.cert.authorized === false ? [[t('monitors.cert.trust'), <Badge key="a" tone="red">{m.cert.authError ?? t('monitors.cert.untrusted')}</Badge>] as [string, React.ReactNode]] : []),
            ]} />
            {m.cert.chain.length > 0 && <ol className="mt-3 space-y-1 text-xs text-slate-500">{m.cert.chain.map((c, i) => <li key={i}>{i + 1}. {c.subject} <span className="text-slate-400">← {c.issuer}</span></li>)}</ol>}
          </> : <p className="text-sm text-slate-500">{t('monitors.cert.none')}</p>}</div>
        </Card>
      </div>

      {m.locationStates.length > 0 && (
        <Card className="mb-4">
          <CardHeader title={t('monitors.locations')} />
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">{m.locationStates.map((l) => (
            <li key={l.locationId ?? 'local'} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <StatusDot status={l.ok ? 'up' : 'down'} /><span className="font-medium">{l.name}</span>
              <span className="text-slate-500">{fmtMs(l.latencyMs)}</span>
              {!l.ok && l.message && <span className="min-w-0 flex-1 truncate text-red-600" title={l.message}>{l.errorKind}: {l.message}</span>}
              <span className="ml-auto text-xs text-slate-400">{relTime(l.ts)}</span>
            </li>))}</ul>
        </Card>
      )}

      {m.type === 'push' && pushUrl && (
        <Card className="mb-4">
          <CardHeader title={t('monitors.push.title')} subtitle={t('monitors.push.hint')} />
          <div className="space-y-3 p-4">
            <Snippet label={t('monitors.push.url')} text={`${pushUrl}?status=up&msg=OK`} />
            <Snippet label="curl" text={`curl -fsS -m 10 "${pushUrl}?status=up&msg=OK&ping=123"`} />
          </div>
        </Card>
      )}

      {m.publicBadge && (
        <Card className="mb-4">
          <CardHeader title={t('monitors.badges')} subtitle={t('monitors.badgesHint')} />
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-3">{['status', 'uptime-30d', 'ping'].map((f) => <img key={f} src={`/badge/${m.id}/${f}.svg`} alt={f} height={20} />)}</div>
            <Snippet label="Markdown" text={`![${m.name}](${badge('status')})`} />
            <Snippet label="HTML" text={`<img src="${badge('status')}" alt="${m.name.replace(/"/g, '&quot;')} status">`} />
          </div>
        </Card>
      )}

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Heartbeats id={id} />
        <Events id={id} />
      </div>

      <Card className="mb-4">
        <CardHeader title={t('monitors.incidents')} />
        {incidents.isLoading ? <Loading /> : !incidents.data?.length ? <p className="p-4 text-sm text-slate-500">{t('monitors.noIncidents')}</p> : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">{incidents.data.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
              <Link to={`/incidents/${i.id}`} className="font-medium">{i.title}</Link><Badge tone={i.status === 'resolved' ? 'green' : 'red'}>{t(`monitors.incStatus.${i.status}`)}</Badge>
              <span className="ml-auto text-xs text-slate-500">{fmtDateTime(i.started_at)}{i.resolved_at ? ` · ${fmtDuration((new Date(i.resolved_at).getTime() - new Date(i.started_at).getTime()) / 1000)}` : ''}</span>
            </li>))}</ul>
        )}
      </Card>

      {periods.data && periods.data.length > 0 && (
        <Card className="mb-4">
          <CardHeader title={t('monitors.periods')} subtitle={t(`monitors.range.${range}`)} />
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">{periods.data.slice(0, 50).map((p, i) => {
            const st = p.status === 'down' || p.status === 0 ? 'down' : p.status === 'maintenance' || p.status === 3 ? 'maintenance' : 'up';
            return <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm"><StatusDot status={st} /><span>{t(`status.${st}`)}</span><span className="text-slate-500">{fmtDuration(p.durationS)}</span>{p.message && <span className="min-w-0 flex-1 truncate text-xs text-slate-400" title={p.message}>{p.message}</span>}<span className="ml-auto text-xs text-slate-400">{fmtDateTime(p.from)}</span></li>;
          })}</ul>
        </Card>
      )}
    </>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-500">{label}</div>
      <div className="flex items-center gap-2"><code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-slate-100 px-2 py-1.5 text-xs dark:bg-slate-800">{text}</code><MonitorCopy text={text} /></div>
    </div>
  );
}

function Heartbeats({ id }: { id: number }) {
  const t = useT();
  const q = useInfiniteQuery({
    queryKey: ['monitor', id, 'heartbeats'], initialPageParam: 0,
    queryFn: ({ pageParam }) => get<Hb[]>(`/api/monitors/${id}/heartbeats?limit=15${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (l) => (l.length >= 15 ? l[l.length - 1].id : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <Card>
      <CardHeader title={t('monitors.recentChecks')} />
      {q.isLoading ? <Loading /> : !rows.length ? <p className="p-4 text-sm text-slate-500">{t('monitors.noChecks')}</p> : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">{rows.map((h) => (
          <li key={h.id} className="flex items-center gap-2 px-4 py-2 text-sm"><StatusDot status={h.status === 1 ? 'up' : h.status === 3 ? 'maintenance' : 'down'} /><span className="w-16 text-slate-500">{fmtMs(h.latencyMs)}</span><span className="min-w-0 flex-1 truncate text-xs text-slate-400" title={h.message ?? ''}>{h.errorKind ? `${h.errorKind}: ` : ''}{h.message}</span><time className="text-xs text-slate-400" dateTime={h.ts}>{fmtDateTime(h.ts)}</time></li>))}</ul>
      )}
      {q.hasNextPage && <div className="border-t border-slate-100 p-2 text-center dark:border-slate-800"><Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('common.more')}</Button></div>}
    </Card>
  );
}

function Events({ id }: { id: number }) {
  const t = useT();
  const q = useInfiniteQuery({
    queryKey: ['monitor', id, 'events'], initialPageParam: 0,
    queryFn: ({ pageParam }) => get<Ev[]>(`/api/monitors/${id}/events?limit=15${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (l) => (l.length >= 15 ? l[l.length - 1].id : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <Card>
      <CardHeader title={t('monitors.eventLog')} />
      {q.isLoading ? <Loading /> : !rows.length ? <EmptyState title={t('monitors.noEvents')} /> : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">{rows.map((e) => (
          <li key={e.id} className="px-4 py-2 text-sm">
            <div className="flex items-center gap-2"><StatusDot status={e.to === 'down' ? 'down' : e.to === 'up' ? 'up' : e.type.startsWith('maintenance') ? 'maintenance' : 'pending'} /><span className="font-medium">{e.type === 'status_change' ? t('monitors.event.change') + (e.from && e.to ? `: ${e.from} → ${e.to}` : '') : t(`monitors.event.${e.type}`)}</span><time className="ml-auto text-xs text-slate-400" dateTime={e.ts}>{fmtDateTime(e.ts)}</time></div>
            {(e.message || e.errorKind) && <p className="ml-4 mt-0.5 break-words text-xs text-slate-500">{e.errorKind ? `${e.errorKind}: ` : ''}{e.message}</p>}
          </li>))}</ul>
      )}
      {q.hasNextPage && <div className="border-t border-slate-100 p-2 text-center dark:border-slate-800"><Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('common.more')}</Button></div>}
    </Card>
  );
}
