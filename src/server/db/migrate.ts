import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createConnection } from 'mysql2/promise';
import { config } from '../config';

export interface MigrateResult { applied: string[]; skipped: number }

/**
 * Versioned SQL migrations. Files are applied in name order, each exactly once; the checksum
 * guards against edits of already-applied files. A named lock keeps app and worker from racing.
 */
export async function migrate(dir = config.migrationsDir, log: (m: string) => void = console.log): Promise<MigrateResult> {
  const conn = await createConnection({
    host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: config.db.database,
    multipleStatements: true, charset: 'utf8mb4',
  });
  const applied: string[] = [];
  try {
    const [lock] = await conn.query<any[]>("SELECT GET_LOCK('pulsewatch_migrate', 120) AS ok");
    if (lock[0].ok !== 1) throw new Error('Could not acquire the migration lock');
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [rows] = await conn.query<any[]>('SELECT version, checksum FROM schema_migrations');
    const done = new Map<string, string>(rows.map((r: any) => [r.version, r.checksum]));
    const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');
      const have = done.get(f);
      if (have) {
        if (have !== sum) throw new Error(`Migration ${f} was modified after being applied`);
        continue;
      }
      log(`[migrate] applying ${f}`);
      await conn.query(sql);
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
