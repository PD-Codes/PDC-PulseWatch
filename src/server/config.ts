import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import brand from '../../brand.json';

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
  trustProxy: bool('PW_TRUST_PROXY', false),
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
  session: { ttlHours: int('PW_SESSION_TTL_HOURS', 168), cookieSecure: bool('PW_COOKIE_SECURE', (read('PW_BASE_URL', '') ?? '').startsWith('https://')) },
  ssrf: { mode: read('PW_SSRF_MODE', 'allow-private') as 'allow-private' | 'public-only', allow: list('PW_SSRF_ALLOW'), deny: list('PW_SSRF_DENY') },
  retention: {
    rawDays: int('PW_RETENTION_RAW_DAYS', 14),
    minuteDays: int('PW_RETENTION_MINUTE_DAYS', 60),
    hourDays: int('PW_RETENTION_HOUR_DAYS', 400),
    dayDays: int('PW_RETENTION_DAY_DAYS', 3650),
    eventDays: int('PW_RETENTION_EVENT_DAYS', 365),
    auditDays: int('PW_RETENTION_AUDIT_DAYS', 730),
  },
  metricsToken: read('PW_METRICS_TOKEN'),
  deadman: { url: read('PW_DEADMAN_URL'), intervalSec: int('PW_DEADMAN_INTERVAL', 60) },
  smtp: {
    host: read('PW_SMTP_HOST'), port: int('PW_SMTP_PORT', 587), user: read('PW_SMTP_USER'), pass: read('PW_SMTP_PASS'),
    from: read('PW_SMTP_FROM', 'PulseWatch <pulsewatch@localhost>')!, secure: bool('PW_SMTP_SECURE', false),
  },
  demo: bool('PW_DEMO', false),
  rateLimit: { max: int('PW_RATE_LIMIT_MAX', 300), loginMax: int('PW_RATE_LIMIT_LOGIN', 10) },
  otlpEndpoint: read('PW_OTEL_EXPORTER_OTLP_ENDPOINT'),
};

export type Config = typeof config;
