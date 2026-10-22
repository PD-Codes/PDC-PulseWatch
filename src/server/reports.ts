import PDFDocument from 'pdfkit';
import { Cron } from 'croner';
import { sql } from 'kysely';
import { config } from './config';
import type { Ctx } from './context';
import { bool, parseJson } from './db';
import { mailConfigured, sendSystemMail } from './mail';
import { fill, groupByLang, notifyLang, TEXTS, type Lang } from './notify/texts';
import { describeTarget } from '../core';
import { parseMonitor } from './monitors/model';

export type Scope = { type: 'all' | 'group' | 'monitor' | 'tag'; id?: number | null };
export interface SlaRow { monitorId: number; name: string; group: string | null; uptime: number | null; downtimeMin: number; incidents: number; mttrMin: number | null; avgMs: number | null; p95Ms: number | null; checks: number }
export interface SlaReport { generatedAt: string; from: string; to: string; days: number; scope: string; scopeType: Scope['type']; scopeId: number | null; rows: SlaRow[]; overall: number | null }

const DAY = 86_400_000;

/** Monitor ids in scope (groups include descendants). `limit` restricts to what the requesting user may see. */
export async function scopeMonitorIds(ctx: Ctx, scope: Scope, limit: number[] | null): Promise<number[]> {
  const { db } = ctx;
  let ids: number[];
  if (scope.type === 'monitor') ids = scope.id ? [scope.id] : [];
  else if (scope.type === 'tag') ids = scope.id ? (await db.selectFrom('monitor_tags').select('monitor_id').distinct().where('tag_id', '=', scope.id).execute()).map((r) => r.monitor_id) : [];
  else if (scope.type === 'group') {
    const groups = await db.selectFrom('monitor_groups').select(['id', 'parent_id']).execute();
    const set = new Set(scope.id ? [scope.id] : []);
    for (let grew = true; grew;) { grew = false; for (const g of groups) if (g.parent_id && set.has(g.parent_id) && !set.has(g.id)) { set.add(g.id); grew = true; } }
    ids = set.size ? (await db.selectFrom('monitors').select('id').where('group_id', 'in', [...set]).execute()).map((m) => m.id) : [];
  } else ids = (await db.selectFrom('monitors').select('id').execute()).map((m) => m.id);
  return limit ? ids.filter((i) => limit.includes(i)) : ids;
}

/**
 * Hourly rollups for ranges up to 90 days, daily ones beyond. Downtime is estimated as the down share of checks times the
 * observed span, which is accurate to about one check interval per outage.
 */
export async function buildSla(ctx: Ctx, scope: Scope, days: number, limit: number[] | null = null): Promise<SlaReport> {
  const { db } = ctx;
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY);
  const ids = await scopeMonitorIds(ctx, scope, limit);
  const rows: SlaRow[] = [];
  let up = 0, down = 0;
  if (ids.length) {
    const mons = await db.selectFrom('monitors as m').leftJoin('monitor_groups as g', 'g.id', 'm.group_id').select(['m.id', 'm.name', 'm.created_at', 'g.name as gname']).where('m.id', 'in', ids).orderBy('m.name').execute();
    const res = days <= 90 ? 'hour' : 'day';
    const agg = await sql<any>`SELECT monitor_id, SUM(up_n) u, SUM(down_n) d, SUM(lat_n) ln, SUM(lat_sum) ls, SUM(lat_p95 * lat_n) p95w, SUM(CASE WHEN lat_p95 IS NULL THEN 0 ELSE lat_n END) p95n
      FROM rollups WHERE res = ${res} AND bucket >= ${from} AND monitor_id IN (${sql.join(ids)}) GROUP BY monitor_id`.execute(db);
    const byMon = new Map<number, any>(agg.rows.map((r: any) => [r.monitor_id, r]));
    const inc = await sql<any>`SELECT im.monitor_id, COUNT(DISTINCT i.id) n, AVG(TIMESTAMPDIFF(SECOND, i.started_at, i.resolved_at)) mttr
      FROM incidents i JOIN incident_monitors im ON im.incident_id = i.id
      WHERE i.started_at >= ${from} AND im.monitor_id IN (${sql.join(ids)}) GROUP BY im.monitor_id`.execute(db);
    const incBy = new Map<number, any>(inc.rows.map((r: any) => [r.monitor_id, r]));
    for (const m of mons) {
      const a = byMon.get(m.id);
      const u = Number(a?.u ?? 0), d = Number(a?.d ?? 0), ln = Number(a?.ln ?? 0), p95n = Number(a?.p95n ?? 0);
      const span = Math.min(to.getTime() - from.getTime(), to.getTime() - m.created_at.getTime());
      const i = incBy.get(m.id);
      up += u; down += d;
      rows.push({
        monitorId: m.id, name: m.name, group: m.gname, uptime: u + d ? Math.round((u / (u + d)) * 10000) / 100 : null, downtimeMin: u + d ? Math.round(((d / (u + d)) * span) / 60000) : 0,
        incidents: Number(i?.n ?? 0), mttrMin: i?.mttr != null ? Math.round(Number(i.mttr) / 60) : null, avgMs: ln ? Math.round(Number(a.ls) / ln) : null, p95Ms: p95n ? Math.round(Number(a.p95w) / p95n) : null, checks: u + d,
      });
    }
  }
  const scopeName = scope.type === 'all' ? 'All monitors' : `${scope.type} #${scope.id}`;
  return { generatedAt: to.toISOString(), from: from.toISOString(), to: to.toISOString(), days, scope: scopeName, scopeType: scope.type, scopeId: scope.id ?? null, rows, overall: up + down ? Math.round((up / (up + down)) * 10000) / 100 : null };
}

const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection from monitor names
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** shortcut: a byte order mark is added for German only, so Excel reads the umlauts of the headings; English stays byte-identical. */
export function slaCsv(r: SlaReport, lang: Lang = 'en'): string {
  const head = TEXTS[lang].csvHead;
  return (lang === 'de' ? '\uFEFF' : '') + [head, ...r.rows.map((x) => [x.name, x.group, x.uptime, x.downtimeMin, x.incidents, x.mttrMin, x.avgMs, x.p95Ms, x.checks])].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** The scope in words, in the language of the document. */
const scopeLabel = (r: SlaReport, T: (typeof TEXTS)[Lang]) => (r.scopeType === 'all' ? T.scope.all : `${T.scope[r.scopeType]} #${r.scopeId}`);

export function slaPdf(r: SlaReport, lang: Lang = 'en'): Promise<Buffer> {
  const T = TEXTS[lang];
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape', info: { Title: fill(T.pdfTitle, { brand: config.brand.name }), Author: config.brand.vendor ?? config.brand.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    doc.fontSize(20).text(fill(T.pdfTitle, { brand: config.brand.name }));
    doc.moveDown(0.3).fontSize(10).fillColor('#555').text(fill(T.pdfSub, { scope: scopeLabel(r, T), days: r.days, from: r.from.slice(0, 10), to: r.to.slice(0, 10), v: r.overall ?? T.na })).fillColor('#000');
    doc.moveDown();
    const cols = [230, 110, 55, 65, 45, 50, 55, 55].map((w, i) => ({ t: T.pdfCols[i], w }));
    const row = (vals: (string | number | null)[], bold = false) => {
      if (doc.y > doc.page.height - 60) doc.addPage();
      const y = doc.y; let x = 40;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      vals.forEach((v, i) => { doc.text(String(v ?? '-'), x, y, { width: cols[i].w - 6, height: 12, ellipsis: true, lineBreak: false }); x += cols[i].w; });
      doc.y = y + 15; doc.x = 40;
    };
    row(cols.map((c) => c.t), true);
    doc.moveTo(40, doc.y - 3).lineTo(40 + cols.reduce((a, c) => a + c.w, 0), doc.y - 3).strokeColor('#999').stroke();
    for (const x of r.rows) row([x.name, x.group, x.uptime == null ? null : `${x.uptime}%`, `${x.downtimeMin} min`, x.incidents, x.mttrMin == null ? null : `${x.mttrMin} min`, x.avgMs, x.p95Ms]);
    doc.moveDown().font('Helvetica').fontSize(8).fillColor('#777').text(T.pdfNote, 40);
    doc.end();
  });
}

/* ------------------------------ scheduled jobs ------------------------------ */

export interface DigestSettings { enabled: boolean; hour: number; timezone: string; recipients: string[] }
export const DIGEST_DEFAULT: DigestSettings = { enabled: false, hour: 8, timezone: 'UTC', recipients: [] };

/** Compare-and-set claim so that several processes never run the same job twice. */
async function claim(ctx: Ctx, key: string, value: string): Promise<boolean> {
  await sql`INSERT IGNORE INTO settings (\`key\`, value) VALUES (${key}, ${JSON.stringify('')})`.execute(ctx.db);
  const r = await sql`UPDATE settings SET value = ${JSON.stringify(value)} WHERE \`key\` = ${key} AND value <> ${JSON.stringify(value)}`.execute(ctx.db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

/** A digest stays readable when a whole network goes down. */
const LIST_MAX = 50;

export async function buildDigest(ctx: Ctx, lang?: Lang): Promise<{ subject: string; text: string; html: string }> {
  const { db } = ctx;
  const T = TEXTS[lang ?? (await notifyLang(ctx)).lang];
  const brand = { brand: config.brand.name };
  const since = new Date(Date.now() - DAY);
  const [down, opened, resolved, flapping, certs] = await Promise.all([
    db.selectFrom('monitor_state as s').innerJoin('monitors as m', 'm.id', 's.monitor_id').select(['m.id', 'm.name', 's.status_since', 's.last_message']).where('m.active', '=', 1).where('s.status', '=', 'down').execute(),
    db.selectFrom('incidents').select(['title', 'started_at']).where('started_at', '>=', since).orderBy('started_at', 'desc').limit(20).execute(),
    db.selectFrom('incidents').select(['title', 'started_at', 'resolved_at']).where('resolved_at', '>=', since).execute(),
    db.selectFrom('monitor_state as s').innerJoin('monitors as m', 'm.id', 's.monitor_id').select('m.name').where('s.flapping', '=', 1).execute(),
    db.selectFrom('monitor_state as s').innerJoin('monitors as m', 'm.id', 's.monitor_id').select(['m.id', 'm.name', 's.cert_expires_at', 's.cert_info', 's.last_message']).where('s.cert_expires_at', '<', new Date(Date.now() + 14 * DAY)).where('s.cert_expires_at', 'is not', null).execute(),
  ]);
  const sla = await buildSla(ctx, { type: 'all' }, 1);
  const ids = [...new Set([...down, ...certs].map((x) => x.id))];
  const targets = new Map((ids.length ? await db.selectFrom('monitors').selectAll().where('id', 'in', ids).execute() : []).map((row) => [row.id, describeTarget(parseMonitor(row).config)]));
  const certLine = (c: (typeof certs)[number]) => {
    const info = parseJson<{ subject?: string; issuer?: string } | null>(c.cert_info, null);
    const when = c.cert_expires_at!;
    const left = Math.floor((when.getTime() - Date.now()) / DAY);
    return `${c.name}${targets.get(c.id) ? ` [${targets.get(c.id)}]` : ''}: ${left < 0 ? fill(T.certExpired, { d: when.toISOString().slice(0, 10) }) : fill(T.certExpires, { d: when.toISOString().slice(0, 10), n: left })}${info?.subject ? fill(T.certSubject, { v: info.subject }) : ''}${info?.issuer ? fill(T.certIssuer, { v: info.issuer }) : ''}`;
  };
  const worst = [...sla.rows].filter((r) => r.uptime != null && r.uptime < 100).sort((a, b) => a.uptime! - b.uptime!).slice(0, 5);
  const lines = [
    fill(T.uptime24, { v: sla.overall ?? T.na }),
    fill(T.downNow, { n: down.length }),
    ...down.slice(0, LIST_MAX).map((d) => `  - ${d.name}${targets.get(d.id) ? ` [${targets.get(d.id)}]` : ''}: ${d.last_message ?? T.noDetails}`),
    ...(down.length > LIST_MAX ? [fill(T.more, { n: down.length - LIST_MAX })] : []),
    fill(T.incidents, { a: opened.length, b: resolved.length }),
    ...(worst.length ? [fill(T.lowest, { v: worst.map((w) => `${w.name} ${w.uptime}%`).join('; ') })] : []),
    ...(flapping.length ? [fill(T.flapping, { v: `${flapping.slice(0, LIST_MAX).map((f) => f.name).join(', ')}${flapping.length > LIST_MAX ? fill(T.moreInline, { n: flapping.length - LIST_MAX }) : ''}` })] : []),
    ...(certs.length ? [T.certsHead, ...certs.slice(0, LIST_MAX).map((c) => `  - ${certLine(c)}`), ...(certs.length > LIST_MAX ? [fill(T.more, { n: certs.length - LIST_MAX })] : [])] : []),
  ];
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return {
    subject: fill(T.digestSubject, { ...brand, what: down.length ? fill(T.digestDown, { n: down.length }) : T.digestClear }),
    text: `${fill(T.digestTitle, brand)}\n\n${lines.join('\n')}\n\n${config.baseUrl}`,
    html: `<h2>${esc(fill(T.digestTitle, brand))}</h2><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p><a href="${esc(config.baseUrl)}">${esc(fill(T.digestOpen, brand))}</a></p>`,
  };
}

export async function sendReport(ctx: Ctx, s: { name: string; scope_type: Scope['type']; scope_id: number | null; range_days: number; recipients: string; format: 'pdf' | 'csv' }): Promise<void> {
  const rep = await buildSla(ctx, { type: s.scope_type, id: s.scope_id }, s.range_days);
  const stamp = rep.to.slice(0, 10);
  // one mail per language: every recipient gets text and attachment in the language of their own profile
  for (const [lang, to] of await groupByLang(ctx, s.recipients.split(',').map((x) => x.trim()).filter(Boolean))) {
    const T = TEXTS[lang];
    const file = s.format === 'pdf' ? { filename: `sla-${stamp}.pdf`, content: await slaPdf(rep, lang), contentType: 'application/pdf' } : { filename: `sla-${stamp}.csv`, content: slaCsv(rep, lang), contentType: 'text/csv; charset=utf-8' };
    await sendSystemMail({ to, subject: fill(T.reportSubject, { brand: config.brand.name, name: s.name }), text: fill(T.reportBody, { name: s.name, scope: scopeLabel(rep, T), days: rep.days, v: rep.overall ?? T.na }), attachments: [file] });
  }
}

/** Checks once a minute for due report schedules and the daily digest. */
export class ReportJobs {
  private timer?: NodeJS.Timeout;
  constructor(private ctx: Ctx) {}
  start() { this.timer = setInterval(() => void this.tick().catch((e) => this.ctx.log.warn({ err: e }, 'report job failed')), 60_000); this.timer.unref(); }
  stop() { clearInterval(this.timer); }

  async tick(now = new Date()): Promise<void> {
    if (!mailConfigured()) return;
    const { db, log } = this.ctx;
    for (const s of await db.selectFrom('report_schedules').selectAll().where('enabled', '=', 1).execute()) {
      try {
        const last = s.last_run_at ?? s.created_at;
        const next = new Cron(s.cron_expr, { timezone: s.timezone }).nextRun(last);
        if (!next || next > now) continue;
        const r = await db.updateTable('report_schedules').set({ last_run_at: now }).where('id', '=', s.id).where((eb) => (s.last_run_at ? eb('last_run_at', '=', s.last_run_at) : eb('last_run_at', 'is', null))).executeTakeFirst();
        if (!Number(r.numUpdatedRows)) continue; // another process took it
        await sendReport(this.ctx, s);
      } catch (e) { log.warn({ err: e, schedule: s.id }, 'scheduled report failed'); }
    }
    const d = await this.ctx.settings.get<DigestSettings>('digest', DIGEST_DEFAULT);
    if (d.enabled && d.recipients.length) {
      const local = new Intl.DateTimeFormat('en-CA', { timeZone: d.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      const part = (t: string) => local.find((p) => p.type === t)!.value;
      const day = `${part('year')}-${part('month')}-${part('day')}`;
      if (Number(part('hour')) >= d.hour && (await claim(this.ctx, 'digest_last', day))) {
        for (const [lang, to] of await groupByLang(this.ctx, d.recipients)) await sendSystemMail({ to, ...(await buildDigest(this.ctx, lang)) });
      }
    }
  }
}
