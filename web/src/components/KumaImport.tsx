import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage, get, post, upload } from '../lib/api';
import { useT } from '../lib/i18n';
import { ReportView, type Report } from './ImportReport';
import { CopyButton } from './settingsParts';
import { Badge, Button, Card, CardHeader, Field, Input, Select, useToast } from './ui';

interface Unsupported { kind: string; name: string; reason: string }
interface Items {
  groups: { path: string; exists: boolean }[]; tags: { name: string; exists: boolean }[]; channels: { name: string; type: string; exists: boolean; notes?: string[] }[];
  monitors: { name: string; type: string; group: string | null; exists: boolean; notes?: string[] }[];
  maintenance: { name: string; kind: string; targets: number; exists: boolean; notes?: string[] }[];
  statusPages: { slug: string; title: string; components: number; exists: boolean; notes?: string[] }[];
  /** Things Uptime Kuma has that have no equivalent here; only listed, never selectable. */
  unsupported: Unsupported[];
}
type Preview = Report & { previewId: string; items: Items };
interface Job { state: 'running' | 'done' | 'error'; phase: string; done: number; total: number; report?: Report; error?: string }
type Section = Exclude<keyof Items, 'unsupported'>;
/** `notes` are details of that one item that could not be carried over (shown in amber below the row). */
interface Row { key: string; label: string; detail?: string; exists: boolean; notes?: string[] }

const SECTIONS: Section[] = ['statusPages', 'monitors', 'maintenance', 'groups', 'channels', 'tags'];
const rowsOf = (items: Items, s: Section): Row[] => {
  switch (s) {
    case 'groups': return items.groups.map((g) => ({ key: g.path, label: g.path, exists: g.exists }));
    case 'tags': return items.tags.map((x) => ({ key: x.name, label: x.name, exists: x.exists }));
    case 'channels': return items.channels.map((c) => ({ key: c.name, label: c.name, detail: c.type, exists: c.exists, notes: c.notes }));
    case 'monitors': return items.monitors.map((m) => ({ key: m.name, label: m.name, detail: m.group ? `${m.type} · ${m.group}` : m.type, exists: m.exists, notes: m.notes }));
    case 'maintenance': return items.maintenance.map((m) => ({ key: m.name, label: m.name, detail: m.kind, exists: m.exists, notes: m.notes }));
    case 'statusPages': return items.statusPages.map((p) => ({ key: p.slug, label: p.title, detail: `/${p.slug}`, exists: p.exists, notes: p.notes }));
  }
};
// CSV cells that start with = + - @ would run as a formula when the file is opened in a spreadsheet; the names come from another system
const csvCell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

function Bar({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="space-y-1">
      <div className="text-sm" aria-live="polite">{label}</div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value)} className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={`h-full rounded-full bg-brand-600 transition-[width] ${value === null ? 'w-1/3 animate-pulse' : ''}`} style={value === null ? undefined : { width: `${Math.min(100, Math.max(2, value))}%` }} />
      </div>
    </div>
  );
}

/** One import section: master checkbox, optional filter, and a scrollable list of items with "new" / "exists" badges. */
function SelectionList({ section, rows, selected, onChange }: { section: Section; rows: Row[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const shown = useMemo(() => (q ? rows.filter((r) => r.label.toLowerCase().includes(q.toLowerCase())) : rows), [rows, q]);
  const all = selected.size === rows.length;
  const master = useRef<HTMLInputElement>(null);
  useEffect(() => { if (master.current) master.current.indeterminate = selected.size > 0 && !all; }, [selected.size, all]);
  if (!rows.length) return null;
  const toggle = (k: string) => { const n = new Set(selected); if (n.has(k)) n.delete(k); else n.add(k); onChange(n); };
  return (
    <details className="rounded-lg border border-slate-200 dark:border-slate-800" open={section === 'statusPages' || section === 'monitors'}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3">
        <input ref={master} type="checkbox" checked={all} aria-label={`${t(`settings.backup.section.${section}`)}: ${t('kuma.select.all')}`} onClick={(e) => e.stopPropagation()} onChange={() => onChange(all ? new Set() : new Set(rows.map((r) => r.key)))} />
        <span className="font-medium">{t(`settings.backup.section.${section}`)}</span>
        <span className="text-sm text-slate-500">{selected.size} / {rows.length}</span>
        <span className="ml-auto text-xs text-slate-500">{t(`kuma.hint.${section}`)}</span>
      </summary>
      <div className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800">
        {rows.length > 12 && <Input aria-label={t('kuma.select.filter')} placeholder={t('kuma.select.filter')} value={q} onChange={(e) => setQ(e.target.value)} />}
        <ul className="max-h-64 divide-y divide-slate-100 overflow-auto dark:divide-slate-800">
          {shown.map((r, n) => (
            <li key={`${n}:${r.key}`}>
              <label className="flex cursor-pointer items-center gap-2 py-1.5 text-sm">
                <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} />
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.detail && <span className="truncate text-xs text-slate-500">{r.detail}</span>}
                <Badge tone={r.exists ? 'amber' : 'green'}>{t(r.exists ? 'kuma.exists' : 'kuma.new')}</Badge>
              </label>
              {r.notes && <ul aria-label={t('kuma.notes.label')} className="mb-1.5 ml-6 list-disc space-y-0.5 pl-4 text-xs text-amber-700 dark:text-amber-300">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** Everything Uptime Kuma has that cannot be taken over, greyed out and without checkboxes, so that nothing disappears silently. Can be copied or downloaded as CSV. */
function UnsupportedList({ items }: { items: Unsupported[] }) {
  const t = useT();
  if (!items.length) return null;
  const kind = (k: string) => { const key = `kuma.kind.${k}`; const v = t(key); return v === key ? k : v; };
  const rows = [...items].sort((a, b) => kind(a.kind).localeCompare(kind(b.kind)) || a.name.localeCompare(b.name));
  const text = rows.map((u) => `${kind(u.kind)}\t${u.name}\t${u.reason}`).join('\n');
  const download = () => {
    const head = [t('kuma.unsupported.col.kind'), t('kuma.unsupported.col.name'), t('kuma.unsupported.col.reason')];
    const csv = [head, ...rows.map((u) => [kind(u.kind), u.name, u.reason])].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'uptime-kuma-not-imported.csv'; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3">
        <span className="font-medium text-slate-600 dark:text-slate-300">{t('kuma.unsupported.title', { n: rows.length })}</span>
        <span className="ml-auto text-xs text-slate-500">{t('kuma.unsupported.hint')}</span>
      </summary>
      <div className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800">
        <div className="flex flex-wrap gap-2">
          <CopyButton text={text} label={t('kuma.unsupported.copy')} />
          <Button size="sm" onClick={download}><Download className="h-3.5 w-3.5" />{t('kuma.unsupported.csv')}</Button>
        </div>
        <div className="max-h-72 overflow-auto text-slate-600 dark:text-slate-400">
          <table className="tbl">
            <thead><tr><th scope="col">{t('kuma.unsupported.col.kind')}</th><th scope="col">{t('kuma.unsupported.col.name')}</th><th scope="col">{t('kuma.unsupported.col.reason')}</th></tr></thead>
            <tbody>{rows.map((u, i) => <tr key={i}><td className="whitespace-nowrap">{kind(u.kind)}</td><td className="break-all">{u.name}</td><td>{u.reason}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

/** Uptime Kuma 1.x/2.x: database file upload or live API login, previewed first; the admin picks what to take over and watches the progress. */
export function KumaImport() {
  const t = useT(); const toast = useToast(); const qc = useQueryClient();
  const [mode, setMode] = useState<'db' | 'api'>('db');
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState({ url: '', username: '', password: '', token: '' });
  const [needToken, setNeedToken] = useState(false);
  const [sent, setSent] = useState<{ loaded: number; total: number } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sel, setSel] = useState<Record<Section, Set<string>> | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [left, setLeft] = useState<Unsupported[]>([]); // kept after the import so the admin can still copy it

  const read = useMutation({
    mutationFn: async () => {
      setSent(null);
      return mode === 'db' ? upload<Preview>('/api/import/kuma-db', file!, (loaded, total) => setSent({ loaded, total })) : post<Preview>('/api/import/kuma-api', { ...f, token: f.token || undefined });
    },
    onSuccess: (r) => {
      setPreview(r); setLeft(r.items.unsupported ?? []); setNeedToken(false); setJob(null); setJobId(null);
      // Existing channels, monitors and pages would be overwritten, so they start unticked; groups and tags only gain a color or description.
      setSel(Object.fromEntries(SECTIONS.map((s) => [s, new Set(rowsOf(r.items, s).filter((x) => !x.exists || s === 'groups' || s === 'tags').map((x) => x.key))])) as Record<Section, Set<string>>);
      toast(t('settings.backup.dryDone'));
    },
    onError: (e) => { setPreview(null); setSel(null); setLeft([]); if (e instanceof ApiError && e.code === 'token_required') { setNeedToken(true); toast(t('settings.kuma.tokenNeeded'), 'error'); } else toast(errorMessage(e), 'error'); },
    onSettled: () => setSent(null),
  });

  const apply = useMutation({
    mutationFn: () => {
      // a section that is fully selected is sent as "all" so that nothing created by the source in between is missed
      const selection = Object.fromEntries(SECTIONS.filter((s) => sel![s].size !== rowsOf(preview!.items, s).length).map((s) => [s, [...sel![s]]]));
      return post<{ jobId: string }>('/api/import/kuma-apply', { previewId: preview!.previewId, selection });
    },
    onSuccess: (r) => { setJob({ state: 'running', phase: 'starting', done: 0, total: 0 }); setJobId(r.jobId); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  useEffect(() => {
    if (!jobId) return;
    let stop = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await get<Job>(`/api/import/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.state === 'running') { timer = setTimeout(tick, 600); return; }
        setPreview(null); setSel(null);
        void qc.invalidateQueries();
        toast(j.state === 'done' ? t('settings.backup.applied') : t('kuma.failed', { msg: j.error ?? '' }), j.state === 'done' ? undefined : 'error');
      } catch (e) { if (!stop) { toast(errorMessage(e), 'error'); setJobId(null); setJob(null); } }
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const canRead = mode === 'db' ? !!file : !!(f.url && f.username && f.password);
  const picked = sel ? SECTIONS.reduce((n, s) => n + sel[s].size, 0) : 0;
  const clean = !!preview && preview.errors.length === 0;
  const running = job?.state === 'running';
  const uploading = read.isPending && mode === 'db';
  const pct = sent ? (sent.loaded / sent.total) * 100 : 0;

  return (
    <Card>
      <CardHeader title={t('settings.kuma.title')} subtitle={t('settings.kuma.intro')} />
      <div className="space-y-4 p-4">
        <Field label={t('settings.kuma.source')}>{(id) => <Select id={id} value={mode} disabled={read.isPending || running} onChange={(e) => { setMode(e.target.value as 'db' | 'api'); setPreview(null); setSel(null); setLeft([]); }}><option value="db">{t('settings.kuma.db')}</option><option value="api">{t('settings.kuma.api')}</option></Select>}</Field>
        {mode === 'db' ? (
          <Field label={t('settings.kuma.dbFile')} hint={t('settings.kuma.dbHint')}>{(id) => <input id={id} type="file" accept=".db,.sqlite,.sqlite3,application/octet-stream" className="input" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setSel(null); setLeft([]); }} />}</Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('settings.kuma.url')} className="sm:col-span-2" hint={t('settings.kuma.urlHint')}>{(id) => <Input id={id} placeholder="https://kuma.example.com" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />}</Field>
            <Field label={t('settings.kuma.username')}>{(id) => <Input id={id} autoComplete="off" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />}</Field>
            <Field label={t('settings.kuma.password')}>{(id) => <Input id={id} type="password" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
            {needToken && <Field label={t('settings.kuma.token')}>{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />}</Field>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!canRead || running} loading={read.isPending} onClick={() => read.mutate()}>{t('kuma.read')}</Button>
        </div>
        {uploading && <Bar value={sent && pct < 100 ? pct : sent ? null : 0} label={sent && pct < 100 ? t('kuma.uploading', { pct: Math.round(pct), done: mb(sent.loaded), total: mb(sent.total) }) : t('kuma.reading')} />}
        {read.isPending && mode === 'api' && <Bar value={null} label={t('kuma.connecting')} />}

        {preview && sel && !job && (
          <section className="space-y-3" aria-label={t('kuma.select.title')}>
            <div><h3 className="font-medium">{t('kuma.select.title')}</h3><p className="hint">{t('kuma.select.hint')}</p></div>
            {SECTIONS.some((s) => s !== 'groups' && s !== 'tags' && rowsOf(preview.items, s).some((x) => x.exists)) && <p className="hint">{t('kuma.existsHint')}</p>}
            <div className="space-y-2">{SECTIONS.map((s) => <SelectionList key={s} section={s} rows={rowsOf(preview.items, s)} selected={sel[s]} onChange={(n) => setSel({ ...sel, [s]: n })} />)}</div>
            <UnsupportedList items={left} />
            <ReportView report={preview} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={!clean || picked === 0} loading={apply.isPending} onClick={() => apply.mutate()}><Upload className="h-4 w-4" />{t('kuma.apply', { n: picked })}</Button>
              {!clean && <span className="hint">{t('kuma.fixErrors')}</span>}
              {clean && picked === 0 && <span className="hint">{t('kuma.nothingSelected')}</span>}
            </div>
          </section>
        )}

        {job && (
          <section className="space-y-3">
            {running && <Bar value={job.total ? (job.done / job.total) * 100 : null} label={t('kuma.running', { phase: t(`kuma.phase.${job.phase}`), done: job.done, total: job.total })} />}
            {job.state === 'error' && <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">{t('kuma.failed', { msg: job.error ?? '' })}</div>}
            {job.report && <ReportView report={job.report} />}
            {!running && <UnsupportedList items={left} />}
          </section>
        )}
      </div>
    </Card>
  );
}
