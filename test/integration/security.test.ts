import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './harness';

let t: TestApp;
let admin: ReturnType<TestApp['client']>;
let ed: ReturnType<TestApp['client']>; // scope-restricted editor, manages group "mine" only
let mineGroup = 0, otherGroup = 0, mineMonitor = 0, otherMonitor = 0;
const PW = 'correct-horse-battery-1';

beforeAll(async () => {
  t = await startApp();
  admin = t.client();
  await admin.post('/api/setup', { username: 'admin', password: PW });
  mineGroup = (await admin.post('/api/groups', { name: 'mine' })).json.id;
  otherGroup = (await admin.post('/api/groups', { name: 'other' })).json.id;
  mineMonitor = (await admin.post('/api/monitors', { name: 'mine-push', type: 'push', config: {}, groupId: mineGroup })).json.id;
  otherMonitor = (await admin.post('/api/monitors', { name: 'other-push', type: 'push', config: {}, groupId: otherGroup })).json.id;
  const u = (await admin.post('/api/users', { username: 'scoped', password: 'correct-horse-battery-2', role: 'editor', scopeRestricted: true })).json;
  await admin.put(`/api/users/${u.id}/grants`, { grants: [{ type: 'monitor_group', id: mineGroup, level: 'manage' }] });
  ed = t.client();
  await ed.post('/api/auth/login', { username: 'scoped', password: 'correct-horse-battery-2' });
});
afterAll(async () => { await t?.close(); });

const window = (targets: object[]) => ({ name: 'w', kind: 'once', startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-01-01T01:00:00Z', targets });

describe('scope restricted editor', () => {
  it('cannot plan maintenance for monitors or groups outside the scope, and can for its own', async () => {
    expect((await ed.post('/api/maintenance', window([{ type: 'monitor', id: otherMonitor }]))).status).toBe(403);
    expect((await ed.post('/api/maintenance', window([{ type: 'group', id: otherGroup }]))).status).toBe(403);
    expect((await ed.post('/api/maintenance', window([{ type: 'monitor', id: mineMonitor }]))).status).toBe(200);
    const w = (await admin.post('/api/maintenance', window([{ type: 'monitor', id: otherMonitor }]))).json;
    expect((await ed.del(`/api/maintenance/${w.id}`)).status).toBe(403);
  });

  it('cannot create monitors in foreign groups or without a group', async () => {
    expect((await ed.post('/api/monitors', { name: 'x', type: 'push', config: {}, groupId: otherGroup })).status).toBe(403);
    expect((await ed.post('/api/monitors', { name: 'x', type: 'push', config: {} })).status).toBe(403);
    expect((await ed.post('/api/monitors', { name: 'x', type: 'push', config: {}, groupId: mineGroup })).status).toBe(200);
  });

  it('does not see monitors, push tokens or deliveries of foreign groups', async () => {
    const list = (await ed.get('/api/monitors')).json;
    const rows: any[] = Array.isArray(list) ? list : list.items ?? list.monitors ?? [];
    expect(rows.map((m) => m.id)).toContain(mineMonitor);
    expect(rows.map((m) => m.id)).not.toContain(otherMonitor);
    expect((await ed.get(`/api/monitors/${otherMonitor}`)).status).toBe(404);
    await t.ctx.db.insertInto('notification_channels').values({ name: 'c', type: 'webhook', config_enc: '{}', active: 1 } as any).execute();
    const ch = (await t.ctx.db.selectFrom('notification_channels').select('id').executeTakeFirstOrThrow()).id;
    const add = (monitor_id: number, subject: string) => t.ctx.db.insertInto('notification_deliveries').values({ channel_id: ch, monitor_id, event: 'down', status: 'sent', attempts: 1, subject, payload: '{}' }).execute();
    await add(mineMonitor, 'visible'); await add(otherMonitor, 'hidden');
    const subjects = ((await ed.get('/api/notification-deliveries')).json as any[]).map((d) => d.subject);
    expect(subjects).toContain('visible');
    expect(subjects).not.toContain('hidden');
  });

  it('cannot move a group below its own sub-group (that would loop the tree)', async () => {
    const parent = (await admin.post('/api/groups', { name: 'p' })).json.id;
    const child = (await admin.post('/api/groups', { name: 'c', parentId: parent })).json.id;
    expect((await admin.call('PATCH', `/api/groups/${parent}`, { parentId: child })).status).toBe(400);
    expect((await admin.call('PATCH', `/api/groups/${parent}`, { parentId: parent })).status).toBe(400);
  });
});

describe('sessions, tokens and re-authentication', () => {
  it('rejects API tokens on session-only routes', async () => {
    const tok = (await admin.post('/api/tokens', { name: 'ci', scopes: ['admin'] })).json.token as string;
    const api = t.client({ bearer: tok });
    expect((await api.get('/api/monitors')).status).toBe(200);
    expect((await api.post('/api/auth/2fa/setup')).status).toBe(403);
    expect((await api.post('/api/auth/passkeys/register/options', { password: PW })).status).toBe(403);
  });

  it('refuses to restart 2FA enrollment once it is on, and asks for the password before a passkey is added', async () => {
    const c = t.client();
    await c.post('/api/auth/login', { username: 'admin', password: PW });
    const setup = (await c.post('/api/auth/2fa/setup')).json;
    expect(setup.secret).toBeTruthy();
    const { totpCode } = await import('../../src/server/crypto');
    expect((await c.post('/api/auth/2fa/enable', { code: totpCode(setup.secret) })).status).toBe(200);
    expect((await c.post('/api/auth/2fa/setup')).status).toBe(409);
    const noPassword = await c.post('/api/auth/passkeys/register/options', {});
    expect(noPassword.status).toBe(400);
  });
});

describe('viewers', () => {
  it('never get push tokens', async () => {
    await admin.post('/api/users', { username: 'viewer', password: 'correct-horse-battery-3', role: 'viewer' });
    const v = t.client();
    await v.post('/api/auth/login', { username: 'viewer', password: 'correct-horse-battery-3' });
    const list = (await v.get('/api/monitors')).json;
    const rows: any[] = Array.isArray(list) ? list : list.items ?? list.monitors ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const m of rows) expect(m.pushToken ?? null).toBeNull();
    expect(JSON.stringify((await v.get(`/api/monitors/${mineMonitor}`)).json)).not.toMatch(/pushToken":"[^"]/);
  });
});
