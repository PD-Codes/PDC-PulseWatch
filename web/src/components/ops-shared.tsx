import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { get, type Group, type MonitorItem, type Tag } from '../lib/api';
import { useT } from '../lib/i18n';
import { Badge, Input, cx, type Tone } from './ui';

export const incidentTone: Record<string, Tone> = { open: 'red', acknowledged: 'amber', identified: 'violet', fixing: 'blue', monitoring: 'brand', resolved: 'green' };
/** Statuses an operator can set, in the order of an incident's life. */
export const INCIDENT_STATUSES = ['open', 'acknowledged', 'identified', 'fixing', 'monitoring', 'resolved'] as const;
export const severityTone: Record<string, Tone> = { minor: 'blue', major: 'amber', critical: 'red' };

export function IncidentStatusBadge({ status }: { status: string }) { const t = useT(); return <Badge tone={incidentTone[status] ?? 'gray'}>{t(`incidents.status.${status}`)}</Badge>; }
export function SeverityBadge({ severity }: { severity: string }) { const t = useT(); return <Badge tone={severityTone[severity] ?? 'gray'}>{t(`incidents.severity.${severity}`)}</Badge>; }

/** Shared monitors / groups / tags queries (same keys as the rest of the app so the cache is reused). */
export const useMonitorsQ = () => useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorItem[]>('/api/monitors'), staleTime: 30_000 });
export const useGroupsQ = () => useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups'), staleTime: 30_000 });
export const useTagsQ = () => useQuery({ queryKey: ['tags'], queryFn: () => get<Tag[]>('/api/tags'), staleTime: 30_000 });

/** Searchable checkbox list for picking several items. */
export function CheckList<T extends number | string>({ items, value, onChange, searchable, empty }: { items: { id: T; label: string; hint?: string }[]; value: T[]; onChange: (v: T[]) => void; searchable?: boolean; empty?: string }) {
  const t = useT();
  const [q, setQ] = useState('');
  const shown = useMemo(() => items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())), [items, q]);
  const toggle = (id: T) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700">
      {searchable && <div className="border-b border-slate-200 p-2 dark:border-slate-700"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} aria-label={t('common.search')} className="py-1" /></div>}
      <ul className="max-h-44 overflow-y-auto p-1">
        {shown.length === 0 && <li className="px-2 py-3 text-center text-sm text-slate-500">{empty ?? t('common.noResults')}</li>}
        {shown.map((i) => (
          <li key={String(i.id)}>
            <label className={cx('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800')}>
              <input type="checkbox" checked={value.includes(i.id)} onChange={() => toggle(i.id)} className="h-4 w-4 rounded border-slate-300" />
              <span className="truncate">{i.label}</span>{i.hint && <span className="ml-auto shrink-0 text-xs text-slate-400">{i.hint}</span>}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Monitor checklist with one-click group chips: a chip (re)selects every monitor of that group and its subgroups. */
export function MonitorPicker({ monitors, groups, value, onChange }: { monitors: MonitorItem[]; groups: Group[]; value: number[]; onChange: (v: number[]) => void }) {
  const t = useT();
  const chips = useMemo(() => {
    const kids = new Map<number | null, number[]>();
    for (const g of groups) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g.id]);
    const sub = (id: number, seen = new Set<number>()): number[] => (seen.has(id) ? [] : (seen.add(id), [id, ...(kids.get(id) ?? []).flatMap((k) => sub(k, seen))]));
    return groups.map((g) => { const gs = new Set(sub(g.id)); return { g, ids: monitors.filter((m) => m.groupId != null && gs.has(m.groupId)).map((m) => m.id) }; }).filter((c) => c.ids.length);
  }, [monitors, groups]);
  const toggle = (ids: number[]) => onChange(ids.every((i) => value.includes(i)) ? value.filter((v) => !ids.includes(v)) : [...new Set([...value, ...ids])]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('picker.groups')}>
        {chips.map(({ g, ids }) => {
          const on = ids.every((i) => value.includes(i));
          return <button key={g.id} type="button" aria-pressed={on} onClick={() => toggle(ids)} className={cx('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500', on ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-200' : 'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800')}>{g.name}<span className="text-slate-500">{ids.length}</span></button>;
        })}
        <button type="button" className="ml-auto text-xs underline" onClick={() => onChange(monitors.map((m) => m.id))}>{t('picker.all')}</button>
        <button type="button" className="text-xs underline" onClick={() => onChange([])}>{t('picker.none')}</button>
      </div>
      <CheckList searchable items={monitors.map((m) => ({ id: m.id, label: m.name, hint: m.type }))} value={value} onChange={onChange} />
    </div>
  );
}

/** Timezone names the browser knows, with UTC first. */
export const timeZones: string[] = (() => { try { const z = (Intl as any).supportedValuesOf('timeZone') as string[]; return ['UTC', ...z.filter((x) => x !== 'UTC')]; } catch { return ['UTC']; } })();
