import type { MonitorItem } from './api';

/** SLO as the monitor list reports it. `met` is null while there is not enough data. */
export interface SloSummary { target: number; uptime30d: number | null; met: boolean | null }
/** SLO with the error budget, as the monitor detail reports it. */
export interface SloDetail extends SloSummary { budgetMinutes: number; usedMinutes: number; remainingMinutes: number; windowDays: number }

/** Monitor list item with the snooze and SLO fields (optional, so an older server still type-checks). */
export type MonitorX = MonitorItem & { snoozedUntil?: string | null; sloTarget?: number | null; slo?: SloSummary | null };

/** Snooze limits of the server: 5 minutes to 7 days. */
export const SNOOZE_MIN_MINUTES = 5;
export const SNOOZE_MAX_MINUTES = 7 * 24 * 60;

/** Body for POST …/snooze. */
export type SnoozeBody = { minutes: number } | { until: string };
export type SnoozePreset = 'h1' | 'h4' | 'morning';

export const snoozeActive = (m: { snoozedUntil?: string | null } | null | undefined, now = Date.now()): boolean => {
  const at = m?.snoozedUntil ? Date.parse(m.snoozedUntil) : NaN;
  return Number.isFinite(at) && at > now;
};

export const sloViolated = (m: { slo?: SloSummary | null }): boolean => m.slo?.met === false;

/**
 * The next "morning" at `hour` o'clock in the browser's time zone. Before 05:00 the coming morning of the same day counts
 * (someone on night duty means "until 8 today"), later in the day it is tomorrow.
 */
export function nextMorning(now: Date, hour = 8): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (now.getHours() >= 5 || d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** Request body for a snooze preset; the morning preset is clamped to the server's 7-day limit. */
export function snoozeBody(preset: SnoozePreset, now = new Date()): SnoozeBody {
  if (preset === 'h1') return { minutes: 60 };
  if (preset === 'h4') return { minutes: 240 };
  const until = Math.min(nextMorning(now).getTime(), now.getTime() + SNOOZE_MAX_MINUTES * 60_000);
  return { until: new Date(until).toISOString() };
}

/** Is `until` on the same calendar day as `now` (browser time)? */
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "14:30" today, otherwise "Fri 08:00" (within a week) in the given locale. */
export function fmtUntil(iso: string, locale: string, now = new Date()): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '–';
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
  if (sameDay(d, now)) return time;
  return `${new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d)} ${time}`;
}

/** Traffic light of an SLO: red when missed or the budget is used up, amber when less than a quarter is left. */
export function sloTone(s: Pick<SloDetail, 'met'> & Partial<Pick<SloDetail, 'budgetMinutes' | 'remainingMinutes'>>): 'green' | 'amber' | 'red' | 'gray' {
  if (s.met === false || (s.remainingMinutes != null && s.remainingMinutes <= 0)) return 'red';
  if (s.met == null) return 'gray';
  if (s.budgetMinutes != null && s.remainingMinutes != null && s.budgetMinutes > 0 && s.remainingMinutes < s.budgetMinutes / 4) return 'amber';
  return 'green';
}
