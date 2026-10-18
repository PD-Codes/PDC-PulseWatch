import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import type { FieldDef } from '../../../src/core/types';
import { useT } from '../lib/i18n';
import { Button, Field, Input, Select, Textarea, Toggle, useToast } from './ui';

/** Copy text to the clipboard with a short confirmation. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const toast = useToast();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); toast(t('common.copied')); setTimeout(() => setDone(false), 1500); } catch { toast(t('common.failed'), 'error'); }
  };
  return <Button size="sm" onClick={copy} aria-label={label ?? t('common.copy')}>{done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{label ?? t('common.copy')}</Button>;
}

/** Renders a list of server-defined field definitions (text, number, bool, select, secret, textarea). */
export function FieldsForm({ fields, value, onChange }: { fields: FieldDef[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        if (f.showIf && value[f.showIf.key] !== f.showIf.equals) return null;
        const v = value[f.key];
        const label = <>{f.label}{f.required && <span aria-hidden> *</span>}</>;
        if (f.kind === 'bool') return <Toggle key={f.key} checked={!!v} onChange={(x) => set(f.key, x)} label={f.label} />;
        return (
          <Field key={f.key} label={label} hint={f.help}>
            {(id) => f.kind === 'select' ? (
              <Select id={id} value={v ?? ''} onChange={(e) => set(f.key, e.target.value)}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            ) : f.kind === 'textarea' ? (
              <Textarea id={id} value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <Input id={id} type={f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text'} value={v ?? ''} autoComplete="off" required={f.required} placeholder={f.placeholder}
                onChange={(e) => set(f.key, f.kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

/** One entry per line or comma, empties dropped. */
export const splitList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
