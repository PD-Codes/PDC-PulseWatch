import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import brand from '../../brand.json';
import { checkTimeZone } from './tz';

const env = process.env;

/** Read VAR, or the file named by VAR_FILE (Docker/K8s secrets convention). */
function read(name: string, def?: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return env[name] ?? def;
}
const int = (name: string, def: number) => {
  const v = read(name);
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};
const bool = (name: string, def: boolean) => {
  const v = read(name);
  return v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};
const list = (name: string) => (read(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * PW_TRUST_PROXY: false (default), true (every proxy is trusted, X-Forwarded-For can then be forged by clients), a hop count, or comma separated proxy IPs/CIDRs.
 * Returns what Fastify's trustProxy option takes; throws on anything else so a typo cannot silently trust the wrong clients.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const v = (raw ?? '').trim();
  if (!v || ['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
  if (['true', 'yes', 'on'].includes(v.toLowerCase())) return true;
  if (/^\d+$/.test(v)) { const n = Number(v); if (n >= 1 && n <= 32) return n; }
  else {
    const entries = v.split(',').map((e) => e.trim()).filter(Boolean);
    const ok = (e: string) => { const [a, b, extra] = e.split('/'); return extra === undefined && net.isIP(a ?? '') > 0 && (b === undefined || (/^\d+$/.test(b) && Number(b) <= (net.isIPv6(a!) ? 128 : 32))); };
    if (entries.length && entries.every(ok)) return entries;
  }
  throw new Error(`PW_TRUST_PROXY="${v}" is not valid: use false, true, the number of proxies in front of the app (1-32), or comma separated proxy IPs/CIDRs such as 10.0.0.0/8`);
}

/** PW_SSRF_MODE: only the two known modes; anything else stops the start instead of silently allowing private targets. */
export function parseSsrfMode(raw: string | undefined): 'allow-private' | 'public-only' {
  const v = (raw ?? '').trim() || 'allow-private';
  if (v === 'allow-private' || v === 'public-only') return v;
  throw new Error(`PW_SSRF_MODE="${v}" is not valid: use allow-private or public-only`);
}

const dataDir = path.resolve(read('PW_DATA_DIR', './data')!);

/** The encryption key comes from the environment, a secret file, or (quick start) a generated key file in the data dir. */
function loadSecretKey(): Buffer {
  let raw = read('PW_SECRET_KEY');
  if (!raw) {
    const keyFile = path.join(dataDir, 'secret.key');
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
      console.warn(`[config] PW_SECRET_KEY not set: generated ${keyFile}. Back it up, encrypted settings cannot be recovered without it.`);
    }
    raw = fs.readFileSync(keyFile, 'utf8').trim();
  }
  return Buffer.from(crypto.hkdfSync('sha256', raw, 'pulsewatch', 'secret-encryption-v1', 32));
}

export const config = {
  brand,
  role: (read('PW_ROLE', 'all') as 'all' | 'api' | 'worker'),
  host: read('PW_HOST', '0.0.0.0')!,
  port: int('PW_PORT', 3000),
  baseUrl: read('PW_BASE_URL', 'http://localhost:3000')!.replace(/\/$/, ''),
  trustProxy: parseTrustProxy(read('PW_TRUST_PROXY')),
  logLevel: read('PW_LOG_LEVEL', 'info')!,
  dataDir,
  migrationsDir: path.resolve(read('PW_MIGRATIONS_DIR', './migrations')!),
  webDir: path.resolve(read('PW_WEB_DIR', './dist/web')!),
  db: {
    host: read('PW_DB_HOST', '127.0.0.1')!,
    port: int('PW_DB_PORT', 3306),
    user: read('PW_DB_USER', 'pulsewatch')!,
    password: read('PW_DB_PASSWORD', '')!,
    database: read('PW_DB_NAME', 'pulsewatch')!,
    pool: int('PW_DB_POOL', 20),
  },
  get secretKey() { return (this._key ??= loadSecretKey()); },
  _key: undefined as Buffer | undefined,
  scheduler: {
    tickMs: int('PW_TICK_MS', 1000),
    maxConcurrency: int('PW_MAX_CONCURRENCY', 200),
    jitterPct: int('PW_JITTER_PCT', 5),
  },
  /** Total time a SIGTERM may take: running checks, lease release, HTTP close, DB close. Keep it below the orchestrator's stop timeout. */
  shutdownGraceMs: int('PW_SHUTDOWN_GRACE_MS', 20_000),
  session: { ttlHours: int('PW_SESSION_TTL_HOURS', 168), cookieSecure: bool('PW_COOKIE_SECURE', (read('PW_BASE_URL', '') ?? '').startsWith('https://')) },
  ssrf: { mode: parseSsrfMode(read('PW_SSRF_MODE')), allow: list('PW_SSRF_ALLOW'), deny: list('PW_SSRF_DENY') },
  retention: {
    rawDays: int('PW_RETENTION_RAW_DAYS', 14),
    minuteDays: int('PW_RETENTION_MINUTE_DAYS', 60),
    hourDays: int('PW_RETENTION_HOUR_DAYS', 400),
    dayDays: int('PW_RETENTION_DAY_DAYS', 3650),
    eventDays: int('PW_RETENTION_EVENT_DAYS', 365),
    auditDays: int('PW_RETENTION_AUDIT_DAYS', 730),
  },
  metricsToken: read('PW_METRICS_TOKEN'),
  /** Token for creating the first administrator; generated (and logged) at start when unset. */
  setupToken: read('PW_SETUP_TOKEN')?.trim() || undefined,
  deadman: { url: read('PW_DEADMAN_URL'), intervalSec: int('PW_DEADMAN_INTERVAL', 60) },
  smtp: {
    host: read('PW_SMTP_HOST'), port: int('PW_SMTP_PORT', 587), user: read('PW_SMTP_USER'), pass: read('PW_SMTP_PASS'),
    from: read('PW_SMTP_FROM', 'PulseWatch <pulsewatch@localhost>')!, secure: bool('PW_SMTP_SECURE', false),
  },
  demo: bool('PW_DEMO', false),
  rateLimit: { max: int('PW_RATE_LIMIT_MAX', 300), loginMax: int('PW_RATE_LIMIT_LOGIN', 10) },
  otlpEndpoint: read('PW_OTEL_EXPORTER_OTLP_ENDPOINT'),
  /** Calendar days (daily rollups, heatmaps, day bars, reports) are counted in this zone; must be the same for all roles. */
  timezone: checkTimeZone(read('PW_TIMEZONE', 'UTC') || 'UTC', 'PW_TIMEZONE'),
};

export type Config = typeof config;
