import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { config } from '../config';
import type { DB } from './types';

export type Database = Kysely<DB>;

export function createDb(overrides: Partial<typeof config.db> = {}): Database {
  const c = { ...config.db, ...overrides };
  return new Kysely<DB>({
    dialect: new MysqlDialect({
      pool: createPool({
        host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
        connectionLimit: c.pool, timezone: 'Z', dateStrings: false, supportBigNumbers: true, bigNumberStrings: false,
        charset: 'utf8mb4', waitForConnections: true, enableKeepAlive: true,
      }),
    }),
  });
}

/** Flag columns come back as 0/1 numbers. */
export const bool = (v: number | boolean | null | undefined) => v === 1 || v === true;

/** MariaDB JSON columns are LONGTEXT; parse defensively. */
export function parseJson<T>(v: string | null | undefined, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}
