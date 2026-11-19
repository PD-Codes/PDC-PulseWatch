import { Download } from 'lucide-react';
import { useState } from 'react';
import { download, qs } from '../lib/api';
import { useI18n, useT } from '../lib/i18n';
import { Button, cx, Field, Input, Modal } from './ui';

type Kind = 'heartbeats' | 'events';
type Preset = '24h' | '7d' | '14d' | '30d' | 'custom';
const HOURS: Record<Exclude<Preset, 'custom'>, number> = { '24h': 24, '7d': 168, '14d': 336, '30d': 720 };

/** "2026-11-19T08:00" in browser time, as datetime-local wants it. */
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Export button with a small dialog: what (checks or events), which period, in the language of the interface. */
export function ExportCsvButton({ monitorId }: { monitorId: number }) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('events');
  const [preset, setPreset] = useState<Preset>('7d');
  const [from, setFrom] = useState(() => localInput(new Date(Date.now() - 7 * 86_400_000)));
  const [to, setTo] = useState(() => localInput(new Date()));
  const range = (): [Date, Date] | null => {
    if (preset !== 'custom') { const end = new Date(); return [new Date(end.getTime() - HOURS[preset] * 3_600_000), end]; }
    const a = new Date(from), b = new Date(to);
    return Number.isFinite(a.getTime()) && Number.isFinite(b.getTime()) && a < b ? [a, b] : null;
  };
  const r = range();
  const go = () => {
    if (!r) return;
    download(`/api/monitors/${monitorId}/export.csv${qs({ kind, from: r[0].toISOString(), to: r[1].toISOString(), lang: locale })}`);
    setOpen(false);
  };
  const seg = (on: boolean) => cx('rounded-md px-2.5 py-1 text-sm font-medium', on ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800');
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} title={t('mux.export.title')}><Download className="h-4 w-4" />{t('mux.export.button')}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('mux.export.title')}
        footer={<><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button variant="primary" disabled={!r} onClick={go}><Download className="h-4 w-4" />{t('mux.export.download')}</Button></>}>
        <div className="space-y-4">
          <fieldset>
            <legend className="label">{t('mux.export.kind')}</legend>
            <div className="inline-flex gap-1 rounded-lg border border-slate-200 p-0.5 dark:border-slate-700" role="radiogroup">
              {(['events', 'heartbeats'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={seg(kind === k)}>{t(`mux.export.${k}`)}</button>)}
            </div>
            <p className="hint">{t(kind === 'heartbeats' ? 'mux.export.heartbeatsHint' : 'mux.export.eventsHint')}</p>
          </fieldset>
          <fieldset>
            <legend className="label">{t('mux.export.range')}</legend>
            <div className="inline-flex flex-wrap gap-1 rounded-lg border border-slate-200 p-0.5 dark:border-slate-700" role="radiogroup">
              {(['24h', '7d', '14d', '30d', 'custom'] as const).map((p) => <button key={p} type="button" role="radio" aria-checked={preset === p} onClick={() => setPreset(p)} className={seg(preset === p)}>{t(`mux.export.p.${p}`)}</button>)}
            </div>
            {preset === 'custom' && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={t('common.from')} error={!r ? t('mux.export.badRange') : undefined}>{(id) => <Input id={id} type="datetime-local" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
                <Field label={t('common.to')}>{(id) => <Input id={id} type="datetime-local" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
              </div>
            )}
            {kind === 'heartbeats' && (preset === '30d' || preset === 'custom') && <p className="hint">{t('mux.export.retention')}</p>}
          </fieldset>
        </div>
      </Modal>
    </>
  );
}
