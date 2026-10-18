import { parseJson } from './db';
import type { Database } from './db';

/** Key/value settings with a short in-memory cache (other processes may change them). */
export class Settings {
  private cache = new Map<string, { v: unknown; exp: number }>();
  constructor(private db: Database, private ttlMs = 10_000) {}

  async get<T>(key: string, def: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v as T;
    const row = await this.db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
    const v = row ? parseJson<T>(row.value, def) : def;
    this.cache.set(key, { v, exp: Date.now() + this.ttlMs });
    return v;
  }

  async set(key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    await this.db.insertInto('settings').values({ key, value: json }).onDuplicateKeyUpdate({ value: json }).execute();
    this.cache.delete(key);
  }

  async delete(key: string): Promise<void> {
    await this.db.deleteFrom('settings').where('key', '=', key).execute();
    this.cache.delete(key);
  }

  async all(prefix = ''): Promise<Record<string, unknown>> {
    const rows = await this.db.selectFrom('settings').selectAll().where('key', 'like', `${prefix}%`).execute();
    return Object.fromEntries(rows.map((r) => [r.key, parseJson(r.value, null)]));
  }
}
