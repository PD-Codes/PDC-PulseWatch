import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, Input, Modal, Select } from './ui';
import { get, type Group, type Tag } from '../lib/api';
import { useT } from '../lib/i18n';

interface Named { id: number; name: string }
interface Rule { channelId: number | null; policyId: number | null; events: string[] }
const EVENTS = ['down', 'up', 'flap', 'cert'] as const;
const NUMS = [
  ['intervalS', 'monitors.interval', 5, 86400], ['timeoutS', 'monitors.timeout', 1, 300], ['retries', 'monitors.retries', 0, 100], ['retryIntervalS', 'monitors.retryInterval', 5, 3600],
  ['upThreshold', 'monitors.upThreshold', 1, 20], ['flapWindow', 'monitors.flapWindow', 4, 60], ['flapThreshold', 'monitors.flapThreshold', 0, 60],
] as const;
type NumKey = (typeof NUMS)[number][0];

const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Bulk edit dialog: every field left on "keep"/empty stays untouched on the selected monitors. */
export function BulkEditModal({ open, onClose, count, groups, tags, onSubmit }: { open: boolean; onClose: () => void; count: number; groups: Group[]; tags: Tag[]; onSubmit: (p: object) => void }) {
  const t = useT();
  const [nums, setNums] = useState<Partial<Record<NumKey, string>>>({});
  const [group, setGroup] = useState('');
  const [badge, setBadge] = useState('');
  const [addTags, setAddTags] = useState<number[]>([]);
  const [removeTags, setRemoveTags] = useState<number[]>([]);
  const [notifyMode, setNotifyMode] = useState<'' | 'add' | 'replace'>('');
  const [rules, setRules] = useState<Rule[]>([{ channelId: null, policyId: null, events: ['down', 'up', 'flap'] }]);
  const channels = useQuery({ queryKey: ['notification-channels'], queryFn: () => get<Named[]>('/api/notification-channels'), enabled: open });
  const policies = useQuery({ queryKey: ['escalation-policies'], queryFn: () => get<Named[]>('/api/escalation-policies'), enabled: open });

  const submit = () => {
    const patch: Record<string, unknown> = {};
    for (const [k] of NUMS) if (nums[k]) patch[k] = Number(nums[k]);
    if (group) patch.groupId = group === 'none' ? null : Number(group);
    if (badge) patch.publicBadge = badge === 'yes';
    if (addTags.length) patch.addTagIds = addTags;
    if (removeTags.length) patch.removeTagIds = removeTags;
    if (notifyMode) patch.notifications = { mode: notifyMode, rules: rules.filter((r) => r.channelId || r.policyId) };
    onSubmit(patch);
  };
  const empty = !Object.values(nums).some(Boolean) && !group && !badge && !addTags.length && !removeTags.length && !notifyMode;
  const chips = (list: number[], set: (v: number[]) => void) => (
    <div className="flex flex-wrap gap-1.5">{tags.map((x) => <button key={x.id} type="button" aria-pressed={list.includes(x.id)} onClick={() => set(toggleIn(list, x.id))} className="rounded-full border px-2.5 py-1 text-xs" style={list.includes(x.id) ? { background: x.color, borderColor: x.color, color: '#fff' } : { borderColor: x.color }}>{x.name}</button>)}</div>
  );

  return (
    <Modal open={open} wide onClose={onClose} title={t('bulk.title', { n: count })} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={empty} onClick={submit}>{t('common.apply')}</Button></>}>
      <p className="mb-3 text-sm text-slate-500">{t('dashboard.bulkHint')}</p>
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-4">
          {NUMS.map(([k, label, min, max]) => (
            <Field key={k} label={t(label)}>{(id) => <Input id={id} type="number" min={min} max={max} placeholder={t('bulk.keep')} value={nums[k] ?? ''} onChange={(e) => setNums({ ...nums, [k]: e.target.value })} />}</Field>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('monitors.group')}>{(id) => <Select id={id} value={group} onChange={(e) => setGroup(e.target.value)}><option value="">{t('dashboard.keep')}</option><option value="none">{t('monitors.noGroup')}</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}</Field>
          <Field label={t('monitors.form.publicBadge')}>{(id) => <Select id={id} value={badge} onChange={(e) => setBadge(e.target.value)}><option value="">{t('dashboard.keep')}</option><option value="yes">{t('bulk.on')}</option><option value="no">{t('bulk.off')}</option></Select>}</Field>
        </div>
        {tags.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset><legend className="label">{t('dashboard.addTag')}</legend>{chips(addTags, setAddTags)}</fieldset>
            <fieldset><legend className="label">{t('dashboard.removeTag')}</legend>{chips(removeTags, setRemoveTags)}</fieldset>
          </div>
        )}
        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="label px-1">{t('monitors.form.notifications')}</legend>
          <Select aria-label={t('monitors.form.notifications')} value={notifyMode} onChange={(e) => setNotifyMode(e.target.value as typeof notifyMode)}>
            <option value="">{t('dashboard.keep')}</option><option value="add">{t('bulk.notifyAdd')}</option><option value="replace">{t('bulk.notifyReplace')}</option>
          </Select>
          {notifyMode && (
            <>
              {rules.map((r, i) => {
                const patch = (p: Partial<Rule>) => setRules(rules.map((x, n) => (n === i ? { ...x, ...p } : x)));
                return (
                  <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <Select aria-label={t('monitors.form.channel')} value={r.channelId ?? ''} onChange={(e) => patch({ channelId: e.target.value ? Number(e.target.value) : null })}><option value="">{t('monitors.form.channel')}</option>{channels.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
                    <Select aria-label={t('monitors.form.policy')} value={r.policyId ?? ''} onChange={(e) => patch({ policyId: e.target.value ? Number(e.target.value) : null })}><option value="">{t('monitors.form.policy')}</option>{policies.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
                    <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => setRules(rules.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4" /></Button>
                    <div className="flex flex-wrap gap-3 sm:col-span-3">{EVENTS.map((ev) => <label key={ev} className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={r.events.includes(ev)} onChange={() => patch({ events: toggleIn(r.events, ev) })} />{t(`monitors.form.event.${ev}`)}</label>)}</div>
                  </div>
                );
              })}
              <Button size="sm" onClick={() => setRules([...rules, { channelId: null, policyId: null, events: ['down', 'up', 'flap'] }])}><Plus className="h-4 w-4" />{t('monitors.form.addRule')}</Button>
              {notifyMode === 'replace' && <p className="text-xs text-amber-600">{t('bulk.replaceWarn')}</p>}
            </>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}
