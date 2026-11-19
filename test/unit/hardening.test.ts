import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_DENY, getRunner, NetGuard, restoreSecrets, SECRET_MASK, SecretTargetError, type Runner } from '../../src/core';
import { httpRequest } from '../../src/core/http';
import { compileRegex } from '../../src/core/regex';
import { isAssetPath, redactUrl, requestLogOptions } from '../../src/server/app';
import { ldapExternalId } from '../../src/server/auth/external';
import { brakeAfter, clientKey, delayAfter } from '../../src/server/auth/reauth';
import { parseSsrfMode, parseTrustProxy } from '../../src/server/config';
import { totpCode, totpStep } from '../../src/server/crypto';
import { channelTypes } from '../../src/server/notify/channels';
import { viewerConfig } from '../../src/server/routes/monitors';

const open = new NetGuard({ mode: 'allow-private', allow: [], deny: [] });
const servers: { close(): void }[] = [];
afterAll(() => { for (const s of servers) s.close(); });
const listen = (handler: http.RequestListener) => new Promise<string>((resolve) => {
  const s = http.createServer(handler);
  servers.push(s);
  s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
});

describe('regex safety', () => {
  it('refuses nested quantifiers at any depth and overlapping alternatives', () => {
    for (const p of ['(a+)+', '^((a+))+$', '(?:(a+))+', '(?<n>a+)+', '((ab)*c)+', '(a*)*', '(x+x+)+y', '(.*a){10}', '(a?a)+$', '(a|a)+', '(\\w|\\d)+', '((a|a))+', '(a|ab)*c', '(a|)+']) {
      expect(() => compileRegex(p), p).toThrow(/hang the check/);
    }
  });
  it('refuses backreferences, which the linear fallback engine cannot run', () => {
    for (const p of ['(?<x>a+)\\k<x>*z', '^(a*)\\1*\\1*c', '(a)\\1', '(a)(b)(c)(d)(e)(f)(g)(h)(i)\\9']) expect(() => compileRegex(p), p).toThrow(/backreferences/);
    expect(() => compileRegex('[\\1]x')).not.toThrow(); // inside a class it is an octal escape, not a backreference
  });
  it('still allows ordinary patterns', () => {
    for (const p of ['^\\d+ ms$', '(foo|bar)', '[a-z]+@[a-z]+\\.de', 'status: (up|ok)', '(up|ok)+', '(\\d{1,3}\\.){3}\\d{1,3}', '"status":\\s*"ok"', '^HTTP/1\\.[01] 200', '(.|\\n)*', '[(]+', '\\((a+)\\)', '(?:https?|ftp)://', '(abc)?(def)+']) {
      expect(() => compileRegex(p), p).not.toThrow();
    }
  });
  it('refused patterns really were slow, allowed ones stay fast', () => {
    const t0 = performance.now();
    expect(compileRegex('^\\d+ ms$').test(`${'1'.repeat(10000)}!`)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('restoreSecrets only for the same target', () => {
  const http_ = getRunner('http')!;
  const stored = { url: 'https://api.example.com/v1/health', authType: 'bearer', bearerToken: 'tok', headers: { 'X-Key': 'k1' } };
  it('reuses the stored secret while the target stays the same (a new path on the same origin is fine)', () => {
    const out = restoreSecrets(http_, { ...stored, url: 'https://API.example.com/v2/other', bearerToken: SECRET_MASK, headers: { 'X-Key': SECRET_MASK } }, stored);
    expect([out.bearerToken, out.headers['X-Key']]).toEqual(['tok', 'k1']);
  });
  it('refuses the mask when the URL points elsewhere', () => {
    expect(() => restoreSecrets(http_, { ...stored, url: 'https://evil.example.net/', bearerToken: SECRET_MASK }, stored)).toThrow(SecretTargetError);
    expect(() => restoreSecrets(http_, { ...stored, url: 'https://evil.example.net/', headers: { 'X-Key': SECRET_MASK } }, stored)).toThrow(/URL changed: enter Headers again/);
    // a newly typed secret for the new target is fine
    expect(restoreSecrets(http_, { ...stored, url: 'https://new.example.net/', bearerToken: 'fresh', headers: {} }, stored).bearerToken).toBe('fresh');
  });
  it('watches host and port of database monitors, and only when there is a stored secret', () => {
    const mysql = getRunner('mysql')!;
    const db = { host: 'db.local', port: 3306, username: 'mon', password: 'pw' };
    expect(restoreSecrets(mysql, { ...db, port: '3306', password: SECRET_MASK }, db).password).toBe('pw');
    expect(() => restoreSecrets(mysql, { ...db, host: 'attacker.example', password: SECRET_MASK }, db)).toThrow(/Host changed/);
    expect(() => restoreSecrets(mysql, { ...db, port: 3307, password: SECRET_MASK }, db)).toThrow(/Port changed/);
    expect(restoreSecrets(mysql, { ...db, host: 'other', password: SECRET_MASK }, { ...db, password: '' }).password).toBe('');
  });
  it('compares the origins inside multistep steps', () => {
    const ms = getRunner('multistep')!;
    const st = { steps: [{ url: 'https://a.example/login' }], variables: { token: 't' } };
    expect(restoreSecrets(ms, { steps: [{ url: 'https://a.example/other' }], variables: { token: SECRET_MASK } }, st).variables.token).toBe('t');
    expect(() => restoreSecrets(ms, { steps: [{ url: 'https://b.example/' }], variables: { token: SECRET_MASK } }, st)).toThrow(SecretTargetError);
  });
  it('fills in multistep variables before comparing, so moving a URL through a variable counts as a new target', () => {
    const ms = getRunner('multistep')!;
    const steps = [{ url: '{{BASE}}/api', headers: { Authorization: 'Bearer {{TOKEN}}' } }];
    const st = { steps, variables: { BASE: 'https://good.example', TOKEN: 'real-token' } };
    expect(() => restoreSecrets(ms, { steps, variables: { BASE: 'https://evil.example', TOKEN: SECRET_MASK } }, st)).toThrow(SecretTargetError);
    expect(() => restoreSecrets(ms, { steps, variables: { BASE: 'https://good.example.evil.example', TOKEN: SECRET_MASK } }, st)).toThrow(SecretTargetError);
    expect(restoreSecrets(ms, { steps, variables: { BASE: SECRET_MASK, TOKEN: SECRET_MASK } }, st).variables).toEqual(st.variables);
    expect(restoreSecrets(ms, { steps, variables: { BASE: 'https://good.example', TOKEN: SECRET_MASK } }, st).variables.TOKEN).toBe('real-token');
    // a variable that only goes into a header does not move the request
    expect(restoreSecrets(ms, { steps, variables: { BASE: SECRET_MASK, TOKEN: SECRET_MASK, OTHER: 'x' } }, st).variables.TOKEN).toBe('real-token');
  });
  it('covers notification channels and provider configs too', () => {
    const ntfy: Runner = { type: 'ntfy', label: 'ntfy', category: 'channel', fields: channelTypes.get('ntfy')!.fields, run: async () => ({ ok: true }) };
    expect(() => restoreSecrets(ntfy, { server: 'https://evil.example', topic: 't', token: SECRET_MASK }, { server: 'https://ntfy.sh', topic: 't', token: 'x' })).toThrow(/Server/);
  });
});

describe('cross-origin redirects', () => {
  it('drops every header but a short safe list when the redirect leaves the origin', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const other = await listen((req, res) => { seen = req.headers; res.end('ok'); });
    const first = await listen((_req, res) => { res.writeHead(302, { location: `${other}/landed` }); res.end(); });
    const r = await httpRequest({ url: first, headers: { 'X-Api-Key': 'secret', Authorization: 'Bearer t', Cookie: 'a=b', 'Accept-Language': 'de', 'User-Agent': 'probe/1' }, signal: AbortSignal.timeout(5000), guard: open });
    expect(r.body).toBe('ok');
    expect(seen['x-api-key']).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    expect([seen['accept-language'], seen['user-agent']]).toEqual(['de', 'probe/1']);
  });
  it('keeps custom headers on a same-origin redirect', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const base = await listen((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/next' }); res.end(); return; }
      seen = req.headers; res.end('ok');
    });
    await httpRequest({ url: `${base}/start`, headers: { 'X-Api-Key': 'secret' }, signal: AbortSignal.timeout(5000), guard: open });
    expect(seen['x-api-key']).toBe('secret');
  });
});

describe('environment parsing', () => {
  it('PW_TRUST_PROXY takes false, true, a hop count or proxy addresses', () => {
    expect([parseTrustProxy(undefined), parseTrustProxy(''), parseTrustProxy('false'), parseTrustProxy('0'), parseTrustProxy('off')]).toEqual([false, false, false, false, false]);
    expect([parseTrustProxy('true'), parseTrustProxy('yes')]).toEqual([true, true]);
    expect([parseTrustProxy('1'), parseTrustProxy('2')]).toEqual([1, 2]);
    expect(parseTrustProxy('10.0.0.0/8, 192.168.1.5,::1, fd00::/8')).toEqual(['10.0.0.0/8', '192.168.1.5', '::1', 'fd00::/8']);
    for (const bad of ['maybe', '10.0.0.0/33', '10.0.0.1/8/1', 'proxy.local', '-1', '99']) expect(() => parseTrustProxy(bad), bad).toThrow(/PW_TRUST_PROXY/);
  });
  it('PW_SSRF_MODE only knows its two modes', () => {
    expect([parseSsrfMode(undefined), parseSsrfMode('public-only')]).toEqual(['allow-private', 'public-only']);
    expect(() => parseSsrfMode('public_only')).toThrow(/PW_SSRF_MODE/);
  });
});

describe('SSRF defaults', () => {
  it('blocks the metadata endpoints of Alibaba, AWS ECS and the Azure WireServer by default', () => {
    const g = new NetGuard({ mode: 'allow-private', allow: [], deny: DEFAULT_DENY });
    for (const ip of ['100.100.100.200', '169.254.170.2', '168.63.129.16', '169.254.169.254']) expect(g.check(ip), ip).toMatch(/deny list/);
    expect(g.check('100.100.100.201')).toBeNull();
  });
});

describe('request log', () => {
  it('masks push tokens and credential query values', () => {
    expect(redactUrl('/api/push/abcDEF123?status=up&msg=ok')).toBe('/api/push/***?status=up&msg=ok');
    expect(redactUrl('/api/public/subscriptions/confirm?token=xyz')).toBe('/api/public/subscriptions/confirm?token=***');
    expect(redactUrl('/api/auth/oidc/callback?code=c1&state=s1&iss=x')).toBe('/api/auth/oidc/callback?code=***&state=***&iss=x');
    expect(redactUrl('/api/monitors?api_key=1&page=2')).toBe('/api/monitors?api_key=***&page=2');
    expect(redactUrl('/dashboard')).toBe('/dashboard');
  });
  it('writes the masked URL into the request log', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'info' }, { write: (l: string) => void lines.push(l) });
    const app = Fastify({ loggerInstance: log, ...requestLogOptions });
    app.get('/api/push/:token', async () => 'ok');
    await app.inject({ url: '/api/push/very-secret-token?token=abc' });
    await app.close();
    const all = lines.join('\n');
    expect(all).toContain('/api/push/***?token=***');
    expect(all).not.toContain('very-secret-token');
  });
});

describe('asset paths', () => {
  it('tells file requests from app routes', () => {
    for (const p of ['/assets/index-abc.js', '/assets/x', '/favicon.ico', '/manifest.webmanifest', '/robots.txt', '/app.js.map', '/x.woff2?v=1']) expect(isAssetPath(p), p).toBe(true);
    for (const p of ['/', '/dashboard', '/status/main', '/monitors/12', '/status/v1.2']) expect(isAssetPath(p), p).toBe(false);
  });
});

describe('viewer config', () => {
  it('masks query values in URLs and the Redis command', () => {
    const c = viewerConfig('http', { url: 'https://user:pw@api.example.com/health?apikey=abc&mode=full#token=1' });
    expect(c.url).toBe('https://api.example.com/health?apikey=***&mode=***#***');
    expect(viewerConfig('redis', { host: 'r', command: 'AUTH secret' }).command).toBe(SECRET_MASK);
    expect(viewerConfig('http', { url: 'https://api.example.com/health' }).url).toBe('https://api.example.com/health');
  });
});

describe('TOTP steps', () => {
  it('returns the step of the code within one step of drift', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const now = 1_700_000_000_000;
    expect(totpStep(secret, totpCode(secret, now), now)).toBe(Math.floor(now / 30_000));
    expect(totpStep(secret, totpCode(secret, now - 30_000), now)).toBe(Math.floor(now / 30_000) - 1);
    expect(totpStep(secret, totpCode(secret, now - 90_000), now)).toBeNull();
  });
});

describe('failure delays', () => {
  it('starts after five failures and doubles up to 15 minutes', () => {
    expect([1, 4, 5, 6, 7, 20].map(delayAfter)).toEqual([0, 0, 30_000, 60_000, 120_000, 900_000]);
  });
  it('brakes a status page with short delays only', () => {
    expect([19, 20, 21, 30].map(brakeAfter)).toEqual([0, 2_000, 4_000, 60_000]);
  });
  it('counts an IPv6 client per /64, everything else as is', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(clientKey('10.1.2.3')).toBe('10.1.2.3');
    expect(clientKey('s:42')).toBe('s:42');
  });
});

describe('LDAP external ids', () => {
  it('carry the provider and fall back to a hash for DNs too long for the column', () => {
    expect(ldapExternalId(3, 'cn=bob,dc=x')).toBe('3:cn=bob,dc=x');
    const long = `cn=${'x'.repeat(250)},dc=x`;
    expect(ldapExternalId(3, long)).toMatch(/^3:sha256:[0-9a-f]{64}$/);
    expect(ldapExternalId(3, long).length).toBeLessThanOrEqual(255);
  });
});

describe('email channel', () => {
  it('connects to the address the guard checked and keeps the host name for TLS', async () => {
    let got = '';
    const smtp = net.createServer((s) => {
      s.write('220 fake ESMTP\r\n');
      let data = false;
      s.on('data', (d) => {
        for (const line of d.toString().split('\r\n').filter(Boolean)) {
          if (data) { got += `${line}\n`; if (line === '.') { data = false; s.write('250 queued\r\n'); } continue; }
          if (/^(EHLO|HELO)/i.test(line)) s.write('250 fake\r\n');
          else if (/^DATA/i.test(line)) { data = true; s.write('354 go\r\n'); }
          else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
          else s.write('250 ok\r\n');
        }
      });
    });
    servers.push(smtp);
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    const port = (smtp.address() as AddressInfo).port;
    // the name does not resolve: the mail only arrives when the channel uses the address from the guard instead of resolving again
    const guard = { resolve: async () => [{ address: '127.0.0.1', family: 4 as const }] } as unknown as NetGuard;
    await channelTypes.get('email')!.send({ host: 'smtp.does-not-exist.invalid', port, security: 'none', from: 'a@example.com', to: 'b@example.com' }, { event: 'test', subject: 'hi', text: 'body', vars: {} }, { guard, signal: AbortSignal.timeout(5000) });
    expect(got).toContain('body');
  });
});
