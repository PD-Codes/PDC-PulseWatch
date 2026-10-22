import { sql } from 'kysely';
import type { Ctx } from './context';

/** Optional content blocks of a status page, shown below its components in the order the admin chose. */
export type BlockConfig =
  | { type: 'summary' }
  | { type: 'heatmap'; days: 90 | 180 | 365 }
  | { type: 'streak' }
  | { type: 'text'; title: string; body: string };

export const HEATMAP_DAYS = [90, 180, 365] as const;
export const MAX_BLOCKS = 12;
const DAY = 86_400_000;

/** Accepts whatever a client or an import file sends and keeps only well-formed blocks. */
export function normalizeBlocks(input: unknown): BlockConfig[] {
  if (!Array.isArray(input)) return [];
  const out: BlockConfig[] = [];
  for (const b of input.slice(0, MAX_BLOCKS)) {
    if (!b || typeof b !== 'object') continue;
    const x = b as Record<string, unknown>;
    if (x.type === 'summary' || x.type === 'streak') out.push({ type: x.type });
    else if (x.type === 'heatmap') out.push({ type: 'heatmap', days: (HEATMAP_DAYS as readonly unknown[]).includes(x.days) ? (x.days as 90 | 180 | 365) : 365 });
    else if (x.type === 'text') {
      const title = String(x.title ?? '').trim().slice(0, 120), body = String(x.body ?? '').trim().slice(0, 2000);
      if (title || body) out.push({ type: 'text', title, body });
    }
  }
  return out;
}

export interface Day { date: string; uptime: number | null; down: number; total: number }
export type RenderedBlock =
  | { type: 'summary'; uptime: { h24: number | null; d7: number | null; d30: number | null; d90: number | null } }
  | { type: 'heatmap'; days: Day[] }
  | { type: 'streak'; days: number | null; ongoing: boolean }
  | { type: 'text'; title: string; body: string };

const pct = (up: unknown, down: unknown): number | null => {
  const u = Number(up ?? 0), d = Number(down ?? 0);
  return u + d === 0 ? null : Math.round((u / (u + d)) * 10000) / 100;
};

// Public pages are polled by every open browser, so the heavy aggregates are shared for a minute.
const cache = new Map<string, { exp: number; value: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value as T;
  const value = await fn();
  if (cache.size > 500) cache.clear();
  cache.set(key, { exp: Date.now() + 60_000, value });
  return value;
}

async function summary(ctx: Ctx, ids: number[]) {
  const now = Date.now(), t = (ms: number) => new Date(now - ms);
  const { rows } = await sql<any>`
    SELECT SUM(CASE WHEN res='hour' AND bucket >= ${t(DAY)} THEN up_n END) u24, SUM(CASE WHEN res='hour' AND bucket >= ${t(DAY)} THEN down_n END) d24,
      SUM(CASE WHEN res='hour' AND bucket >= ${t(7 * DAY)} THEN up_n END) u7, SUM(CASE WHEN res='hour' AND bucket >= ${t(7 * DAY)} THEN down_n END) d7,
      SUM(CASE WHEN res='day' AND bucket >= ${t(30 * DAY)} THEN up_n END) u30, SUM(CASE WHEN res='day' AND bucket >= ${t(30 * DAY)} THEN down_n END) d30,
      SUM(CASE WHEN res='day' AND bucket >= ${t(90 * DAY)} THEN up_n END) u90, SUM(CASE WHEN res='day' AND bucket >= ${t(90 * DAY)} THEN down_n END) d90
    FROM rollups WHERE monitor_id IN (${sql.join(ids)}) AND ((res='hour' AND bucket >= ${t(7 * DAY)}) OR (res='day' AND bucket >= ${t(90 * DAY)}))`.execute(ctx.db);
  const r = rows[0] ?? {};
  return { h24: pct(r.u24, r.d24), d7: pct(r.u7, r.d7), d30: pct(r.u30, r.d30), d90: pct(r.u90, r.d90) };
}

async function heatmap(ctx: Ctx, ids: number[], days: number): Promise<Day[]> {
  const since = new Date(Math.floor(Date.now() / DAY) * DAY - (days - 1) * DAY);
  const { rows } = await sql<any>`SELECT bucket, SUM(up_n) u, SUM(down_n) d FROM rollups WHERE res = 'day' AND bucket >= ${since} AND monitor_id IN (${sql.join(ids)}) GROUP BY bucket ORDER BY bucket`.execute(ctx.db);
  const by = new Map<string, { u: number; d: number }>(rows.map((r: any) => [new Date(r.bucket).toISOString().slice(0, 10), { u: Number(r.u), d: Number(r.d) }]));
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10), v = by.get(date);
    return { date, uptime: v ? pct(v.u, v.d) : null, down: v?.d ?? 0, total: v ? v.u + v.d : 0 };
  });
}

/** Days since the last incident that touched this page ended, counting only incidents the page itself would show. */
async function streak(ctx: Ctx, ids: number[]) {
  const rows = await ctx.db.selectFrom('incidents as i').innerJoin('incident_monitors as im', 'im.incident_id', 'i.id')
    .select(['i.started_at', 'i.resolved_at']).where('im.monitor_id', 'in', ids).where('i.hidden', '=', 0).where((eb) => eb.or([eb('i.source', '=', 'auto'), eb('i.public', '=', 1)])).execute();
  if (!rows.length) return { days: null, ongoing: false };
  if (rows.some((r) => !r.resolved_at)) return { days: 0, ongoing: true };
  const last = Math.max(...rows.map((r) => r.resolved_at!.getTime()));
  return { days: Math.max(0, Math.floor((Date.now() - last) / DAY)), ongoing: false };
}

export async function renderBlocks(ctx: Ctx, pageId: number, blocks: BlockConfig[], ids: number[]): Promise<RenderedBlock[]> {
  const out: RenderedBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') { out.push(b); continue; }
    if (!ids.length) { // a page without components has nothing to aggregate
      out.push(b.type === 'summary' ? { type: 'summary', uptime: { h24: null, d7: null, d30: null, d90: null } } : b.type === 'heatmap' ? { type: 'heatmap', days: [] } : { type: 'streak', days: null, ongoing: false });
      continue;
    }
    const key = `${pageId}:${ids.join(',')}:${b.type}:${'days' in b ? b.days : ''}`;
    if (b.type === 'summary') out.push({ type: 'summary', uptime: await cached(key, () => summary(ctx, ids)) });
    else if (b.type === 'heatmap') out.push({ type: 'heatmap', days: await cached(key, () => heatmap(ctx, ids, b.days)) });
    else out.push({ type: 'streak', ...(await cached(key, () => streak(ctx, ids))) });
  }
  return out;
}
