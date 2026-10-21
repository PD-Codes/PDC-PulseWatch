import { httpRequest, type HttpResponse } from '../http';
import { CheckError, type FieldDef, type Runner } from '../types';
import { fail, failure, hrMs, ok, udpRequest } from '../util';

const hostPort = (port: number): FieldDef[] => [
  { key: 'host', label: 'Host', kind: 'text', required: true },
  { key: 'port', label: 'Query port', kind: 'number', default: port, min: 1, max: 65535 },
];

/* ---------------------------- Steam / Source engine (A2S) --------------------------- */
const A2S_INFO = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0')]);

function cstr(b: Buffer, pos: number): [string, number] {
  const end = b.indexOf(0, pos);
  if (end < 0) throw new CheckError('protocol', 'Truncated A2S reply');
  return [b.toString('utf8', pos, end), end + 1];
}

const steam: Runner = {
  type: 'steam', label: 'Steam game server (A2S)', category: 'Games',
  fields: [...hostPort(27015), { key: 'minPlayers', label: 'Fail when fewer players are online (0 = off)', kind: 'number', default: 0, min: 0, max: 10000 }],
  async run(ctx) {
    const c = ctx.config;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0];
      const t0 = process.hrtime.bigint();
      let r = await udpRequest(addr, c.port ?? 27015, A2S_INFO, ctx.timeoutMs, 'A2S', ctx.signal);
      // Servers since 2020 answer with a challenge number first; the query is then repeated with it appended
      if (r.length >= 9 && r[4] === 0x41) r = await udpRequest(addr, c.port ?? 27015, Buffer.concat([A2S_INFO, r.subarray(5, 9)]), ctx.timeoutMs, 'A2S', ctx.signal);
      const ms = hrMs(t0);
      if (r.length < 6 || r.readInt32LE(0) !== -1 || r[4] !== 0x49) return fail('protocol', 'Not an A2S_INFO reply', { latencyMs: Math.round(ms) });
      let pos = 6;
      let name: string, map: string;
      [name, pos] = cstr(r, pos);
      [map, pos] = cstr(r, pos);
      [, pos] = cstr(r, pos); // folder
      [, pos] = cstr(r, pos); // game
      pos += 2; // app id
      const [players, max, bots] = [r[pos], r[pos + 1], r[pos + 2]];
      if (players === undefined) return fail('protocol', 'Truncated A2S reply', { latencyMs: Math.round(ms) });
      const details = { name, map, players, maxPlayers: max, bots };
      if (c.minPlayers && players < c.minPlayers) return fail('content', `${players} players online, expected at least ${c.minPlayers}`, { latencyMs: Math.round(ms), details });
      return ok(ms, { message: `${name} (${map}), ${players}/${max} players`, details });
    } catch (e) { return failure(e); }
  },
};

/* ------------------------------------ GameDig ------------------------------------ */
const gamedig: Runner = {
  type: 'gamedig', label: 'Game server (GameDig)', category: 'Games',
  fields: [
    { key: 'game', label: 'Game', kind: 'text', required: true, placeholder: 'valheim', help: 'GameDig game id, e.g. valheim, rust, cs2, ark, terraria, factorio. About 350 games are supported.' },
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'port', label: 'Query port (blank = game default)', kind: 'number', min: 1, max: 65535 },
    { key: 'minPlayers', label: 'Fail when fewer players are online (0 = off)', kind: 'number', default: 0, min: 0, max: 10000 },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const addr = (await ctx.guard.resolve(c.host))[0].address; // GameDig gets the vetted address, never the name
      const { GameDig } = await import('gamedig').catch(() => { throw new CheckError('config', 'The gamedig package is not installed on this node'); });
      const t0 = process.hrtime.bigint();
      let aborted: (() => void) | undefined;
      const abort = new Promise<never>((_, reject) => { aborted = () => reject(new CheckError('timeout', `No answer from the ${c.game} server`, { phase: 'response' })); ctx.signal.addEventListener('abort', aborted, { once: true }); });
      let st: Record<string, any>;
      try {
        st = await Promise.race([abort, GameDig.query({ type: c.game, host: addr, ...(c.port ? { port: c.port, givenPortOnly: true } : {}), maxRetries: 1, attemptTimeout: ctx.timeoutMs, socketTimeout: Math.min(ctx.timeoutMs, 4000) })]);
      } finally { if (aborted) ctx.signal.removeEventListener('abort', aborted); }
      const ms = hrMs(t0);
      const players = st.numplayers ?? st.players?.length ?? 0;
      const details = { name: st.name, map: st.map, players, maxPlayers: st.maxplayers, passwordProtected: st.password };
      if (c.minPlayers && players < c.minPlayers) return fail('content', `${players} players online, expected at least ${c.minPlayers}`, { latencyMs: Math.round(ms), details });
      return ok(ms, { message: `${st.name || c.game}${st.map ? ` (${st.map})` : ''}, ${players}/${st.maxplayers ?? '?'} players`, details });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/invalid game/i.test(msg)) return fail('config', `Unknown GameDig game id "${c.game}"`);
      if (!(e instanceof CheckError) && /failed all|timed? ?out|no response/i.test(msg)) return fail('timeout', `No answer from the ${c.game} server`, { details: { phase: 'response' } });
      return failure(e);
    }
  },
};

/* ----------------------------- Pelican / Pterodactyl panel ---------------------------- */
const apiFail = (res: HttpResponse, what: string) => {
  if (res.status === 401 || res.status === 403) return fail('auth', `${what} refused the API key (HTTP ${res.status})`, { latencyMs: Math.round(res.timings.total) });
  if (res.status === 404) return fail('content', `${what} does not know this server id (HTTP 404)`, { latencyMs: Math.round(res.timings.total) });
  return fail('http_status', `${what} answered HTTP ${res.status}`, { latencyMs: Math.round(res.timings.total) });
};

const pelican: Runner = {
  type: 'pelican', label: 'Pelican / Pterodactyl server', category: 'Games',
  fields: [
    { key: 'url', label: 'Panel URL', kind: 'text', required: true, placeholder: 'https://panel.example.com' },
    { key: 'serverId', label: 'Server id', kind: 'text', required: true, placeholder: 'a1b2c3d4', help: 'The short id from the server URL in the panel (or its full UUID).' },
    { key: 'apiKey', label: 'Client API key', kind: 'secret', required: true, help: 'Create it in the panel under Account > API Credentials. A read-only account is enough.' },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const res = await httpRequest({
        url: `${String(c.url).replace(/\/+$/, '')}/api/client/servers/${encodeURIComponent(c.serverId)}/resources`, signal: ctx.signal, guard: ctx.guard, verifyTls: c.verifyTls !== false,
        headers: { authorization: `Bearer ${c.apiKey}`, accept: 'application/json' },
      });
      if (res.status !== 200) return apiFail(res, 'The panel');
      const a = JSON.parse(res.body)?.attributes;
      if (!a || typeof a.current_state !== 'string') return fail('protocol', 'The panel answered, but not with server statistics', { latencyMs: Math.round(res.timings.total) });
      const r = a.resources ?? {};
      const details = { state: a.current_state, suspended: !!a.is_suspended, cpuPercent: r.cpu_absolute, memoryBytes: r.memory_bytes, diskBytes: r.disk_bytes, uptimeMs: r.uptime };
      if (a.is_suspended) return fail('content', 'The server is suspended', { latencyMs: Math.round(res.timings.total), details });
      if (a.current_state !== 'running') return fail('content', `The server is ${a.current_state}`, { latencyMs: Math.round(res.timings.total), details });
      const mb = typeof r.memory_bytes === 'number' ? `, ${Math.round(r.memory_bytes / 1048576)} MB RAM` : '';
      return ok(res.timings.total, { message: `Running${typeof r.cpu_absolute === 'number' ? `, ${r.cpu_absolute.toFixed(1)}% CPU` : ''}${mb}`, details, cert: res.cert });
    } catch (e) { return failure(e); }
  },
};

/* ------------------------------------ AMP (CubeCoders) ------------------------------------ */
const AMP_STATES: Record<number, string> = { 0: 'stopped', 5: 'pre-start', 7: 'configuring', 10: 'starting', 20: 'ready', 30: 'restarting', 40: 'stopping', 45: 'preparing for sleep', 50: 'sleeping', 60: 'waiting', 70: 'installing', 75: 'updating', 80: 'awaiting user input', 100: 'failed', 200: 'suspended', 250: 'in maintenance', 999: 'indeterminate' };

const amp: Runner = {
  type: 'amp', label: 'AMP game server (CubeCoders)', category: 'Games',
  fields: [
    { key: 'url', label: 'AMP URL', kind: 'text', required: true, placeholder: 'http://amp.example.com:8080' },
    { key: 'username', label: 'Username', kind: 'text', required: true, help: 'A read-only AMP user with access to the instance is enough.' },
    { key: 'password', label: 'Password', kind: 'secret', required: true },
    { key: 'instanceId', label: 'Instance id (when the URL is the ADS controller)', kind: 'text', help: 'Leave empty when the URL points at the instance itself.' },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
  ],
  async run(ctx) {
    const c = ctx.config;
    try {
      const base = String(c.url).replace(/\/+$/, '');
      const post = async (path: string, body: object) => {
        const res = await httpRequest({ url: base + path, method: 'POST', body: JSON.stringify(body), signal: ctx.signal, guard: ctx.guard, verifyTls: c.verifyTls !== false, headers: { 'content-type': 'application/json', accept: 'text/javascript' } });
        if (res.status !== 200) throw Object.assign(new Error('http'), { res });
        try { return { json: JSON.parse(res.body) as Record<string, any>, res }; } catch { throw new CheckError('protocol', 'AMP answered with something that is not JSON'); }
      };
      const t0 = process.hrtime.bigint();
      let session: string | undefined;
      try {
        const login = (await post('/API/Core/Login', { username: c.username, password: c.password, token: '', rememberMe: false })).json;
        session = login.sessionID || undefined;
        if (!session) return fail('auth', `AMP refused the login${login.resultReason ? `: ${login.resultReason}` : ''}`, { latencyMs: Math.round(hrMs(t0)) });
        const path = c.instanceId ? `/API/ADSModule/Servers/${encodeURIComponent(c.instanceId)}/API/Core/GetStatus` : '/API/Core/GetStatus';
        const { json: st, res } = await post(path, { SESSIONID: session });
        const ms = hrMs(t0);
        if (typeof st.State !== 'number') return fail('protocol', `AMP did not report a state${st.Title || st.Message ? ` (${st.Title ?? st.Message})` : ''}: check the instance id`, { latencyMs: Math.round(ms) });
        const users = st.Metrics?.['Active Users'];
        const details = { state: AMP_STATES[st.State] ?? st.State, uptime: st.Uptime, players: users?.RawValue, maxPlayers: users?.MaxValue, cpuPercent: st.Metrics?.['CPU Usage']?.RawValue, memoryMb: st.Metrics?.['Memory Usage']?.RawValue };
        if (st.State !== 20) return fail('content', `The instance is ${details.state}`, { latencyMs: Math.round(ms), details });
        return ok(ms, { message: `Ready${users ? `, ${users.RawValue}/${users.MaxValue} players` : ''}`, details, cert: res.cert });
      } finally {
        // sessions that are never closed pile up on the AMP side
        if (session) void post('/API/Core/Logout', { SESSIONID: session }).catch(() => {});
      }
    } catch (e) {
      const res = (e as { res?: HttpResponse }).res;
      return res ? apiFail(res, 'AMP') : failure(e);
    }
  },
};

export const gameRunners: Runner[] = [steam, gamedig, pelican, amp];
