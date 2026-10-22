import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let monId: number;
beforeAll(async () => {
  t = await startApp();
  c = await loggedInAdmin(t);
  monId = (await c.post('/api/monitors', { name: 'blocks-push', type: 'push', config: {} })).json.id;
});
afterAll(async () => { await t?.close(); });

const DAY = 86_400_000;
const today = () => new Date(Math.floor(Date.now() / DAY) * DAY);

describe('status page blocks', () => {
  it('keeps only well-formed blocks and renders them from rollups', async () => {
    const d1 = new Date(today().getTime() - DAY), d2 = new Date(today().getTime() - 2 * DAY);
    const row = (bucket: Date, up_n: number, down_n: number) => ({ monitor_id: monId, res: 'day' as const, bucket, total: up_n + down_n, up_n, down_n });
    await t.ctx.db.insertInto('rollups').values([row(d1, 99, 1), row(d2, 100, 0)]).execute();

    const body = {
      slug: 'blocks', title: 'Blocks', isPublic: true, sections: [], components: [{ monitorId: monId }],
      blocks: [{ type: 'summary' }, { type: 'heatmap', days: 90 }, { type: 'streak' }, { type: 'text', title: 'Contact', body: 'ops@example.com' }, { type: 'bogus' }, { type: 'text', title: '', body: '' }, { type: 'heatmap', days: 7 }],
    };
    expect((await c.post('/api/status-pages', body)).status).toBe(200);
    const pub = (await t.client().get('/api/public/status/blocks')).json;
    expect(pub.blocks.map((b: any) => b.type)).toEqual(['summary', 'heatmap', 'streak', 'text', 'heatmap']); // bogus and empty text dropped
    expect(pub.blocks[4].days.length).toBe(365); // unknown range falls back to the default
    const heat = pub.blocks[1].days;
    expect(heat.length).toBe(90);
    expect(heat.find((d: any) => d.date === d1.toISOString().slice(0, 10))).toMatchObject({ uptime: 99, down: 1, total: 100 });
    expect(heat.at(-1).uptime).toBeNull(); // today has no rollup
    expect(pub.blocks[0].uptime.d90).toBeCloseTo(99.5, 1);
    expect(pub.blocks[2]).toMatchObject({ days: null, ongoing: false }); // no incident on record
  });

  it('round-trips through the admin API and clears with an empty list', async () => {
    const id = (await c.get('/api/status-pages')).json.find((p: any) => p.slug === 'blocks').id;
    expect((await c.get(`/api/status-pages/${id}`)).json.blocks).toHaveLength(5);
    expect((await c.put(`/api/status-pages/${id}`, { slug: 'blocks', title: 'Blocks', isPublic: true, sections: [], components: [{ monitorId: monId }], blocks: [] })).status).toBe(200);
    expect((await c.get(`/api/status-pages/${id}`)).json.blocks).toEqual([]);
    expect((await t.client().get('/api/public/status/blocks')).json.blocks).toEqual([]);
  });
});
