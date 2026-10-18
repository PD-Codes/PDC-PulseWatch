import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setFormatLocale } from './format';

export type Locale = 'en' | 'de';
type Dict = Record<string, string>;

// Every file in ../locales exports `en` and `de` dictionaries; they are merged here so that features own their own strings.
const modules = import.meta.glob<{ en?: Dict; de?: Dict }>('../locales/*.ts', { eager: true });
const dict: Record<Locale, Dict> = { en: {}, de: {} };
for (const m of Object.values(modules)) { Object.assign(dict.en, m.en); Object.assign(dict.de, m.de); }

const KEY = 'pw.locale';
export const detectLocale = (): Locale => {
  try { const s = localStorage.getItem(KEY); if (s === 'en' || s === 'de') return s; } catch { /* storage unavailable */ }
  return (navigator.languages?.[0] ?? navigator.language ?? 'en').toLowerCase().startsWith('de') ? 'de' : 'en';
};

interface Ctx { locale: Locale; setLocale: (l: Locale | null) => void; t: (key: string, vars?: Record<string, string | number>) => string }
const I18n = createContext<Ctx>({ locale: 'en', setLocale: () => {}, t: (k) => k });

export function LocaleProvider({ children, preferred }: { children: ReactNode; preferred?: Locale | null }) {
  const [locale, set] = useState<Locale>(detectLocale);
  // a language chosen in the profile wins over the browser language
  useEffect(() => { if (preferred) set(preferred); }, [preferred]);
  useEffect(() => { document.documentElement.lang = locale; setFormatLocale(locale); }, [locale]);
  const setLocale = useCallback((l: Locale | null) => {
    try { if (l) localStorage.setItem(KEY, l); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    set(l ?? detectLocale());
  }, []);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    const s = dict[locale][key] ?? dict.en[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s;
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useI18n = () => useContext(I18n);
export const useT = () => useContext(I18n).t;
