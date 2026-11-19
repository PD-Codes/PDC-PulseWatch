import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createConnection } from 'mysql2/promise';
import { config } from '../config';

export interface MigrateResult { applied: string[]; skipped: number }

/**
 * Split a migration file into statements at top-level semicolons. Quotes, backticks and comments are respected;
 * DELIMITER blocks (stored procedures) are not supported, as before.
 */
export function splitStatements(text: string): { sql: string; line: number }[] {
  const out: { sql: string; line: number }[] = [];
  let start = 0, i = 0, line = 1, startLine = 1;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    // leading blanks and comments are skipped (but not executable comments such as /*! ... */)
    const lead = raw.match(/^(\s|--[^\n]*\n?|#[^\n]*\n?|\/\*(?!!|M!)[\s\S]*?\*\/)*/)![0];
    const body = raw.slice(lead.length).trim();
    if (body) out.push({ sql: body, line: startLine + (lead.match(/\n/g)?.length ?? 0) });
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) { if (text[i] === '\\' && c !== '`') i++; if (text[i] === '\n') line++; }
      i++; continue;
    }
    if ((c === '-' && text[i + 1] === '-') || c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); const stop = end < 0 ? text.length : end + 2; line += (text.slice(i, stop).match(/\n/g)?.length ?? 0); i = stop; continue; }
    if (c === ';') { push(i); start = i + 1; startLine = line; }
    i++;
  }
  push(text.length);
  return out;
}

/** Thrown when a migration file stops part-way; the statements before it are already committed (MariaDB DDL commits at once). */
export class MigrationError extends Error {
  constructor(readonly file: string, readonly statement: number, readonly total: number, readonly line: number, readonly checksum: string, cause: Error & { code?: string }) {
    super(
      `Migration ${file} failed at statement ${statement} of ${total} (line ${line}): ${cause.code ? `${cause.code}: ` : ''}${cause.message}\n` +
      (statement > 1 ? `Statements 1-${statement - 1} of ${file} are already applied and cannot be rolled back (MariaDB commits DDL immediately). ` : 'Nothing of this file was applied. ') +
      `To repair: fix the cause and restart (migrations written to the idempotent convention in migrations/README.md simply run again), ` +
      `or apply the remaining statements by hand and then mark the file as done with ` +
      `INSERT INTO schema_migrations (version, checksum) VALUES ('${file}', '${checksum}');`,
      { cause },
    );
    this.name = 'MigrationError';
  }
}

/**
 * Versioned SQL migrations. Files are applied in name order, each exactly once; the checksum
 * guards against edits of already-applied files. A named lock keeps app and worker from racing.
 * Statements run one by one, so a failure names the file and the statement.
 */
export interface MigrateOpts {
  /** How long to wait for another process that is migrating (it may build an index on a big table). */
  lockTimeoutMs?: number;
  /** Seconds one GET_LOCK attempt blocks before the wait is logged again. */
  lockPollS?: number;
  /** lock_wait_timeout of the migration session: a DDL that waits longer for its metadata lock gives up and is retried. */
  ddlLockWaitS?: number;
  /** Pause before such a retry, and how long to keep retrying one statement. */
  retryDelayMs?: number;
  retryForMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function migrate(dir = config.migrationsDir, log: (m: string) => void = console.log, opts: MigrateOpts = {}): Promise<MigrateResult> {
  const lockTimeoutMs = opts.lockTimeoutMs ?? 30 * 60_000, lockPollS = opts.lockPollS ?? 10, ddlLockWaitS = opts.ddlLockWaitS ?? 10;
  const retryDelayMs = opts.retryDelayMs ?? 5_000, retryForMs = opts.retryForMs ?? 30 * 60_000;
  const conn = await createConnection({
    host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: config.db.database,
    multipleStatements: true, charset: 'utf8mb4',
  });
  const applied: string[] = [];
  try {
    // the other role may be building an index on a big table for minutes: wait for it instead of failing the start
    for (const until = Date.now() + lockTimeoutMs; ;) {
      const [lock] = await conn.query<any[]>('SELECT GET_LOCK(?, ?) AS ok', ['pulsewatch_migrate', lockPollS]);
      if (lock[0].ok === 1) break;
      if (Date.now() >= until) throw new Error(`Could not acquire the migration lock within ${Math.round(lockTimeoutMs / 60_000)} min (another process is still migrating)`);
      log('[migrate] waiting for migrations of another process');
    }
    // a DDL statement queued behind a long transaction or a dump blocks every write to its table: give up quickly and retry
    await conn.query(`SET SESSION lock_wait_timeout = ${Math.max(1, Math.floor(ddlLockWaitS))}`);
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [rows] = await conn.query<any[]>('SELECT version, checksum FROM schema_migrations');
    const done = new Map<string, string>(rows.map((r: any) => [r.version, r.checksum]));
    const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const sum = crypto.createHash('sha256').update(text).digest('hex');
      const have = done.get(f);
      if (have) {
        if (have !== sum) throw new Error(`Migration ${f} was modified after being applied`);
        continue;
      }
      log(`[migrate] applying ${f}`);
      const statements = splitStatements(text);
      for (const [i, st] of statements.entries()) {
        for (const until = Date.now() + retryForMs; ;) {
          try { await conn.query(st.sql); break; } catch (e) {
            if ((e as { errno?: number }).errno !== 1205 || Date.now() >= until) throw new MigrationError(f, i + 1, statements.length, st.line, sum, e as Error);
            log(`[migrate] ${f} statement ${i + 1}: waited ${ddlLockWaitS}s for a table lock (long transaction or backup running?), retrying`);
            await sleep(retryDelayMs);
          }
        }
      }
      await conn.query('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)', [f, sum]);
      applied.push(f);
    }
    await conn.query("SELECT RELEASE_LOCK('pulsewatch_migrate')");
    return { applied, skipped: done.size };
  } finally {
    await conn.end();
  }
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate().then((r) => { console.log(`[migrate] done, applied ${r.applied.length}`); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
