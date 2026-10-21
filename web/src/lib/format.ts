let locale = 'en';
export const setFormatLocale = (l: string) => { locale = l; };

/** "Public Services" becomes "public-services"; German umlauts turn into ae/oe/ue/ss, other accents are dropped. */
export const slugify = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 63).replace(/-+$/, '');

export const fmtMs = (v: number | null | undefined) => (v == null ? '–' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
export const fmtPct = (v: number | null | undefined, digits = 2) => (v == null ? '–' : `${v.toFixed(digits).replace(/\.?0+$/, '') || '0'}%`);

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '–';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24 ? `${h % 24}h` : ''}`.trim();
}

const toDate = (d: string | number | Date) => (d instanceof Date ? d : new Date(d));
export const fmtDateTime = (d: string | number | Date | null | undefined) => (d == null ? '–' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(toDate(d)));
export const fmtDate = (d: string | number | Date | null | undefined) => (d == null ? '–' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(toDate(d)));
export const fmtTime = (d: string | number | Date | null | undefined) => (d == null ? '–' : new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(toDate(d)));

/** "3 minutes ago" / "in 2 hours". */
export function relTime(d: string | number | Date | null | undefined): string {
  if (d == null) return '–';
  const diff = (toDate(d).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 60) return rtf.format(Math.round(diff / 86400), 'day');
  return rtf.format(Math.round(diff / (86400 * 30)), 'month');
}

export const fmtNumber = (n: number) => new Intl.NumberFormat(locale).format(n);
