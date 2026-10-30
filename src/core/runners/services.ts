import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Client } from 'ldapts';
import { connect, upgradeTls, type Conn } from '../conn';
import { httpRequest } from '../http';
import { trustOptions } from '../trust';
import { CheckError, type FieldDef, type Runner } from '../types';
import { certExpiryError, fail, failure, hrMs, ok, readUntil, statusMatcher, toCheckError, udpRequest } from '../util';

const hostPort = (port: number): FieldDef[] => [
  { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'example.com' },
  { key: 'port', label: 'Port', kind: 'number', default: port, min: 1, max: 65535 },
];

/* ------------------------------------- NTP -------------------------------------- */
const NTP_EPOCH = 2_208_988_800;
const ntpMs = (b: Buffer, o: number) => (b.readUInt32BE(o) - NTP_EPOCH) * 1000 + (b.readUInt32BE(o + 4) / 2 ** 32) * 1000;
function ntpStamp(ms: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE((Math.floor(ms / 1000) + NTP_EPOCH) >>> 0, 0);
  b.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0, 4);
  return b;
}

const ntp: Runner = {
  type: 'ntp', label: 'NTP server', category: 'Network',
  fields: [
    ...hostPort(123),
    { key: 'maxOffsetMs', label: 'Fail when the clock offset exceeds (ms, 0 = off)', kind: 'number', default: 0, min: 0, max: 3_600_000, help: 'Compares the server clock with the clock of the machine running the check (or probe).' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0];
      const pkt = Buffer.alloc(48);
      pkt[0] = 0x1b; // leap 0, version 3, mode 3 (client)
      const t1 = Date.now();
      const origin = ntpStamp(t1);
      origin.copy(pkt, 40);
      const t0 = process.hrtime.bigint();
      const r = await udpRequest(addr, c.port ?? 123, pkt, ctx.timeoutMs, 'NTP', ctx.signal);
      const t4 = Date.now();
      const ms = hrMs(t0);
      if (r.length < 48 || (r[0] & 7) !== 4) return fail('protocol', 'Not an NTP server reply', { latencyMs: Math.round(ms) });
      if (!r.subarray(24, 32).equals(origin)) return fail('protocol', 'NTP reply does not belong to this request', { latencyMs: Math.round(ms) });
      if (r[1] === 0) return fail('protocol', `NTP server refused the request (kiss code ${r.toString('ascii', 12, 16).replace(/\0/g, '')})`, { latencyMs: Math.round(ms) });
      if (r[0] >> 6 === 3) return fail('content', 'NTP server is not synchronized (leap indicator 3)', { latencyMs: Math.round(ms) });
      const offset = Math.round(((ntpMs(r, 32) - t1) + (ntpMs(r, 40) - t4)) / 2);
      const details = { offsetMs: offset, stratum: r[1] };
      if (c.maxOffsetMs && Math.abs(offset) > c.maxOffsetMs) return fail('content', `Clock offset ${offset} ms exceeds ${c.maxOffsetMs} ms`, { latencyMs: Math.round(ms), details });
      return ok(ms, { message: `Stratum ${r[1]}, clock offset ${offset} ms`, details });
    } catch (e) { return failure(e); }
  },
};

/* ------------------------------------ RADIUS ------------------------------------ */
const md5 = (...parts: Buffer[]) => { const h = createHash('md5'); for (const p of parts) h.update(p); return h.digest(); };
const radiusAttr = (type: number, value: Buffer) => Buffer.concat([Buffer.from([type, value.length + 2]), value]);

/** RFC 2865 section 5.2: the password is padded to blocks of 16 and XORed with an MD5 chain keyed by the shared secret. */
function radiusPassword(password: Buffer, secret: Buffer, ra: Buffer): Buffer {
  const padded = Buffer.concat([password, Buffer.alloc(password.length === 0 ? 16 : (16 - (password.length % 16)) % 16)]);
  const out: Buffer[] = [];
  let prev = ra;
  for (let i = 0; i < padded.length; i += 16) {
    const key = md5(secret, prev);
    prev = Buffer.from(padded.subarray(i, i + 16).map((b, j) => b ^ key[j]));
    out.push(prev);
  }
  return Buffer.concat(out);
}

const radius: Runner = {
  type: 'radius', label: 'RADIUS', category: 'Identity',
  fields: [
    ...hostPort(1812),
    { key: 'secret', label: 'Shared secret', kind: 'secret', required: true },
    { key: 'username', label: 'Username', kind: 'text', required: true },
    { key: 'password', label: 'Password', kind: 'secret', required: true },
    { key: 'calledStationId', label: 'Called-Station-Id (optional)', kind: 'text' },
    { key: 'callingStationId', label: 'Calling-Station-Id (optional)', kind: 'text' },
    { key: 'rejectIsUp', label: 'Treat Access-Reject as up', kind: 'bool', default: false, help: 'The server answered, so it is alive. Useful when no real account may be stored in the monitor.' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0];
      const secret = Buffer.from(String(c.secret));
      const ra = randomBytes(16);
      const id = randomBytes(1)[0];
      const attrs = [
        radiusAttr(1, Buffer.from(String(c.username))),
        radiusAttr(2, radiusPassword(Buffer.from(String(c.password ?? '')), secret, ra)),
        radiusAttr(32, Buffer.from('pulsewatch')),
        ...(c.calledStationId ? [radiusAttr(30, Buffer.from(String(c.calledStationId)))] : []),
        ...(c.callingStationId ? [radiusAttr(31, Buffer.from(String(c.callingStationId)))] : []),
        radiusAttr(80, Buffer.alloc(16)), // Message-Authenticator, filled in below (servers patched against BlastRADIUS insist on it)
      ];
      const body = Buffer.concat(attrs);
      const pkt = Buffer.concat([Buffer.from([1, id, 0, 0]), ra, body]);
      pkt.writeUInt16BE(pkt.length, 2);
      createHmac('md5', secret).update(pkt).digest().copy(pkt, pkt.length - 16);
      const t0 = process.hrtime.bigint();
      const r = await udpRequest(addr, c.port ?? 1812, pkt, ctx.timeoutMs, 'RADIUS', ctx.signal);
      const ms = hrMs(t0);
      const len = r.length >= 20 ? r.readUInt16BE(2) : 0;
      if (len < 20 || len > r.length || r[1] !== id) return fail('protocol', 'Not a RADIUS reply to this request', { latencyMs: Math.round(ms) });
      if (!md5(r.subarray(0, 4), ra, r.subarray(20, len), secret).equals(r.subarray(4, 20))) return fail('auth', 'RADIUS reply failed verification: the shared secret is probably wrong', { latencyMs: Math.round(ms) });
      let reason = '';
      for (let p = 20; p + 2 <= len && r[p + 1] >= 2; p += r[p + 1]) if (r[p] === 18) reason = r.toString('utf8', p + 2, p + r[p + 1]);
      if (r[0] === 2) return ok(ms, { message: 'Access-Accept' });
      if (r[0] === 11) return ok(ms, { message: 'Access-Challenge (the credentials were accepted, a second step is required)' });
      if (r[0] === 3) {
        const msg = `Access-Reject${reason ? `: ${reason}` : ''}`;
        return c.rejectIsUp ? ok(ms, { message: `${msg} (counted as up)` }) : fail('auth', msg, { latencyMs: Math.round(ms) });
      }
      return fail('protocol', `Unexpected RADIUS code ${r[0]}`, { latencyMs: Math.round(ms) });
    } catch (e) { return failure(e); }
  },
};

/* -------------------------------------- FTP ------------------------------------- */
const ftpReply = (conn: Conn) => readUntil(conn.sock, (b) => /(^|\n)\d{3} [^\n]*\n$/.test(b));

const ftp: Runner = {
  type: 'ftp', label: 'FTP / FTPS', category: 'Network',
  fields: [
    ...hostPort(21),
    { key: 'security', label: 'Security', kind: 'select', options: [{ value: 'none', label: 'None' }, { value: 'starttls', label: 'Explicit TLS (AUTH TLS)' }, { value: 'implicit', label: 'Implicit TLS (FTPS)' }], default: 'none' },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
    { key: 'username', label: 'Username (optional login test)', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'secret' },
    { key: 'path', label: 'Directory that must exist (optional)', kind: 'text', placeholder: '/incoming' },
    { key: 'tlsExpiryDays', label: 'Fail when certificate expires within (days, 0 = off)', kind: 'number', default: 0, min: 0, max: 365 },
  ],
  async run(ctx) {
    const c = ctx.config;
    const t0 = process.hrtime.bigint();
    try {
      let conn = await connect({ host: c.host, port: c.port ?? 21, signal: ctx.signal, guard: ctx.guard, tls: c.security === 'implicit' ? { verify: c.verifyTls !== false } : false });
      try {
        const banner = await ftpReply(conn);
        if (!banner.startsWith('220')) return fail('protocol', `Unexpected FTP greeting: ${banner.trim().slice(0, 80)}`);
        const send = async (cmd: string) => { conn.sock.write(cmd + '\r\n'); return ftpReply(conn); };
        if (c.security === 'starttls') {
          const r = await send('AUTH TLS');
          if (!r.startsWith('234')) return fail('protocol', `Server refused AUTH TLS: ${r.trim().slice(0, 80)}`);
          conn = await upgradeTls(conn, c.host, c.verifyTls !== false, ctx.signal);
        }
        if (c.username) {
          let r = await send(`USER ${c.username}`);
          if (r.startsWith('331')) r = await send(`PASS ${c.password ?? ''}`);
          if (!r.startsWith('230')) return fail('auth', `Login rejected: ${r.trim().slice(0, 80)}`);
        }
        if (c.path) {
          if (!c.username) return fail('config', 'A directory check needs a username');
          const r = await send(`CWD ${c.path}`);
          if (!r.startsWith('250')) return fail('content', `Directory ${c.path} is not available: ${r.trim().slice(0, 80)}`);
        }
        conn.sock.write('QUIT\r\n');
        const bad = certExpiryError(conn.cert, c.tlsExpiryDays);
        if (bad) return fail(bad.kind, bad.message, { cert: conn.cert });
        return ok(hrMs(t0), { message: banner.trim().split(/\r?\n/).pop()!.slice(4), cert: conn.cert });
      } finally { conn.close(); }
    } catch (e) { return failure(e); }
  },
};

/* -------------------------------------- RDP ------------------------------------- */
const rdp: Runner = {
  type: 'rdp', label: 'Remote Desktop (RDP)', category: 'Network',
  fields: hostPort(3389),
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      const conn = await connect({ host: c.host, port: c.port ?? 3389, signal: ctx.signal, guard: ctx.guard });
      try {
        // TPKT + X.224 Connection Request carrying an RDP negotiation request (TLS and CredSSP allowed)
        conn.sock.write(Buffer.from('03000013' + '0ee00000000000' + '01000800' + '03000000', 'hex'));
        const reply = Buffer.from(await readUntil(conn.sock, (b) => b.length >= 11), 'latin1');
        if (reply[0] !== 3 || reply[5] >> 4 !== 0xd) return fail('protocol', 'Not an RDP server (no X.224 Connection Confirm)');
        return ok(hrMs(t0), { message: 'RDP server answered the connection request' });
      } finally { conn.close(); }
    } catch (e) { return failure(e); }
  },
};

/* -------------------------------------- SIP ------------------------------------- */
const sip: Runner = {
  type: 'sip', label: 'SIP (OPTIONS)', category: 'Application',
  fields: [
    ...hostPort(5060),
    { key: 'transport', label: 'Transport', kind: 'select', options: [{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }], default: 'udp' },
    { key: 'expectedStatus', label: 'Expected status codes', kind: 'codes', default: '200-299,401,407', help: 'A PBX that demands authentication even for OPTIONS answers 401 or 407, which still proves it is alive.' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const port = c.port ?? 5060;
      const tcp = c.transport === 'tcp';
      const callId = randomBytes(8).toString('hex');
      const host = String(c.host).includes(':') ? `[${c.host}]` : c.host;
      const msg = Buffer.from([
        `OPTIONS sip:${host}:${port} SIP/2.0`,
        `Via: SIP/2.0/${tcp ? 'TCP' : 'UDP'} pulsewatch.invalid;branch=z9hG4bK${randomBytes(6).toString('hex')};rport`,
        'Max-Forwards: 70',
        `From: <sip:monitor@pulsewatch.invalid>;tag=${randomBytes(4).toString('hex')}`,
        `To: <sip:${host}>`,
        `Call-ID: ${callId}@pulsewatch.invalid`,
        'CSeq: 1 OPTIONS',
        'Contact: <sip:monitor@pulsewatch.invalid>',
        'Accept: application/sdp',
        'Content-Length: 0', '', '',
      ].join('\r\n'));
      const t0 = process.hrtime.bigint();
      let text: string;
      if (tcp) {
        const conn = await connect({ host: c.host, port, signal: ctx.signal, guard: ctx.guard });
        try { conn.sock.write(msg); text = await readUntil(conn.sock, (b) => b.includes('\r\n\r\n')); } finally { conn.close(); }
      } else {
        text = (await udpRequest((await ctx.guard.resolve(c.host))[0], port, msg, ctx.timeoutMs, 'SIP', ctx.signal)).toString('latin1');
      }
      const ms = hrMs(t0);
      const m = /^SIP\/2\.0 (\d{3})[ \t]*([^\r\n]*)/.exec(text);
      if (!m || !text.includes(callId)) return fail('protocol', 'Not a SIP reply to this request', { latencyMs: Math.round(ms) });
      const server = /^(?:Server|User-Agent):[ \t]*([^\r\n]+)/im.exec(text)?.[1];
      if (!statusMatcher(c.expectedStatus ?? '200-299,401,407')(Number(m[1]))) return fail('http_status', `SIP answered ${m[1]} ${m[2]}`, { latencyMs: Math.round(ms) });
      return ok(ms, { message: `${m[1]} ${m[2]}${server ? ` (${server})` : ''}`, details: { status: Number(m[1]), server } });
    } catch (e) { return failure(e); }
  },
};

/* ------------------------------------- LDAP ------------------------------------- */
const ldap: Runner = {
  type: 'ldap', label: 'LDAP directory', category: 'Identity',
  fields: [
    { key: 'url', label: 'Server URL', kind: 'text', required: true, placeholder: 'ldaps://ldap.example.com:636', help: 'ldap://host:389 or ldaps://host:636' },
    { key: 'startTls', label: 'Upgrade with STARTTLS', kind: 'bool', default: false },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
    { key: 'bindDn', label: 'Bind DN (blank = anonymous)', kind: 'text', placeholder: 'cn=monitor,dc=example,dc=com' },
    { key: 'bindPassword', label: 'Bind password', kind: 'secret' },
    { key: 'baseDn', label: 'Search base (blank = read the root DSE)', kind: 'text', placeholder: 'dc=example,dc=com' },
    { key: 'filter', label: 'Search filter', kind: 'text', default: '(objectClass=*)' },
    { key: 'minEntries', label: 'Minimum number of entries', kind: 'number', default: 1, min: 0, max: 100000 },
  ],
  async run(ctx) {
    const c = ctx.config;
    let client: Client | undefined;
    try {
      const u = new URL(c.url);
      if (u.protocol !== 'ldap:' && u.protocol !== 'ldaps:') return fail('config', 'The URL must start with ldap:// or ldaps://');
      const name = u.hostname.replace(/^\[|\]$/g, '');
      const addr = (await ctx.guard.resolve(name))[0].address; // connect to the vetted address, not to whatever the name resolves to later
      u.hostname = addr.includes(':') ? `[${addr}]` : addr;
      const tlsOptions = { servername: /^[\d.:]+$/.test(name) ? undefined : name, rejectUnauthorized: c.verifyTls !== false, ...trustOptions() };
      // ldapts switches a plain ldap:// connection to TLS as soon as any TLS option is set, so only ldaps:// gets them up front
      client = new Client({ url: u.toString().replace(/\/$/, ''), tlsOptions: u.protocol === 'ldaps:' ? tlsOptions : undefined, connectTimeout: ctx.timeoutMs, timeout: ctx.timeoutMs });
      const stop = () => { client?.unbind().catch(() => {}); };
      ctx.signal.addEventListener('abort', stop, { once: true });
      const t0 = process.hrtime.bigint();
      if (c.startTls) await client.startTLS(tlsOptions);
      if (c.bindDn) await client.bind(c.bindDn, c.bindPassword ?? '');
      const want = Math.max(1, c.minEntries ?? 1);
      let found = 0;
      if (c.baseDn) {
        // the size limit keeps a search over a huge directory cheap; "size limit exceeded" then means there are at least `want` entries
        try { found = (await client.search(c.baseDn, { scope: 'sub', filter: c.filter || '(objectClass=*)', sizeLimit: want })).searchEntries.length; } catch (e) {
          if ((e as { name?: string }).name !== 'SizeLimitExceededError') throw e;
          found = want;
        }
      } else found = (await client.search('', { scope: 'base', filter: '(objectClass=*)' })).searchEntries.length;
      const ms = hrMs(t0);
      if (c.baseDn && found < (c.minEntries ?? 1)) return fail('content', `Search returned ${found} entries, expected at least ${c.minEntries ?? 1}`, { latencyMs: Math.round(ms) });
      return ok(ms, { message: c.baseDn ? `Search found ${found >= want && want > 1 ? 'at least ' : ''}${found} entr${found === 1 ? 'y' : 'ies'}` : c.bindDn ? 'Bind and root DSE query succeeded' : 'Root DSE query succeeded' });
    } catch (e) {
      const err = e as { name?: string; code?: number; message?: string };
      if (err?.name === 'InvalidCredentialsError' || err?.code === 49) return fail('auth', `Bind rejected: ${err.message}`);
      if (err?.name === 'InsufficientAccessRightsError' || err?.code === 50) return fail('auth', `Access denied: ${err.message}`);
      return failure(e);
    } finally { await client?.unbind().catch(() => {}); }
  },
};

/* ------------------------------------- Kafka ------------------------------------ */
/** Reads one length-prefixed Kafka response frame. */
function kafkaFrame(conn: Conn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => { conn.sock.off('data', onData); conn.sock.off('close', onClose); conn.sock.off('error', reject); };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.readInt32BE(0) > 1 << 20) { cleanup(); return reject(new CheckError('protocol', 'Kafka reply too large')); }
      if (buf.length >= 4 && buf.length >= 4 + buf.readInt32BE(0)) { cleanup(); resolve(buf.subarray(4, 4 + buf.readInt32BE(0))); }
    };
    const onClose = () => { cleanup(); reject(new CheckError('protocol', 'Broker closed the connection (it may require SASL, which is not supported)')); };
    conn.sock.on('data', onData); conn.sock.on('close', onClose); conn.sock.on('error', reject);
  });
}

class Cursor {
  constructor(public b: Buffer, public p = 0) {}
  i16() { const v = this.b.readInt16BE(this.p); this.p += 2; return v; }
  i32() { const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  str() { const n = this.i16(); if (n < 0) return null; const s = this.b.toString('utf8', this.p, this.p + n); this.p += n; return s; }
  skip(n: number) { if (this.p + n > this.b.length) throw new RangeError('short'); this.p += n; }
  list<T>(fn: () => T): T[] { const n = this.i32(); if (n < 0 || n > 100_000) throw new RangeError('bad array'); return Array.from({ length: n }, fn); }
}

const KAFKA_ERRORS: Record<number, string> = { 3: 'UNKNOWN_TOPIC_OR_PARTITION', 5: 'LEADER_NOT_AVAILABLE', 6: 'NOT_LEADER_OR_FOLLOWER', 29: 'TOPIC_AUTHORIZATION_FAILED' };

async function kafkaCall(conn: Conn, apiKey: number, version: number, body: Buffer): Promise<Cursor> {
  const id = randomBytes(2).readUInt16BE(0);
  const client = Buffer.from('pulsewatch');
  const head = Buffer.alloc(10);
  head.writeInt16BE(apiKey, 0); head.writeInt16BE(version, 2); head.writeInt32BE(id, 4); head.writeInt16BE(client.length, 8);
  const msg = Buffer.concat([head, client, body]);
  const len = Buffer.alloc(4);
  len.writeInt32BE(msg.length);
  const reply = kafkaFrame(conn);
  conn.sock.write(Buffer.concat([len, msg]));
  const cur = new Cursor(await reply);
  try { if (cur.i32() !== id) throw new CheckError('protocol', 'Kafka reply has the wrong correlation id'); } catch (e) { if (e instanceof RangeError) throw new CheckError('protocol', 'Truncated Kafka reply'); throw e; }
  return cur;
}

/** ApiVersions proves the peer speaks Kafka; Metadata (v4 is the oldest version Kafka 4 still accepts) vets the topic. */
async function kafkaBroker(host: string, port: number, topic: string | undefined, o: { tls: boolean; verify: boolean }, ctx: Parameters<Runner['run']>[0]): Promise<string> {
  const conn = await connect({ host, port, signal: ctx.signal, guard: ctx.guard, tls: o.tls ? { verify: o.verify } : false });
  try {
    const av = await kafkaCall(conn, 18, 0, Buffer.alloc(0));
    const err = av.i16();
    if (err !== 0) throw new CheckError('protocol', `Broker rejected the version probe (error ${err})`);
    if (!topic) return 'broker answered';
    const t = Buffer.from(topic);
    const body = Buffer.concat([Buffer.from([0, 0, 0, 1, t.length >> 8, t.length & 255]), t, Buffer.from([0])]); // one topic, no auto-creation
    const md = await kafkaCall(conn, 3, 4, body);
    md.skip(4); // throttle time
    md.list(() => { md.i32(); md.str(); md.i32(); md.str(); }); // brokers: id, host, port, rack
    md.str(); md.i32(); // cluster id, controller id
    const topics = md.list(() => {
      const code = md.i16(); const name = md.str(); md.skip(1); // is_internal
      const parts = md.list(() => { const pe = md.i16(); md.i32(); const leader = md.i32(); md.list(() => md.i32()); md.list(() => md.i32()); return { pe, leader }; });
      return { code, name, parts };
    });
    const found = topics.find((x) => x.name === topic);
    if (!found) throw new CheckError('protocol', 'Broker did not describe the topic');
    if (found.code !== 0) throw new CheckError('content', `Topic ${topic}: ${KAFKA_ERRORS[found.code] ?? `error ${found.code}`}`);
    const leaderless = found.parts.filter((x) => x.leader < 0).length;
    if (leaderless) throw new CheckError('content', `Topic ${topic}: ${leaderless} of ${found.parts.length} partitions have no leader`);
    return `topic ${topic} has ${found.parts.length} partitions, all with a leader`;
  } catch (e) {
    if (e instanceof RangeError) throw new CheckError('protocol', 'Truncated Kafka reply');
    throw e;
  } finally { conn.close(); }
}

const kafka: Runner = {
  type: 'kafka', label: 'Kafka broker', category: 'Application',
  fields: [
    { key: 'brokers', label: 'Brokers', kind: 'text', required: true, placeholder: 'kafka1:9092,kafka2:9092', help: 'Comma separated host:port list. PulseWatch asks the brokers (no message is produced); SASL is not supported.' },
    { key: 'topic', label: 'Topic that must exist and have leaders (optional)', kind: 'text' },
    { key: 'tls', label: 'Use TLS', kind: 'bool', default: false },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true, showIf: { key: 'tls', equals: true } },
    { key: 'requireAll', label: 'Fail when any listed broker is down', kind: 'bool', default: false },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const list = String(c.brokers).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d{1,5}))?$/.exec(s);
        if (!m) throw new CheckError('config', `Invalid broker address "${s}"`);
        return { host: m[1] ?? m[2], port: Number(m[3] ?? 9092) };
      });
      if (!list.length) return fail('config', 'No broker configured');
      const t0 = process.hrtime.bigint();
      const results = await Promise.allSettled(list.map((b) => kafkaBroker(b.host, b.port, c.topic, { tls: !!c.tls, verify: c.verifyTls !== false }, ctx)));
      const ms = hrMs(t0);
      const good = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const bad = results.flatMap((r, i) => (r.status === 'rejected' ? [{ who: `${list[i].host}:${list[i].port}`, e: toCheckError(r.reason) }] : []));
      const down = bad.map((x) => `${x.who} (${x.e.message})`);
      if (!good.length) return fail(bad.every((x) => x.e.kind === bad[0].e.kind) ? bad[0].e.kind : 'network', bad[0].e.kind === 'content' ? bad[0].e.message : `No broker answered: ${down.join('; ')}`, { latencyMs: Math.round(ms), details: { down } });
      if (c.requireAll && bad.length) return fail('network', `${bad.length} of ${list.length} brokers down: ${down.join('; ')}`, { latencyMs: Math.round(ms), details: { down } });
      return ok(ms, { message: `${good.length}/${list.length} brokers up, ${good[0]}`, details: { down } });
    } catch (e) { return failure(e); }
  },
};

/* ------------------------------------ RabbitMQ ---------------------------------- */
const rabbitmq: Runner = {
  type: 'rabbitmq', label: 'RabbitMQ', category: 'Application',
  fields: [
    { key: 'url', label: 'Management URL', kind: 'text', required: true, placeholder: 'http://rabbit.example.com:15672', help: 'Needs the management plugin. Checks that the node reports no alarms (memory, disk).' },
    { key: 'username', label: 'Username', kind: 'text', required: true },
    { key: 'password', label: 'Password', kind: 'secret', required: true },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const res = await httpRequest({
        url: `${String(c.url).replace(/\/+$/, '')}/api/health/checks/alarms`, signal: ctx.signal, guard: ctx.guard, verifyTls: c.verifyTls !== false,
        headers: { authorization: 'Basic ' + Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64'), accept: 'application/json' },
      });
      const ms = res.timings.total;
      if (res.status === 401 || res.status === 403) return fail('auth', `RabbitMQ refused the login (HTTP ${res.status})`, { latencyMs: Math.round(ms) });
      let body: { status?: string; reason?: string } = {};
      try { body = JSON.parse(res.body); } catch { /* not JSON, reported below */ }
      if (res.status !== 200) return fail(res.status === 503 ? 'content' : 'http_status', `RabbitMQ reports a problem: ${body.reason ?? `HTTP ${res.status}`}`, { latencyMs: Math.round(ms) });
      if (body.status !== 'ok') return fail('content', `Unexpected RabbitMQ answer: ${res.body.slice(0, 120)}`, { latencyMs: Math.round(ms) });
      return ok(ms, { message: 'No alarms in effect', cert: res.cert });
    } catch (e) { return failure(e); }
  },
};

export const serviceRunners: Runner[] = [ntp, radius, ftp, rdp, sip, ldap, kafka, rabbitmq];
