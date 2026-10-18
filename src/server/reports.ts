import PDFDocument from 'pdfkit';
import { Cron } from 'croner';
import { sql } from 'kysely';
import { config } from './config';
import type { Ctx } from './context';
import { bool, parseJson } from './db';
import { mailConfigured, sendSystemMail } from './mail';

export type Scope = { type: 'all' | 'group' | 'monitor' | 'tag'; id?: number | null };
export interface SlaRow { monitorId: number; name: string; group: string | null; uptime: number | null; downtimeMin: number; incidents: number; mttrMin: number | null; avgMs: number | null; p95Ms: number | null; checks: number }
export interface SlaReport { generatedAt: string; from: string; to: string; days: number; scope: string; rows: SlaRow[]; overall: number | null }

const DAY = 86_400_000;

/** Monitor ids in scope (groups include descendants). `limit` restricts to what the requesting user may see. */
export async function scopeMonitorIds(ctx: Ctx, scope: Scope, limit: number[] | null): Promise<number[]> {
  const { db } = ctx;
  let ids: number[];
  if (scope.type === 'monitor') ids = scope.id ? [scope.id] : [];
  else if (scope.type === 'tag') ids = scope.id ? (await db.selectFrom('monitor_tags').select('monitor_id').where('tag_id', '=', scope.id).execute()).map((r) => r.monitor_id) : [];
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
  return { generatedAt: to.toISOString(), from: from.toISOString(), to: to.toISOString(), days, scope: scopeName, rows, overall: up + down ? Math.round((up / (up + down)) * 10000) / 100 : null };
}

const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection from monitor names
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function slaCsv(r: SlaReport): string {
  const head = ['Monitor', 'Group', 'Uptime %', 'Downtime (min)', 'Incidents', 'MTTR (min)', 'Avg latency (ms)', 'p95 latency (ms)', 'Checks'];
  return [head, ...r.rows.map((x) => [x.name, x.group, x.uptime, x.downtimeMin, x.incidents, x.mttrMin, x.avgMs, x.p95Ms, x.checks])].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function slaPdf(r: SlaReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape', info: { Title: `${config.brand.name} SLA report`, Author: config.brand.vendor ?? config.brand.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    doc.fontSize(20).text(`${config.brand.name} SLA report`);
    doc.moveDown(0.3).fontSize(10).fillColor('#555').text(`${r.scope} | last ${r.days} days | ${r.from.slice(0, 10)} to ${r.to.slice(0, 10)} (UTC) | overall uptime ${r.overall ?? 'n/a'}%`).fillColor('#000');
    doc.moveDown();
    const cols = [{ t: 'Monitor', w: 230 }, { t: 'Group', w: 110 }, { t: 'Uptime', w: 55 }, { t: 'Downtime', w: 65 }, { t: 'Incid.', w: 45 }, { t: 'MTTR', w: 50 }, { t: 'Avg ms', w: 55 }, { t: 'p95 ms', w: 55 }];
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
    doc.moveDown().font('Helvetica').fontSize(8).fillColor('#777').text('Downtime is estimated from the share of failed checks. Maintenance periods are excluded from uptime.', 40);
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

export async function buildDigest(ctx: Ctx): Promise<{ subject: string; text: string; html: string }> {
  const { db } = ctx;
  const since = new Date(Date.now() - DAY);
  const [down, opened, resolved, flapping, certs] = await Promise.all([
    db.selectFrom('monitor_state as s').innerJoin('monitors as m', 'm.id', 's.monitor_id').select(['m.name', 's.status_since', 's.last_message']).where('m.active', '=', 1).where('s.status', '=', 'down').execute(),
    db.selectFrom('incidents').select(['title', 'started_at']).where('started_at', '>=', since).orderBy('started_at', 'desc').limit(20).execute(),
    db.selectFrom('incidents').select(['title', 'started_at', 'resolved_at']).where('resolved_at', '>=', since).execute(),
    db.selectFrom('monitor_state as s').innerJoin('monitors as m', 'm.id', 's.monitor_id').select('m.name').where('s.flapping', '=', 1).execute(),
    db.selectFrom('monitor_state as s').innerJoin('monitors as m', 'm.id', 's.monitor_id').select(['m.name', 's.cert_expires_at']).where('s.cert_expires_at', '<', new Date(Date.now() + 14 * DAY)).where('s.cert_expires_at', 'is not', null).execute(),
  ]);
  const sla = await buildSla(ctx, { type: 'all' }, 1);
  const worst = [...sla.rows].filter((r) => r.uptime != null && r.uptime < 100).sort((a, b) => a.uptime! - b.uptime!).slice(0, 5);
  const lines = [
    `Overall uptime (24h): ${sla.overall ?? 'n/a'}%`,
    `Monitors down right now: ${down.length}${down.length ? ` (${down.map((d) => d.name).join(', ')})` : ''}`,
    `Incidents opened: ${opened.length}, resolved: ${resolved.length}`,
    ...(worst.length ? ['Lowest uptime: ' + worst.map((w) => `${w.name} ${w.uptime}%`).join('; ')] : []),
    ...(flapping.length ? [`Flapping: ${flapping.map((f) => f.name).join(', ')}`] : []),
    ...(certs.length ? [`Certificates expiring within 14 days: ${certs.map((c) => `${c.name} (${c.cert_expires_at!.toISOString().slice(0, 10)})`).join(', ')}`] : []),
  ];
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return {
    subject: `${config.brand.name} daily digest: ${down.length ? `${down.length} down` : 'all clear'}`,
    text: `${config.brand.name} daily digest\n\n${lines.join('\n')}\n\n${config.baseUrl}`,
    html: `<h2>${esc(config.brand.name)} daily digest</h2><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p><a href="${esc(config.baseUrl)}">Open ${esc(config.brand.name)}</a></p>`,
  };
}

export async function sendReport(ctx: Ctx, s: { name: string; scope_type: Scope['type']; scope_id: number | null; range_days: number; recipients: string; format: 'pdf' | 'csv' }): Promise<void> {
  const rep = await buildSla(ctx, { type: s.scope_type, id: s.scope_id }, s.range_days);
  const stamp = rep.to.slice(0, 10);
  const file = s.format === 'pdf' ? { filename: `sla-${stamp}.pdf`, content: await slaPdf(rep), contentType: 'application/pdf' } : { filename: `sla-${stamp}.csv`, content: slaCsv(rep), contentType: 'text/csv' };
  await sendSystemMail({ to: s.recipients.split(',').map((x) => x.trim()).filter(Boolean), subject: `${config.brand.name} SLA report: ${s.name}`, text: `SLA report "${s.name}" (${rep.scope}, last ${rep.days} days). Overall uptime: ${rep.overall ?? 'n/a'}%.\nSee the attachment for details.`, attachments: [file] });
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
        const m = await buildDigest(this.ctx);
        await sendSystemMail({ to: d.recipients, ...m });
      }
    }
  }
}
