// Wall display presets, read-only kiosk keys, the hourly history and the key-based kiosk endpoints.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;

beforeAll(async () => {
  t = await startApp();
  c = await loggedInAdmin(t);
});
afterAll(async () => { await t?.close(); });

const db = () => t.ctx.db;
type Client = ReturnType<TestApp['client']>;
const patch = (cl: Client, url: string, body: unknown) => cl.call('PATCH', url, body);
const login = async (username: string, role: string, scopeRestricted = false) => {
  const r = await c.post('/api/users', { username, password: `${username}-password-123`, role, scopeRestricted });
  expect(r.status).toBe(200);
  const u = t.client();
  expect((await u.post('/api/auth/login', { username, password: `${username}-password-123` })).status).toBe(200);
  return { client: u, id: r.json.id as number };
};
const push = async (name: string, extra: object = {}) => {
  const r = await c.post('/api/monitors', { name, type: 'push', config: {}, ...extra });
  expect(r.status).toBe(200);
  return r.json.id as number;
};
/** A client without a session: screens only send the key. */
const screen = (key?: string) => {
  const cl = t.client();
  return (url: string) => cl.call('GET', url, undefined, { headers: key === undefined ? {} : { 'x-kiosk-key': key } });
};
/** The port of the app on a real socket (streams need one); listens on first use. */
const portOf = async () => {
  if (!t.app.server.listening) await t.app.listen({ host: '127.0.0.1', port: 0 });
  return (t.app.server.address() as AddressInfo).port;
};
const presetBySlug = async (slug: string) => (await c.get('/api/kiosk/presets')).json.items.find((p: any) => p.slug === slug);

describe('presets', () => {
  it('starts with the five built-in presets with empty names, in order', async () => {
    const r = await c.get('/api/kiosk/presets');
    expect(r.status).toBe(200);
    expect(r.json.items.map((p: any) => p.slug)).toEqual(['all', 'wall', 'groups', 'problems', 'history']);
    expect(r.json.items.every((p: any) => p.name === '' && p.keys === 0 && typeof p.updatedAt === 'string')).toBe(true);
    expect(r.json.defaultId).toBeNull();
    const wall = r.json.items[1];
    expect(wall.config).toMatchObject({ display: 'wall', grouped: true, show: 'all', zoom: 100, theme: 'classic' });
    expect(r.json.items[3].config.show).toBe('problems');
  });

  it('creates, validates, renames and deletes', async () => {
    const created = await c.post('/api/kiosk/presets', { slug: 'noc-floor', name: '  NOC floor  ', config: { display: 'table', zoom: 133, theme: 'nope', bogus: 1 }, sort: 5 });
    expect(created.status).toBe(201);
    const id = created.json.id;
    const p = await presetBySlug('noc-floor');
    expect(p).toMatchObject({ id, name: 'NOC floor', sort: 5 });
    expect(p.config).toMatchObject({ display: 'table', zoom: 135, theme: 'classic' });
    expect(p.config).not.toHaveProperty('bogus');
    // only the difference to the defaults is stored
    const row = await db().selectFrom('kiosk_presets').select('config').where('id', '=', id).executeTakeFirstOrThrow();
    expect(JSON.parse(row.config)).toEqual({ display: 'table', zoom: 135 });
    // sorted by sort, then slug
    expect((await c.get('/api/kiosk/presets')).json.items[0].slug).toBe('noc-floor');

    for (const slug of ['Bad', '-x', 'x-', 'a_b', '', 'a'.repeat(33)]) expect((await c.post('/api/kiosk/presets', { slug, name: 'x', config: {} })).status).toBe(400);
    expect((await c.post('/api/kiosk/presets', { slug: 'ok-1', name: '   ', config: {} })).status).toBe(400);
    expect((await c.post('/api/kiosk/presets', { slug: 'ok-1', name: 'x'.repeat(65), config: {} })).status).toBe(400);
    expect((await c.post('/api/kiosk/presets', { slug: 'ok-1', name: 'x', config: {}, sort: 100_001 })).status).toBe(400);
    const dup = await c.post('/api/kiosk/presets', { slug: 'wall', name: 'x', config: {} });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe('slug_taken');

    expect((await patch(c, `/api/kiosk/presets/${id}`, { slug: 'wall' })).json.error).toBe('slug_taken');
    expect((await patch(c, `/api/kiosk/presets/${id}`, { slug: 'Wall' })).status).toBe(400);
    expect((await patch(c, `/api/kiosk/presets/${id}`, { name: '' })).status).toBe(400);
    expect((await patch(c, '/api/kiosk/presets/999999', { name: 'x' })).status).toBe(404);
    const ok = await patch(c, `/api/kiosk/presets/${id}`, { slug: 'noc', name: 'NOC', config: { display: 'heatmap' }, sort: 7 });
    expect(ok.json).toEqual({ ok: true });
    const after = await presetBySlug('noc');
    expect(after).toMatchObject({ id, name: 'NOC', sort: 7 });
    expect(after.config.display).toBe('heatmap');
    expect(after.config.zoom).toBe(100); // a config replaces the old one
    expect(await presetBySlug('noc-floor')).toBeUndefined();
    // a built-in preset keeps its empty name when a form sends it back unchanged
    const wall = await presetBySlug('wall');
    expect((await patch(c, `/api/kiosk/presets/${wall.id}`, { name: '', config: { ...wall.config, zoom: 120 } })).status).toBe(200);
    expect(await presetBySlug('wall')).toMatchObject({ name: '', config: { zoom: 120, display: 'wall' } });

    expect((await c.del(`/api/kiosk/presets/${id}`)).json).toEqual({ ok: true });
    expect(await presetBySlug('noc')).toBeUndefined();
    expect((await c.del(`/api/kiosk/presets/${id}`)).status).toBe(404);
  });

  it('only admins write; every signed-in user lists, without key counts', async () => {
    const all = await presetBySlug('all');
    for (const role of ['viewer', 'editor']) {
      const { client: u } = await login(`kiosk-${role}`, role);
      const list = await u.get('/api/kiosk/presets');
      expect(list.status).toBe(200);
      expect(list.json.items.length).toBeGreaterThanOrEqual(5);
      expect(list.json.items.every((p: any) => !('keys' in p))).toBe(true);
      expect((await u.post('/api/kiosk/presets', { slug: `by-${role}`, name: 'x', config: {} })).status).toBe(403);
      expect((await patch(u, `/api/kiosk/presets/${all.id}`, { name: 'x' })).status).toBe(403);
      expect((await u.del(`/api/kiosk/presets/${all.id}`)).status).toBe(403);
      expect((await u.get('/api/settings/kiosk')).status).toBe(403);
      expect((await u.put('/api/settings/kiosk', { defaultPreset: all.id })).status).toBe(403);
      expect((await u.get(`/api/kiosk/presets/${all.id}/keys`)).status).toBe(403);
      expect((await u.post(`/api/kiosk/presets/${all.id}/keys`, { name: 'x' })).status).toBe(403);
      expect((await u.del('/api/kiosk/keys/1')).status).toBe(403);
    }
    expect((await t.client().get('/api/kiosk/presets')).status).toBe(401);
  });

  it('keeps a default preset and clears it when that preset goes', async () => {
    expect((await c.get('/api/settings/kiosk')).json).toEqual({ defaultPreset: null });
    const id = (await c.post('/api/kiosk/presets', { slug: 'lobby', name: 'Lobby', config: {} })).json.id;
    expect((await c.put('/api/settings/kiosk', { defaultPreset: id })).json).toEqual({ ok: true });
    expect((await c.get('/api/settings/kiosk')).json).toEqual({ defaultPreset: id });
    expect((await c.get('/api/kiosk/presets')).json.defaultId).toBe(id);
    expect((await c.put('/api/settings/kiosk', { defaultPreset: 999999 })).status).toBe(400);
    expect((await c.put('/api/settings/kiosk', { defaultPreset: 'x' })).status).toBe(400);
    await c.del(`/api/kiosk/presets/${id}`);
    expect((await c.get('/api/settings/kiosk')).json).toEqual({ defaultPreset: null });
    expect((await c.get('/api/kiosk/presets')).json.defaultId).toBeNull();
    const all = await presetBySlug('all');
    await c.put('/api/settings/kiosk', { defaultPreset: all.id });
    expect((await c.put('/api/settings/kiosk', { defaultPreset: null })).json).toEqual({ ok: true });
    expect((await c.get('/api/settings/kiosk')).json).toEqual({ defaultPreset: null });
  });
});

describe('kiosk keys and screens', () => {
  let root: number, sub: number, other: number, unused: number;
  let mA: number, mB: number, mC: number, mPaused: number;
  let presetId: number, key: string, keyId: number;

  beforeAll(async () => {
    root = (await c.post('/api/groups', { name: 'Root' })).json.id;
    sub = (await c.post('/api/groups', { name: 'Sub', parentId: root })).json.id;
    other = (await c.post('/api/groups', { name: 'Other' })).json.id;
    unused = (await c.post('/api/groups', { name: 'Unused', parentId: root })).json.id;
    const tag = (await c.post('/api/tags', { name: 'edge' })).json.id;
    mA = await push('Alpha', { groupId: root });
    mB = await push('Beta', { groupId: sub, tagIds: [tag] });
    mC = await push('Gamma', { groupId: other });
    mPaused = await push('Paused', { groupId: sub });
    await c.post(`/api/monitors/${mPaused}/pause`);
    await db().updateTable('monitor_state').set({ status: 'down', last_error_kind: 'timeout', last_message: 'secret detail', info: JSON.stringify({ players: 3, maxPlayers: 10, names: ['x'], motd: 'hi' }) }).where('monitor_id', '=', mB).execute();
    presetId = (await c.post('/api/kiosk/presets', { slug: 'ops', name: 'Ops', config: { groups: [root], messages: false, incidents: false } })).json.id;
  });

  it('creates a key that is shown once and listed by its prefix only', async () => {
    const r = await c.post(`/api/kiosk/presets/${presetId}/keys`, { name: 'Lobby TV' });
    expect(r.status).toBe(201);
    key = r.json.key; keyId = r.json.id;
    expect(key).toMatch(/^pwk_[A-Za-z0-9_-]{43}$/);
    const list = await c.get(`/api/kiosk/presets/${presetId}/keys`);
    expect(list.status).toBe(200);
    expect(list.json).toEqual([{ id: keyId, name: 'Lobby TV', prefix: key.slice(0, 12), createdAt: expect.any(String), createdBy: 'admin', lastUsedAt: null, lastIp: null }]);
    expect(list.body).not.toContain(key);
    const stored = await db().selectFrom('kiosk_keys').selectAll().where('id', '=', keyId).executeTakeFirstOrThrow();
    expect(list.body).not.toContain(stored.token_hash);
    expect((await c.post(`/api/kiosk/presets/${presetId}/keys`, { name: '  ' })).status).toBe(400);
    expect((await c.post('/api/kiosk/presets/999999/keys', { name: 'x' })).status).toBe(404);
    expect((await c.get('/api/kiosk/presets/999999/keys')).status).toBe(404);
    expect((await presetBySlug('ops')).keys).toBe(1);
  });

  it('serves the scoped view to a screen without a session', async () => {
    const r = await screen(key)('/api/public/kiosk/view');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.json.preset).toMatchObject({ id: presetId, slug: 'ops', name: 'Ops' });
    expect(r.json.preset.config.groups).toEqual([root]);
    expect(typeof r.json.serverTime).toBe('string');
    // Gamma is outside the scope, Paused is not active
    expect(r.json.monitors.map((m: any) => m.name)).toEqual(['Alpha', 'Beta']);
    for (const m of r.json.monitors) {
      expect(Object.keys(m).sort()).toEqual(['active', 'errorKind', 'groupId', 'id', 'info', 'lastCheckAt', 'latencyMs', 'message', 'name', 'overlay', 'recent', 'status', 'statusSince', 'uptime']);
      expect(Object.keys(m.uptime).sort()).toEqual(['d30', 'h24']);
      for (const k of ['pushToken', 'description', 'tags', 'type']) expect(m).not.toHaveProperty(k);
    }
    const beta = r.json.monitors.find((m: any) => m.id === mB);
    expect(beta).toMatchObject({ status: 'down', message: null, errorKind: null, info: { players: 3, maxPlayers: 10 } });
    expect(Object.keys(beta.info).sort()).toEqual(['maxPlayers', 'players']);
    expect(r.json.monitors.find((m: any) => m.id === mA).info).toBeNull();
    // used groups and their ancestors only, in sort/name order
    expect(r.json.groups).toEqual([{ id: root, parentId: null, name: 'Root', description: null }, { id: sub, parentId: root, name: 'Sub', description: null }]);
    expect(r.json.groups.some((g: any) => g.id === unused || g.id === other)).toBe(false);
    expect(r.json.incidents).toEqual([]);
    expect(r.body).not.toContain('secret detail');
    const k = await db().selectFrom('kiosk_keys').select(['last_used_at', 'last_ip']).where('id', '=', keyId).executeTakeFirstOrThrow();
    expect(k.last_used_at).not.toBeNull();
  });

  it('follows the preset: messages, incidents and scope after a PATCH', async () => {
    const inc = Number((await db().insertInto('incidents').values({ title: 'Beta is down', status: 'open', severity: 'critical', started_at: new Date() }).executeTakeFirstOrThrow()).insertId);
    await db().insertInto('incident_monitors').values({ incident_id: inc, monitor_id: mB }).execute();
    const done = Number((await db().insertInto('incidents').values({ title: 'Old', status: 'resolved', started_at: new Date(Date.now() - 1000) }).executeTakeFirstOrThrow()).insertId);
    await db().insertInto('incident_monitors').values({ incident_id: done, monitor_id: mB }).execute();
    const outside = Number((await db().insertInto('incidents').values({ title: 'Gamma is down', status: 'open', started_at: new Date() }).executeTakeFirstOrThrow()).insertId);
    await db().insertInto('incident_monitors').values({ incident_id: outside, monitor_id: mC }).execute();

    expect((await patch(c, `/api/kiosk/presets/${presetId}`, { config: { groups: [root], messages: true, incidents: true } })).status).toBe(200);
    const r = await screen(key)('/api/public/kiosk/view');
    const beta = r.json.monitors.find((m: any) => m.id === mB);
    expect(beta).toMatchObject({ message: 'secret detail', errorKind: 'timeout' });
    expect(r.json.incidents).toEqual([{ id: inc, title: 'Beta is down', status: 'open', severity: 'critical', startedAt: expect.any(String) }]);

    expect((await patch(c, `/api/kiosk/presets/${presetId}`, { config: { groups: [other], tags: [], messages: true, incidents: true } })).status).toBe(200);
    const moved = await screen(key)('/api/public/kiosk/view');
    expect(moved.json.monitors.map((m: any) => m.id)).toEqual([mC]);
    expect(moved.json.groups.map((g: any) => g.id)).toEqual([other]);
    expect(moved.json.incidents.map((i: any) => i.id)).toEqual([outside]);

    // tags narrow the scope by name; the key belongs to its preset, not to a slug
    expect((await patch(c, `/api/kiosk/presets/${presetId}`, { slug: 'ops-2', config: { tags: ['edge'] } })).status).toBe(200);
    expect((await screen(key)('/api/public/kiosk/view')).json.monitors.map((m: any) => m.id)).toEqual([mB]);
    await patch(c, `/api/kiosk/presets/${presetId}`, { slug: 'ops', config: { groups: [root], messages: false, incidents: false } });
  });

  it('refuses missing, malformed, unknown and revoked keys', async () => {
    for (const k of [undefined, '', 'nope', 'pw_abc', `pwk_${'a'.repeat(200)}`, 'pwk_unknownkeyvalue']) {
      for (const path of ['/api/public/kiosk/view', '/api/public/kiosk/history', '/api/public/kiosk/stream']) {
        const r = await screen(k)(path);
        expect(r.status).toBe(401);
        expect(r.json.error).toBe('kiosk_key');
      }
    }
    // a signed-in session is no substitute for a key
    expect((await c.get('/api/public/kiosk/view')).status).toBe(401);
    const extra = (await c.post(`/api/kiosk/presets/${presetId}/keys`, { name: 'Temp' })).json;
    expect((await screen(extra.key)('/api/public/kiosk/view')).status).toBe(200);
    expect((await c.del(`/api/kiosk/keys/${extra.id}`)).json).toEqual({ ok: true });
    expect((await screen(extra.key)('/api/public/kiosk/view')).status).toBe(401);
    expect((await c.del(`/api/kiosk/keys/${extra.id}`)).status).toBe(404);
  });

  it('caps the keys per preset', async () => {
    const p = (await c.post('/api/kiosk/presets', { slug: 'many', name: 'Many', config: {} })).json.id;
    await db().insertInto('kiosk_keys').values(Array.from({ length: 50 }, (_, i) => ({ preset_id: p, name: `k${i}`, token_hash: `${p}`.padStart(8, '0') + String(i).padStart(56, '0'), token_prefix: 'pwk_x' }))).execute();
    const r = await c.post(`/api/kiosk/presets/${p}/keys`, { name: 'one too many' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('too_many_keys');
    await c.del(`/api/kiosk/presets/${p}`);
    expect(Number((await db().selectFrom('kiosk_keys').select((eb) => eb.fn.countAll().as('n')).where('preset_id', '=', p).executeTakeFirstOrThrow()).n)).toBe(0);
  });

  it('serves hourly history with the cells in their columns', async () => {
    const HOUR = 3_600_000;
    const cur = Math.floor(Date.now() / HOUR) * HOUR;
    await db().insertInto('rollups').values([
      { monitor_id: mA, res: 'hour', bucket: new Date(cur), total: 60, up_n: 58, down_n: 2, maint_n: 0 },
      { monitor_id: mA, res: 'hour', bucket: new Date(cur - 5 * HOUR), total: 60, up_n: 50, down_n: 0, maint_n: 10 },
      { monitor_id: mA, res: 'hour', bucket: new Date(cur - 30 * HOUR), total: 60, up_n: 60, down_n: 0, maint_n: 0 }, // before the window
      { monitor_id: mA, res: 'minute', bucket: new Date(cur), total: 1, up_n: 1, down_n: 0, maint_n: 0 },
      { monitor_id: mB, res: 'hour', bucket: new Date(cur - 23 * HOUR), total: 12, up_n: 0, down_n: 12, maint_n: 0 },
      { monitor_id: mC, res: 'hour', bucket: new Date(cur - HOUR), total: 6, up_n: 6, down_n: 0, maint_n: 0 },
    ]).execute();

    const r = await c.get('/api/monitors/history');
    expect(r.status).toBe(200);
    expect(r.json.hours).toBe(24);
    expect(r.json.bucketS).toBe(3600);
    expect(r.json.from).toBe(new Date(cur - 23 * HOUR).toISOString());
    expect(Object.keys(r.json.monitors).sort()).toEqual([mA, mB, mC].map(String).sort());
    const a = r.json.monitors[mA];
    expect(a).toHaveLength(24);
    expect(a[23]).toEqual([60, 58, 2, 0]);
    expect(a[18]).toEqual([60, 50, 0, 10]);
    expect(a.filter((x: unknown) => x !== null)).toHaveLength(2);
    expect(r.json.monitors[mB][0]).toEqual([12, 0, 12, 0]);
    expect(r.json.monitors[mC][22]).toEqual([6, 6, 0, 0]);

    const six = await c.get('/api/monitors/history?hours=6');
    expect(six.json.monitors[mA]).toHaveLength(6);
    expect(six.json.monitors[mA][0]).toEqual([60, 50, 0, 10]);
    expect(six.json.monitors[mB]).toBeUndefined();
    for (const h of ['5', '49', 'x']) expect((await c.get(`/api/monitors/history?hours=${h}`)).status).toBe(400);
    expect((await t.client().get('/api/monitors/history')).status).toBe(401);

    // the screen only gets the monitors of its preset (Alpha, Beta under Root)
    const pub = await screen(key)('/api/public/kiosk/history?hours=48');
    expect(pub.status).toBe(200);
    expect(pub.headers['cache-control']).toBe('no-store');
    expect(pub.json.hours).toBe(48);
    expect(Object.keys(pub.json.monitors).sort()).toEqual([mA, mB].map(String).sort());
    expect(pub.json.monitors[mA][47 - 30]).toEqual([60, 60, 0, 0]);

    // a scope-restricted user only gets their granted groups
    const { client: limited, id: uid } = await login('kiosk-limited', 'viewer', true);
    expect(Object.keys((await limited.get('/api/monitors/history')).json.monitors)).toEqual([]);
    expect((await c.put(`/api/users/${uid}/grants`, { grants: [{ type: 'monitor_group', id: other, level: 'view' }] })).status).toBe(200);
    expect(Object.keys((await limited.get('/api/monitors/history')).json.monitors)).toEqual([String(mC)]);
  });

  it('writes audit rows without the key', async () => {
    const extra = (await c.post(`/api/kiosk/presets/${presetId}/keys`, { name: 'Audit TV' })).json;
    await c.del(`/api/kiosk/keys/${extra.id}`);
    const rows = await db().selectFrom('audit_log').select(['action', 'entity_type', 'entity_id', 'details']).where('action', 'like', 'kiosk.%').execute();
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['kiosk.preset.created', 'kiosk.preset.updated', 'kiosk.preset.deleted', 'kiosk.key.created', 'kiosk.key.revoked', 'kiosk.default.changed']) expect(actions.has(a)).toBe(true);
    const created = rows.find((r) => r.action === 'kiosk.key.created' && r.entity_id === String(extra.id))!;
    expect(created.entity_type).toBe('kiosk_key');
    expect(JSON.parse(created.details!)).toEqual({ presetId, name: 'Audit TV', prefix: extra.key.slice(0, 12) });
    const revoked = rows.find((r) => r.action === 'kiosk.key.revoked' && r.entity_id === String(extra.id))!;
    expect(JSON.parse(revoked.details!)).toEqual({ presetId, name: 'Audit TV', prefix: extra.key.slice(0, 12) });
    expect(rows.find((r) => r.action === 'kiosk.preset.created')!.entity_type).toBe('kiosk_preset');
    const all = JSON.stringify(rows);
    expect(all).not.toContain(extra.key);
    expect(all).not.toContain(key);
  });

  it('streams events to a screen with a key', async () => {
    const port = await portOf();
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/kiosk/stream`, { headers: { 'x-kiosk-key': key }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text.startsWith('event: hello\n')).toBe(true);
    // a monitor update inside the scope arrives, without its message (messages are off); one outside does not
    t.ctx.bus.publish({ type: 'monitor', monitorId: mC, data: { id: mC, status: 'down', message: 'other' } });
    t.ctx.bus.publish({ type: 'monitor', monitorId: mA, data: { id: mA, status: 'down', message: 'hidden', errorKind: 'timeout' } });
    text = '';
    while (!text.includes('event: monitor')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(`"id":${mA}`);
    expect(text).not.toContain(`"id":${mC}`);
    expect(text).toContain('"message":null');
    // an edit of the preset tells the screen to refetch (debounced)
    await patch(c, `/api/kiosk/presets/${presetId}`, { sort: 3 });
    text = '';
    while (!text.includes('event: config')) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    await reader.cancel().catch(() => {});

    // revoking the key ends its stream
    const temp = (await c.post(`/api/kiosk/presets/${presetId}/keys`, { name: 'Stream TV' })).json;
    const res2 = await fetch(`http://127.0.0.1:${port}/api/public/kiosk/stream`, { headers: { 'x-kiosk-key': temp.key } });
    const r2 = res2.body!.getReader();
    await r2.read();
    await c.del(`/api/kiosk/keys/${temp.id}`);
    let ended = false;
    for (let i = 0; i < 20 && !ended; i++) ended = (await r2.read()).done;
    expect(ended).toBe(true);

    const bad = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/public/kiosk/stream', headers: { 'x-kiosk-key': 'pwk_wrong' } }, (r) => { r.resume(); resolve(r.statusCode!); }).on('error', reject);
    });
    expect(bad).toBe(401);
  });

  it('leaves nothing behind when clients disconnect while the stream starts', async () => {
    const port = await portOf();
    const keys = await Promise.all([0, 1, 2, 3].map(async (i) => (await c.post(`/api/kiosk/presets/${presetId}/keys`, { name: `Leak ${i}` })).json.key as string));
    const baseline = t.ctx.bus.listenerCount('event');
    await Promise.all(Array.from({ length: 30 }, (_, i) => new Promise<void>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/public/kiosk/stream', headers: { 'x-kiosk-key': keys[i % 4]! } });
      req.on('error', () => resolve());
      req.on('response', (r) => { r.resume(); req.destroy(); resolve(); });
      setTimeout(() => { req.destroy(); resolve(); }, i % 8);
    })));
    let n = -1;
    for (let i = 0; i < 60 && n !== baseline; i++) { await new Promise((r) => setTimeout(r, 50)); n = t.ctx.bus.listenerCount('event'); }
    expect(n).toBe(baseline);
  });

  it('caps open streams per key and per address', async () => {
    const port = await portOf();
    const keys = await Promise.all([0, 1, 2, 3].map(async (i) => (await c.post(`/api/kiosk/presets/${presetId}/keys`, { name: `Cap ${i}` })).json.key as string));
    // the responses are kept: undici cancels an unreferenced body when it is garbage collected, which would end the stream
    const open: { ac: AbortController; r: Response }[] = [];
    const openOne = async (k: string) => {
      const ac = new AbortController();
      const r = await fetch(`http://127.0.0.1:${port}/api/public/kiosk/stream`, { headers: { 'x-kiosk-key': k }, signal: ac.signal });
      if (r.status === 200) open.push({ ac, r }); else await r.text();
      return r;
    };
    for (let i = 0; i < 10; i++) expect((await openOne(keys[0]!)).status).toBe(200);
    const over = await openOne(keys[0]!);
    expect(over.status).toBe(429);
    for (let i = 0; i < 20; i++) expect((await openOne(keys[1 + (i % 2)]!)).status).toBe(200);
    const r = await fetch(`http://127.0.0.1:${port}/api/public/kiosk/stream`, { headers: { 'x-kiosk-key': keys[3]! } });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: string }).error).toBe('too_many_streams');
    for (const o of open) o.ac.abort();
    // the slots are given back when the streams end
    let again = 0;
    for (let i = 0; i < 40 && again !== 200; i++) {
      await new Promise((res) => setTimeout(res, 50));
      const ac = new AbortController();
      const x = await fetch(`http://127.0.0.1:${port}/api/public/kiosk/stream`, { headers: { 'x-kiosk-key': keys[3]! }, signal: ac.signal });
      again = x.status;
      ac.abort();
    }
    expect(again).toBe(200);
  });

  it('refetching after an incident event sees the incident at once', async () => {
    expect((await patch(c, `/api/kiosk/presets/${presetId}`, { config: { groups: [root], incidents: true } })).status).toBe(200);
    const before = (await screen(key)('/api/public/kiosk/view')).json.incidents.map((i: any) => i.id);
    const inc = Number((await db().insertInto('incidents').values({ title: 'Alpha is down', status: 'open', started_at: new Date() }).executeTakeFirstOrThrow()).insertId);
    await db().insertInto('incident_monitors').values({ incident_id: inc, monitor_id: mA }).execute();
    expect((await screen(key)('/api/public/kiosk/view')).json.incidents.map((i: any) => i.id)).toEqual(before); // cached
    t.ctx.bus.publish({ type: 'incident', incidentId: inc, monitorId: mA, status: 'open' });
    expect((await screen(key)('/api/public/kiosk/view')).json.incidents.map((i: any) => i.id)).toContain(inc);
    await db().updateTable('incidents').set({ status: 'resolved' }).where('id', '=', inc).execute();
    await patch(c, `/api/kiosk/presets/${presetId}`, { config: { groups: [root], messages: false, incidents: false } });
  });

  it('refuses scope lists that would lose entries, and fails closed on a broken stored config', async () => {
    for (const config of [{ groups: ['1'] }, { groups: '1' }, { monitors: [0] }, { monitors: [mA, -1] }, { tags: [''] }, { tags: [5] }]) {
      const r = await c.post('/api/kiosk/presets', { slug: 'bad-scope', name: 'x', config });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('invalid_scope');
      expect((await patch(c, `/api/kiosk/presets/${presetId}`, { config })).json.error).toBe('invalid_scope');
    }
    // duplicates are fine, they do not widen anything
    const ok = await c.post('/api/kiosk/presets', { slug: 'dup-scope', name: 'x', config: { groups: [other, other], tags: [], monitors: null } });
    expect(ok.status).toBe(201);
    const k = (await c.post(`/api/kiosk/presets/${ok.json.id}/keys`, { name: 'Broken TV' })).json.key;
    expect((await screen(k)('/api/public/kiosk/view')).json.monitors.map((m: any) => m.id)).toEqual([mC]);
    for (const broken of ['{bad', '{"groups":["1"]}', '[1]']) {
      await db().updateTable('kiosk_presets').set({ config: broken, sort: broken.length }).where('id', '=', ok.json.id).execute();
      const v = await screen(k)('/api/public/kiosk/view');
      expect(v.status).toBe(200);
      expect(v.json.monitors).toEqual([]);
      expect(v.json.groups).toEqual([]);
      expect((await screen(k)('/api/public/kiosk/history')).json.monitors).toEqual({});
    }
    await c.del(`/api/kiosk/presets/${ok.json.id}`);
  });

  it('hides presets that reference groups or monitors outside a restricted user\'s grants', async () => {
    const mine = (await c.post('/api/kiosk/presets', { slug: 'other-only', name: 'Other', config: { groups: [other] } })).json.id;
    const picked = (await c.post('/api/kiosk/presets', { slug: 'alpha-only', name: 'Alpha', config: { monitors: [mA] } })).json.id;
    const { client: u, id: uid } = await login('kiosk-restricted-list', 'editor', true);
    await c.put(`/api/users/${uid}/grants`, { grants: [{ type: 'monitor_group', id: other, level: 'view' }] });
    await c.put('/api/settings/kiosk', { defaultPreset: presetId });
    const r = (await u.get('/api/kiosk/presets')).json;
    const slugs = r.items.map((p: any) => p.slug);
    expect(slugs).toContain('other-only');
    expect(slugs).toContain('all'); // no scope: references nothing
    expect(slugs).not.toContain('alpha-only');
    expect(slugs).not.toContain('ops');
    expect(r.defaultId).toBeNull();
    expect((await c.get('/api/kiosk/presets')).json.defaultId).toBe(presetId);
    await c.put('/api/settings/kiosk', { defaultPreset: mine });
    expect((await u.get('/api/kiosk/presets')).json.defaultId).toBe(mine);
    await c.put('/api/settings/kiosk', { defaultPreset: null });
    await c.del(`/api/kiosk/presets/${mine}`); await c.del(`/api/kiosk/presets/${picked}`);
  });
});
