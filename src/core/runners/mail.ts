import { connect, upgradeTls, type Conn } from '../conn';
import type { FieldDef, Runner } from '../types';
import { certExpiryError, fail, hrMs, ok, readUntil, toCheckError } from '../util';

const modes = [{ value: 'none', label: 'None' }, { value: 'starttls', label: 'STARTTLS' }, { value: 'implicit', label: 'Implicit TLS (SSL)' }];

function mailFields(port: number): FieldDef[] {
  return [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'port', label: 'Port', kind: 'number', default: port, min: 1, max: 65535 },
    { key: 'security', label: 'Security', kind: 'select', options: modes, default: 'none' },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
    { key: 'username', label: 'Username (optional login test)', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'secret' },
    { key: 'tlsExpiryDays', label: 'Fail when certificate expires within (days, 0 = off)', kind: 'number', default: 0, min: 0, max: 365 },
  ];
}

/** Read a complete (possibly multi-line) SMTP reply and return it. */
const smtpReply = (conn: Conn) => readUntil(conn.sock, (b) => /(^|\r?\n)\d{3} [^\r\n]*\r?\n$/.test(b) || /^\d{3} [^\r\n]*\r?\n$/.test(b));
const lineReply = (conn: Conn) => readUntil(conn.sock, (b) => b.endsWith('\n'));

const smtp: Runner = {
  type: 'smtp', label: 'SMTP', category: 'Mail',
  fields: mailFields(25),
  async run(ctx) {
    const c = ctx.config;
    const t0 = process.hrtime.bigint();
    try {
      let conn = await connect({ host: c.host, port: c.port, signal: ctx.signal, guard: ctx.guard, tls: c.security === 'implicit' ? { verify: c.verifyTls !== false } : false });
      try {
        const banner = await smtpReply(conn);
        if (!banner.startsWith('220')) return fail('protocol', `Unexpected SMTP banner: ${banner.trim().slice(0, 80)}`);
        const send = async (cmd: string) => { conn.sock.write(cmd + '\r\n'); return smtpReply(conn); };
        let ehlo = await send('EHLO pulsewatch.local');
        if (!ehlo.startsWith('250')) return fail('protocol', `EHLO rejected: ${ehlo.trim().slice(0, 80)}`);
        if (c.security === 'starttls') {
          if (!/STARTTLS/i.test(ehlo)) return fail('protocol', 'Server does not offer STARTTLS');
          const r = await send('STARTTLS');
          if (!r.startsWith('220')) return fail('protocol', `STARTTLS refused: ${r.trim().slice(0, 80)}`);
          conn = await upgradeTls(conn, c.host, c.verifyTls !== false, ctx.signal);
          ehlo = await send('EHLO pulsewatch.local');
        }
        if (c.username) {
          const r1 = await send('AUTH LOGIN');
          if (!r1.startsWith('334')) return fail('protocol', `AUTH LOGIN not accepted: ${r1.trim().slice(0, 80)}`);
          const r2 = await send(Buffer.from(c.username).toString('base64'));
          if (!r2.startsWith('334')) return fail('auth', `Login rejected: ${r2.trim().slice(0, 80)}`);
          const r3 = await send(Buffer.from(c.password ?? '').toString('base64'));
          if (!r3.startsWith('235')) return fail('auth', `Login rejected: ${r3.trim().slice(0, 80)}`);
        }
        conn.sock.write('QUIT\r\n');
        const bad = certExpiryError(conn.cert, c.tlsExpiryDays);
        if (bad) return fail(bad.kind, bad.message, { cert: conn.cert });
        return ok(hrMs(t0), { message: banner.split(/\r?\n/)[0].slice(4), cert: conn.cert });
      } finally { conn.close(); }
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
  },
};

const imap: Runner = {
  type: 'imap', label: 'IMAP', category: 'Mail',
  fields: mailFields(143),
  async run(ctx) {
    const c = ctx.config;
    const t0 = process.hrtime.bigint();
    try {
      let conn = await connect({ host: c.host, port: c.port, signal: ctx.signal, guard: ctx.guard, tls: c.security === 'implicit' ? { verify: c.verifyTls !== false } : false });
      try {
        const banner = await lineReply(conn);
        if (!/^\* (OK|PREAUTH)/i.test(banner)) return fail('protocol', `Unexpected IMAP banner: ${banner.trim().slice(0, 80)}`);
        let n = 0;
        const cmd = async (text: string) => {
          const tag = `a${++n}`;
          conn.sock.write(`${tag} ${text}\r\n`);
          return readUntil(conn.sock, (b) => new RegExp(`(^|\\n)${tag} (OK|NO|BAD)`).test(b));
        };
        if (c.security === 'starttls') {
          const r = await cmd('STARTTLS');
          if (!/ OK/i.test(r)) return fail('protocol', 'STARTTLS refused');
          conn = await upgradeTls(conn, c.host, c.verifyTls !== false, ctx.signal);
        }
        if (c.username) {
          const r = await cmd(`LOGIN "${String(c.username).replace(/["\\]/g, '\\$&')}" "${String(c.password ?? '').replace(/["\\]/g, '\\$&')}"`);
          if (!/a\d+ OK/i.test(r)) return fail('auth', 'Login rejected');
        }
        conn.sock.write('a99 LOGOUT\r\n');
        const bad = certExpiryError(conn.cert, c.tlsExpiryDays);
        if (bad) return fail(bad.kind, bad.message, { cert: conn.cert });
        return ok(hrMs(t0), { message: banner.trim().slice(0, 100), cert: conn.cert });
      } finally { conn.close(); }
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
  },
};

const pop3: Runner = {
  type: 'pop3', label: 'POP3', category: 'Mail',
  fields: mailFields(110),
  async run(ctx) {
    const c = ctx.config;
    const t0 = process.hrtime.bigint();
    try {
      let conn = await connect({ host: c.host, port: c.port, signal: ctx.signal, guard: ctx.guard, tls: c.security === 'implicit' ? { verify: c.verifyTls !== false } : false });
      try {
        const banner = await lineReply(conn);
        if (!banner.startsWith('+OK')) return fail('protocol', `Unexpected POP3 banner: ${banner.trim().slice(0, 80)}`);
        const cmd = async (text: string) => { conn.sock.write(text + '\r\n'); return lineReply(conn); };
        if (c.security === 'starttls') {
          const r = await cmd('STLS');
          if (!r.startsWith('+OK')) return fail('protocol', 'STLS refused');
          conn = await upgradeTls(conn, c.host, c.verifyTls !== false, ctx.signal);
        }
        if (c.username) {
          const u = await cmd(`USER ${c.username}`);
          if (!u.startsWith('+OK')) return fail('auth', 'User rejected');
          const p = await cmd(`PASS ${c.password ?? ''}`);
          if (!p.startsWith('+OK')) return fail('auth', 'Login rejected');
        }
        conn.sock.write('QUIT\r\n');
        const bad = certExpiryError(conn.cert, c.tlsExpiryDays);
        if (bad) return fail(bad.kind, bad.message, { cert: conn.cert });
        return ok(hrMs(t0), { message: banner.trim().slice(0, 100), cert: conn.cert });
      } finally { conn.close(); }
    } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
  },
};

export const mailRunners: Runner[] = [smtp, imap, pop3];
