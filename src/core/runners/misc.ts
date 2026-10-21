import { execFile } from 'node:child_process';
import { httpRequest } from '../http';
import { CheckError, type CheckResult, type Runner } from '../types';
import { fail, failure, hrMs, ok, sleep, statusMatcher } from '../util';

/* ------------------------------------- Manual ------------------------------------ */
const manual: Runner = {
  type: 'manual', label: 'Manual status', category: 'Passive',
  fields: [
    { key: 'state', label: 'Status', kind: 'select', options: [{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }], default: 'up', required: true, help: 'Nothing is checked. Change the status here when something is known to be broken, for example an outage at a provider that has no API.' },
    { key: 'message', label: 'Message (optional)', kind: 'text', placeholder: 'Provider reports a disruption' },
  ],
  async run(ctx) {
    const c = ctx.config;
    return c.state === 'down' ? fail('reported', c.message || 'Set to down manually') : ok(0, { message: c.message || 'Set to up manually' });
  },
};

/* -------------------------------------- PM2 -------------------------------------- */
const pm2: Runner = {
  type: 'pm2', label: 'PM2 process', category: 'Infrastructure',
  fields: [{ key: 'processName', label: 'Process name', kind: 'text', required: true, help: 'The pm2 command must be installed on the machine that runs the check, so use a probe on the PM2 host.' }],
  async run(ctx) {
    const c = ctx.config;
    try {
      const t0 = process.hrtime.bigint();
      const out = await new Promise<string>((resolve, reject) => {
        execFile('pm2', ['jlist'], { timeout: ctx.timeoutMs, signal: ctx.signal, maxBuffer: 16 << 20 }, (err, stdout) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new CheckError('config', 'The pm2 command is not installed on this node'));
          if (err) return reject(err);
          resolve(stdout);
        });
      });
      const ms = hrMs(t0);
      // pm2 prints a banner before the JSON when it has to start its daemon
      const start = /^\[\s*(?:\{|\])/m.exec(out);
      if (!start) return fail('protocol', 'pm2 jlist did not print a process list', { latencyMs: Math.round(ms) });
      const all = JSON.parse(out.slice(start.index)) as { name: string; pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number } }[];
      const mine = all.filter((p) => p.name === c.processName);
      if (!mine.length) return fail('content', `PM2 has no process named "${c.processName}"`, { latencyMs: Math.round(ms) });
      const online = mine.filter((p) => p.pm2_env?.status === 'online');
      const restarts = mine.reduce((n, p) => n + (p.pm2_env?.restart_time ?? 0), 0);
      const details = { instances: mine.length, online: online.length, restarts, states: mine.map((p) => p.pm2_env?.status) };
      if (online.length < mine.length) return fail('content', `${mine.length - online.length} of ${mine.length} instances are not online (${[...new Set(mine.map((p) => p.pm2_env?.status))].join(', ')})`, { latencyMs: Math.round(ms), details });
      return ok(ms, { message: `${online.length} instance${online.length === 1 ? '' : 's'} online, ${restarts} restart${restarts === 1 ? '' : 's'}`, details });
    } catch (e) { return failure(e); }
  },
};

/* ------------------------------------- Oracle ------------------------------------ */
const oracle: Runner = {
  type: 'oracle', label: 'Oracle Database', category: 'Database',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'port', label: 'Port', kind: 'number', default: 1521, min: 1, max: 65535 },
    { key: 'serviceName', label: 'Service name', kind: 'text', required: true, placeholder: 'ORCLPDB1' },
    { key: 'username', label: 'Username', kind: 'text', required: true },
    { key: 'password', label: 'Password', kind: 'secret' },
    { key: 'query', label: 'Query (use a read-only account)', kind: 'textarea', default: 'SELECT 1 FROM DUAL' },
    { key: 'expected', label: 'Expected first value (optional)', kind: 'text' },
  ],
  async run(ctx) {
    const c = ctx.config;
    let conn: { close(): Promise<void>; execute(sql: string, binds: unknown[], o: object): Promise<{ rows?: unknown[][] }>; callTimeout: number } | undefined;
    try {
      if (!/^[\w.$#-]+$/.test(c.serviceName)) return fail('config', 'The service name may only contain letters, digits and . _ $ # -');
      const addr = (await ctx.guard.resolve(c.host))[0].address;
      const { default: oracledb } = await import('oracledb').catch(() => { throw new CheckError('config', 'The oracledb package is not installed on this node'); });
      const sec = Math.max(1, Math.ceil(ctx.timeoutMs / 1000));
      const t0 = process.hrtime.bigint();
      conn = (await oracledb.getConnection({
        user: c.username, password: c.password ?? '',
        connectString: `(DESCRIPTION=(RETRY_COUNT=0)(CONNECT_TIMEOUT=${sec})(TRANSPORT_CONNECT_TIMEOUT=${sec})(ADDRESS=(PROTOCOL=TCP)(HOST=${addr.includes(':') ? `[${addr}]` : addr})(PORT=${c.port ?? 1521}))(CONNECT_DATA=(SERVICE_NAME=${c.serviceName})))`,
      })) as unknown as typeof conn;
      conn!.callTimeout = ctx.timeoutMs;
      const r = await conn!.execute(c.query || 'SELECT 1 FROM DUAL', [], { maxRows: 1 });
      const first = r.rows?.[0]?.[0];
      const ms = hrMs(t0);
      if (c.expected !== undefined && c.expected !== '' && String(first) !== String(c.expected)) return fail('content', `Query returned ${JSON.stringify(first)}, expected ${JSON.stringify(c.expected)}`, { latencyMs: Math.round(ms) });
      return ok(ms, { message: first === undefined ? 'Query OK' : `Query returned ${String(first).slice(0, 80)}` });
    } catch (e) {
      const err = e as { errorNum?: number; message?: string };
      if (err?.errorNum === 1017) return fail('auth', 'Oracle refused the username or password (ORA-01017)');
      if (!(e instanceof CheckError) && /ORA-12541|ECONNREFUSED|refused/i.test(err?.message ?? '')) return fail('refused', `Connection refused: ${err.message}`);
      if (!(e instanceof CheckError) && /timeout|timed out|NJS-040|NJS-510|ORA-12170/i.test(err?.message ?? '')) return fail('timeout', `Timed out: ${err.message}`);
      return failure(e);
    } finally { await conn?.close().catch(() => {}); }
  },
};

/* ----------------------------------- Globalping ---------------------------------- */
interface GpResult { status: string; rawOutput?: string; statusCode?: number; stats?: { avg?: number; loss?: number }; timings?: { total?: number } }

const globalping: Runner = {
  type: 'globalping', label: 'Globalping (remote location)', category: 'Application',
  fields: [
    { key: 'measurement', label: 'Measurement', kind: 'select', options: [{ value: 'ping', label: 'Ping' }, { value: 'http', label: 'HTTP' }], default: 'ping', required: true },
    { key: 'target', label: 'Target', kind: 'text', required: true, placeholder: 'example.com or https://example.com/health', help: 'Measured by a volunteer probe of globalping.io, so the target must be reachable from the internet.' },
    { key: 'location', label: 'Location', kind: 'text', placeholder: 'Germany', help: 'A country, city, continent, network or cloud region such as "Frankfurt" or "aws-eu-west-1". Blank = anywhere.' },
    { key: 'token', label: 'API token (optional)', kind: 'secret', help: 'Raises the hourly limit of anonymous use.' },
    { key: 'maxLoss', label: 'Max packet loss (%)', kind: 'number', default: 0, min: 0, max: 99, showIf: { key: 'measurement', equals: 'ping' } },
    { key: 'expectedStatus', label: 'Expected status codes', kind: 'codes', default: '200-299', showIf: { key: 'measurement', equals: 'http' } },
    { key: 'apiUrl', label: 'API URL', kind: 'text', default: 'https://api.globalping.io', help: 'Only change this for a self-hosted Globalping API.' },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const base = String(c.apiUrl || 'https://api.globalping.io').replace(/\/+$/, '');
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) };
      const http = c.measurement === 'http';
      let target = String(c.target).trim();
      let measurementOptions: object | undefined;
      if (http && /^https?:\/\//i.test(target)) {
        const u = new URL(target);
        target = u.hostname;
        measurementOptions = { protocol: u.protocol === 'https:' ? 'HTTPS' : 'HTTP', ...(u.port ? { port: Number(u.port) } : {}), request: { method: 'GET', path: u.pathname, ...(u.search ? { query: u.search.slice(1) } : {}) } };
      }
      const t0 = process.hrtime.bigint();
      const call = (method: string, path: string, body?: object) => httpRequest({ url: base + path, method, body: body && JSON.stringify(body), headers, signal: ctx.signal, guard: ctx.guard });
      const created = await call('POST', '/v1/measurements', { type: c.measurement ?? 'ping', target, limit: 1, ...(c.location ? { locations: [{ magic: c.location }] } : {}), ...(measurementOptions ? { measurementOptions } : {}) });
      const apiError = (): CheckResult | undefined => {
        if (created.status === 202 || created.status === 200) return undefined;
        const msg = (() => { try { return JSON.parse(created.body)?.error?.message as string; } catch { return undefined; } })();
        if (created.status === 401 || created.status === 403) return fail('auth', `Globalping refused the token${msg ? `: ${msg}` : ''}`);
        if (created.status === 422) return fail('config', `Globalping rejected the measurement: ${msg ?? 'invalid request'}`);
        if (created.status === 429) return fail('protocol', 'Globalping rate limit reached, add an API token or lengthen the interval');
        return fail('http_status', `Globalping answered HTTP ${created.status}${msg ? `: ${msg}` : ''}`);
      };
      const bad = apiError();
      if (bad) return bad;
      const id = JSON.parse(created.body).id as string;
      if (!id) return fail('protocol', 'Globalping did not return a measurement id');
      let m: { status?: string; results?: { probe?: { city?: string; country?: string }; result: GpResult }[] } = {};
      for (;;) {
        const res = await call('GET', `/v1/measurements/${encodeURIComponent(id)}`);
        if (res.status !== 200) return fail('http_status', `Globalping answered HTTP ${res.status} while waiting for the result`);
        m = JSON.parse(res.body);
        if (m.status && m.status !== 'in-progress') break;
        await sleep(700, ctx.signal);
      }
      const ms = hrMs(t0);
      const first = m.results?.[0];
      if (!first) return fail('protocol', `No Globalping probe is available for "${c.location || 'any location'}"`, { latencyMs: Math.round(ms) });
      const r = first.result;
      const where = [first.probe?.city, first.probe?.country].filter(Boolean).join(', ') || 'unknown location';
      const details = { probe: where, ...(http ? { statusCode: r.statusCode } : { avgMs: r.stats?.avg, lossPercent: r.stats?.loss }) };
      if (r.status === 'offline') return fail('internal', `The Globalping probe in ${where} went offline`, { latencyMs: Math.round(ms), details });
      if (r.status !== 'finished') return fail('network', `From ${where}: ${(r.rawOutput ?? 'measurement failed').split('\n')[0].slice(0, 160)}`, { latencyMs: Math.round(ms), details });
      if (http) {
        if (!statusMatcher(c.expectedStatus ?? '200-299')(r.statusCode ?? 0)) return fail('http_status', `From ${where}: HTTP ${r.statusCode}`, { latencyMs: Math.round(r.timings?.total ?? ms), details });
        return ok(r.timings?.total ?? ms, { message: `From ${where}: HTTP ${r.statusCode}`, details });
      }
      const loss = r.stats?.loss ?? 100;
      if (loss > (c.maxLoss ?? 0)) return fail('network', `From ${where}: ${loss}% packet loss`, { details, ...(r.stats?.avg ? { latencyMs: Math.round(r.stats.avg) } : {}) });
      return ok(r.stats?.avg ?? ms, { message: `From ${where}: ${r.stats?.avg ?? '?'} ms`, details });
    } catch (e) { return failure(e); }
  },
};

export const miscRunners: Runner[] = [manual, pm2, oracle, globalping];
