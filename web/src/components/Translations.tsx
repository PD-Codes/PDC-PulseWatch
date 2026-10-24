import { useEffect, useState } from 'react';
import { useMeta } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Field, Input, Textarea } from './ui';

/** English and German wording of one text; an empty version means the text as written is shown in that language. */
export interface Versions { en: string; de: string }
export const NO_VERSIONS: Versions = { en: '', de: '' };

/** Optional fields for the two versions, folded away until someone needs them (or a version already exists). */
export function Translations({ value, onChange, multiline, max }: { value: Versions; onChange: (v: Versions) => void; multiline?: boolean; max: number }) {
  const t = useT();
  const single = useMeta()?.languages;
  const [open, setOpen] = useState(false);
  useEffect(() => { if (value.en || value.de) setOpen(true); }, [value.en, value.de]); // opens when a version exists (also when it arrives late), emptying a field never folds it away
  if (single === 'en' || single === 'de') return null; // one language for everything: the text as written is the text
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
      <summary className="cursor-pointer text-sm text-slate-600 dark:text-slate-300">{t('translations.summary')}</summary>
      <div className="mt-3 space-y-3">
        {(['en', 'de'] as const).map((l) => (
          <Field key={l} label={t(`translations.${l}`)} hint={t('translations.hint')}>
            {(id) => multiline
              ? <Textarea id={id} rows={3} maxLength={max} className="font-sans" value={value[l]} onChange={(e) => onChange({ ...value, [l]: e.target.value })} />
              : <Input id={id} maxLength={max} value={value[l]} onChange={(e) => onChange({ ...value, [l]: e.target.value })} />}
          </Field>
        ))}
      </div>
    </details>
  );
}
