import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Lock, Rss, Wrench, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ServerInfoBlock } from '../components/ServerInfo';
import { Pager } from '../components/Pager';
import { Badge, Button, cx, ErrorBox, Field, Input, Loading, type Tone } from '../components/ui';
import { ApiError, get, post, type ServerInfo } from '../lib/api';
import { fmtDate, fmtDateTime, fmtPct, relTime } from '../lib/format';
import { useForcedLocale, useI18n, useT, type Locale } from '../lib/i18n';

type CompStatus = 'operational' | 'outage' | 'degraded' | 'maintenance' | 'unknown';
interface Comp { monitorId: number; name: string; description: string | null; status: CompStatus; since: string | null; info: ServerInfo | null; uptime: number | null; daily: { date: string; uptime: number | null }[] }
interface Incident { id: number; title: string; status: string; severity: 'minor' | 'major' | 'critical'; startedAt: string; resolvedAt: string | null; updates: { ts: string; kind: string; status?: string | null; body: string | null; edited?: boolean }[] }
interface Page {
  slug: string; title: string; description: string | null; language: Locale | null; branding: { logoUrl?: string; primaryColor?: string; footer?: string }; customCss: string | null; showHistory: boolean; historyDays: number;
  overall: 'operational' | 'partial' | 'outage' | 'degraded' | 'maintenance'; generatedAt: string; sections: { name: string; components: Comp[] }[]; components: Comp[];
  announcements: { id: number; kind: 'info' | 'maintenance' | 'incident'; title: string; body: string | null; startsAt: string; endsAt: string | null }[];
  maintenance: { id: number; name: string; description: string | null; endsAt: string }[]; incidents: Incident[]; recentIncidents: Incident[]; incidentDays: number; incidentPageSize: number; subscribe: { email: boolean };
}

const DOT: Record<CompStatus, string> = { operational: 'bg-emerald-500', outage: 'bg-red-500', degraded: 'bg-amber-500', maintenance: 'bg-sky-500', unknown: 'bg-slate-400' };
const TEXT: Record<CompStatus, string> = { operational: 'text-emerald-700 dark:text-emerald-400', outage: 'text-red-700 dark:text-red-400', degraded: 'text-amber-700 dark:text-amber-400', maintenance: 'text-sky-700 dark:text-sky-400', unknown: 'text-slate-500' };
const BANNER: Record<Page['overall'], { cls: string; icon: ReactNode }> = {
  operational: { cls: 'bg-emerald-600', icon: <CheckCircle2 className="h-6 w-6" /> }, partial: { cls: 'bg-red-600', icon: <XCircle className="h-6 w-6" /> }, outage: { cls: 'bg-red-700', icon: <XCircle className="h-6 w-6" /> },
  degraded: { cls: 'bg-amber-600', icon: <AlertTriangle className="h-6 w-6" /> }, maintenance: { cls: 'bg-sky-600', icon: <Wrench className="h-6 w-6" /> },
};
const SEVERITY: Record<Incident['severity'], Tone> = { minor: 'amber', major: 'red', critical: 'red' };

const barColor = (u: number | null) => (u == null ? 'bg-slate-200 dark:bg-slate-800' : u >= 99.9 ? 'bg-emerald-500' : u >= 99 ? 'bg-lime-500' : u >= 95 ? 'bg-amber-500' : 'bg-red-500');

function UptimeStrip({ comp, days }: { comp: Comp; days: number }) {
  const t = useT();
  return (
    <div className="flex h-7 items-stretch gap-px" role="img" aria-label={t('public.uptimeStrip', { n: days, pct: fmtPct(comp.uptime) })}>
      {comp.daily.map((d) => <span key={d.date} title={`${fmtDate(d.date)}: ${d.uptime == null ? t('public.noData') : fmtPct(d.uptime)}`} className={cx('min-w-px flex-1 rounded-[1px]', barColor(d.uptime))} />)}
    </div>
  );
}

function Component({ comp, history, days }: { comp: Comp; history: boolean; days: number }) {
  const t = useT();
  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><div className="truncate font-medium">{comp.name}</div>{comp.description && <div className="truncate text-xs text-slate-500">{comp.description}</div>}</div>
        <span className={cx('flex shrink-0 items-center gap-1.5 text-sm font-medium', TEXT[comp.status])}><span className={cx('h-2.5 w-2.5 rounded-full', DOT[comp.status])} aria-hidden />{t(`public.status.${comp.status}`)}</span>
      </div>
      {comp.info && <ServerInfoBlock info={comp.info} className="mt-1.5" />}
      {history && comp.daily.length > 0 && (
        <div className="mt-2">
          <UptimeStrip comp={comp} days={days} />
          <div className="mt-1 flex justify-between text-xs text-slate-500"><span>{t('public.daysAgo', { n: days })}</span><span>{t('public.uptimeValue', { pct: fmtPct(comp.uptime) })}</span><span>{t('public.today')}</span></div>
        </div>
      )}
    </li>
  );
}

const PHASES = new Set(['identified', 'fixing', 'monitoring']);

/** Resolved incidents, paged on the client: the server already limited them to the page's maximum age. */
function PastIncidents({ items, pageSize: initial, days }: { items: Incident[]; pageSize: number; days: number }) {
  const t = useT();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initial);
  const current = Math.min(page, Math.max(1, Math.ceil(items.length / pageSize)));
  return (
    <section aria-labelledby="inc-past" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="inc-past" className="text-lg font-semibold">{t('public.pastIncidents')}</h2><span className="text-xs text-slate-500">{days === 1 ? t('public.pastIncidentsDay') : t('public.pastIncidentsDays', { n: days })}</span></div>
      {items.slice((current - 1) * pageSize, current * pageSize).map((i) => <IncidentCard key={i.id} inc={i} />)}
      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 [&>nav]:border-t-0"><Pager page={current} pageSize={pageSize} total={items.length} onPage={setPage} onPageSize={setPageSize} sizes={[...new Set([5, 10, 20, 50, initial])].sort((a, b) => a - b)} /></div>
    </section>
  );
}
function IncidentCard({ inc }: { inc: Incident }) {
  const t = useT();
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{inc.title}</h3><Badge tone={SEVERITY[inc.severity]}>{t(`public.severity.${inc.severity}`)}</Badge><Badge tone={inc.resolvedAt ? 'green' : 'amber'}>{inc.resolvedAt ? t('public.resolved') : PHASES.has(inc.status) ? t(`public.phase.${inc.status}`) : t('public.ongoing')}</Badge></div>
      <p className="mt-1 text-xs text-slate-500">{fmtDateTime(inc.startedAt)}{inc.resolvedAt ? ` – ${fmtDateTime(inc.resolvedAt)}` : ''}</p>
      {inc.updates.length > 0 && (
        <ul className="mt-3 space-y-2 border-l-2 border-slate-200 pl-3 dark:border-slate-700">
          {inc.updates.map((u, i) => <li key={i} className="text-sm"><span className="text-xs text-slate-500">{fmtDateTime(u.ts)}{u.status && u.kind !== 'note' && <> · <strong className="font-semibold">{t(`public.phase.${u.status}`)}</strong></>}{u.edited && <> · {t('public.edited')}</>}</span>{(u.kind === 'postmortem' || u.body) && <p className="whitespace-pre-wrap">{u.kind === 'postmortem' ? t('public.postmortemWritten') : u.body}</p>}</li>)}
        </ul>
      )}
    </article>
  );
}

function Subscribe({ slug }: { slug: string }) {
  const t = useT();
  const { locale } = useI18n();
  const [email, setEmail] = useState('');
  const m = useMutation({ mutationFn: () => post(`/api/public/status/${encodeURIComponent(slug)}/subscribe`, { email, lang: locale }) });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  if (m.isSuccess) return <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">{t('public.subscribed')}</p>;
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Field label={t('public.subscribeEmail')} className="min-w-[14rem] flex-1">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />}</Field>
      <Button type="submit" variant="primary" loading={m.isPending}>{t('public.subscribe')}</Button>
      {m.error ? <div className="w-full"><ErrorBox error={m.error} /></div> : null}
    </form>
  );
}

function Gate({ slug, title, onUnlocked }: { slug: string; title?: string; onUnlocked: () => void }) {
  const t = useT();
  const [pw, setPw] = useState('');
  const m = useMutation({ mutationFn: () => post(`/api/public/status/${encodeURIComponent(slug)}/unlock`, { password: pw }), onSuccess: onUnlocked });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="card mx-auto mt-24 w-full max-w-sm space-y-4 p-6">
      <div className="flex flex-col items-center gap-2 text-center"><Lock className="h-8 w-8 text-slate-400" aria-hidden /><h1 className="text-lg font-semibold">{title ?? t('public.protected')}</h1><p className="text-sm text-slate-500">{t('public.passwordPrompt')}</p></div>
      {m.error ? <ErrorBox error={m.error} /> : null}
      <Field label={t('auth.password')}>{(id) => <Input id={id} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus required autoComplete="off" />}</Field>
      <Button type="submit" variant="primary" className="w-full" loading={m.isPending}>{t('public.unlock')}</Button>
    </form>
  );
}

/** Public status page. Works signed out; `slug` is passed when the page is served on its own domain. */
export default function PublicStatus({ slug: slugProp }: { slug?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const loc = useLocation();
  const params = useParams();
  const [sp, setSp] = useSearchParams();
  const { locale, setLocale } = useI18n();
  const slug = slugProp ?? params.slug ?? '';
  const [unlocked, setUnlocked] = useState(false);
  // the server words incident titles and notes in the language asked for (a page with a fixed language ignores it); switching language loads that wording, the old page stays until it arrives
  const q = useQuery({ queryKey: ['public-status', slug, locale], queryFn: () => get<Page>(`/api/public/status/${encodeURIComponent(slug)}?lang=${locale}`), placeholderData: (prev) => prev, refetchInterval: (query) => (query.state.data ? 30_000 : false), retry: false }); // no polling while the gate or an error is shown
  const page = q.data;
  useEffect(() => { if (page) document.title = page.title; }, [page]);
  // the page's own language wins; otherwise a ?lang= link; a locked page already speaks its language in the password form
  const urlLang = sp.get('lang') === 'de' || sp.get('lang') === 'en' ? (sp.get('lang') as Locale) : null;
  useForcedLocale(page ? page.language ?? urlLang : (q.error as ApiError | null)?.body?.language ?? null);
  const pick = (l: Locale) => { setLocale(l); if (sp.has('lang')) { const next = new URLSearchParams(sp); next.set('lang', l); setSp(next, { replace: true }); } };

  if (q.isLoading) return <Loading />;
  if (q.error && !page) { // a failed refresh keeps showing the last page
    const e = q.error as ApiError;
    const title: string | undefined = e.body?.title;
    if (e.status === 401 && e.code === 'password_required') return <Gate slug={slug} title={title} onUnlocked={() => { setUnlocked(true); void qc.invalidateQueries({ queryKey: ['public-status', slug] }); }} />;
    if (e.status === 401 && e.code === 'login_required') return <div className="card mx-auto mt-24 max-w-sm space-y-3 p-6 text-center"><Lock className="mx-auto h-8 w-8 text-slate-400" aria-hidden /><h1 className="text-lg font-semibold">{title ?? t('public.protected')}</h1><p className="text-sm text-slate-500">{t('public.loginRequired')}</p><Link className="btn btn-primary no-underline" to="/login" state={{ from: loc.pathname }}>{t('auth.signIn')}</Link></div>;
    return <div className="card mx-auto mt-24 max-w-sm p-6 text-center"><h1 className="text-lg font-semibold">{e.status === 403 ? t('public.forbidden') : t('public.notFound')}</h1><p className="mt-1 text-sm text-slate-500">{e.status === 403 ? t('public.forbiddenBody') : t('public.notFoundBody')}</p></div>;
  }
  if (!page) return null;

  const accent = /^#[0-9a-f]{6}$/i.test(page.branding.primaryColor ?? '') ? page.branding.primaryColor! : undefined;
  const banner = BANNER[page.overall];
  const logo = page.branding.logoUrl && /^(https?:\/\/|\/)/i.test(page.branding.logoUrl) ? page.branding.logoUrl : undefined; // no javascript: URLs
  const list = (comps: Comp[], name?: string) => (
    <section key={name ?? '_'} className="card overflow-hidden">
      {name && <h2 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold dark:border-slate-800 dark:bg-slate-800/50">{name}</h2>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">{comps.map((c) => <Component key={c.monitorId} comp={c} history={page.showHistory} days={page.historyDays} />)}</ul>
    </section>
  );

  return (
    <div className="min-h-screen" style={accent ? ({ '--accent': accent } as React.CSSProperties) : undefined}>
      {page.customCss && <style>{page.customCss}</style>}
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:py-12">
        <header className="flex items-center gap-3">
          {logo && <img src={logo} alt="" className="h-10 w-auto max-w-[8rem] object-contain" />}
          <div className="min-w-0"><h1 className="truncate text-2xl font-semibold" style={accent ? { color: accent } : undefined}>{page.title}</h1>{page.description && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{page.description}</p>}</div>
          {!page.language && (
            <div role="group" aria-label={t('public.language')} className="ml-auto flex shrink-0 overflow-hidden rounded-lg border border-slate-300 text-xs dark:border-slate-700">
              {(['en', 'de'] as const).map((l) => <button key={l} type="button" aria-pressed={locale === l} onClick={() => pick(l)} className={cx('px-2 py-1 font-medium', locale === l ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>{l.toUpperCase()}</button>)}
            </div>
          )}
        </header>

        <div role="status" className={cx('flex items-center gap-3 rounded-xl px-5 py-4 text-white shadow-sm', banner.cls)}>{banner.icon}<span className="text-lg font-semibold">{t(`public.overall.${page.overall}`)}</span></div>

        {page.announcements.map((a) => (
          <div key={a.id} className={cx('rounded-xl border px-4 py-3', a.kind === 'incident' ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40' : a.kind === 'maintenance' ? 'border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40' : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900')}>
            <div className="font-semibold">{a.title}</div>{a.body && <p className="mt-1 whitespace-pre-wrap text-sm">{a.body}</p>}<p className="mt-1 text-xs text-slate-500">{fmtDateTime(a.startsAt)}{a.endsAt ? ` – ${fmtDateTime(a.endsAt)}` : ''}</p>
          </div>
        ))}
        {page.maintenance.map((m) => (
          <div key={m.id} className="flex gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 dark:border-sky-900 dark:bg-sky-950/40"><Wrench className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" aria-hidden /><div><div className="font-semibold">{t('public.maintenanceNow', { name: m.name })}</div>{m.description && <p className="text-sm">{m.description}</p>}<p className="text-xs text-slate-500">{t('public.until', { when: fmtDateTime(m.endsAt) })}</p></div></div>
        ))}

        {page.incidents.length > 0 && <section aria-labelledby="inc-now" className="space-y-3"><h2 id="inc-now" className="text-lg font-semibold">{t('public.activeIncidents')}</h2>{page.incidents.map((i) => <IncidentCard key={i.id} inc={i} />)}</section>}

        {page.sections.map((s) => list(s.components, s.name))}
        {page.components.length > 0 && list(page.components)}
        {page.sections.length === 0 && page.components.length === 0 && <p className="text-center text-sm text-slate-500">{t('public.noComponents')}</p>}

        {page.recentIncidents.length > 0 && <PastIncidents items={page.recentIncidents} pageSize={page.incidentPageSize} days={page.incidentDays} />}

        {(page.subscribe.email || !unlocked) && (
          <section className="card space-y-3 p-4" aria-label={t('public.subscribeTitle')}>
            <h2 className="text-sm font-semibold">{t('public.subscribeTitle')}</h2>
            {page.subscribe.email && <Subscribe slug={slug} />}
            {!unlocked && <a href={`/api/public/status/${encodeURIComponent(slug)}/rss?lang=${locale}`} className="inline-flex items-center gap-1.5 text-sm"><Rss className="h-4 w-4" />{t('public.rss')}</a>}
          </section>
        )}

        <footer className="space-y-1 pt-2 text-center text-xs text-slate-500">
          {page.branding.footer && <p>{page.branding.footer}</p>}
          <p>{t('public.updated', { when: relTime(page.generatedAt) })}</p>
        </footer>
      </div>
    </div>
  );
}
