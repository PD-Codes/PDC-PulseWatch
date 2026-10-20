import mysql from 'mysql2/promise';
import pg from 'pg';
import { Connection as Tedious, Request as TediousRequest } from 'tedious';
import { connect } from '../conn';
import { trustOptions } from '../trust';
import { CheckError, type FieldDef, type Runner } from '../types';
import { fail, hrMs, ok, readUntil, toCheckError } from '../util';

const wrap = (e: unknown) => { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); };

function dbFields(port: number, withQuery: boolean, defQuery = 'SELECT 1'): FieldDef[] {
  const f: FieldDef[] = [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'port', label: 'Port', kind: 'number', default: port, min: 1, max: 65535 },
    { key: 'database', label: 'Database', kind: 'text' },
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'secret' },
    { key: 'useTls', label: 'Use TLS', kind: 'bool', default: false },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true, showIf: { key: 'useTls', equals: true } },
  ];
  if (withQuery) f.push(
    { key: 'query', label: 'Query (use a read-only account)', kind: 'textarea', default: defQuery },
    { key: 'expected', label: 'Expected first value (optional)', kind: 'text' },
  );
  return f;
}

function compare(c: Record<string, any>, value: unknown) {
  if (c.expected === undefined || c.expected === '') return null;
  return String(value) === String(c.expected) ? null : fail('content', `Query returned ${JSON.stringify(value)}, expected ${JSON.stringify(c.expected)}`);
}

const mysqlRunner = (type: string, label: string): Runner => ({
  type, label, category: 'Database', fields: dbFields(3306, true),
  async run(ctx) {
    const c = ctx.config;
    let conn: mysql.Connection | undefined;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0].address;
      const t0 = process.hrtime.bigint();
      conn = await mysql.createConnection({
        host: addr, port: c.port, user: c.username, password: c.password, database: c.database || undefined, connectTimeout: ctx.timeoutMs,
        ssl: c.useTls ? ({ servername: c.host, rejectUnauthorized: c.verifyTls !== false, ...trustOptions() } as any) : undefined,
      });
      const [rows] = await conn.query({ sql: c.query || 'SELECT 1', timeout: ctx.timeoutMs, rowsAsArray: true });
      const first = Array.isArray(rows) && Array.isArray(rows[0]) ? (rows[0] as unknown[])[0] : undefined;
      const bad = compare(c, first);
      if (bad) return { ...bad, latencyMs: Math.round(hrMs(t0)) };
      return ok(hrMs(t0), { message: first === undefined ? 'Query OK' : `Query returned ${String(first).slice(0, 80)}` });
    } catch (e) {
      const code = (e as any)?.code;
      if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') return fail('auth', (e as Error).message);
      return wrap(e);
    } finally { conn?.destroy(); }
  },
});

const postgres: Runner = {
  type: 'postgres', label: 'PostgreSQL', category: 'Database', fields: dbFields(5432, true),
  async run(ctx) {
    const c = ctx.config;
    let client: pg.Client | undefined;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0].address;
      const t0 = process.hrtime.bigint();
      client = new pg.Client({
        host: addr, port: c.port, user: c.username, password: c.password, database: c.database || undefined,
        connectionTimeoutMillis: ctx.timeoutMs, query_timeout: ctx.timeoutMs,
        ssl: c.useTls ? { servername: c.host, rejectUnauthorized: c.verifyTls !== false, ...trustOptions() } : false,
      });
      client.on('error', () => {});
      await client.connect();
      const res = await client.query({ text: c.query || 'SELECT 1', rowMode: 'array' });
      const first = res.rows[0]?.[0];
      const bad = compare(c, first);
      if (bad) return { ...bad, latencyMs: Math.round(hrMs(t0)) };
      return ok(hrMs(t0), { message: first === undefined ? 'Query OK' : `Query returned ${String(first).slice(0, 80)}` });
    } catch (e) {
      const code = (e as any)?.code;
      if (code === '28P01' || code === '28000') return fail('auth', (e as Error).message);
      return wrap(e);
    } finally { await client?.end().catch(() => {}); }
  },
};

const mssql: Runner = {
  type: 'mssql', label: 'Microsoft SQL Server', category: 'Database', fields: dbFields(1433, true),
  async run(ctx) {
    const c = ctx.config;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0].address;
      const t0 = process.hrtime.bigint();
      const value = await new Promise<unknown>((resolve, reject) => {
        const conn = new Tedious({
          server: addr,
          authentication: { type: 'default', options: { userName: c.username, password: c.password } },
          options: { port: c.port, database: c.database || undefined, encrypt: !!c.useTls, trustServerCertificate: c.verifyTls === false, cryptoCredentialsDetails: trustOptions(), connectTimeout: ctx.timeoutMs, requestTimeout: ctx.timeoutMs, serverName: c.host, rowCollectionOnRequestCompletion: true },
        });
        const stop = () => conn.close();
        ctx.signal.addEventListener('abort', () => { stop(); reject(new CheckError('timeout', 'Timed out')); }, { once: true });
        conn.on('error', () => {});
        conn.connect((err) => {
          if (err) return reject(err);
          const req = new TediousRequest(c.query || 'SELECT 1', (e, _n, rows) => { stop(); e ? reject(e) : resolve((rows as any)?.[0]?.[0]?.value); });
          conn.execSql(req);
        });
      });
      const bad = compare(c, value);
      if (bad) return { ...bad, latencyMs: Math.round(hrMs(t0)) };
      return ok(hrMs(t0), { message: value === undefined ? 'Query OK' : `Query returned ${String(value).slice(0, 80)}` });
    } catch (e) {
      if ((e as any)?.code === 'ELOGIN') return fail('auth', (e as Error).message);
      return wrap(e);
    }
  },
};

/** Read one RESP reply (simple string, error, integer, bulk string). */
function respDone(b: string): boolean {
  const t = b[0];
  if (t === '$') {
    const nl = b.indexOf('\r\n');
    if (nl < 0) return false;
    const n = parseInt(b.slice(1, nl), 10);
    return n < 0 || b.length >= nl + 2 + n + 2;
  }
  return b.endsWith('\r\n');
}
const respValue = (b: string): string => (b[0] === '$' ? b.slice(b.indexOf('\r\n') + 2, -2) : b.slice(1).trim());

const redis: Runner = {
  type: 'redis', label: 'Redis', category: 'Database',
  fields: [
    ...dbFields(6379, false).filter((f) => f.key !== 'database'),
    { key: 'command', label: 'Command', kind: 'text', default: 'PING', placeholder: 'GET my-key' },
    { key: 'expected', label: 'Expected reply (optional)', kind: 'text', placeholder: 'PONG' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      const conn = await connect({ host: c.host, port: c.port ?? 6379, signal: ctx.signal, guard: ctx.guard, tls: c.useTls ? { verify: c.verifyTls !== false } : false });
      try {
        const cmd = async (args: string[]) => {
          conn.sock.write(`*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join(''));
          const r = await readUntil(conn.sock, respDone);
          if (r[0] === '-') throw new CheckError(/NOAUTH|WRONGPASS|invalid password/i.test(r) ? 'auth' : 'protocol', r.slice(1).trim());
          return respValue(r);
        };
        if (c.password) await cmd(c.username ? ['AUTH', c.username, c.password] : ['AUTH', c.password]);
        const reply = await cmd(String(c.command || 'PING').trim().split(/\s+/));
        const bad = compare(c, reply);
        if (bad) return { ...bad, latencyMs: Math.round(hrMs(t0)) };
        return ok(hrMs(t0), { message: `Reply: ${reply.slice(0, 80)}` });
      } finally { conn.close(); }
    } catch (e) { return wrap(e); }
  },
};

const mongo: Runner = {
  type: 'mongodb', label: 'MongoDB', category: 'Database',
  fields: dbFields(27017, false).map((f) => (f.key === 'database' ? { ...f, default: 'admin' } : f)),
  async run(ctx) {
    const c = ctx.config;
    const { MongoClient } = await import('mongodb');
    let client: InstanceType<typeof MongoClient> | undefined;
    try {
      await ctx.guard.resolve(c.host);
      const t0 = process.hrtime.bigint();
      client = new MongoClient(`mongodb://${c.host}:${c.port ?? 27017}`, {
        auth: c.username ? { username: c.username, password: c.password } : undefined,
        authSource: c.database || 'admin', serverSelectionTimeoutMS: ctx.timeoutMs, connectTimeoutMS: ctx.timeoutMs, socketTimeoutMS: ctx.timeoutMs,
        tls: !!c.useTls, tlsAllowInvalidCertificates: c.useTls && c.verifyTls === false, directConnection: true, ...trustOptions(),
      });
      await client.db(c.database || 'admin').command({ ping: 1 });
      return ok(hrMs(t0), { message: 'ping OK' });
    } catch (e) {
      const m = (e as Error).message ?? '';
      if (/auth/i.test(m)) return fail('auth', m);
      if (/server selection timed out/i.test(m)) return fail('timeout', 'Server selection timed out', { details: { phase: 'connect' } });
      return wrap(e);
    } finally { await client?.close().catch(() => {}); }
  },
};

export const dbRunners: Runner[] = [mysqlRunner('mysql', 'MariaDB / MySQL'), postgres, mssql, redis, mongo];
