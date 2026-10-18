import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRunner, NetGuard, type CheckResult } from '../../src/core';
import { jsonCompare, jsonGet } from '../../src/core/jsonpath';

const guard = new NetGuard({ mode: 'allow-private', allow: [], deny: [] });
const run = (type: string, config: Record<string, any>, timeoutMs = 3000, g = guard): Promise<CheckResult> =>
  getRunner(type)!.run({ config, timeoutMs, signal: AbortSignal.timeout(timeoutMs), guard: g, monitor: { id: 1, name: 't' } });

let web: http.Server, secure: https.Server, tcp: net.Server;
let webPort = 0, tlsPort = 0, tcpPort = 0;
const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

beforeAll(async () => {
  const handler: http.RequestListener = (req, res) => {
    if (req.url === '/ok') return void res.end('hello world');
    if (req.url === '/json') return void res.setHeader('content-type', 'application/json').end('{"status":"ok","n":{"items":[1,2,3]}}');
    if (req.url === '/redir') return void res.writeHead(302, { location: '/ok' }).end();
    if (req.url === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/slow') return void setTimeout(() => res.end('late'), 2000);
    if (req.url === '/login') return void res.writeHead(200, { 'set-cookie': 'sid=abc; Path=/', 'content-type': 'application/json' }).end('{"token":"t0k"}');
    if (req.url === '/me') return void res.end(req.headers.authorization === 'Bearer t0k' && req.headers.cookie === 'sid=abc' ? '{"user":"x"}' : '{}');
    res.statusCode = 500; res.end('boom');
  };
  web = http.createServer(handler);
  secure = https.createServer({ key: fs.readFileSync(path.join(__dirname, '../fixtures/localhost.key')), cert: fs.readFileSync(path.join(__dirname, '../fixtures/localhost.crt')) }, handler);
  tcp = net.createServer((s) => { s.write('SSH-2.0-TestServer\r\n'); s.on('error', () => {}); });
  [webPort, tlsPort, tcpPort] = await Promise.all([listen(web), listen(secure), listen(tcp)]);
});
afterAll(() => { web.close(); secure.close(); tcp.close(); });

describe('http runner', () => {
  const base = () => `http://127.0.0.1:${webPort}`;
  it('passes on 2xx', async () => expect(await run('http', { url: `${base()}/ok` })).toMatchObject({ ok: true }));
  it('reports wrong status distinctly', async () => expect(await run('http', { url: `${base()}/err` })).toMatchObject({ ok: false, errorKind: 'http_status' }));
  it('follows redirects and caps loops', async () => {
    expect(await run('http', { url: `${base()}/redir` })).toMatchObject({ ok: true });
    expect(await run('http', { url: `${base()}/loop`, maxRedirects: 3 })).toMatchObject({ ok: false, errorKind: 'redirect' });
  });
  it('keyword check', async () => {
    expect(await run('keyword', { url: `${base()}/ok`, keyword: 'WORLD' })).toMatchObject({ ok: true });
    expect(await run('keyword', { url: `${base()}/ok`, keyword: 'nope' })).toMatchObject({ ok: false, errorKind: 'content' });
    expect(await run('keyword', { url: `${base()}/ok`, keyword: 'hello', invert: true })).toMatchObject({ ok: false, errorKind: 'content' });
  });
  it('json check', async () => {
    expect(await run('json', { url: `${base()}/json`, jsonPath: '$.status', jsonOp: 'eq', jsonExpected: 'ok' })).toMatchObject({ ok: true });
    expect(await run('json', { url: `${base()}/json`, jsonPath: '$.n.items[2]', jsonOp: 'gte', jsonExpected: '3' })).toMatchObject({ ok: true });
    expect(await run('json', { url: `${base()}/json`, jsonPath: '$.status', jsonOp: 'eq', jsonExpected: 'down' })).toMatchObject({ ok: false, errorKind: 'content' });
  });
  it('distinguishes timeout, refused and DNS failure', async () => {
    expect(await run('http', { url: `${base()}/slow` }, 500)).toMatchObject({ ok: false, errorKind: 'timeout' });
    expect(await run('http', { url: 'http://127.0.0.1:9/' })).toMatchObject({ ok: false, errorKind: 'refused' });
    expect(await run('http', { url: 'http://does-not-exist.invalid/' })).toMatchObject({ ok: false, errorKind: 'dns' });
  });
  it('blocks private targets in public-only mode', async () => {
    const g = new NetGuard({ mode: 'public-only', allow: [], deny: [] });
    expect(await run('http', { url: `${base()}/ok` }, 3000, g)).toMatchObject({ ok: false, errorKind: 'blocked' });
    const allowed = new NetGuard({ mode: 'public-only', allow: ['127.0.0.0/8'], deny: [] });
    expect(await run('http', { url: `${base()}/ok` }, 3000, allowed)).toMatchObject({ ok: true });
    const denied = new NetGuard({ mode: 'allow-private', allow: [], deny: ['127.0.0.1'] });
    expect(await run('http', { url: `${base()}/ok` }, 3000, denied)).toMatchObject({ ok: false, errorKind: 'blocked' });
  });
  it('reports TLS failures and certificate details', async () => {
    const url = `https://localhost:${tlsPort}/ok`;
    expect(await run('http', { url })).toMatchObject({ ok: false, errorKind: 'tls' });
    const r = await run('http', { url, verifyTls: false });
    expect(r.ok).toBe(true);
    expect(r.cert?.subject).toBe('localhost');
    expect(r.cert!.daysLeft).toBeGreaterThan(1000);
    expect(await run('http', { url, verifyTls: false, tlsExpiryDays: 99999 })).toMatchObject({ ok: false, errorKind: 'tls_expiry' });
  });
  it('runs multi-step flows with extraction and cookies', async () => {
    const steps = [
      { name: 'login', url: `${base()}/login`, extract: { token: 'json:$.token' } },
      { name: 'me', url: `${base()}/me`, headers: { Authorization: 'Bearer {{token}}' }, jsonPath: '$.user', jsonOp: 'exists' },
    ];
    expect(await run('multistep', { steps })).toMatchObject({ ok: true });
    steps[1].jsonPath = '$.nothing';
    expect(await run('multistep', { steps })).toMatchObject({ ok: false, errorKind: 'content' });
  });
});

describe('network runners', () => {
  it('tcp open / closed', async () => {
    expect(await run('tcp', { host: '127.0.0.1', port: tcpPort })).toMatchObject({ ok: true });
    expect(await run('tcp', { host: '127.0.0.1', port: 9 })).toMatchObject({ ok: false, errorKind: 'refused' });
    expect(await run('tcp', { host: '127.0.0.1', port: tcpPort, expect: 'SSH-2.0' })).toMatchObject({ ok: true });
  });
  it('ssh banner', async () => {
    expect(await run('ssh', { host: '127.0.0.1', port: tcpPort, expect: 'TestServer' })).toMatchObject({ ok: true });
    expect(await run('ssh', { host: '127.0.0.1', port: tcpPort, expect: 'Other' })).toMatchObject({ ok: false, errorKind: 'content' });
    expect(await run('ssh', { host: '127.0.0.1', port: webPort })).toMatchObject({ ok: false });
  });
  it('tls certificate runner', async () => {
    expect(await run('tls', { host: '127.0.0.1', port: tlsPort, servername: 'localhost', verify: false, warnDays: 30 })).toMatchObject({ ok: true });
    expect(await run('tls', { host: '127.0.0.1', port: tlsPort, servername: 'localhost', verify: true })).toMatchObject({ ok: false, errorKind: 'tls' });
  });
  it('dns failure', async () => {
    expect(await run('dns', { host: 'does-not-exist.invalid', recordType: 'A', resolver: '127.0.0.1' }, 1500)).toMatchObject({ ok: false });
  });
});

describe('helpers', () => {
  it('json path and compare', () => {
    const doc = { a: { 'b c': [{ d: 5 }] } };
    expect(jsonGet(doc, '$.a["b c"][0].d')).toBe(5);
    expect(jsonGet(doc, '$.a.missing.x')).toBeUndefined();
    expect(jsonCompare(5, 'gt', '3')).toBe(true);
    expect(jsonCompare('abc', 'regex', '^a.c$')).toBe(true);
    expect(() => jsonGet(doc, '$.a[')).toThrow();
  });
  it('guard classifies private ranges', () => {
    const g = new NetGuard({ mode: 'public-only', allow: ['10.1.0.0/16'], deny: ['8.8.4.4'] });
    expect(g.check('10.0.0.5')).toBeTruthy();
    expect(g.check('10.1.2.3')).toBeNull();
    expect(g.check('::ffff:192.168.1.1')).toBeTruthy();
    expect(g.check('8.8.8.8')).toBeNull();
    expect(g.check('8.8.4.4')).toBeTruthy();
  });
});
