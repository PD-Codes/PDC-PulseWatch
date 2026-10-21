import fs from 'node:fs';
import { DEFAULT_DENY, getRunner, NetGuard, setExtraCa } from '../core';
import type { CheckResult } from '../core';
import { installCrashBackstop } from '../core/survive';
import { toCheckError } from '../core/util';
import pkg from '../../package.json';

/** Probe agent: pulls its assigned jobs from the server, runs them from this network and pushes the raw results back. */

const env = process.env;
const read = (name: string, def?: string) => (env[`${name}_FILE`] ? fs.readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : env[name] ?? def);
const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const server = (read('PW_SERVER_URL') ?? '').replace(/\/$/, '');
const token = read('PW_PROBE_TOKEN') ?? '';
const fetchEverySec = Number(read('PW_PROBE_FETCH_SECONDS', '30'));
const maxConcurrency = Number(read('PW_PROBE_CONCURRENCY', '50'));
const guard = new NetGuard({ mode: read('PW_PROBE_SSRF_MODE', 'allow-private') === 'public-only' ? 'public-only' : 'allow-private', allow: list(read('PW_PROBE_SSRF_ALLOW')), deny: [...DEFAULT_DENY, ...list(read('PW_PROBE_SSRF_DENY'))] });

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra }));

if (!server || !token) { console.error('PW_SERVER_URL and PW_PROBE_TOKEN (or PW_PROBE_TOKEN_FILE) are required'); process.exit(1); }
if (!server.startsWith('https://') && !/^http:\/\/(localhost|127\.|\[::1\])/.test(server) && read('PW_PROBE_ALLOW_INSECURE') !== 'true') {
  // job payloads contain decrypted monitor secrets, so plain HTTP must be an explicit decision
  console.error('PW_SERVER_URL must use https:// (set PW_PROBE_ALLOW_INSECURE=true to override on a trusted network)'); process.exit(1);
}

interface Job { id: number; name: string; type: string; config: Record<string, any>; intervalS: number; timeoutS: number }
interface Result { monitorId: number; ts: string; ok: boolean; latencyMs: number | null; errorKind: string | null; message: string | null }

const headers = { Authorization: `Bearer ${token}`, 'X-Probe-Version': pkg.version, 'Content-Type': 'application/json' };
const jobs = new Map<number, { job: Job; sig: string; timer: NodeJS.Timeout }>();
let queue: Result[] = [];
let etag = '';
let running = 0;
let stopping = false;

async function runJob(job: Job): Promise<void> {
  if (stopping || running >= maxConcurrency) return; // overloaded: skip this round instead of piling up
  running++;
  const started = Date.now();
  let r: CheckResult;
  try {
    const runner = getRunner(job.type);
    if (!runner) r = { ok: false, errorKind: 'config', message: `Probe does not support monitor type ${job.type}` };
    else {
      const ms = job.timeoutS * 1000;
      r = await runner.run({ config: job.config, timeoutMs: ms, signal: AbortSignal.timeout(ms), guard, monitor: { id: job.id, name: job.name } });
    }
  } catch (e) {
    const ce = toCheckError(e);
    r = { ok: false, errorKind: ce.kind, message: ce.message };
  } finally { running--; }
  queue.push({ monitorId: job.id, ts: new Date(started).toISOString(), ok: r.ok, latencyMs: r.latencyMs ?? null, errorKind: r.errorKind ?? null, message: r.message?.slice(0, 500) ?? null });
  if (queue.length > 5000) queue = queue.slice(-5000); // server unreachable for long: keep the newest
}

function schedule(job: Job, sig: string) {
  const prev = jobs.get(job.id);
  if (prev) clearInterval(prev.timer);
  const timer = setInterval(() => void runJob(job), job.intervalS * 1000);
  jobs.set(job.id, { job, sig, timer });
  setTimeout(() => void runJob(job), Math.random() * Math.min(job.intervalS, 10) * 1000); // jitter the first run
}

async function sync(): Promise<void> {
  const res = await fetch(`${server}/api/probe/v1/jobs`, { headers: { ...headers, ...(etag ? { 'If-None-Match': etag } : {}) }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 304) return;
  if (res.status === 401) { log('error', 'Server rejected the probe token'); return; }
  if (!res.ok) throw new Error(`jobs request failed with HTTP ${res.status}`);
  const body = (await res.json()) as { version: string; jobs: Job[]; ca?: string[] };
  setExtraCa(body.ca ?? []);
  const seen = new Set<number>();
  for (const j of body.jobs) {
    seen.add(j.id);
    const sig = JSON.stringify([j.type, j.config, j.intervalS, j.timeoutS]);
    if (jobs.get(j.id)?.sig !== sig) schedule(j, sig);
  }
  for (const [id, e] of jobs) if (!seen.has(id)) { clearInterval(e.timer); jobs.delete(id); }
  etag = res.headers.get('etag') ?? body.version;
  log('info', 'jobs synced', { jobs: jobs.size });
}

async function flush(): Promise<void> {
  if (!queue.length) return;
  const batch = queue.splice(0, 500);
  try {
    const res = await fetch(`${server}/api/probe/v1/results`, { method: 'POST', headers, body: JSON.stringify({ results: batch }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    queue = [...batch, ...queue].slice(-5000); // retry with the next flush
    log('warn', 'could not deliver results', { error: (e as Error).message, queued: queue.length });
  }
}

const safe = (fn: () => Promise<void>, what: string) => () => void fn().catch((e) => log('warn', `${what} failed`, { error: (e as Error).message }));
installCrashBackstop((kind, e) => log('error', kind, { error: (e as Error)?.message ?? String(e) }));
log('info', 'probe starting', { version: pkg.version, server });
safe(sync, 'job sync')();
const t1 = setInterval(safe(sync, 'job sync'), fetchEverySec * 1000);
const t2 = setInterval(safe(flush, 'result flush'), 5000);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(t1); clearInterval(t2);
  for (const e of jobs.values()) clearInterval(e.timer);
  const deadline = Date.now() + 10_000;
  while (running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await flush().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
