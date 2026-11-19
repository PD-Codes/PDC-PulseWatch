import * as shell from '../locales/shell';
import { detectLocale, type Locale } from './i18n';

/** Active UI language outside React (LocaleProvider keeps <html lang> in step with it). */
export const activeLocale = (): Locale => {
  const l = typeof document === 'undefined' ? '' : document.documentElement.lang;
  return l === 'de' || l === 'en' ? l : detectLocale();
};

/** Translate a shell string from non-React code (API client, event stream). */
export function ts(key: string, vars?: Record<string, string | number>): string {
  const s = (shell[activeLocale()] as Record<string, string>)[key] ?? (shell.en as Record<string, string>)[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s;
}
