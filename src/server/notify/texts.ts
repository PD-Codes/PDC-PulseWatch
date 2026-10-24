import type { Ctx } from '../context';

export type Lang = 'en' | 'de';
export const LANGS: Lang[] = ['en', 'de'];

/** What notifications, the daily digest and report mails say. Channel templates written by the admin are never touched. */
const en = {
  tag: { down: 'DOWN', up: 'UP', flap: 'FLAPPING', cert: 'CERTIFICATE', test: 'TEST' } as Record<string, string>,
  down: '{name} is down.', target: 'Target: {v}', reason: 'Reason: {v}', unknown: 'unknown',
  up: '{name} is back up.', latency: 'Response time: {v}',
  flap: '{name} keeps changing state. Alerts are muted until it is stable again.',
  test: 'This is a test notification from {brand}.',
  escalation: 'Escalation step {n}: {msg}', stillDown: 'monitor is still down',
  digestSubject: '{brand} daily digest: {what}', digestDown: '{n} down', digestClear: 'all clear', digestTitle: '{brand} daily digest', digestOpen: 'Open {brand}',
  uptime24: 'Overall uptime (24h): {v}%', na: 'n/a', downNow: 'Monitors down right now: {n}', more: '  ... and {n} more', noDetails: 'no details',
  incidents: 'Incidents opened: {a}, resolved: {b}', lowest: 'Lowest uptime: {v}', flapping: 'Flapping: {v}', moreInline: ', ... and {n} more',
  certsHead: 'Certificates expiring within 14 days:', certExpired: 'expired on {d}', certExpires: 'expires on {d} (in {n} day(s))', certSubject: ', subject {v}', certIssuer: ', issuer {v}',
  reportSubject: '{brand} SLA report: {name}', reportBody: 'SLA report "{name}" ({scope}, last {days} days). Overall uptime: {v}%.\nSee the attachment for details.',
  scope: { all: 'All monitors', group: 'group', monitor: 'monitor', tag: 'tag' } as Record<string, string>,
  csvHead: ['Monitor', 'Group', 'Uptime %', 'Downtime (min)', 'Incidents', 'MTTR (min)', 'Avg latency (ms)', 'p95 latency (ms)', 'Checks'],
  pdfTitle: '{brand} SLA report', pdfSub: '{scope} | last {days} days | {from} to {to} (UTC) | overall uptime {v}%',
  pdfCols: ['Monitor', 'Group', 'Uptime', 'Downtime', 'Incid.', 'MTTR', 'Avg ms', 'p95 ms'],
  pdfNote: 'Downtime is estimated from the share of failed checks. Maintenance periods are excluded from uptime.',
};
const de: typeof en = {
  tag: { down: 'OFFLINE', up: 'ONLINE', flap: 'INSTABIL', cert: 'ZERTIFIKAT', test: 'TEST' },
  down: '{name} ist nicht erreichbar.', target: 'Ziel: {v}', reason: 'Grund: {v}', unknown: 'unbekannt',
  up: '{name} ist wieder erreichbar.', latency: 'Antwortzeit: {v}',
  flap: '{name} wechselt ständig den Zustand. Benachrichtigungen sind stummgeschaltet, bis es wieder stabil ist.',
  test: 'Das ist eine Testbenachrichtigung von {brand}.',
  escalation: 'Eskalationsstufe {n}: {msg}', stillDown: 'Monitor ist weiterhin nicht erreichbar',
  digestSubject: '{brand} Tagesübersicht: {what}', digestDown: '{n} offline', digestClear: 'alles in Ordnung', digestTitle: '{brand} Tagesübersicht', digestOpen: '{brand} öffnen',
  uptime24: 'Gesamtverfügbarkeit (24 h): {v} %', na: 'k. A.', downNow: 'Monitore, die gerade offline sind: {n}', more: '  ... und {n} weitere', noDetails: 'keine Details',
  incidents: 'Vorfälle eröffnet: {a}, behoben: {b}', lowest: 'Geringste Verfügbarkeit: {v}', flapping: 'Instabil: {v}', moreInline: ', ... und {n} weitere',
  certsHead: 'Zertifikate, die innerhalb von 14 Tagen ablaufen:', certExpired: 'abgelaufen am {d}', certExpires: 'läuft am {d} ab (in {n} Tag(en))', certSubject: ', Subjekt {v}', certIssuer: ', Aussteller {v}',
  reportSubject: '{brand} SLA-Bericht: {name}', reportBody: 'SLA-Bericht "{name}" ({scope}, letzte {days} Tage). Gesamtverfügbarkeit: {v} %.\nDetails stehen im Anhang.',
  scope: { all: 'Alle Monitore', group: 'Gruppe', monitor: 'Monitor', tag: 'Tag' },
  csvHead: ['Monitor', 'Gruppe', 'Verfügbarkeit %', 'Ausfallzeit (min)', 'Vorfälle', 'MTTR (min)', 'Ø Antwortzeit (ms)', 'p95-Antwortzeit (ms)', 'Prüfungen'],
  pdfTitle: '{brand} SLA-Bericht', pdfSub: '{scope} | letzte {days} Tage | {from} bis {to} (UTC) | Gesamtverfügbarkeit {v} %',
  pdfCols: ['Monitor', 'Gruppe', 'Verfügb.', 'Ausfall', 'Vorf.', 'MTTR', 'Ø ms', 'p95 ms'],
  pdfNote: 'Die Ausfallzeit wird aus dem Anteil fehlgeschlagener Prüfungen geschätzt. Wartungszeiträume sind von der Verfügbarkeit ausgenommen.',
};
export const TEXTS: Record<Lang, typeof en> = { en, de };

export const fill = (s: string, v: Record<string, string | number> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

/** "both": pages, visitors and people choose; "en" or "de": everything the instance writes and shows is in that one language. */
export type LangMode = 'both' | Lang;
export async function langMode(ctx: Pick<Ctx, 'settings'>): Promise<LangMode> {
  const v = await ctx.settings.get<string>('languages.mode', 'both');
  return v === 'en' || v === 'de' ? v : 'both';
}

/**
 * The language of notifications: the explicit setting, else the language of the first administrator who picked one in the profile, else English.
 * shortcut: one language for the whole instance, not per channel or per recipient; add a channel setting when teams need different ones.
 */
export async function notifyLang(ctx: Pick<Ctx, 'db' | 'settings'>): Promise<{ lang: Lang; explicit: boolean }> {
  const mode = await langMode(ctx);
  if (mode !== 'both') return { lang: mode, explicit: true };
  const set = await ctx.settings.get<string | null>('notifications.language', null);
  if (set === 'en' || set === 'de') return { lang: set, explicit: true };
  const admin = await ctx.db.selectFrom('users').select('locale').where('role', '=', 'admin').where('is_active', '=', 1).where('locale', 'is not', null).orderBy('id').executeTakeFirst();
  return { lang: admin?.locale === 'de' ? 'de' : 'en', explicit: false };
}

/** A user's own profile language wins over the instance language (profile "automatic" means: no own choice). */
export async function userLang(ctx: Pick<Ctx, 'db' | 'settings'>, user: { locale: string | null } | null): Promise<Lang> {
  const mode = await langMode(ctx);
  if (mode !== 'both') return mode;
  return user?.locale === 'en' || user?.locale === 'de' ? user.locale : (await notifyLang(ctx)).lang;
}

/** Splits mail recipients by language: users with a profile language get theirs, everybody else the instance language. */
export async function groupByLang(ctx: Pick<Ctx, 'db' | 'settings'>, emails: string[]): Promise<Map<Lang, string[]>> {
  const mode = await langMode(ctx);
  if (mode !== 'both') return new Map(emails.length ? [[mode, emails]] : []);
  const base = (await notifyLang(ctx)).lang;
  const known = new Map<string, string | null>();
  if (emails.length) for (const u of await ctx.db.selectFrom('users').select(['email', 'locale']).where('is_active', '=', 1).where('email', 'in', emails).execute()) known.set(u.email!.toLowerCase(), u.locale);
  const out = new Map<Lang, string[]>();
  for (const e of emails) {
    const l = known.get(e.toLowerCase());
    const lang: Lang = l === 'en' || l === 'de' ? l : base;
    out.set(lang, [...(out.get(lang) ?? []), e]);
  }
  return out;
}
