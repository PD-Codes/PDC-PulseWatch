import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import WebSocket from 'ws';
import { connect } from '../conn';
import { jsonCompare, type JsonOp } from '../jsonpath';
import { CheckError, type CheckResult, type Runner } from '../types';
import { fail, hrMs, ok, toCheckError } from '../util';

const wrap = (e: unknown) => { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); };

/* ---------------------------------- WebSocket --------------------------------- */
const websocket: Runner = {
  type: 'websocket', label: 'WebSocket', category: 'Application',
  fields: [
    { key: 'url', label: 'URL', kind: 'text', required: true, placeholder: 'wss://example.com/socket' },
    { key: 'headers', label: 'Headers', kind: 'kv', secretValues: true },
    { key: 'send', label: 'Message to send (optional)', kind: 'textarea' },
    { key: 'expect', label: 'Reply must contain (optional)', kind: 'text' },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const u = new URL(c.url);
      ctx.guard.assertLiteral(u.hostname.replace(/^\[|\]$/g, ''));
      const t0 = process.hrtime.bigint();
      return await new Promise<CheckResult>((resolve) => {
        const ws = new WebSocket(c.url, { headers: c.headers, rejectUnauthorized: c.verifyTls !== false, lookup: ctx.guard.lookup as any, handshakeTimeout: ctx.timeoutMs });
        let connectedAt = 0;
        const done = (r: CheckResult) => { ws.terminate(); resolve(r); };
        ctx.signal.addEventListener('abort', () => done(fail('timeout', 'Timed out waiting for the WebSocket peer')), { once: true });
        ws.on('error', (e) => done(wrap(e)));
        ws.on('unexpected-response', (_q, res) => done(fail('http_status', `Handshake rejected with HTTP ${res.statusCode}`)));
        ws.on('open', () => {
          connectedAt = hrMs(t0);
          if (!c.send && !c.expect) return done(ok(connectedAt, { message: 'WebSocket connected' }));
          if (c.send) ws.send(c.send);
        });
        ws.on('message', (m) => {
          const text = m.toString();
          if (c.expect && !text.includes(c.expect)) return;
          done(ok(hrMs(t0), { message: `Reply received (${text.length} chars)` }));
        });
        ws.on('close', () => done(fail('network', 'Connection closed before the expected reply')));
      });
    } catch (e) { return wrap(e); }
  },
};

/* ------------------------------------- gRPC ------------------------------------ */
const grpc: Runner = {
  type: 'grpc', label: 'gRPC health', category: 'Application',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'port', label: 'Port', kind: 'number', required: true, min: 1, max: 65535 },
    { key: 'service', label: 'Service name (blank = whole server)', kind: 'text' },
    { key: 'useTls', label: 'Use TLS', kind: 'bool', default: true },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      ctx.guard.assertLiteral(c.host);
      const t0 = process.hrtime.bigint();
      return await new Promise<CheckResult>((resolve) => {
        const client = http2.connect(`${c.useTls === false ? 'http' : 'https'}://${c.host}:${c.port}`, {
          createConnection: () => c.useTls === false
            ? net.connect({ host: c.host, port: c.port, lookup: ctx.guard.lookup as any })
            : tls.connect({ host: c.host, port: c.port, servername: net.isIP(c.host) ? undefined : c.host, ALPNProtocols: ['h2'], rejectUnauthorized: c.verifyTls !== false, lookup: ctx.guard.lookup as any }),
        });
        const done = (r: CheckResult) => { client.destroy(); resolve(r); };
        ctx.signal.addEventListener('abort', () => done(fail('timeout', 'gRPC call timed out')), { once: true });
        client.on('error', (e) => done(wrap(e)));
        const svc = Buffer.from(c.service ?? '');
        const msg = svc.length ? Buffer.concat([Buffer.from([0x0a, svc.length]), svc]) : Buffer.alloc(0);
        const frame = Buffer.alloc(5 + msg.length);
        frame.writeUInt32BE(msg.length, 1);
        msg.copy(frame, 5);
        const req = client.request({ ':method': 'POST', ':path': '/grpc.health.v1.Health/Check', 'content-type': 'application/grpc', te: 'trailers' });
        const chunks: Buffer[] = [];
        let status: string | undefined;
        let message: string | undefined;
        req.on('response', (h) => { if (h['grpc-status'] !== undefined) status = String(h['grpc-status']); message = h['grpc-message'] as string | undefined; });
        req.on('trailers', (t) => { status = String(t['grpc-status'] ?? status); message = (t['grpc-message'] as string) ?? message; });
        req.on('data', (d) => chunks.push(Buffer.from(d)));
        req.on('error', (e) => done(wrap(e)));
        req.on('close', () => {
          const body = Buffer.concat(chunks);
          if (status === undefined) return done(fail('protocol', 'No grpc-status in response (not a gRPC server?)'));
          if (status !== '0') return done(fail('protocol', `gRPC status ${status}${message ? `: ${decodeURIComponent(message)}` : ''}`));
          const serving = body.length >= 7 ? body[6] : 0; // field 1 varint after the 5 byte frame header
          if (serving !== 1) return done(fail('content', `Service status is ${['UNKNOWN', 'SERVING', 'NOT_SERVING', 'SERVICE_UNKNOWN'][serving] ?? serving}`, { latencyMs: Math.round(hrMs(t0)) }));
          done(ok(hrMs(t0), { message: 'SERVING' }));
        });
        req.end(frame);
      });
    } catch (e) { return wrap(e); }
  },
};

/* ------------------------------------- MQTT ------------------------------------ */
const mstr = (s: string) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
function mpacket(first: number, body: Buffer): Buffer {
  const len: number[] = [];
  let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0);
  return Buffer.concat([Buffer.from([first, ...len]), body]);
}
/** Pull complete MQTT packets out of a buffer. */
function* mparse(buf: Buffer): Generator<{ type: number; flags: number; body: Buffer; rest: Buffer }> {
  let cur = buf;
  while (cur.length >= 2) {
    let mul = 1, len = 0, i = 1, b: number;
    do { if (i >= cur.length) return; b = cur[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
    if (cur.length < i + len) return;
    const body = cur.subarray(i, i + len);
    cur = cur.subarray(i + len);
    yield { type: buf[0] >> 4, flags: 0, body, rest: cur };
    buf = cur;
  }
}

const mqtt: Runner = {
  type: 'mqtt', label: 'MQTT broker', category: 'Application',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'port', label: 'Port', kind: 'number', default: 1883, min: 1, max: 65535 },
    { key: 'useTls', label: 'Use TLS', kind: 'bool', default: false },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'secret' },
    { key: 'topic', label: 'Topic to subscribe (optional)', kind: 'text', help: 'When set, the check waits for a message on this topic (retained messages count).' },
    { key: 'expect', label: 'Message must contain (optional)', kind: 'text', showIf: { key: 'topic', equals: '' } },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      const conn = await connect({ host: c.host, port: c.port ?? 1883, signal: ctx.signal, guard: ctx.guard, tls: c.useTls ? { verify: c.verifyTls !== false } : false });
      try {
        const flags = 0x02 | (c.username ? 0x80 : 0) | (c.password ? 0x40 : 0);
        const parts = [mstr('MQTT'), Buffer.from([4, flags, 0, 60]), mstr(`pw-${process.pid}-${Date.now() % 100000}`)];
        if (c.username) parts.push(mstr(c.username));
        if (c.password) parts.push(mstr(c.password));
        conn.sock.write(mpacket(0x10, Buffer.concat(parts)));
        let buf = Buffer.alloc(0);
        let state: 'connack' | 'suback' | 'publish' = 'connack';
        return await new Promise<CheckResult>((resolve) => {
          conn.sock.on('close', () => resolve(fail('network', 'Broker closed the connection')));
          conn.sock.on('error', (e) => resolve(wrap(e)));
          conn.sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            for (const p of mparse(buf)) {
              buf = Buffer.from(p.rest);
              if (state === 'connack' && p.type === 2) {
                const rc = p.body[1];
                if (rc !== 0) return resolve(fail(rc === 4 || rc === 5 ? 'auth' : 'protocol', `CONNACK return code ${rc}`));
                if (!c.topic) return resolve(ok(hrMs(t0), { message: 'Broker accepted the connection' }));
                state = 'suback';
                conn.sock.write(mpacket(0x82, Buffer.concat([Buffer.from([0, 1]), mstr(c.topic), Buffer.from([0])])));
              } else if (state === 'suback' && p.type === 9) {
                state = 'publish';
              } else if (p.type === 3) {
                const tlen = p.body.readUInt16BE(0);
                const payload = p.body.subarray(2 + tlen).toString();
                if (!c.expect || payload.includes(c.expect)) return resolve(ok(hrMs(t0), { message: `Message on ${c.topic} (${payload.length} bytes)` }));
              }
            }
          });
        });
      } finally { conn.close(); }
    } catch (e) { return wrap(e); }
  },
};

/* ------------------------------------- SNMP ------------------------------------ */
const blen = (n: number) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag: number, c: Buffer) => Buffer.concat([Buffer.from([tag]), blen(c.length), c]);
function bint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  do { out.unshift(v & 255); v >>= 8; } while (v > 0 && out.length < 4);
  if (out[0] & 128) out.unshift(0);
  return tlv(0x02, Buffer.from(out));
}
function boid(s: string): Buffer {
  const a = s.replace(/^\./, '').split('.').map(Number);
  if (a.length < 2 || a.some((x) => !Number.isInteger(x) || x < 0)) throw new CheckError('config', `Invalid OID ${s}`);
  const out: number[] = [a[0] * 40 + a[1]];
  for (const n of a.slice(2)) {
    const b = [n & 127];
    let v = n >> 7;
    while (v > 0) { b.unshift((v & 127) | 128); v >>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function bread(buf: Buffer, pos: number): { tag: number; start: number; end: number } {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let start = pos + 2;
  if (len & 128) { const n = len & 127; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[start + i]; start += n; }
  if (start + len > buf.length) throw new CheckError('protocol', 'Truncated SNMP response');
  return { tag, start, end: start + len };
}
function snmpValue(buf: Buffer, tag: number): string | number {
  switch (tag) {
    case 0x02: return buf.length ? buf.readIntBE(0, Math.min(buf.length, 6)) : 0;
    case 0x41: case 0x42: case 0x43: case 0x46: return buf.length ? Number(buf.readUIntBE(0, Math.min(buf.length, 6))) : 0;
    case 0x04: { const s = buf.toString('utf8'); return /^[\x20-\x7e\r\n\t]*$/.test(s) ? s : buf.toString('hex'); }
    case 0x40: return [...buf].join('.');
    case 0x06: return 'oid:' + [...buf].join('.');
    default: return buf.toString('hex');
  }
}

const snmp: Runner = {
  type: 'snmp', label: 'SNMP (v2c)', category: 'Application',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'port', label: 'Port', kind: 'number', default: 161, min: 1, max: 65535 },
    { key: 'community', label: 'Community', kind: 'secret', required: true, default: 'public' },
    { key: 'oid', label: 'OID', kind: 'text', required: true, default: '1.3.6.1.2.1.1.3.0', placeholder: '1.3.6.1.2.1.1.3.0' },
    { key: 'op', label: 'Condition', kind: 'select', options: [{ value: 'exists', label: 'returns a value' }, { value: 'eq', label: 'equals' }, { value: 'ne', label: 'does not equal' }, { value: 'gt', label: 'greater than' }, { value: 'lt', label: 'less than' }, { value: 'contains', label: 'contains' }], default: 'exists' },
    { key: 'expected', label: 'Expected value', kind: 'text' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0];
      const reqId = Math.floor(Math.random() * 0x7fffffff);
      const vb = tlv(0x30, tlv(0x30, Buffer.concat([boid(c.oid), Buffer.from([0x05, 0x00])])));
      const pdu = tlv(0xa0, Buffer.concat([bint(reqId), bint(0), bint(0), vb]));
      const msg = tlv(0x30, Buffer.concat([bint(1), tlv(0x04, Buffer.from(c.community)), pdu]));
      const t0 = process.hrtime.bigint();
      const reply = await new Promise<Buffer>((resolve, reject) => {
        const s = dgram.createSocket(addr.family === 6 ? 'udp6' : 'udp4');
        const timer = setTimeout(() => { s.close(); reject(new CheckError('timeout', 'No SNMP response', { phase: 'response' })); }, ctx.timeoutMs);
        s.on('error', (e) => { clearTimeout(timer); s.close(); reject(e); });
        s.on('message', (m) => { clearTimeout(timer); s.close(); resolve(m); });
        s.send(msg, c.port ?? 161, addr.address);
      });
      const ms = hrMs(t0);
      let p = bread(reply, 0);
      p = bread(reply, p.start); // version
      p = bread(reply, p.end); // community
      const pduHdr = bread(reply, p.end);
      if (pduHdr.tag !== 0xa2) throw new CheckError('protocol', 'Not an SNMP GetResponse');
      let q = bread(reply, pduHdr.start); // request id
      q = bread(reply, q.end); // error status
      const errStatus = reply.subarray(q.start, q.end).readUIntBE(0, Math.max(1, q.end - q.start));
      if (errStatus !== 0) return fail(errStatus === 2 ? 'content' : 'auth', `SNMP error status ${errStatus}`, { latencyMs: Math.round(ms) });
      q = bread(reply, q.end); // error index
      const list = bread(reply, q.end);
      const bind = bread(reply, list.start);
      const oidTlv = bread(reply, bind.start);
      const val = bread(reply, oidTlv.end);
      if ([0x80, 0x81, 0x82].includes(val.tag)) return fail('content', `OID ${c.oid} returned no value`, { latencyMs: Math.round(ms) });
      const value = snmpValue(reply.subarray(val.start, val.end), val.tag);
      if (c.op && c.op !== 'exists' && !jsonCompare(value, c.op as JsonOp, String(c.expected ?? ''))) return fail('content', `${c.oid} is ${value}, expected ${c.op} ${c.expected}`, { latencyMs: Math.round(ms), details: { value } });
      return ok(ms, { message: `${c.oid} = ${value}`, details: { value } });
    } catch (e) { return wrap(e); }
  },
};

/* ----------------------------------- Minecraft ---------------------------------- */
const vint = (n: number) => { const o: number[] = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; o.push(b); } while (n); return Buffer.from(o); };

const minecraft: Runner = {
  type: 'minecraft', label: 'Minecraft server', category: 'Games',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'port', label: 'Port', kind: 'number', default: 25565, min: 1, max: 65535 },
    { key: 'edition', label: 'Edition', kind: 'select', options: [{ value: 'java', label: 'Java' }, { value: 'bedrock', label: 'Bedrock' }], default: 'java' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      if (c.edition === 'bedrock') {
        const addr = (await ctx.guard.resolve(c.host))[0];
        const magic = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
        const pkt = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(8), magic, Buffer.alloc(8)]);
        const reply = await new Promise<Buffer>((resolve, reject) => {
          const s = dgram.createSocket(addr.family === 6 ? 'udp6' : 'udp4');
          const timer = setTimeout(() => { s.close(); reject(new CheckError('timeout', 'No Bedrock response', { phase: 'response' })); }, ctx.timeoutMs);
          s.on('error', (e) => { clearTimeout(timer); s.close(); reject(e); });
          s.on('message', (m) => { clearTimeout(timer); s.close(); resolve(m); });
          s.send(pkt, c.port ?? 19132, addr.address);
        });
        const info = reply.subarray(35).toString('utf8').split(';');
        return ok(hrMs(t0), { message: `${info[1] ?? 'Bedrock'} - ${info[4] ?? '?'}/${info[5] ?? '?'} players`, details: { version: info[3], online: Number(info[4]), max: Number(info[5]) } });
      }
      const conn = await connect({ host: c.host, port: c.port ?? 25565, signal: ctx.signal, guard: ctx.guard });
      try {
        const host = Buffer.from(c.host);
        const port = Buffer.alloc(2);
        port.writeUInt16BE(c.port ?? 25565);
        const hs = Buffer.concat([vint(0), vint(767), vint(host.length), host, port, vint(1)]);
        conn.sock.write(Buffer.concat([vint(hs.length), hs, Buffer.from([1, 0])]));
        const json = await new Promise<string>((resolve, reject) => {
          let buf = Buffer.alloc(0);
          conn.sock.on('close', () => reject(new CheckError('network', 'Server closed the connection')));
          conn.sock.on('error', reject);
          conn.sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            const rd = (o: number): [number, number] | null => { let v = 0, s = 0, i = o; for (;;) { if (i >= buf.length) return null; const b = buf[i++]; v |= (b & 127) << s; s += 7; if (!(b & 128)) return [v, i]; if (s > 35) throw new CheckError('protocol', 'Bad VarInt'); } };
            const len = rd(0); if (!len) return;
            if (buf.length < len[1] + len[0]) return;
            const id = rd(len[1]); if (!id) return;
            const jl = rd(id[1]); if (!jl) return;
            if (buf.length < jl[1] + jl[0]) return;
            resolve(buf.subarray(jl[1], jl[1] + jl[0]).toString('utf8'));
          });
        });
        const st = JSON.parse(json);
        const d = st.description;
        const motd = (typeof d === 'string' ? d : d?.text ?? (d?.extra ?? []).map((x: any) => x.text ?? '').join('')).replace(/§./g, '').trim();
        return ok(hrMs(t0), { message: `${motd || 'Minecraft'} - ${st.players?.online ?? '?'}/${st.players?.max ?? '?'} players (${st.version?.name ?? '?'})`, details: { online: st.players?.online, max: st.players?.max, version: st.version?.name } });
      } finally { conn.close(); }
    } catch (e) { return wrap(e); }
  },
};

/* ------------------------------------- Docker ----------------------------------- */
const docker: Runner = {
  type: 'docker', label: 'Docker container', category: 'Infrastructure',
  fields: [
    { key: 'endpoint', label: 'Docker endpoint', kind: 'text', required: true, default: '/var/run/docker.sock', help: 'Unix socket path, or http://host:2375 for a remote API', placeholder: '/var/run/docker.sock' },
    { key: 'container', label: 'Container name or ID', kind: 'text', required: true },
    { key: 'requireHealthy', label: 'Require "healthy" when a health check exists', kind: 'bool', default: true },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      const path = `/containers/${encodeURIComponent(c.container)}/json`;
      const opts: http.RequestOptions = String(c.endpoint).startsWith('http')
        ? (() => { const u = new URL(c.endpoint); ctx.guard.assertLiteral(u.hostname); return { hostname: u.hostname, port: u.port || 2375, path, lookup: ctx.guard.lookup as any }; })()
        : { socketPath: c.endpoint, path };
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.get({ ...opts, agent: false, signal: ctx.signal }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.on('error', reject);
      });
      const ms = hrMs(t0);
      if (status === 404) return fail('content', `Container "${c.container}" not found`, { latencyMs: Math.round(ms) });
      if (status !== 200) return fail('protocol', `Docker API answered HTTP ${status}`, { latencyMs: Math.round(ms) });
      const st = JSON.parse(body).State ?? {};
      const details = { state: st.Status, health: st.Health?.Status, restarts: JSON.parse(body).RestartCount };
      if (!st.Running) return fail('content', `Container is ${st.Status ?? 'not running'}`, { latencyMs: Math.round(ms), details });
      if (c.requireHealthy !== false && st.Health && st.Health.Status !== 'healthy') return fail('content', `Container health is ${st.Health.Status}`, { latencyMs: Math.round(ms), details });
      return ok(ms, { message: `Container is ${st.Status}${st.Health ? ` (${st.Health.Status})` : ''}`, details });
    } catch (e) { return wrap(e); }
  },
};

export const protoRunners: Runner[] = [websocket, grpc, mqtt, snmp, minecraft, docker];
