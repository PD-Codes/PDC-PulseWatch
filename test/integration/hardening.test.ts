import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '../../src/core';
import { ADMIN_PASSWORD, SETUP_TOKEN, startApp, type TestApp } from './harness';

let t: TestApp;
let admin: ReturnType<TestApp['client']>;
const servers: { close(): void }[] = [];
// a built web UI so the not-found handling of assets can be checked
const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-web-'));
fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>spa</title>');

beforeAll(async () => {
  process.env.PW_WEB_DIR = webDir;
  t = await startApp();
});
afterAll(async () => { for (const s of servers) s.close(); await t?.close(); });

/** app.inject from a chosen client address (trustProxy is off, so this is req.ip). */
const from = (ip: string, method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) => t.app.inject({ method, url, payload, remoteAddress: ip, headers });
const login = (ip: string, username: string, password: string, totp?: string) => from(ip, 'POST', '/api/auth/login', { username, password, ...(totp ? { totp } : {}) });
const sessionOf = async (username: string, password: string) => { const c = t.client(); const r = await c.post('/api/auth/login', { username, password }); if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${r.body}`); return c; };

describe('first administrator (runs first)', () => {
  it('needs the setup token while there is no user', async () => {
    const c = t.client();
    expect((await c.get('/api/setup/status')).json).toMatchObject({ needsSetup: true, setupTokenRequired: true });
    const body = { username: 'admin', password: ADMIN_PASSWORD };
    expect((await c.post('/api/setup', { ...body, setupToken: '' })).json.error).toBe('invalid_setup_token');
    const wrong = await c.post('/api/setup', { ...body, setupToken: 'guessed-token-guessed-token' });
    expect([wrong.status, wrong.json.error]).toEqual([403, 'invalid_setup_token']);
    // the generated hash is stored per instance; with PW_SETUP_TOKEN set that is the hash of the variable
    expect(Object.keys(await t.ctx.settings.all('setupToken.')).length).toBe(1);
    // a token logged by an earlier start expires and is cleared when an instance starts
    const { sha256 } = await import('../../src/server/crypto');
    await t.ctx.settings.set('setupToken.earlier-start', { h: sha256('old-token-old-token-old-token'), exp: Date.now() - 1000 });
    expect((await c.post('/api/setup', { ...body, setupToken: 'old-token-old-token-old-token' })).status).toBe(403);
    // a second instance without PW_SETUP_TOKEN generates its own token and logs it once; both are accepted (shared through the settings table)
    const { config } = await import('../../src/server/config');
    const { issueSetupToken } = await import('../../src/server/routes/auth');
    const logged: string[] = [];
    const saved = config.setupToken;
    (config as { setupToken?: string }).setupToken = undefined;
    try { await issueSetupToken({ ...t.ctx, instanceId: 'second-instance', log: { warn: (m: string) => void logged.push(m) } as unknown as typeof t.ctx.log }); } finally { (config as { setupToken?: string }).setupToken = saved; }
    const generated = /^Setup token: (\S+) – enter it on the setup page/.exec(logged[0] ?? '')?.[1] ?? '';
    expect(generated).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(JSON.stringify(await t.ctx.settings.all('setupToken.'))).not.toContain(generated);
    const entries = await t.ctx.settings.all('setupToken.');
    expect(Object.keys(entries).sort()).toEqual(['setupToken.second-instance', expect.stringMatching(/^setupToken\./)].sort());
    expect(entries['setupToken.earlier-start']).toBeUndefined();
    expect((entries['setupToken.second-instance'] as { exp: number }).exp).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect((await c.post('/api/setup', { ...body, setupToken: generated })).status).toBe(200);
    admin = c;
    expect(Object.keys(await t.ctx.settings.all('setupToken.'))).toEqual([]);
    expect((await c.get('/api/setup/status')).json).toMatchObject({ needsSetup: false, setupTokenRequired: false });
    expect((await t.client().post('/api/setup', { username: 'second', password: ADMIN_PASSWORD, setupToken: SETUP_TOKEN })).status).toBe(409);
  });
});

describe('PW_TRUST_PROXY', () => {
  it('trusts the given number of hops and warns when every hop is trusted', async () => {
    const { config } = await import('../../src/server/config');
    const { buildApp } = await import('../../src/server/app');
    const pino = (await import('pino')).default;
    const saved = config.trustProxy;
    const build = async (v: typeof config.trustProxy) => {
      const lines: string[] = [];
      (config as { trustProxy: typeof v }).trustProxy = v;
      try {
        const app = await buildApp({ ...t.ctx, log: pino({ level: 'warn' }, { write: (l: string) => void lines.push(l) }) }, { extraRoutes: [(a) => { a.get('/ip-echo', async (req) => req.ip); }] });
        const ip = (await app.inject({ url: '/ip-echo', remoteAddress: '10.9.9.9', headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' } })).body;
        await app.close();
        return { ip, log: lines.join('') };
      } finally { (config as { trustProxy: typeof v }).trustProxy = saved; }
    };
    expect((await build(false)).ip).toBe('10.9.9.9');
    expect((await build(1)).ip).toBe('1.2.3.4');
    expect((await build(['10.0.0.0/8'])).ip).toBe('1.2.3.4');
    const all = await build(true);
    expect(all.ip).toBe('6.6.6.6'); // the forged first entry wins: hence the warning
    expect(all.log).toContain('PW_TRUST_PROXY=true');
  });
});

describe('failed sign-ins', () => {
  beforeAll(async () => { await admin.post('/api/users', { username: 'lockme', password: 'lockme-password-1', role: 'editor' }); });

  it('slows down the guessing address, not the account owner elsewhere', async () => {
    for (let i = 0; i < 5; i++) expect((await login('10.0.0.1', 'lockme', 'wrong-password')).statusCode).toBe(401);
    const blocked = await login('10.0.0.1', 'lockme', 'lockme-password-1');
    expect([blocked.statusCode, blocked.json().error]).toEqual([429, 'locked']);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login('10.0.0.2', 'lockme', 'lockme-password-1')).statusCode).toBe(200);
    // the admin is not locked out by somebody else's guesses either
    for (let i = 0; i < 6; i++) await login('10.0.0.3', 'admin', 'wrong-password');
    expect((await login('10.0.0.4', 'admin', ADMIN_PASSWORD)).statusCode).toBe(200);
  });

  it('counts an IPv6 client per /64, so rotating addresses inside it does not reset the delay', async () => {
    await admin.post('/api/users', { username: 'six', password: 'six-password-12', role: 'viewer' });
    for (let i = 1; i <= 5; i++) expect((await login(`2001:db8:7:7::${i}`, 'six', 'wrong')).statusCode).toBe(401);
    expect((await login('2001:db8:7:7:abcd::99', 'six', 'six-password-12')).statusCode).toBe(429);
    expect((await login('2001:db8:7:8::1', 'six', 'six-password-12')).statusCode).toBe(200);
  });

  it('treats unknown names the same, so a delay does not reveal which accounts exist', async () => {
    for (let i = 0; i < 5; i++) expect((await login('10.0.1.1', 'nobody-here', 'x')).statusCode).toBe(401);
    expect((await login('10.0.1.1', 'nobody-here', 'x')).statusCode).toBe(429);
  });

  it('locks the account briefly after many failures from many addresses, and the admin can unlock it', async () => {
    await admin.post('/api/users', { username: 'spread', password: 'spread-password-1', role: 'viewer' });
    for (let i = 0; i < 50; i++) await login(`10.1.${Math.floor(i / 4)}.${i % 4}`, 'spread', 'wrong');
    const r = await login('10.2.0.1', 'spread', 'spread-password-1');
    expect([r.statusCode, r.json().error]).toEqual([429, 'locked']);
    const users = (await admin.get('/api/users')).json as { id: number; username: string; locked: boolean }[];
    const u = users.find((x) => x.username === 'spread')!;
    expect(u.locked).toBe(true);
    expect((await admin.call('PATCH', `/api/users/${u.id}`, { unlock: true })).status).toBe(200);
    expect((await login('10.2.0.1', 'spread', 'spread-password-1')).statusCode).toBe(200);
  });

  it('limits guesses at a status page password per address', async () => {
    const page = await admin.post('/api/status-pages', { slug: 'guarded', title: 'Guarded', isPublic: true, password: 'abcd', sections: [] });
    expect(page.status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await from('10.3.0.1', 'POST', '/api/public/status/guarded/unlock', { password: 'nope' })).statusCode).toBe(401);
    expect((await from('10.3.0.1', 'POST', '/api/public/status/guarded/unlock', { password: 'abcd' })).statusCode).toBe(429);
    expect((await from('10.3.0.2', 'POST', '/api/public/status/guarded/unlock', { password: 'abcd' })).statusCode).toBe(200);
  });

  it('brakes a status page with short delays when the guesses come from many addresses', async () => {
    expect((await admin.post('/api/status-pages', { slug: 'braked', title: 'Braked', isPublic: true, password: 'wxyz', sections: [] })).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await from(`10.6.0.${i + 1}`, 'POST', '/api/public/status/braked/unlock', { password: 'nope' })).statusCode).toBe(401);
    const r = await from('10.6.1.1', 'POST', '/api/public/status/braked/unlock', { password: 'wxyz' });
    expect([r.statusCode, Number(r.headers['retry-after'])]).toEqual([429, 2]);
    // only a short brake: once it has passed, the right password works again
    await t.ctx.db.updateTable('auth_failures').set({ locked_until: null }).where('scope', '=', 'status').where('client', '=', '').execute();
    expect((await from('10.6.1.1', 'POST', '/api/public/status/braked/unlock', { password: 'wxyz' })).statusCode).toBe(200);
  });
});

describe('lasting access needs the password again', () => {
  it('asks for the password before an API token is created, with a limit per session', async () => {
    const c = await sessionOf('admin', ADMIN_PASSWORD);
    const none = await c.post('/api/tokens', { name: 'x', scopes: ['read'], password: '' });
    expect([none.status, none.json.error]).toEqual([400, 'invalid_credentials']);
    expect((await c.post('/api/tokens', { name: 'x', scopes: ['read'], password: 'wrong-one' })).status).toBe(400);
    expect((await c.post('/api/tokens', { name: 'x', scopes: ['read'], password: ADMIN_PASSWORD })).status).toBe(200);
    for (let i = 0; i < 5; i++) await c.post('/api/tokens', { name: 'x', scopes: ['read'], password: 'wrong-one' });
    const slowed = await c.post('/api/tokens', { name: 'x', scopes: ['read'], password: ADMIN_PASSWORD });
    expect([slowed.status, slowed.json.message]).toEqual([400, expect.stringMatching(/Too many failed attempts/)]);
    // another session of the same user is not affected
    expect((await (await sessionOf('admin', ADMIN_PASSWORD)).post('/api/tokens', { name: 'y', scopes: ['read'], password: ADMIN_PASSWORD })).status).toBe(200);
  });

  it('revokes all API tokens of the user on a password change', async () => {
    await admin.post('/api/users', { username: 'rotator', password: 'rotator-password-1', role: 'editor' });
    const c = await sessionOf('rotator', 'rotator-password-1');
    const tok = (await c.post('/api/tokens', { name: 'a', scopes: ['read'], password: 'rotator-password-1' })).json.token as string;
    await c.post('/api/tokens', { name: 'b', scopes: ['read'], password: 'rotator-password-1' });
    expect((await t.client({ bearer: tok }).get('/api/monitors')).status).toBe(200);
    const r = await c.post('/api/auth/password', { current: 'rotator-password-1', next: 'rotator-password-2' });
    expect(r.json).toEqual({ ok: true, revokedTokens: 2 });
    expect((await t.client({ bearer: tok }).get('/api/monitors')).status).toBe(401);
  });

  it('exports secrets only through POST with the password', async () => {
    await admin.post('/api/monitors', { name: 'with-secret', type: 'http', config: { url: 'http://127.0.0.1:9/x', authType: 'bearer', bearerToken: 'export-me' } });
    expect((await admin.get('/api/config/export?format=json&secrets=true')).json.error).toBe('reauth_required');
    expect((await admin.get('/api/config/export?format=json')).body).not.toContain('export-me');
    expect((await admin.post('/api/config/export', { format: 'json', secrets: true, password: 'wrong-one' })).json.error).toBe('invalid_credentials');
    const ok = await admin.post('/api/config/export', { format: 'json', secrets: true, password: ADMIN_PASSWORD });
    expect([ok.status, ok.body.includes('export-me'), String(ok.headers['content-disposition'])]).toEqual([200, true, expect.stringContaining('attachment')]);
    expect((await admin.post('/api/config/export', { format: 'yaml' })).status).toBe(200); // without secrets no password is needed
  });
});

describe('TOTP codes', () => {
  it('cannot be used twice', async () => {
    const { totpCode } = await import('../../src/server/crypto');
    await admin.post('/api/users', { username: 'otp', password: 'otp-password-12', role: 'viewer' });
    const c = await sessionOf('otp', 'otp-password-12');
    const { secret } = (await c.post('/api/auth/2fa/setup')).json;
    const first = totpCode(secret);
    expect((await c.post('/api/auth/2fa/enable', { code: first })).status).toBe(200);
    expect((await login('10.4.0.1', 'otp', 'otp-password-12', first)).statusCode).toBe(401); // replay of the enrolment code
    const next = totpCode(secret, Date.now() + 30_000);
    expect((await login('10.4.0.1', 'otp', 'otp-password-12', next)).statusCode).toBe(200);
    expect((await login('10.4.0.2', 'otp', 'otp-password-12', next)).statusCode).toBe(401);
  });
});

describe('API description', () => {
  it('is only served to signed-in users', async () => {
    const anon = t.client();
    expect((await anon.get('/api/openapi.json')).status).toBe(401);
    expect((await anon.get('/api/docs')).status).toBe(401);
    expect((await anon.get('/api/docs/json')).status).toBe(401);
    expect((await admin.get('/api/openapi.json')).json.openapi).toMatch(/^3\./);
    expect([200, 302]).toContain((await admin.get('/api/docs')).status);
    const tok = (await admin.post('/api/tokens', { name: 'docs', scopes: ['read'], password: ADMIN_PASSWORD })).json.token;
    expect((await t.client({ bearer: tok }).get('/api/openapi.json')).status).toBe(200);
  });
});

describe('missing assets', () => {
  it('get a real 404 while app routes still get the single page app', async () => {
    const anon = t.client();
    for (const p of ['/assets/index-gone.js', '/assets/whatever', '/old.css', '/favicon-x.ico', '/site.webmanifest']) {
      const r = await anon.get(p);
      expect([p, r.status, String(r.headers['content-type'])]).toEqual([p, 404, expect.stringContaining('text/plain')]);
    }
    const spa = await anon.get('/monitors/12');
    expect([spa.status, spa.body]).toEqual([200, expect.stringContaining('spa')]);
  });
});

describe('secrets and changed targets', () => {
  let target = '', other = '', seenAuth = '';
  beforeAll(async () => {
    const mk = (cb: (req: http.IncomingMessage) => void) => new Promise<string>((resolve) => {
      const s = http.createServer((req, res) => { cb(req); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
      servers.push(s);
      s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    });
    target = await mk((req) => { seenAuth = String(req.headers.authorization ?? ''); });
    other = await mk(() => {});
  });

  it('refuses a masked secret for a new URL, on save and in "fetch result"', async () => {
    const m = (await admin.post('/api/monitors', { name: 'bearer-mon', type: 'http', config: { url: `${target}/health`, authType: 'bearer', bearerToken: 'keep-me' } })).json;
    const masked = { url: `${other}/steal`, authType: 'bearer', bearerToken: SECRET_MASK };
    const put = await admin.put(`/api/monitors/${m.id}`, { config: masked });
    expect([put.status, put.json.error, put.json.message]).toEqual([400, 'validation', expect.stringMatching(/URL changed: enter Token again/)]);
    const fetchOther = await admin.post('/api/monitors/fetch-json', { monitorId: m.id, config: masked });
    expect([fetchOther.status, fetchOther.json.error]).toEqual([400, 'validation']);
    const same = await admin.post('/api/monitors/fetch-json', { monitorId: m.id, config: { ...masked, url: `${target}/other-path` } });
    expect([same.status, seenAuth]).toEqual([200, 'Bearer keep-me']);
    expect((await admin.put(`/api/monitors/${m.id}`, { config: { ...masked, bearerToken: 'new-token' } })).status).toBe(200);
  });

  it('fills in multistep variables, so a variable that moves the URL needs the secrets again', async () => {
    const steps = [{ url: '{{BASE}}/api', headers: { Authorization: 'Bearer {{TOKEN}}' } }];
    const m = (await admin.post('/api/monitors', { name: 'steps-mon', type: 'multistep', config: { steps, variables: { BASE: target, TOKEN: 'real-token' } } })).json;
    expect(m.id).toBeGreaterThan(0);
    const moved = await admin.put(`/api/monitors/${m.id}`, { config: { steps, variables: { BASE: 'https://evil.example', TOKEN: SECRET_MASK } } });
    expect([moved.status, moved.json.error]).toEqual([400, 'validation']);
    expect((await admin.put(`/api/monitors/${m.id}`, { config: { steps, variables: { BASE: SECRET_MASK, TOKEN: SECRET_MASK } } })).status).toBe(200);
    const stored = await t.ctx.db.selectFrom('monitors').select('id').where('id', '=', m.id).executeTakeFirst();
    expect(stored).toBeTruthy();
    const { loadMonitor } = await import('../../src/server/monitors/service');
    expect((await loadMonitor(t.ctx, m.id))!.config.variables).toEqual({ BASE: target, TOKEN: 'real-token' });
  });

  it('applies to notification channels as well', async () => {
    const ch = (await admin.post('/api/notification-channels', { name: 'n1', type: 'ntfy', config: { server: 'https://ntfy.example.com', topic: 'x', token: 'chan-secret' } })).json;
    expect(ch.id).toBeGreaterThan(0);
    const r = await admin.put(`/api/notification-channels/${ch.id}`, { name: 'n1', type: 'ntfy', config: { server: 'https://evil.example.com', topic: 'x', token: SECRET_MASK } });
    expect([r.status, r.json.error]).toEqual([400, 'validation']);
  });
});

describe('viewers', () => {
  it('see neither query values in URLs nor Redis commands', async () => {
    const q = (await admin.post('/api/monitors', { name: 'q-mon', type: 'http', config: { url: 'https://api.example.com/health?apikey=topsecret&x=1' } })).json.id;
    const r = (await admin.post('/api/monitors', { name: 'r-mon', type: 'redis', config: { host: '127.0.0.1', port: 6379, command: 'AUTH hunter2' } })).json.id;
    await admin.post('/api/users', { username: 'viewer1', password: 'viewer-password-1', role: 'viewer' });
    const v = await sessionOf('viewer1', 'viewer-password-1');
    expect((await v.get(`/api/monitors/${q}`)).json.config.url).toBe('https://api.example.com/health?apikey=***&x=***');
    expect((await v.get(`/api/monitors/${r}`)).json.config.command).toBe(SECRET_MASK);
    expect((await admin.get(`/api/monitors/${r}`)).json.config.command).toBe('AUTH hunter2'); // editors still see it
  });
});

describe('incidents and partial scope', () => {
  it('lets a scope-restricted editor add own internal notes but not change an incident with foreign monitors', async () => {
    const mine = (await admin.post('/api/groups', { name: 'inc-mine' })).json.id;
    const theirs = (await admin.post('/api/groups', { name: 'inc-theirs' })).json.id;
    const m1 = (await admin.post('/api/monitors', { name: 'inc-m1', type: 'push', config: {}, groupId: mine })).json.id;
    const m2 = (await admin.post('/api/monitors', { name: 'inc-m2', type: 'push', config: {}, groupId: theirs })).json.id;
    const u = (await admin.post('/api/users', { username: 'partial', password: 'partial-password-1', role: 'editor', scopeRestricted: true })).json;
    await admin.put(`/api/users/${u.id}/grants`, { grants: [{ type: 'monitor_group', id: mine, level: 'manage' }] });
    const ed = await sessionOf('partial', 'partial-password-1');
    const mixed = (await admin.post('/api/incidents', { title: 'mixed', monitorIds: [m1, m2] })).json.id;
    const own = (await admin.post('/api/incidents', { title: 'own', monitorIds: [m1] })).json.id;

    expect((await ed.call('PATCH', `/api/incidents/${mixed}`, { title: 'renamed' })).status).toBe(403);
    expect((await ed.call('PATCH', `/api/incidents/${mixed}`, { public: true })).status).toBe(403);
    expect((await ed.post(`/api/incidents/${mixed}/resolve`)).status).toBe(403);
    expect((await ed.post(`/api/incidents/${mixed}/status`, { status: 'monitoring' })).status).toBe(403);
    expect((await ed.post(`/api/incidents/${mixed}/notes`, { body: 'public', public: true })).status).toBe(403);
    expect((await ed.post(`/api/incidents/${mixed}/notes`, { body: 'checking my part' })).status).toBe(200);
    const detail = (await admin.get(`/api/incidents/${mixed}`)).json;
    const mineNote = detail.updates.find((x: any) => x.body === 'checking my part');
    const adminNote = detail.updates.find((x: any) => x.kind === 'status');
    expect((await ed.call('PATCH', `/api/incidents/${mixed}/updates/${mineNote.id}`, { body: 'checked my part' })).status).toBe(200);
    expect((await ed.call('PATCH', `/api/incidents/${mixed}/updates/${mineNote.id}`, { public: true })).status).toBe(403);
    expect((await ed.call('PATCH', `/api/incidents/${mixed}/updates/${adminNote.id}`, { body: 'rewritten' })).status).toBe(403);

    expect((await ed.call('PATCH', `/api/incidents/${own}`, { title: 'mine only' })).status).toBe(200);
    expect((await ed.post(`/api/incidents/${own}/resolve`)).status).toBe(200);
  });
});

/* ---------------------------- LDAP (fake directory) ---------------------------- */
// Minimal LDAP server: binds succeed for the service account and for cn=bob,dc=x with "bob-secret"; every search finds cn=bob,dc=x.
const ber = (tag: number, ...parts: Buffer[]) => { const b = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag, ...(b.length < 128 ? [b.length] : [0x81, b.length])]), b]); };
const ldapMsg = (id: number, op: Buffer) => ber(0x30, ber(0x02, Buffer.from([id])), op);
const ldapResult = (tag: number, code: number) => ber(tag, ber(0x0a, Buffer.from([code])), ber(0x04), ber(0x04));
/** Reads one BER element at p: [tag, content start, end]. */
const el = (b: Buffer, p: number): [number, number, number] => { const l = b[p + 1]!; if (l < 128) return [b[p]!, p + 2, p + 2 + l]; const n = l & 127; let len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[p + 2 + i]!; return [b[p]!, p + 2 + n, p + 2 + n + len]; };
function fakeLdap(): Promise<number> {
  const s = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const [, start, end] = el(buf, 0);
        if (buf.length < end) break;
        const msg = buf.subarray(0, end); buf = buf.subarray(end);
        const [, idStart, idEnd] = el(msg, start);
        const id = msg[idStart]!;
        const [op, opStart] = el(msg, idEnd);
        if (op === 0x60) {
          const [, , vEnd] = el(msg, opStart);
          const [, dnS, dnE] = el(msg, vEnd);
          const [, pwS, pwE] = el(msg, dnE);
          const dn = msg.toString('utf8', dnS, dnE), pw = msg.toString('utf8', pwS, pwE);
          sock.write(ldapMsg(id, ldapResult(0x61, (dn === 'cn=svc,dc=x' && pw === 'svc') || (dn === 'cn=bob,dc=x' && pw === 'bob-secret') ? 0 : 49)));
        } else if (op === 0x63) {
          sock.write(ldapMsg(id, ber(0x64, ber(0x04, Buffer.from('cn=bob,dc=x')), ber(0x30))));
          sock.write(ldapMsg(id, ldapResult(0x65, 0)));
        } else if (op === 0x42) sock.end();
      }
    });
  });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
}

describe('LDAP sign-in', () => {
  let a = 0, b = 0;
  const provider = (name: string, port: number, enabled = true) => ({ kind: 'ldap', name, enabled, config: { url: `ldap://127.0.0.1:${port}`, bindDn: 'cn=svc,dc=x', bindPassword: 'svc', baseDn: 'dc=x', userFilter: '(uid={{username}})' } });
  beforeAll(async () => {
    const [pa, pb] = await Promise.all([fakeLdap(), fakeLdap()]);
    a = (await admin.post('/api/auth/providers', provider('dir-a', pa))).json.id;
    b = (await admin.post('/api/auth/providers', provider('dir-b', pb, false))).json.id;
    // an account from before the provider prefix: the bare DN
    await t.ctx.db.insertInto('users').values({ username: 'bob', display_name: 'Bob', role: 'viewer', auth_source: 'ldap', external_id: 'cn=bob,dc=x', password_hash: null }).execute();
    (globalThis as any).__ports = { pa, pb };
  });

  it('keeps the account of an existing directory user and moves it to the provider-prefixed id', async () => {
    expect((await login('10.5.0.1', 'bob', 'bob-secret')).statusCode).toBe(200);
    const rows = await t.ctx.db.selectFrom('users').select(['username', 'external_id']).where('auth_source', '=', 'ldap').execute();
    expect(rows).toEqual([{ username: 'bob', external_id: `${a}:cn=bob,dc=x` }]);
  });

  it('does not let a second directory with the same DN take over that account', async () => {
    const { pa, pb } = (globalThis as any).__ports;
    await admin.put(`/api/auth/providers/${a}`, { ...provider('dir-a', pa, false), config: { ...provider('dir-a', pa).config, bindPassword: SECRET_MASK } });
    await admin.put(`/api/auth/providers/${b}`, { ...provider('dir-b', pb, true), config: { ...provider('dir-b', pb).config, bindPassword: SECRET_MASK } });
    expect((await login('10.5.0.1', 'bob', 'bob-secret')).statusCode).toBe(200);
    const rows = await t.ctx.db.selectFrom('users').select(['username', 'external_id']).where('auth_source', '=', 'ldap').orderBy('id').execute();
    expect(rows).toEqual([{ username: 'bob', external_id: `${a}:cn=bob,dc=x` }, { username: 'bob-2', external_id: `${b}:cn=bob,dc=x` }]);
  });

  it('counts wrong directory passwords like local ones', async () => {
    for (let i = 0; i < 5; i++) expect((await login('10.5.0.9', 'bob', 'wrong')).statusCode).toBe(401);
    expect((await login('10.5.0.9', 'bob', 'bob-secret')).statusCode).toBe(429);
    expect((await login('10.5.0.10', 'bob', 'bob-secret')).statusCode).toBe(200);
  });
});

describe('passkey challenges', () => {
  it('are accepted only once, even within the cookie lifetime', async () => {
    const opts = await t.app.inject({ method: 'POST', url: '/api/auth/passkeys/login/options' });
    const cookie = opts.cookies.find((c) => c.name === 'pw_wa_auth')!;
    const send = () => t.app.inject({ method: 'POST', url: '/api/auth/passkeys/login/verify', payload: { credential: { id: 'not-registered', response: {} } }, headers: { cookie: `pw_wa_auth=${cookie.value}` } });
    expect((await send()).statusCode).toBe(401);
    expect((await send()).statusCode).toBe(401);
    const why = (await t.ctx.db.selectFrom('audit_log').select('details').where('action', '=', 'login.failed').where('entity_type', '=', 'passkey').orderBy('id').execute()).map((r) => JSON.parse(r.details!).why);
    expect(why.slice(-2)).toEqual(['unknown credential', 'challenge already used']);
  });
});
