import { Plus, X } from 'lucide-react';
import { Button, Field, Input, Select, Textarea, Toggle } from './ui';
import { useT } from '../lib/i18n';

export type FieldKind = 'text' | 'number' | 'bool' | 'select' | 'textarea' | 'secret' | 'kv' | 'json' | 'codes';
export interface FieldDef {
  key: string; label: string; kind: FieldKind; required?: boolean; default?: unknown;
  options?: { value: string; label: string }[]; min?: number; max?: number; placeholder?: string; help?: string;
  showIf?: { key: string; equals: unknown }; secretValues?: boolean;
}
export interface MonitorType { type: string; label: string; category: string; fields: FieldDef[] }

/** Form-side value: numbers stay strings while typing, kv is a pair list, json is its text. */
export type FieldValue = string | boolean | [string, string][];
export type FieldValues = Record<string, FieldValue>;

export const isVisible = (f: FieldDef, v: FieldValues) => !f.showIf || String(v[f.showIf.key] ?? '') === String(f.showIf.equals);

/** Build editable values from a stored config, falling back to field defaults. */
export function initValues(fields: FieldDef[], config: Record<string, unknown> = {}): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    const raw = config[f.key] ?? f.default;
    if (f.kind === 'bool') out[f.key] = !!raw;
    else if (f.kind === 'kv') out[f.key] = Object.entries((raw as Record<string, string>) ?? {}).map(([k, x]) => [k, String(x)]);
    else if (f.kind === 'json') out[f.key] = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    else if (f.kind === 'codes') out[f.key] = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
    else out[f.key] = raw == null ? '' : String(raw);
  }
  return out;
}

/** Convert form values back to a config object; hidden and empty optional fields are omitted. Throws on invalid JSON. */
export function toConfig(fields: FieldDef[], v: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!isVisible(f, v)) continue;
    const x = v[f.key];
    if (f.kind === 'bool') out[f.key] = !!x;
    else if (f.kind === 'kv') { const o = Object.fromEntries((x as [string, string][]).filter(([k]) => k.trim()).map(([k, val]) => [k.trim(), val])); if (Object.keys(o).length) out[f.key] = o; }
    else if (f.kind === 'json') { if (String(x).trim()) { try { out[f.key] = JSON.parse(String(x)); } catch { throw new Error(`${f.label}: invalid JSON`); } } }
    else if (f.kind === 'number') { if (x !== '') out[f.key] = Number(x); }
    else if (x !== '' || f.required) out[f.key] = x;
  }
  return out;
}

export function MonitorFields({ fields, values, onChange, idPrefix }: { fields: FieldDef[]; values: FieldValues; onChange: (key: string, v: FieldValue) => void; idPrefix: string }) {
  const t = useT();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.filter((f) => isVisible(f, values)).map((f) => {
        const label = f.required ? `${f.label} *` : f.label;
        const wide = f.kind === 'textarea' || f.kind === 'kv' || f.kind === 'json' ? 'sm:col-span-2' : undefined;
        const val = values[f.key] ?? (f.kind === 'kv' ? [] : ''); // defaults are seeded in an effect, so the first render can be empty
        if (f.kind === 'bool') return <div key={f.key} className={wide}><Toggle checked={!!val} onChange={(c) => onChange(f.key, c)} label={f.label} />{f.help && <p className="hint">{f.help}</p>}</div>;
        if (f.kind === 'kv') {
          const rows = val as [string, string][];
          const set = (i: number, j: 0 | 1, s: string) => onChange(f.key, rows.map((r, n) => (n === i ? (j === 0 ? [s, r[1]] : [r[0], s]) : r)) as [string, string][]);
          return (
            <fieldset key={f.key} className={wide}>
              <legend className="label">{label}</legend>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={i} className="flex gap-2">
                    <input className="input" aria-label={`${f.label} ${t('monitors.form.key')} ${i + 1}`} value={r[0]} onChange={(e) => set(i, 0, e.target.value)} placeholder={t('monitors.form.key')} />
                    <input className="input" type={f.secretValues ? 'password' : 'text'} autoComplete="off" aria-label={`${f.label} ${t('monitors.form.value')} ${i + 1}`} value={r[1]} onChange={(e) => set(i, 1, e.target.value)} placeholder={t('monitors.form.value')} />
                    <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => onChange(f.key, rows.filter((_, n) => n !== i))}><X className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button size="sm" onClick={() => onChange(f.key, [...rows, ['', '']])}><Plus className="h-4 w-4" />{t('monitors.form.addRow')}</Button>
              </div>
              {f.help && <p className="hint">{f.help}</p>}
            </fieldset>
          );
        }
        return (
          <Field key={f.key} label={label} hint={f.help} className={wide}>
            {(id) => {
              const dom = `${idPrefix}-${f.key}-${id}`;
              if (f.kind === 'select') return <Select id={id} value={String(val)} onChange={(e) => onChange(f.key, e.target.value)}>{!f.required && !f.options?.some((o) => o.value === '') && <option value="" />}{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
              if (f.kind === 'textarea' || f.kind === 'json') return <Textarea id={id} rows={f.kind === 'json' ? 10 : 4} value={String(val)} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.placeholder} spellCheck={false} className={f.kind === 'json' ? 'font-mono text-xs' : undefined} />;
              return <Input id={id} name={dom} type={f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text'} autoComplete={f.kind === 'secret' ? 'new-password' : 'off'} min={f.min} max={f.max} step={f.kind === 'number' ? 'any' : undefined} value={String(val)} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.placeholder} required={f.required} />;
            }}
          </Field>
        );
      })}
    </div>
  );
}
