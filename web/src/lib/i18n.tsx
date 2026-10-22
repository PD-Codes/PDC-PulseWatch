import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
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

interface Ctx { locale: Locale; setLocale: (l: Locale | null) => void; force: (l: Locale | null) => void; t: (key: string, vars?: Record<string, string | number>) => string }
const I18n = createContext<Ctx>({ locale: 'en', setLocale: () => {}, force: () => {}, t: (k) => k });

export function LocaleProvider({ children, preferred }: { children: ReactNode; preferred?: Locale | null }) {
  const [chosen, set] = useState<Locale>(detectLocale);
  // a page can force its own language without touching what the person chose (see useForcedLocale)
  const [forced, force] = useState<Locale | null>(null);
  const locale = forced ?? chosen;
  // a language chosen in the profile wins over the browser language
  useEffect(() => { if (preferred) set(preferred); }, [preferred]);
  setFormatLocale(locale); // during render, so dates below already use it
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const setLocale = useCallback((l: Locale | null) => {
    try { if (l) localStorage.setItem(KEY, l); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    set(l ?? detectLocale());
  }, []);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    const s = dict[locale][key] ?? dict.en[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s;
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, force, t }), [locale, setLocale, t]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useI18n = () => useContext(I18n);
export const useT = () => useContext(I18n).t;

/** Shows a page in a fixed language while it is mounted, without saving anything as the person's own choice. */
export function useForcedLocale(l: Locale | null | undefined) {
  const { force } = useI18n();
  useLayoutEffect(() => { force(l ?? null); return () => force(null); }, [l, force]);
}
