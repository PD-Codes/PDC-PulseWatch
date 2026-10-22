import { useMutation } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { jsonCompare, jsonGet, type JsonOp } from '../../../src/core/jsonpath';
import { errorMessage, post } from '../lib/api';
import { child, entries, isContainer, MAX_ITEMS, pickFor, suggestions, type Pick } from '../lib/jsonPick';
import { useT } from '../lib/i18n';
import { toConfig, type FieldDef, type FieldValues } from './MonitorFields';
import { Badge, Button, cx, ErrorBox } from './ui';

interface Fetched { status: number; statusText: string; contentType: string; ms: number; bytes: number; truncated: boolean; json: unknown; jsonError: string | null; preview: string | null }
const ASSERTION_KEYS = new Set(['jsonPath', 'jsonOp', 'jsonExpected']);

const preview = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isContainer(v)) return `{${Object.keys(v).length}}`;
  if (typeof v === 'string') return JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
  return String(v);
};
const TONE = (v: unknown) => (typeof v === 'string' ? 'text-emerald-700 dark:text-emerald-400' : typeof v === 'number' ? 'text-sky-700 dark:text-sky-400' : typeof v === 'boolean' ? 'text-violet-700 dark:text-violet-400' : 'text-slate-500');

function Node({ name, value, path, depth, selected, onPick }: { name: string; value: unknown; path: string; depth: number; selected: string; onPick: (p: Pick) => void }) {
  const t = useT();
  const [open, setOpen] = useState(depth < 1);
  const container = isContainer(value);
  const kids = container ? entries(value) : [];
  return (
    <li>
      <div className={cx('group flex items-center gap-1 rounded px-1 py-0.5 text-sm', selected === path && 'bg-brand-50 dark:bg-brand-700/20')}>
        {container ? (
          <button type="button" className="rounded p-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-expanded={open} aria-label={`${open ? t('json.collapse') : t('json.expand')} ${name}`} onClick={() => setOpen(!open)}>{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button>
        ) : <span className="w-5" aria-hidden />}
        <button type="button" className="flex min-w-0 flex-1 items-baseline gap-2 text-left" onClick={() => onPick(pickFor(path, value))} title={path}>
          <span className="font-mono text-xs font-medium">{name}</span>
          <span className={cx('truncate font-mono text-xs', container ? 'text-slate-500' : TONE(value))}>{preview(value)}</span>
        </button>
        <Button size="sm" variant="ghost" className="shrink-0 opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label={`${t('json.use')} ${path}`} onClick={() => onPick(pickFor(path, value))}>{t('json.use')}</Button>
      </div>
      {container && open && (
        <ul className="ml-3 border-l border-slate-200 pl-2 dark:border-slate-800">
          {kids.slice(0, MAX_ITEMS).map(([k, x]) => <Node key={String(k)} name={String(k)} value={x} path={child(path, k)} depth={depth + 1} selected={selected} onPick={onPick} />)}
          {kids.length > MAX_ITEMS && <li className="px-1 py-0.5 text-xs text-slate-500">{t('json.more', { n: kids.length - MAX_ITEMS })}</li>}
        </ul>
      )}
    </li>
  );
}

/** Fetches the monitor's URL once, shows the JSON as a tree and fills in the assertion fields when a value is clicked. */
export function JsonPicker({ fields, values, monitorId, onPick }: { fields: FieldDef[]; values: FieldValues; monitorId: number | null; onPick: (p: Pick) => void }) {
  const t = useT();
  const [data, setData] = useState<Fetched | null>(null);
  const run = useMutation({
    mutationFn: () => post<Fetched>('/api/monitors/fetch-json', { monitorId: monitorId ?? undefined, config: toConfig(fields.filter((f) => !ASSERTION_KEYS.has(f.key)), values) }),
    onSuccess: setData,
  });
  const path = String(values.jsonPath ?? '').trim();
  const op = (String(values.jsonOp ?? '') || 'eq') as JsonOp;
  const expected = String(values.jsonExpected ?? '');
  const ideas = useMemo(() => (data?.json != null ? suggestions(data.json) : []), [data]);

  // What the assertion currently typed in the form would say about this very response.
  const verdict = useMemo(() => {
    if (!data || data.json == null || !path) return null;
    try { const actual = jsonGet(data.json, path); return { pass: jsonCompare(actual, op, expected), actual }; } catch (e) { return { error: (e as Error).message }; }
  }, [data, path, op, expected]);

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><div className="text-sm font-semibold">{t('json.title')}</div><p className="text-xs text-slate-500">{t('json.intro')}</p></div>
        <Button variant="primary" size="sm" loading={run.isPending} disabled={!String(values.url ?? '').trim()} onClick={() => run.mutate()}><Download className="h-4 w-4" />{t('json.fetch')}</Button>
      </div>
      {run.error && <ErrorBox error={new Error(errorMessage(run.error))} />}
      {data && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge tone={data.status < 400 ? 'green' : 'amber'}>HTTP {data.status} {data.statusText}</Badge><span>{data.ms} ms</span><span>{(data.bytes / 1024).toFixed(1)} KB</span>{data.contentType && <span className="font-mono">{data.contentType.split(';')[0]}</span>}
          </div>
          {data.jsonError || data.json == null ? (
            <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p>{t('json.notJson')}</p>{data.preview && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{data.preview}</pre>}
            </div>
          ) : (
            <>
              {ideas.length > 0 && (
                <div>
                  <div className="label">{t('json.ideas')}</div>
                  <div className="flex flex-wrap gap-2">{ideas.map((i) => <button key={i.jsonPath} type="button" className="kbd cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700" onClick={() => onPick(i)}>{i.jsonPath} = {i.jsonExpected}</button>)}</div>
                </div>
              )}
              <ul className="max-h-80 overflow-auto rounded-lg border border-slate-200 p-2 dark:border-slate-800" aria-label={t('json.treeLabel')}>
                {isContainer(data.json)
                  ? entries(data.json).slice(0, MAX_ITEMS * 5).map(([k, x]) => <Node key={String(k)} name={String(k)} value={x} path={child('$', k)} depth={0} selected={path} onPick={onPick} />)
                  : <Node name="$" value={data.json} path="$" depth={0} selected={path} onPick={onPick} />}
              </ul>
              {verdict && (
                <p className="text-sm" role="status">
                  {'error' in verdict ? <span className="text-red-700 dark:text-red-400">{verdict.error}</span>
                    : verdict.pass ? <span className="text-emerald-700 dark:text-emerald-400">{t('json.pass')}</span>
                    : <span className="text-red-700 dark:text-red-400">{t('json.fail', { value: verdict.actual === undefined ? t('json.missing') : preview(verdict.actual) })}</span>}
                </p>
              )}
              <p className="hint">{t('json.hint')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
