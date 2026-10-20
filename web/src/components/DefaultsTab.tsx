import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, CardHeader, ErrorBox, Field, Input, Loading, useConfirm, useToast } from './ui';
import { del, errorMessage, get, put } from '../lib/api';
import { useT } from '../lib/i18n';

type Key = 'intervalS' | 'timeoutS' | 'retries' | 'retryIntervalS' | 'upThreshold' | 'downThreshold' | 'flapWindow' | 'flapThreshold';
type Values = Record<Key, number>;
interface Payload { defaults: Values; builtIn: Values; limits: Record<Key, [number, number]> }
const ROWS: [Key, string][] = [
  ['intervalS', 'monitors.interval'], ['timeoutS', 'monitors.timeout'], ['retries', 'monitors.retries'], ['retryIntervalS', 'monitors.retryInterval'],
  ['upThreshold', 'monitors.upThreshold'], ['downThreshold', 'monitors.downThreshold'], ['flapWindow', 'monitors.flapWindow'], ['flapThreshold', 'monitors.flapThreshold'],
];

/** Settings tab: instance-wide defaults that pre-fill the "new monitor" form and apply when an API call omits a value. */
export function DefaultsTab() {
  const t = useT(); const toast = useToast(); const confirm = useConfirm(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['monitor-defaults', 'admin'], queryFn: () => get<Payload>('/api/settings/monitor-defaults'), staleTime: 0 });
  const [v, setV] = useState<Record<Key, string> | null>(null);
  useEffect(() => { if (q.data) setV(Object.fromEntries(Object.entries(q.data.defaults).map(([k, x]) => [k, String(x)])) as Record<Key, string>); }, [q.data]);
  const done = () => { void qc.invalidateQueries({ queryKey: ['monitor-defaults'] }); };
  const save = useMutation({
    mutationFn: () => put('/api/settings/monitor-defaults', Object.fromEntries(ROWS.map(([k]) => [k, Number(v![k])]))),
    onSuccess: () => { toast(t('common.saved')); done(); }, onError: (e) => toast(errorMessage(e), 'error'),
  });
  const reset = useMutation({ mutationFn: () => del('/api/settings/monitor-defaults'), onSuccess: () => { toast(t('settings.defaults.resetDone')); done(); }, onError: (e) => toast(errorMessage(e), 'error') });
  if (q.isLoading || !v) return q.error ? <ErrorBox error={q.error} /> : <Loading />;
  const { limits, builtIn } = q.data!;
  return (
    <Card>
      <CardHeader title={t('settings.defaults.title')} subtitle={t('settings.defaults.intro')} />
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ROWS.map(([k, label]) => (
            <Field key={k} label={t(label)} hint={t('settings.defaults.range', { min: limits[k][0], max: limits[k][1], std: builtIn[k] })}>
              {(id) => <Input id={id} type="number" required min={limits[k][0]} max={limits[k][1]} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" loading={reset.isPending} onClick={async () => { if (await confirm({ title: t('settings.defaults.reset'), body: t('settings.defaults.resetBody'), confirmLabel: t('settings.defaults.reset') })) reset.mutate(); }}><RotateCcw className="h-4 w-4" />{t('settings.defaults.reset')}</Button>
        </div>
      </form>
    </Card>
  );
}
