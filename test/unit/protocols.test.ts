import { createHash, createHmac } from 'node:crypto';
import dgram from 'node:dgram';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getRunner, NetGuard, validateConfig, type CheckResult } from '../../src/core';

const guard = new NetGuard({ mode: 'allow-private', allow: [], deny: [] });
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

/** Runs a monitor type the way the engine does: the config goes through the field definitions first. */
async function run(type: string, input: Record<string, any>, timeoutMs = 3000): Promise<CheckResult> {
  const runner = getRunner(type);
  if (!runner) throw new Error(`runner ${type} is not registered`);
  const v = validateConfig(runner, { host: '127.0.0.1', ...input });
  expect(v.errors).toEqual([]);
  return runner.run({ config: v.config, timeoutMs, signal: AbortSignal.timeout(timeoutMs), guard, monitor: { id: 1, name: 't' } });
}

function udpServer(handler: (msg: Buffer, reply: (b: Buffer) => void) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (m, r) => handler(m, (b) => s.send(b, r.port, r.address)));
    s.bind(0, '127.0.0.1', () => { closers.push(() => s.close()); resolve(s.address().port); });
  });
}
function tcpServer(onConn: (sock: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => { sock.on('error', () => {}); onConn(sock); });
    s.listen(0, '127.0.0.1', () => { closers.push(() => s.close()); resolve((s.address() as net.AddressInfo).port); });
  });
}
function httpServer(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => { closers.push(() => { s.closeAllConnections(); s.close(); }); resolve((s.address() as net.AddressInfo).port); });
  });
}
async function deadPort(): Promise<number> {
  const p = await tcpServer(() => {});
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); void p; });
}
const body = (req: http.IncomingMessage) => new Promise<string>((resolve) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => resolve(b)); });

describe('registry', () => {
  it('knows every new monitor type under a category the form can group', () => {
    const want = { ntp: 'Network', radius: 'Identity', rabbitmq: 'Application', kafka: 'Application', steam: 'Games', gamedig: 'Games', pelican: 'Games', amp: 'Games', manual: 'Passive', pm2: 'Infrastructure', oracle: 'Database', globalping: 'Application', ldap: 'Identity', ftp: 'Network', rdp: 'Network', sip: 'Application' };
    for (const [type, category] of Object.entries(want)) expect(getRunner(type)?.category, type).toBe(category);
  });
});

/* ------------------------------------- NTP ------------------------------------- */
const NTP_EPOCH = 2_208_988_800;
const stamp = (ms: number) => { const b = Buffer.alloc(8); b.writeUInt32BE(Math.floor(ms / 1000) + NTP_EPOCH, 0); b.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32), 4); return b; };

describe('ntp', () => {
  let skewMs = 0, stratum = 2;
  const port = udpServer((msg, reply) => {
    const r = Buffer.alloc(48);
    r[0] = 0x24; r[1] = stratum;
    if (stratum === 0) r.write('RATE', 12);
    msg.copy(r, 24, 40, 48);
    stamp(Date.now() + skewMs).copy(r, 32);
    stamp(Date.now() + skewMs).copy(r, 40);
    reply(r);
  });
  it('measures the clock offset and enforces the limit', async () => {
    const p = await port;
    skewMs = 0; stratum = 2;
    const good = await run('ntp', { port: p });
    expect(good.ok).toBe(true);
    expect(Math.abs(good.details!.offsetMs as number)).toBeLessThan(100);
    skewMs = 2000;
    const off = await run('ntp', { port: p, maxOffsetMs: 500 });
    expect(off.ok).toBe(false);
    expect(off.errorKind).toBe('content');
    expect(off.message).toMatch(/offset 2\d{3} ms/);
    expect((await run('ntp', { port: p, maxOffsetMs: 5000 })).ok).toBe(true);
  });
  it('reports a kiss-of-death reply', async () => {
    const p = await port;
    stratum = 0; skewMs = 0;
    const r = await run('ntp', { port: p });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/kiss code RATE/);
  });
  it('times out when nobody answers', async () => {
    const r = await run('ntp', { port: await udpServer(() => {}) }, 400);
    expect(r.errorKind).toBe('timeout');
  });
});

/* ------------------------------------ RADIUS ----------------------------------- */
const md5 = (...p: Buffer[]) => { const h = createHash('md5'); p.forEach((x) => h.update(x)); return h.digest(); };

describe('radius', () => {
  const serverSecret = Buffer.from('testing123');
  let macValid = false;
  const port = udpServer((msg, reply) => {
    const ra = msg.subarray(4, 20);
    const len = msg.readUInt16BE(2);
    let user = '', cipher: Buffer = Buffer.alloc(0), ma = -1;
    for (let p = 20; p < len; p += msg[p + 1]) {
      const v = msg.subarray(p + 2, p + msg[p + 1]);
      if (msg[p] === 1) user = v.toString();
      if (msg[p] === 2) cipher = v;
      if (msg[p] === 80) ma = p + 2;
    }
    const zeroed = Buffer.from(msg.subarray(0, len));
    zeroed.fill(0, ma, ma + 16);
    macValid = ma > 0 && createHmac('md5', serverSecret).update(zeroed).digest().equals(msg.subarray(ma, ma + 16));
    const plain: number[] = [];
    for (let i = 0; i < cipher.length; i += 16) {
      const key = md5(serverSecret, i === 0 ? ra : cipher.subarray(i - 16, i));
      cipher.subarray(i, i + 16).forEach((b, j) => plain.push(b ^ key[j]));
    }
    const pw = Buffer.from(plain).toString().replace(/\0+$/, '');
    const accept = user === 'bob' && pw === 'hunter2';
    const attrs = accept ? Buffer.alloc(0) : Buffer.concat([Buffer.from([18, 2 + 11]), Buffer.from('bad account')]);
    const head = Buffer.from([accept ? 2 : 3, msg[1], 0, 0]);
    head.writeUInt16BE(20 + attrs.length, 2);
    reply(Buffer.concat([head, md5(head, ra, attrs, serverSecret), attrs]));
  });
  const cfg = { username: 'bob', password: 'hunter2', secret: 'testing123' };

  it('accepts a valid account and signs the request with a Message-Authenticator', async () => {
    const r = await run('radius', { ...cfg, port: await port });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Access-Accept');
    expect(macValid).toBe(true);
  });
  it('reports a rejected account, or counts it as up on request', async () => {
    const p = await port;
    const bad = await run('radius', { ...cfg, password: 'nope', port: p });
    expect(bad.errorKind).toBe('auth');
    expect(bad.message).toBe('Access-Reject: bad account');
    expect((await run('radius', { ...cfg, password: 'nope', port: p, rejectIsUp: true })).ok).toBe(true);
  });
  it('notices a wrong shared secret', async () => {
    const r = await run('radius', { ...cfg, secret: 'other', port: await port });
    expect(r.errorKind).toBe('auth');
    expect(r.message).toMatch(/shared secret/);
  });
});

/* -------------------------------------- FTP ------------------------------------ */
describe('ftp', () => {
  const port = tcpServer((s) => {
    s.write('220-Welcome\r\n220 Test FTP ready\r\n');
    let user = '';
    s.on('data', (d) => {
      for (const line of d.toString().split('\r\n').filter(Boolean)) {
        const [cmd, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        if (cmd === 'USER') { user = arg; s.write('331 Password required\r\n'); }
        else if (cmd === 'PASS') s.write(user === 'bob' && arg === 'pw' ? '230 Logged in\r\n' : '530 Login incorrect\r\n');
        else if (cmd === 'CWD') s.write(arg === '/incoming' ? '250 OK\r\n' : '550 No such directory\r\n');
        else if (cmd === 'QUIT') s.end('221 Bye\r\n');
      }
    });
  });
  it('reads the greeting, logs in and checks a directory', async () => {
    const p = await port;
    expect((await run('ftp', { port: p })).message).toBe('Test FTP ready');
    expect((await run('ftp', { port: p, username: 'bob', password: 'pw', path: '/incoming' })).ok).toBe(true);
  });
  it('tells a bad login and a missing directory apart', async () => {
    const p = await port;
    expect((await run('ftp', { port: p, username: 'bob', password: 'x' })).errorKind).toBe('auth');
    const dir = await run('ftp', { port: p, username: 'bob', password: 'pw', path: '/nope' });
    expect(dir.errorKind).toBe('content');
    expect(dir.message).toMatch(/\/nope/);
  });
  it('rejects a peer that is not an FTP server', async () => {
    const p = await tcpServer((s) => s.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    expect((await run('ftp', { port: p })).errorKind).toBe('protocol');
  });
});

/* -------------------------------------- RDP ------------------------------------ */
describe('rdp', () => {
  it('recognizes an X.224 connection confirm', async () => {
    const p = await tcpServer((s) => s.once('data', (d) => { if (d[0] === 3 && d[5] === 0xe0) s.write(Buffer.from('030000130ed000001234000200080002000000', 'hex')); else s.end(); }));
    expect((await run('rdp', { port: p })).ok).toBe(true);
  });
  it('rejects anything else', async () => {
    const p = await tcpServer((s) => s.once('data', () => s.write('SSH-2.0-OpenSSH_9.0 not rdp\r\n')));
    expect((await run('rdp', { port: p })).errorKind).toBe('protocol');
  });
});

/* -------------------------------------- SIP ------------------------------------ */
describe('sip', () => {
  let status = '200 OK';
  const answer = (req: string) => `SIP/2.0 ${status}\r\nCall-ID: ${/^Call-ID:\s*(\S+)/im.exec(req)?.[1]}\r\nServer: FakePBX/1.0\r\nContent-Length: 0\r\n\r\n`;
  const udp = udpServer((m, reply) => reply(Buffer.from(answer(m.toString()))));
  const tcp = tcpServer((s) => s.on('data', (d) => s.write(answer(d.toString()))));
  it('sends OPTIONS over UDP and TCP', async () => {
    status = '200 OK';
    const u = await run('sip', { port: await udp });
    expect(u.ok).toBe(true);
    expect(u.message).toBe('200 OK (FakePBX/1.0)');
    expect((await run('sip', { port: await tcp, transport: 'tcp' })).ok).toBe(true);
  });
  it('accepts an authentication challenge by default but not a 404', async () => {
    const p = await udp;
    status = '401 Unauthorized';
    expect((await run('sip', { port: p })).ok).toBe(true);
    status = '404 Not Found';
    const r = await run('sip', { port: p });
    expect(r.errorKind).toBe('http_status');
    expect((await run('sip', { port: p, expectedStatus: '404' })).ok).toBe(true);
  });
  it('ignores a reply that belongs to another dialog', async () => {
    const p = await udpServer((_m, reply) => reply(Buffer.from('SIP/2.0 200 OK\r\nCall-ID: someone-else\r\n\r\n')));
    expect((await run('sip', { port: p })).errorKind).toBe('protocol');
  });
});

/* ------------------------------------- LDAP ------------------------------------ */
const ber = (tag: number, ...parts: Buffer[]) => { const b = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag, ...(b.length < 128 ? [b.length] : [0x81, b.length])]), b]); };
const ldapMsg = (id: number, op: Buffer) => ber(0x30, ber(0x02, Buffer.from([id])), op);
const ldapResult = (tag: number, code: number) => ber(tag, ber(0x0a, Buffer.from([code])), ber(0x04), ber(0x04));

describe('ldap', () => {
  let searchCode = 0, entries = 1;
  const port = tcpServer((s) => {
    let buf: Buffer = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const msg = buf.subarray(0, 2 + buf[1]);
        buf = buf.subarray(msg.length);
        const id = msg[4], op = msg[5];
        if (op === 0x60) {
          // bind: version, name, simple password
          let p = 10; const dnLen = msg[p + 1]; const dn = msg.toString('utf8', p + 2, p + 2 + dnLen); p += 2 + dnLen;
          const pw = msg.toString('utf8', p + 2, p + 2 + msg[p + 1]);
          s.write(ldapMsg(id, ldapResult(0x61, dn === 'cn=mon,dc=x' && pw === 'secret' ? 0 : 49)));
        } else if (op === 0x63) {
          for (let i = 0; i < entries; i++) s.write(ldapMsg(id, ber(0x64, ber(0x04, Buffer.from(`cn=e${i},dc=x`)), ber(0x30))));
          s.write(ldapMsg(id, ldapResult(0x65, searchCode)));
        } else if (op === 0x42) s.end();
      }
    });
  });
  const url = async () => `ldap://127.0.0.1:${await port}`;
  it('reads the root DSE anonymously and binds with an account', async () => {
    expect((await run('ldap', { url: await url() })).message).toBe('Root DSE query succeeded');
    expect((await run('ldap', { url: await url(), bindDn: 'cn=mon,dc=x', bindPassword: 'secret' })).message).toBe('Bind and root DSE query succeeded');
  });
  it('reports refused credentials', async () => {
    const r = await run('ldap', { url: await url(), bindDn: 'cn=mon,dc=x', bindPassword: 'wrong' });
    expect(r.errorKind).toBe('auth');
  });
  it('counts search results against the minimum', async () => {
    searchCode = 0; entries = 1;
    expect((await run('ldap', { url: await url(), baseDn: 'dc=x' })).message).toBe('Search found 1 entry');
    const few = await run('ldap', { url: await url(), baseDn: 'dc=x', minEntries: 2 });
    expect(few.errorKind).toBe('content');
    // "size limit exceeded" means there are at least as many entries as asked for
    searchCode = 4; entries = 2;
    expect((await run('ldap', { url: await url(), baseDn: 'dc=x', minEntries: 2 })).ok).toBe(true);
  });
  it('refuses a URL that is not LDAP', async () => {
    expect((await run('ldap', { url: 'http://127.0.0.1:1' })).errorKind).toBe('config');
  });
});

/* ------------------------------------- Kafka ----------------------------------- */
const k16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const k32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const kstr = (s: string) => Buffer.concat([k16(s.length), Buffer.from(s)]);

describe('kafka', () => {
  let topicError = 0, leaders = [1, 1, 1];
  const broker = () => tcpServer((s) => {
    let buf: Buffer = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32BE(0)) {
        const frame = buf.subarray(4, 4 + buf.readInt32BE(0));
        buf = buf.subarray(4 + frame.length);
        const key = frame.readInt16BE(0), corr = frame.readInt32BE(4);
        let reply: Buffer;
        if (key === 18) reply = Buffer.concat([k16(0), k32(1), k16(18), k16(0), k16(0)]);
        else {
          const clientLen = frame.readInt16BE(8);
          const topic = frame.toString('utf8', 10 + clientLen + 6, frame.length - 1); // topic array: count(4) + string
          const partitions = leaders.map((l, i) => Buffer.concat([k16(l < 0 ? 5 : 0), k32(i), k32(l), k32(1), k32(1), k32(1), k32(1)]));
          reply = Buffer.concat([k32(0), k32(1), k32(1), kstr('127.0.0.1'), k32(9092), k16(-1), kstr('cluster'), k32(1), k32(1), k16(topicError), kstr(topic), Buffer.from([0]), k32(partitions.length), ...partitions]);
        }
        s.write(Buffer.concat([k32(4 + reply.length), k32(corr), reply]));
      }
    });
  });
  it('asks the broker and checks the topic leaders', async () => {
    topicError = 0; leaders = [1, 1, 1];
    const p = await broker();
    expect((await run('kafka', { brokers: `127.0.0.1:${p}` })).message).toMatch(/1\/1 brokers up, broker answered/);
    expect((await run('kafka', { brokers: `127.0.0.1:${p}`, topic: 'orders' })).message).toMatch(/topic orders has 3 partitions, all with a leader/);
  });
  it('fails for a missing topic and for partitions without a leader', async () => {
    const p = await broker();
    topicError = 3; leaders = [1];
    const missing = await run('kafka', { brokers: `127.0.0.1:${p}`, topic: 'orders' });
    expect(missing.errorKind).toBe('content');
    expect(missing.message).toMatch(/UNKNOWN_TOPIC_OR_PARTITION/);
    topicError = 0; leaders = [1, -1];
    expect((await run('kafka', { brokers: `127.0.0.1:${p}`, topic: 'orders' })).message).toMatch(/1 of 2 partitions have no leader/);
  });
  it('tolerates a dead broker unless every broker is required', async () => {
    topicError = 0; leaders = [1];
    const up = await broker(), dead = await deadPort();
    const brokers = `127.0.0.1:${up},127.0.0.1:${dead}`;
    expect((await run('kafka', { brokers })).message).toMatch(/1\/2 brokers up/);
    const strict = await run('kafka', { brokers, requireAll: true });
    expect(strict.ok).toBe(false);
    expect(strict.message).toMatch(/1 of 2 brokers down/);
    expect((await run('kafka', { brokers: `127.0.0.1:${dead}` })).errorKind).toBe('refused');
  });
  it('rejects a peer that does not speak Kafka', async () => {
    const p = await tcpServer((s) => s.once('data', () => s.end('HTTP/1.1 400 Bad Request\r\n\r\n')));
    expect((await run('kafka', { brokers: `127.0.0.1:${p}` })).ok).toBe(false);
  });
});

/* ------------------------------------ RabbitMQ --------------------------------- */
describe('rabbitmq', () => {
  let alarm = false;
  const port = httpServer((req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('guest:guest').toString('base64')) { res.writeHead(401).end(); return; }
    if (req.url !== '/api/health/checks/alarms') { res.writeHead(404).end(); return; }
    res.writeHead(alarm ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(alarm ? { status: 'failed', reason: 'resource alarm(s) in effect: disk' } : { status: 'ok' }));
  });
  it('is up without alarms, down with them, and tells a bad login apart', async () => {
    const url = `http://127.0.0.1:${await port}/`;
    alarm = false;
    expect((await run('rabbitmq', { url, username: 'guest', password: 'guest' })).ok).toBe(true);
    expect((await run('rabbitmq', { url, username: 'guest', password: 'x' })).errorKind).toBe('auth');
    alarm = true;
    const r = await run('rabbitmq', { url, username: 'guest', password: 'guest' });
    expect(r.errorKind).toBe('content');
    expect(r.message).toMatch(/disk/);
  });
});

/* -------------------------------- Steam and GameDig ---------------------------- */
const a2sInfo = (players: number) => Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]), Buffer.from('My Server\0de_dust2\0cstrike\0Counter-Strike\0'), Buffer.from([0x0a, 0x00, players, 24, 0, 0x64, 0x6c, 0, 0]), Buffer.from('1.0.0\0')]);

describe('steam', () => {
  let players = 3, challenge = true;
  const port = udpServer((msg, reply) => {
    if (msg[4] !== 0x54) return;
    if (challenge && msg.length === 25) reply(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]));
    else if (!challenge || (msg.length === 29 && msg.subarray(25).equals(Buffer.from([1, 2, 3, 4])))) reply(a2sInfo(players));
  });
  it('answers the challenge and reads name, map and players', async () => {
    const p = await port;
    const r = await run('steam', { port: p });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('My Server (de_dust2), 3/24 players');
    challenge = false;
    expect((await run('steam', { port: p })).ok).toBe(true);
    challenge = true;
  });
  it('can require a minimum number of players', async () => {
    const r = await run('steam', { port: await port, minPlayers: 10 });
    expect(r.errorKind).toBe('content');
    expect(r.message).toMatch(/3 players online/);
  });
  it('rejects a reply that is not A2S_INFO', async () => {
    const p = await udpServer((_m, reply) => reply(Buffer.from('definitely not valve')));
    expect((await run('steam', { port: p })).errorKind).toBe('protocol');
  });
});

describe('gamedig', () => {
  it('reports an unknown game id as a configuration error', async () => {
    const r = await run('gamedig', { game: 'no-such-game', port: 9 });
    expect(r.errorKind).toBe('config');
  });
  it('times out when the server does not answer', async () => {
    const p = await udpServer(() => {});
    const r = await run('gamedig', { game: 'css', port: p }, 1500);
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('timeout');
  });
  it('queries a Source server through the vetted address', async () => {
    const p = await udpServer((msg, reply) => {
      if (msg[4] === 0x54) reply(a2sInfo(2));
      else if (msg[4] === 0x55) reply(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, 0]));
    });
    const r = await run('gamedig', { game: 'css', port: p }, 4000);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/My Server/);
  });
});

/* --------------------------- Pelican and AMP (panel APIs) ----------------------- */
describe('pelican', () => {
  let state = 'running', suspended = false;
  const port = httpServer((req, res) => {
    if (req.headers.authorization !== 'Bearer pel_key') { res.writeHead(401).end(); return; }
    if (req.url !== '/api/client/servers/abc123/resources') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'stats', attributes: { current_state: state, is_suspended: suspended, resources: { memory_bytes: 3 * 1048576, cpu_absolute: 12.34, disk_bytes: 5, uptime: 1000 } } }));
  });
  it('is up while the server runs and says what is wrong otherwise', async () => {
    const url = `http://127.0.0.1:${await port}`;
    const cfg = { url, serverId: 'abc123', apiKey: 'pel_key' };
    state = 'running'; suspended = false;
    expect((await run('pelican', cfg)).message).toBe('Running, 12.3% CPU, 3 MB RAM');
    state = 'offline';
    expect((await run('pelican', cfg)).message).toBe('The server is offline');
    state = 'running'; suspended = true;
    expect((await run('pelican', cfg)).message).toBe('The server is suspended');
    expect((await run('pelican', { ...cfg, apiKey: 'bad' })).errorKind).toBe('auth');
    const missing = await run('pelican', { ...cfg, serverId: 'zzz' });
    expect(missing.errorKind).toBe('content');
  });
});

describe('amp', () => {
  let state = 20, logouts = 0;
  const port = httpServer(async (req, res) => {
    const b = JSON.parse((await body(req)) || '{}');
    const json = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/API/Core/Login') return b.username === 'amp' && b.password === 'pw' ? json({ success: true, sessionID: 'S1', resultReason: '' }) : json({ success: false, resultReason: 'Invalid credentials' });
    if (req.url === '/API/Core/Logout') { logouts++; return json({}); }
    if (req.url === '/API/ADSModule/Servers/inst-1/API/Core/GetStatus' && b.SESSIONID === 'S1') return json({ State: state, Uptime: '0:00:12:00', Metrics: { 'Active Users': { RawValue: 3, MaxValue: 20 } } });
    return json({ Title: 'Unauthorized Access' });
  });
  it('logs in, reads the instance state and logs out again', async () => {
    const cfg = { url: `http://127.0.0.1:${await port}`, username: 'amp', password: 'pw', instanceId: 'inst-1' };
    state = 20; logouts = 0;
    const r = await run('amp', cfg);
    expect(r.message).toBe('Ready, 3/20 players');
    await new Promise((r2) => setTimeout(r2, 50));
    expect(logouts).toBe(1);
    state = 0;
    expect((await run('amp', cfg)).message).toBe('The instance is stopped');
    expect((await run('amp', { ...cfg, password: 'x' })).errorKind).toBe('auth');
    expect((await run('amp', { ...cfg, instanceId: 'other' })).errorKind).toBe('protocol');
  });
});

/* ------------------------------------ Globalping ------------------------------- */
describe('globalping', () => {
  let polls = 0, mode = 'ping-ok', lastCreate: any, lastAuth: string | undefined;
  const result = (): object => ({
    'ping-ok': { status: 'finished', results: [{ probe: { city: 'Frankfurt', country: 'DE' }, result: { status: 'finished', stats: { avg: 12.5, loss: 0 } } }] },
    'ping-lost': { status: 'finished', results: [{ probe: { city: 'Frankfurt', country: 'DE' }, result: { status: 'finished', stats: { avg: null, loss: 100 } } }] },
    'http-500': { status: 'finished', results: [{ probe: { city: 'Paris', country: 'FR' }, result: { status: 'finished', statusCode: 500, timings: { total: 80 } } }] },
    'none': { status: 'finished', results: [] },
  } as Record<string, object>)[mode];
  const port = httpServer(async (req, res) => {
    const send = (code: number, o: object) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.method === 'POST') {
      lastCreate = JSON.parse(await body(req)); lastAuth = req.headers.authorization;
      if (mode === 'limit') return send(429, { error: { message: 'too many' } });
      if (mode === 'invalid') return send(422, { error: { message: 'bad target' } });
      polls = 0;
      return send(202, { id: 'm1' });
    }
    return send(200, ++polls < 2 ? { status: 'in-progress', results: [] } : result());
  });
  const cfg = async (extra: Record<string, any> = {}) => ({ apiUrl: `http://127.0.0.1:${await port}`, measurement: 'ping', target: 'example.com', ...extra });
  it('waits for the probe and reports latency and location', async () => {
    mode = 'ping-ok';
    const r = await run('globalping', await cfg({ location: 'Germany', token: 'tok' }), 8000);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('From Frankfurt, DE: 12.5 ms');
    expect(lastCreate).toMatchObject({ type: 'ping', target: 'example.com', limit: 1, locations: [{ magic: 'Germany' }] });
    expect(lastAuth).toBe('Bearer tok');
  });
  it('fails on packet loss and on an unexpected HTTP status', async () => {
    mode = 'ping-lost';
    expect((await run('globalping', await cfg(), 8000)).message).toBe('From Frankfurt, DE: 100% packet loss');
    mode = 'http-500';
    const r = await run('globalping', await cfg({ measurement: 'http', target: 'https://example.com/health?x=1' }), 8000);
    expect(r.errorKind).toBe('http_status');
    expect(lastCreate).toMatchObject({ type: 'http', target: 'example.com', measurementOptions: { protocol: 'HTTPS', request: { path: '/health', query: 'x=1' } } });
  });
  it('explains rate limits, invalid requests and missing probes', async () => {
    mode = 'limit';
    expect((await run('globalping', await cfg())).message).toMatch(/rate limit/);
    mode = 'invalid';
    expect((await run('globalping', await cfg())).errorKind).toBe('config');
    mode = 'none';
    expect((await run('globalping', await cfg({ location: 'Atlantis' }), 8000)).message).toMatch(/Atlantis/);
  });
});

/* -------------------------------- Manual, PM2 and Oracle ----------------------- */
describe('manual', () => {
  it('reports the status that was set', async () => {
    expect((await run('manual', { state: 'up' })).ok).toBe(true);
    const down = await run('manual', { state: 'down', message: 'Provider outage' });
    expect(down.ok).toBe(false);
    expect(down.message).toBe('Provider outage');
  });
});

describe.skipIf(process.platform === 'win32')('pm2', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pw-pm2-'));
  const list = [{ name: 'api', pm2_env: { status: 'online', restart_time: 2 } }, { name: 'api', pm2_env: { status: 'errored', restart_time: 5 } }, { name: 'web', pm2_env: { status: 'online', restart_time: 1 } }];
  writeFileSync(path.join(dir, 'pm2'), `#!/bin/sh\necho "[PM2] Spawning PM2 daemon with pm2_home=/tmp/x"\necho "[PM2] PM2 Successfully daemonized"\necho '${JSON.stringify(list)}'\n`);
  chmodSync(path.join(dir, 'pm2'), 0o755);
  it('checks that every instance of a process is online', async () => {
    const saved = process.env.PATH;
    process.env.PATH = `${dir}:${saved}`;
    try {
      expect((await run('pm2', { processName: 'web' })).message).toBe('1 instance online, 1 restart');
      const bad = await run('pm2', { processName: 'api' });
      expect(bad.errorKind).toBe('content');
      expect(bad.message).toMatch(/1 of 2 instances are not online \(online, errored\)/);
      expect((await run('pm2', { processName: 'ghost' })).message).toMatch(/no process named "ghost"/);
    } finally { process.env.PATH = saved; }
  });
  it('says so when pm2 is not installed', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try { expect((await run('pm2', { processName: 'web' })).errorKind).toBe('config'); } finally { process.env.PATH = saved; }
  });
});

describe('oracle', () => {
  it('rejects a service name that could alter the connect descriptor', async () => {
    expect((await run('oracle', { port: 1, serviceName: 'x)(HOST=evil', username: 'u' })).errorKind).toBe('config');
  });
  it('fails cleanly when nothing listens', async () => {
    const r = await run('oracle', { port: await deadPort(), serviceName: 'XEPDB1', username: 'u', password: 'p' }, 4000);
    expect(r.ok).toBe(false);
    expect(['refused', 'timeout', 'network']).toContain(r.errorKind);
  });
});
