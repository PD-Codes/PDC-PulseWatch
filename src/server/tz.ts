/**
 * Calendar days in an IANA time zone, computed with Intl (the Docker image has no MariaDB time zone tables).
 * A day is identified by its local date 'YYYY-MM-DD' and starts at the first instant whose local date is that day,
 * which keeps days of 23 or 25 hours (DST changes) and midnights that do not exist correct.
 */

const fmts = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string) => {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })));
  return f;
};

/** Canonical name of a time zone; throws for unknown names. */
export function checkTimeZone(name: string, label = 'time zone'): string {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone; } catch { throw new Error(`${label}: unknown time zone "${name}" (expected an IANA name such as Europe/Berlin)`); }
}

/** Local date of an instant. */
export function localDate(tz: string, t: Date | number): string {
  const ms = typeof t === 'number' ? t : t.getTime();
  if (tz === 'UTC') return new Date(ms).toISOString().slice(0, 10);
  const p = fmt(tz).formatToParts(ms);
  const get = (k: string) => p.find((x) => x.type === k)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Calendar arithmetic on a local date. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** First instant of a local date. */
export function dayStart(tz: string, date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  if (tz === 'UTC') return new Date(base);
  // offsets lie within -12h..+14h: search the first minute whose local date is not before `date`
  let lo = (base - 15 * 3_600_000) / 60_000, hi = (base + 13 * 3_600_000) / 60_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(tz, mid * 60_000) >= date) hi = mid; else lo = mid;
  }
  return new Date(hi * 60_000);
}

export const startOfLocalDay = (tz: string, t: Date | number) => dayStart(tz, localDate(tz, t));

/** The local days that overlap [from, to) (at least one), each with its start and the next day's start. */
export function localDays(tz: string, from: Date, to: Date): { date: string; start: Date; end: Date }[] {
  const out: { date: string; start: Date; end: Date }[] = [];
  let date = localDate(tz, from);
  let start = dayStart(tz, date);
  for (let i = 0; (i === 0 || start < to) && i < 4000; i++) {
    const next = addDays(date, 1);
    const end = dayStart(tz, next);
    out.push({ date, start, end });
    date = next; start = end;
  }
  return out;
}

/** The last `days` local dates up to today, oldest first, and the instant the first one starts. */
export function recentDays(tz: string, days: number, now = new Date()): { since: Date; dates: string[] } {
  const today = localDate(tz, now);
  const dates = Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
  return { since: dayStart(tz, dates[0]), dates };
}
