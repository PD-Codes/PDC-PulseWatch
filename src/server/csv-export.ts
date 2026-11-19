import { Readable } from 'node:stream';
import type { Database } from './db';
import { LOCAL_LOCATION_ID } from './monitors/model';
import type { Lang } from './notify/texts';
import { csvCell } from './reports';

/** Row cap and page size of the per-monitor CSV export (an object, so tests can lower them). */
export const CSV_EXPORT = { maxRows: 200_000, pageSize: 5_000 };
export type CsvKind = 'heartbeats' | 'events';

const HEAD: Record<Lang, Record<CsvKind, string[]>> = {
  en: { heartbeats: ['ts', 'status', 'latency_ms', 'error_kind', 'message', 'location'], events: ['ts', 'type', 'from_status', 'to_status', 'error_kind', 'message'] },
  de: { heartbeats: ['Zeitpunkt', 'Status', 'Antwortzeit (ms)', 'Fehlerart', 'Meldung', 'Standort'], events: ['Zeitpunkt', 'Typ', 'Von Status', 'Zu Status', 'Fehlerart', 'Meldung'] },
};
/** Stored heartbeat status values (0 down, 1 up, 2 pending, 3 maintenance, 4 suppressed), written as words in both languages. */
const STATUS = ['down', 'up', 'pending', 'maintenance', 'suppressed'];
const OVERALL: Record<Lang, string> = { en: 'overall', de: 'gesamt' };

const line = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;
/** 2026-11-19T08:30:00.000Z -> 20261119T083000Z, for file names. */
export const fileStamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

/** Rows of the window, counted up to the cap plus one: more than the cap means the file is cut off. */
export async function exportRowCount(db: Database, kind: CsvKind, monitorId: number, from: Date, to: Date, cap = CSV_EXPORT.maxRows): Promise<number> {
  const inner = kind === 'heartbeats'
    ? db.selectFrom('heartbeats').select('id').where('monitor_id', '=', monitorId).where('ts', '>=', from).where('ts', '<', to).limit(cap + 1)
    : db.selectFrom('events').select('id').where('monitor_id', '=', monitorId).where('ts', '>=', from).where('ts', '<', to).limit(cap + 1);
  return Number((await db.selectFrom(inner.as('t')).select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n ?? 0);
}

/**
 * The export as a stream: read page by page in (ts, id) order with a keyset (no OFFSET, no full result in memory), oldest first,
 * up to the cap. German files start with a byte order mark and use German column names (as the SLA report does).
 */
export function exportCsv(db: Database, o: { kind: CsvKind; monitorId: number; from: Date; to: Date; lang: Lang; probeNames: Map<number, string> }): Readable {
  const { pageSize, maxRows } = CSV_EXPORT;
  const location = (id: number) => (id === 0 ? OVERALL[o.lang] : id === LOCAL_LOCATION_ID ? 'Server' : o.probeNames.get(id) ?? `Probe ${id}`);
  async function* rows(): AsyncGenerator<string> {
    yield (o.lang === 'de' ? '\uFEFF' : '') + line(HEAD[o.lang][o.kind]); // German: byte order mark, so Excel reads the umlauts
    let sent = 0;
    let after: { ts: Date; id: number } | null = null;
    while (sent < maxRows) {
      const n = Math.min(pageSize, maxRows - sent);
      const page: { ts: Date; id: number; cells: unknown[] }[] = [];
      if (o.kind === 'heartbeats') {
        let q = db.selectFrom('heartbeats').select(['id', 'ts', 'status', 'latency_ms', 'error_kind', 'message', 'location_id']).where('monitor_id', '=', o.monitorId).where('ts', '>=', o.from).where('ts', '<', o.to);
        if (after) { const a = after; q = q.where((eb) => eb.or([eb('ts', '>', a.ts), eb.and([eb('ts', '=', a.ts), eb('id', '>', a.id)])])); }
        for (const r of await q.orderBy('ts').orderBy('id').limit(n).execute()) page.push({ ts: r.ts, id: Number(r.id), cells: [r.ts.toISOString(), STATUS[r.status] ?? r.status, r.latency_ms, r.error_kind, r.message, location(r.location_id)] });
      } else {
        let q = db.selectFrom('events').select(['id', 'ts', 'type', 'from_status', 'to_status', 'error_kind', 'message']).where('monitor_id', '=', o.monitorId).where('ts', '>=', o.from).where('ts', '<', o.to);
        if (after) { const a = after; q = q.where((eb) => eb.or([eb('ts', '>', a.ts), eb.and([eb('ts', '=', a.ts), eb('id', '>', a.id)])])); }
        for (const r of await q.orderBy('ts').orderBy('id').limit(n).execute()) page.push({ ts: r.ts, id: Number(r.id), cells: [r.ts.toISOString(), r.type, r.from_status, r.to_status, r.error_kind, r.message] });
      }
      if (!page.length) return;
      yield page.map((p) => line(p.cells)).join('');
      sent += page.length;
      const last = page[page.length - 1]!;
      after = { ts: last.ts, id: last.id };
      if (page.length < n) return;
    }
  }
  return Readable.from(rows());
}
