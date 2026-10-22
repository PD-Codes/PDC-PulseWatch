import { useState } from 'react';
import { Field, Input, Select } from './ui';
import { useT } from '../lib/i18n';

/**
 * "Report as down only after ..." as a number plus unit. The value is kept in seconds; an empty string means
 * "follow the instance-wide rule" and is only offered where `inherit` is set.
 */
export function DownDelayField({ value, onChange, inherit, hint }: { value: string; onChange: (seconds: string) => void; inherit?: boolean; hint?: string }) {
  const t = useT();
  const [unit, setUnit] = useState<'s' | 'm'>(Number(value) > 0 && Number(value) % 60 === 0 ? 'm' : 's');
  const shown = value === '' ? '' : String(unit === 'm' ? Number(value) / 60 : Number(value));
  const emit = (n: string, u: 's' | 'm') => onChange(n === '' ? (inherit ? '' : '0') : String(Math.round(Number(n) * (u === 'm' ? 60 : 1))));
  return (
    <Field label={t('delay.label')} hint={hint}>
      {(id) => (
        <div className="flex gap-2">
          <Input id={id} type="number" min={0} step={unit === 'm' ? 0.5 : 1} max={unit === 'm' ? 1440 : 86400} value={shown} placeholder={inherit ? t('delay.inherit') : '0'} onChange={(e) => emit(e.target.value, unit)} />
          <Select aria-label={t('delay.unit')} className="w-auto" value={unit} onChange={(e) => { const u = e.target.value as 's' | 'm'; setUnit(u); emit(shown, u); }}>
            <option value="s">{t('delay.seconds')}</option><option value="m">{t('delay.minutes')}</option>
          </Select>
        </div>
      )}
    </Field>
  );
}
