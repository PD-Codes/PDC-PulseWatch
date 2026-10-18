import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, LogOut, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, cx } from '../components/ui';
import { displayStatus, HeartbeatBar, StatusDot, type DisplayStatus } from '../components/status';
import { get, type Group, type MonitorItem } from '../lib/api';
import { fmtMs, fmtPct } from '../lib/format';
import { useT } from '../lib/i18n';

const ROTATE_MS = 12_000;
const TILE_W = 260;
const TILE_H = 150;
const RANK: Partial<Record<DisplayStatus, number>> = { down: 0, pending: 1, suppressed: 2, maintenance: 3, unknown: 4, up: 5, paused: 6 };
const TONE: Record<string, string> = { down: 'border-red-500 bg-red-950/60', maintenance: 'border-sky-500 bg-sky-950/50', up: 'border-emerald-700 bg-emerald-950/40' };

export default function Kiosk() {
  const t = useT();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const groupId = Number(params.get('group')) || null;
  const body = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1280, h: 720 });
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(() => new Date());

  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors'), refetchInterval: 30_000 });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups'), enabled: groupId != null });

  useEffect(() => { document.title = `${t('kiosk.title')} · PulseWatch`; }, [t]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') nav('/'); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [nav]);
  useEffect(() => { const i = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const list = useMemo(() => {
    let all = (monitors.data ?? []).filter((m) => m.active || displayStatus(m) !== 'paused');
    if (groupId != null) {
      const ids = new Set([groupId]);
      for (let grew = true; grew;) { grew = false; for (const g of groups.data ?? []) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) { ids.add(g.id); grew = true; } }
      all = all.filter((m) => m.groupId != null && ids.has(m.groupId));
    }
    return all.filter((m) => displayStatus(m) !== 'paused').sort((a, b) => (RANK[displayStatus(a)] ?? 9) - (RANK[displayStatus(b)] ?? 9) || a.name.localeCompare(b.name));
  }, [monitors.data, groups.data, groupId]);

  const cols = Math.max(1, Math.floor(size.w / TILE_W));
  const rows = Math.max(1, Math.floor(size.h / TILE_H));
  const perPage = cols * rows;
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  const cur = Math.min(page, pages - 1);

  useEffect(() => {
    if (pages < 2) { setPage(0); return; }
    const i = setInterval(() => setPage((p) => (p + 1) % pages), ROTATE_MS);
    return () => clearInterval(i);
  }, [pages]);

  const down = list.filter((m) => displayStatus(m) === 'down').length;
  const ok = down === 0;
  const visible = list.slice(cur * perPage, (cur + 1) * perPage);

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-white">
      <header className={cx('flex items-center gap-4 px-6 py-4', ok ? 'bg-emerald-700' : 'bg-red-700')} role="status" aria-live="polite">
        {ok ? <CheckCircle2 className="h-10 w-10 shrink-0" aria-hidden /> : <TriangleAlert className="h-10 w-10 shrink-0" aria-hidden />}
        <h1 className="min-w-0 flex-1 truncate text-2xl font-bold sm:text-4xl">{ok ? t('kiosk.allUp') : t('kiosk.someDown', { n: down })}</h1>
        <time className="hidden text-3xl font-semibold tabular-nums sm:block" dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        <Button size="sm" onClick={() => nav('/')} aria-label={t('kiosk.exit')}><LogOut className="h-4 w-4" /><span className="hidden sm:inline">{t('kiosk.exit')} (Esc)</span></Button>
      </header>

      <div ref={body} className="min-h-0 flex-1 p-4">
        {monitors.isLoading ? <p className="p-8 text-center text-slate-400">{t('common.loading')}</p> : list.length === 0 ? <p className="p-8 text-center text-2xl text-slate-400">{t('kiosk.empty')}</p> : (
          <ul className="grid h-full gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
            {visible.map((m) => {
              const s = displayStatus(m);
              return (
                <li key={m.id} className={cx('flex min-h-0 flex-col justify-between overflow-hidden rounded-2xl border-2 p-4', TONE[s] ?? 'border-slate-600 bg-slate-900')}>
                  <div className="flex items-start gap-2"><StatusDot status={s} pulse className="mt-2 h-3 w-3" /><span className="min-w-0 flex-1 truncate text-xl font-semibold leading-tight">{m.name}</span></div>
                  <HeartbeatBar beats={m.recent} count={30} height="h-6" />
                  <div className="flex items-end justify-between text-slate-300"><span className="text-2xl font-bold tabular-nums text-white">{fmtMs(m.latencyMs)}</span><span className="text-sm"><span className="sr-only">{t('monitors.uptime')} 24h </span>{fmtPct(m.uptime.h24, 2)} · {t(`status.${s}`)}</span></div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {pages > 1 && (
        <nav className="flex items-center justify-center gap-2 pb-3" aria-label={t('kiosk.pages')}>
          {Array.from({ length: pages }, (_, i) => <button key={i} type="button" onClick={() => setPage(i)} aria-label={t('kiosk.page', { n: i + 1 })} aria-current={i === cur} className={cx('h-2.5 rounded-full transition-all', i === cur ? 'w-8 bg-white' : 'w-2.5 bg-slate-600')} />)}
        </nav>
      )}
    </div>
  );
}
