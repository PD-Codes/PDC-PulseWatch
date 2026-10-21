import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); });
afterAll(async () => { await t?.close(); });

const tagsOf = async (id: number) => ((await c.get(`/api/monitors/${id}`)).json.tags as { name: string; value: string }[]).map((x) => `${x.name}${x.value ? `=${x.value}` : ''}`);

describe('tags with a value', () => {
  let env: number, plain: number;
  beforeAll(async () => {
    env = (await c.post('/api/tags', { name: 'env', color: '#2563eb' })).json.id;
    plain = (await c.post('/api/tags', { name: 'plain', color: '#059669' })).json.id;
  });

  it('keeps plain tags and name + value tags side by side and replaces each kind on its own', async () => {
    const m = await c.post('/api/monitors', { name: 'tv-1', type: 'push', config: {}, tagIds: [plain], tagValues: [{ tagId: env, value: 'prod' }, { tagId: env, value: ' eu ' }] });
    expect(m.status).toBe(200);
    const id = m.json.id as number;
    expect(await tagsOf(id)).toEqual(['env=eu', 'env=prod', 'plain']);
    // an update that only sends the plain tags leaves the values alone
    await c.put(`/api/monitors/${id}`, { tagIds: [] });
    expect(await tagsOf(id)).toEqual(['env=eu', 'env=prod']);
    // and the other way round
    await c.put(`/api/monitors/${id}`, { tagIds: [plain], tagValues: [{ tagId: env, value: 'dev' }] });
    expect(await tagsOf(id)).toEqual(['env=dev', 'plain']);
    await c.put(`/api/monitors/${id}`, { tagValues: [] });
    expect(await tagsOf(id)).toEqual(['plain']);
  });

  it('rejects empty values and unknown tags', async () => {
    const bad = (extra: object) => c.post('/api/monitors', { name: 'tv-bad', type: 'push', config: {}, ...extra });
    expect((await bad({ tagValues: [{ tagId: env, value: '   ' }] })).status).toBe(400);
    expect((await bad({ tagValues: [{ tagId: 999999, value: 'x' }] })).status).toBe(400);
    expect((await bad({ tagIds: [999999] })).status).toBe(400);
    expect((await bad({ tagValues: [{ tagId: env, value: 'x'.repeat(256) }] })).status).toBe(400);
  });

  it('lists the values in use with their counts and counts a monitor once per tag', async () => {
    const a = (await c.post('/api/monitors', { name: 'tv-a', type: 'push', config: {}, tagValues: [{ tagId: env, value: 'stage' }, { tagId: env, value: 'canary' }] })).json.id;
    await c.post('/api/monitors', { name: 'tv-b', type: 'push', config: {}, tagValues: [{ tagId: env, value: 'stage' }] });
    const list = (await c.get('/api/tags')).json as { id: number; monitors: number; values: { value: string; count: number }[] }[];
    const e = list.find((x) => x.id === env)!;
    expect(e.values).toEqual(expect.arrayContaining([{ value: 'stage', count: 2 }, { value: 'canary', count: 1 }]));
    expect(e.monitors).toBeGreaterThanOrEqual(2);
    const sla = (await c.get(`/api/reports/sla?scope=tag&id=${env}&days=1`)).json.rows as { monitorId: number }[];
    expect(sla.filter((r) => r.monitorId === a)).toHaveLength(1); // two values of one tag must not duplicate the monitor
  });

  it('copies the values when a monitor is cloned', async () => {
    const src = (await c.post('/api/monitors', { name: 'tv-clone', type: 'push', config: {}, tagIds: [plain], tagValues: [{ tagId: env, value: 'prod' }] })).json.id;
    const copy = (await c.post(`/api/monitors/${src}/clone`)).json.id;
    expect(await tagsOf(copy)).toEqual(['env=prod', 'plain']);
  });

  it('survives an export and import, and still reads documents with plain tag names', async () => {
    const id = (await c.post('/api/monitors', { name: 'tv-rt', type: 'push', config: {}, tagIds: [plain], tagValues: [{ tagId: env, value: 'prod' }] })).json.id;
    const doc = JSON.parse((await c.get('/api/config/export?format=json')).body);
    expect(doc.monitors.find((m: any) => m.name === 'tv-rt').tags).toEqual(expect.arrayContaining(['plain', { name: 'env', value: 'prod' }]));
    await c.del(`/api/monitors/${id}`);
    const rep = (await c.post('/api/config/import', { content: JSON.stringify({ version: 1, monitors: doc.monitors.filter((m: any) => m.name === 'tv-rt') }) })).json;
    expect(rep.errors).toEqual([]);
    const back = ((await c.get('/api/monitors')).json as any[]).find((m) => m.name === 'tv-rt');
    expect(await tagsOf(back.id)).toEqual(['env=prod', 'plain']);
    // an older document that lists tags as strings only still imports them as plain tags
    const old = { version: 1, monitors: [{ name: 'tv-old', type: 'push', config: {}, tags: ['legacy', 'plain'] }] };
    expect((await c.post('/api/config/import', { content: JSON.stringify(old) })).json.errors).toEqual([]);
    const o = ((await c.get('/api/monitors')).json as any[]).find((m) => m.name === 'tv-old');
    expect(await tagsOf(o.id)).toEqual(['legacy', 'plain']);
  });

  it('creates a new tag once even when the same import uses it with several values', async () => {
    const doc = { version: 1, monitors: [{ name: 'tv-multi', type: 'push', config: {}, tags: [{ name: 'region', value: 'eu' }, { name: 'region', value: 'us' }, { name: 'tier', value: 'gold' }] }] };
    const rep = (await c.post('/api/config/import', { content: JSON.stringify(doc) })).json;
    expect(rep.errors).toEqual([]);
    const m = ((await c.get('/api/monitors')).json as any[]).find((x) => x.name === 'tv-multi');
    expect(await tagsOf(m.id)).toEqual(['region=eu', 'region=us', 'tier=gold']);
    expect(((await c.get('/api/tags')).json as any[]).filter((x) => x.name === 'region')).toHaveLength(1);
  });
});
