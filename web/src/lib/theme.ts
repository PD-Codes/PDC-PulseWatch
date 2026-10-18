import { useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'pw.theme';
const read = (): ThemePref => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } };

export function applyTheme(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function setTheme(pref: ThemePref) {
  try { localStorage.setItem(KEY, pref); } catch { /* storage unavailable */ }
  applyTheme(pref);
  window.dispatchEvent(new Event('pw:theme'));
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(read);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const sync = () => { setPref(read()); applyTheme(read()); setDark(document.documentElement.classList.contains('dark')); };
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    sync();
    window.addEventListener('pw:theme', sync); mq.addEventListener('change', sync);
    return () => { window.removeEventListener('pw:theme', sync); mq.removeEventListener('change', sync); };
  }, []);
  return { pref, dark, set: setTheme };
}
