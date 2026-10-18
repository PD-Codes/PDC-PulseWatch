import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import tls from 'node:tls';
import { connect } from '../conn';
import { CheckError, type CheckResult, type Runner } from '../types';
import { certExpiryError, fail, hrMs, ok, readUntil, toCheckError } from '../util';

const hostPort = (defPort?: number) => [
  { key: 'host', label: 'Host', kind: 'text' as const, required: true, placeholder: 'example.com' },
  { key: 'port', label: 'Port', kind: 'number' as const, required: defPort === undefined, default: defPort, min: 1, max: 65535 },
];

const tcp: Runner = {
  type: 'tcp', label: 'TCP port', category: 'Network',
  fields: [
    ...hostPort(),
    { key: 'send', label: 'Send after connect (optional)', kind: 'textarea' },
    { key: 'expect', label: 'Expect in response (optional)', kind: 'text' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      const conn = await connect({ host: c.host, port: c.port, signal: ctx.signal, guard: ctx.guard });
      try {
        if (c.send) conn.sock.write(c.send.replace(/\\r/g, '\r').replace(/\\n/g, '\n'));
        if (c.expect) {
          const data = await readUntil(conn.sock, (b) => b.includes(c.expect));
          return ok(hrMs(t0), { message: `Port open, response matched (${data.length} bytes)` });
        }
        return ok(conn.connectMs, { message: `Port ${c.port} open` });
      } finally { conn.close(); }
    } catch (e) {
      const ce = toCheckError(e);
      return fail(ce.kind === 'protocol' ? 'content' : ce.kind, ce.message, { details: ce.details });
    }
  },
};

const udp: Runner = {
  type: 'udp', label: 'UDP port', category: 'Network',
  fields: [
    ...hostPort(),
    { key: 'payload', label: 'Payload', kind: 'text', help: 'Plain text, or hex with a 0x prefix' },
    { key: 'expectResponse', label: 'Require a response', kind: 'bool', default: true, help: 'UDP is connectionless: without a response only ICMP "port unreachable" can be detected.' },
    { key: 'expect', label: 'Response must contain (optional)', kind: 'text' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0];
      const payload = String(c.payload ?? '').startsWith('0x') ? Buffer.from(c.payload.slice(2), 'hex') : Buffer.from(c.payload ?? '');
      const t0 = process.hrtime.bigint();
      return await new Promise<CheckResult>((resolve) => {
        const s = dgram.createSocket(addr.family === 6 ? 'udp6' : 'udp4');
        const done = (r: CheckResult) => { clearTimeout(timer); s.close(); resolve(r); };
        const wait = c.expectResponse === false ? Math.min(ctx.timeoutMs, 1500) : ctx.timeoutMs;
        const timer = setTimeout(() => done(c.expectResponse === false ? ok(hrMs(t0), { message: 'No ICMP error received' }) : fail('timeout', 'No UDP response', { details: { phase: 'response' } })), wait);
        ctx.signal.addEventListener('abort', () => done(fail('timeout', 'Aborted')), { once: true });
        s.on('error', (e) => done((() => { const ce = toCheckError(e); return fail(ce.kind, ce.message); })()));
        s.on('message', (m) => {
          if (c.expect && !m.toString('latin1').includes(c.expect)) return done(fail('content', 'Response did not contain the expected text'));
          done(ok(hrMs(t0), { message: `Response received (${m.length} bytes)` }));
        });
        s.connect(c.port, addr.address, () => s.send(payload));
      });
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message); }
  },
};

const ping: Runner = {
  type: 'ping', label: 'ICMP ping', category: 'Network',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'count', label: 'Packets', kind: 'number', default: 1, min: 1, max: 10 },
    { key: 'maxLoss', label: 'Max packet loss (%)', kind: 'number', default: 0, min: 0, max: 99 },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const ip = (await ctx.guard.resolve(c.host))[0].address;
      const count = c.count ?? 1;
      const args = ['-c', String(count), '-W', String(Math.max(1, Math.ceil(ctx.timeoutMs / 1000 / count))), ip];
      const out = await new Promise<string>((resolve, reject) => {
        execFile('ping', args, { timeout: ctx.timeoutMs + 1000, signal: ctx.signal }, (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new CheckError('config', 'ping binary is not installed'));
          if (err && (err as any).name === 'AbortError') return reject(err);
          resolve(stdout + stderr);
        });
      });
      const times = [...out.matchAll(/time[=<]\s*([\d.]+)\s*ms/g)].map((m) => parseFloat(m[1]));
      const loss = /(\d+(?:\.\d+)?)% packet loss/.exec(out);
      const lossPct = loss ? parseFloat(loss[1]) : times.length ? (1 - times.length / count) * 100 : 100;
      if (/operation not permitted|permission denied/i.test(out)) return fail('config', 'ping is not permitted (needs CAP_NET_RAW or ping_group_range)');
      if (!times.length) return fail('timeout', `No ICMP reply from ${c.host}`, { details: { phase: 'response' } });
      if (lossPct > (c.maxLoss ?? 0)) return fail('network', `Packet loss ${lossPct}% exceeds ${c.maxLoss ?? 0}%`, { latencyMs: Math.round(times.reduce((a, b) => a + b) / times.length) });
      return ok(times.reduce((a, b) => a + b) / times.length, { message: `${times.length}/${count} replies`, details: { lossPct } });
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
  },
};

const RTYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'PTR', 'CAA'];
const dnsRunner: Runner = {
  type: 'dns', label: 'DNS record', category: 'Network',
  fields: [
    { key: 'host', label: 'Name', kind: 'text', required: true, placeholder: 'example.com' },
    { key: 'recordType', label: 'Record type', kind: 'select', options: RTYPES.map((v) => ({ value: v, label: v })), default: 'A' },
    { key: 'resolver', label: 'Resolver IP (blank = system)', kind: 'text', placeholder: '1.1.1.1' },
    { key: 'matchMode', label: 'Match', kind: 'select', options: [{ value: 'any', label: 'Any answer' }, { value: 'contains', label: 'An answer contains' }, { value: 'equals', label: 'An answer equals' }, { value: 'regex', label: 'An answer matches regex' }], default: 'any' },
    { key: 'expected', label: 'Expected value', kind: 'text', showIf: { key: 'matchMode', equals: 'any' } },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const r = new dns.promises.Resolver({ timeout: ctx.timeoutMs, tries: 1 });
      if (c.resolver) { ctx.guard.assertAddress(c.resolver); r.setServers([c.resolver]); }
      const t0 = process.hrtime.bigint();
      let answers: string[];
      const t = (c.recordType ?? 'A') as string;
      const flat = (x: unknown): string[] => (Array.isArray(x) ? x : [x]).map((v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join('') : Object.values(v as object).join(' ')));
      switch (t) {
        case 'A': answers = await r.resolve4(c.host); break;
        case 'AAAA': answers = await r.resolve6(c.host); break;
        case 'CNAME': answers = await r.resolveCname(c.host); break;
        case 'MX': answers = (await r.resolveMx(c.host)).map((m) => `${m.priority} ${m.exchange}`); break;
        case 'TXT': answers = (await r.resolveTxt(c.host)).map((x) => x.join('')); break;
        case 'NS': answers = await r.resolveNs(c.host); break;
        case 'SOA': answers = flat(await r.resolveSoa(c.host)); break;
        case 'SRV': answers = (await r.resolveSrv(c.host)).map((s) => `${s.priority} ${s.weight} ${s.port} ${s.name}`); break;
        case 'PTR': answers = await r.resolvePtr(c.host); break;
        default: answers = (await r.resolveCaa(c.host)).map((x) => JSON.stringify(x));
      }
      const ms = hrMs(t0);
      const mode = c.matchMode ?? 'any';
      const exp = String(c.expected ?? '');
      const match = (a: string) => (mode === 'equals' ? a === exp : mode === 'contains' ? a.includes(exp) : new RegExp(exp).test(a));
      if (mode !== 'any' && exp && !answers.some(match)) return fail('content', `No ${t} answer ${mode === 'equals' ? 'equals' : mode === 'contains' ? 'contains' : 'matches'} "${exp}" (got ${answers.join(', ')})`, { latencyMs: Math.round(ms), details: { answers } });
      return ok(ms, { message: answers.slice(0, 3).join(', '), details: { answers } });
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
  },
};

const tlsRunner: Runner = {
  type: 'tls', label: 'TLS certificate', category: 'Security',
  fields: [
    ...hostPort(443),
    { key: 'servername', label: 'SNI server name (optional)', kind: 'text' },
    { key: 'warnDays', label: 'Fail when expiring within (days)', kind: 'number', default: 14, min: 0, max: 365 },
    { key: 'verify', label: 'Require a trusted chain and matching name', kind: 'bool', default: true },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const sni = c.servername || c.host;
      const conn = await connect({ host: c.host, port: c.port ?? 443, signal: ctx.signal, guard: ctx.guard, tls: { verify: false, servername: sni } });
      try {
        const cert = conn.cert;
        const total = conn.connectMs + (conn.tlsMs ?? 0);
        if (!cert) return fail('tls', 'Peer sent no certificate');
        if (c.verify !== false) {
          if (!cert.authorized) return fail('tls', `Certificate not trusted: ${cert.authError}`, { cert, latencyMs: Math.round(total) });
          const id = tls.checkServerIdentity(sni, (conn.sock as tls.TLSSocket).getPeerCertificate());
          if (id) return fail('tls', `Certificate does not match ${sni}`, { cert, latencyMs: Math.round(total) });
        }
        const bad = certExpiryError(cert, c.warnDays);
        if (bad) return fail(bad.kind, bad.message, { cert, latencyMs: Math.round(total) });
        return ok(total, { message: `Valid for ${cert.daysLeft} more day(s), issued by ${cert.issuer}`, cert });
      } finally { conn.close(); }
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
  },
};

const EXPIRY_RE = /(?:registry expiry date|registrar registration expiration date|expiry date|expiration date|expire[sd]?(?: on)?|paid-till|renewal date)\s*[:.]\s*(.+)/i;

async function whoisQuery(server: string, query: string, ctx: Parameters<Runner['run']>[0]): Promise<string> {
  const conn = await connect({ host: server, port: 43, signal: ctx.signal, guard: ctx.guard });
  try {
    conn.sock.write(query + '\r\n');
    return await new Promise<string>((resolve, reject) => {
      let buf = '';
      conn.sock.on('data', (d) => { buf += d.toString('utf8'); if (buf.length > 200_000) conn.close(); });
      conn.sock.on('close', () => resolve(buf));
      conn.sock.on('error', reject);
    });
  } finally { conn.close(); }
}

const whois: Runner = {
  type: 'domain', label: 'Domain expiry (WHOIS)', category: 'Security',
  fields: [
    { key: 'domain', label: 'Domain', kind: 'text', required: true, placeholder: 'example.com' },
    { key: 'warnDays', label: 'Fail when expiring within (days)', kind: 'number', default: 30, min: 1, max: 730 },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      const iana = await whoisQuery('whois.iana.org', c.domain, ctx);
      const refer = /^(?:refer|whois):\s*(\S+)/im.exec(iana)?.[1];
      const text = refer ? await whoisQuery(refer, c.domain, ctx) : iana;
      const raw = EXPIRY_RE.exec(text)?.[1]?.trim();
      const when = raw ? new Date(raw.replace(/\s*\(.*\)$/, '')) : undefined;
      if (!when || Number.isNaN(when.getTime())) return fail('protocol', `WHOIS server ${refer ?? 'whois.iana.org'} did not publish an expiry date`);
      const days = Math.floor((when.getTime() - Date.now()) / 86_400_000);
      const details = { expires: when.toISOString(), daysLeft: days, server: refer };
      if (days < 0) return fail('tls_expiry', `Domain expired ${-days} day(s) ago`, { details, latencyMs: Math.round(hrMs(t0)) });
      if (days < (c.warnDays ?? 30)) return fail('tls_expiry', `Domain expires in ${days} day(s)`, { details, latencyMs: Math.round(hrMs(t0)) });
      return ok(hrMs(t0), { message: `Domain valid for ${days} more day(s)`, details });
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
  },
};

const ssh: Runner = {
  type: 'ssh', label: 'SSH banner', category: 'Network',
  fields: [...hostPort(22), { key: 'expect', label: 'Banner must contain (optional)', kind: 'text', placeholder: 'OpenSSH' }],
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      const conn = await connect({ host: c.host, port: c.port ?? 22, signal: ctx.signal, guard: ctx.guard });
      try {
        const banner = (await readUntil(conn.sock, (b) => b.includes('\n'))).split(/\r?\n/)[0];
        if (!banner.startsWith('SSH-')) return fail('protocol', `Not an SSH server (got "${banner.slice(0, 40)}")`);
        if (c.expect && !banner.includes(c.expect)) return fail('content', `Banner "${banner}" does not contain "${c.expect}"`);
        return ok(hrMs(t0), { message: banner, details: { banner } });
      } finally { conn.close(); }
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
  },
};

export const netRunners: Runner[] = [tcp, udp, ping, dnsRunner, tlsRunner, whois, ssh];
