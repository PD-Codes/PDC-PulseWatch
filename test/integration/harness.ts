// Integration test harness: every test file gets its own database on a real MariaDB and a fully wired Fastify app.
// Connection defaults match `docker run -e MARIADB_ROOT_PASSWORD=dev -p 3306:3306 mariadb:11`; override with PW_TEST_DB_*.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';

const admin = {
  host: process.env.PW_TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.PW_TEST_DB_PORT ?? 3306),
  user: process.env.PW_TEST_DB_USER ?? 'root',
  password: process.env.PW_TEST_DB_PASSWORD ?? 'dev',
};

export async function startApp() {
  const dbName = `pw_it_${crypto.randomBytes(4).toString('hex')}`;
  const root = await mysql.createConnection(admin);
  await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();

  Object.assign(process.env, {
    PW_DB_HOST: admin.host, PW_DB_PORT: String(admin.port), PW_DB_USER: admin.user, PW_DB_PASSWORD: admin.password, PW_DB_NAME: dbName,
    PW_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pw-it-')), PW_SECRET_KEY: crypto.randomBytes(32).toString('base64'),
    PW_MIGRATIONS_DIR: path.resolve(import.meta.dirname, '../../migrations'), PW_LOG_LEVEL: 'silent',
    PW_RATE_LIMIT_LOGIN: '1000', PW_RATE_LIMIT_MAX: '100000', PW_BASE_URL: 'http://localhost:3000', PW_DEMO: 'false',
  });

  // Imported late: config reads the environment at import time.
  const { createServices } = await import('../../src/server/services');
  const { buildApp } = await import('../../src/server/app');
  const { migrate } = await import('../../src/server/db/migrate');
  const { registerAllRoutes } = await import('../../src/server/routes');
  const ctx = createServices();
  await migrate(process.env.PW_MIGRATIONS_DIR, () => {});
  const app = await buildApp(ctx, { extraRoutes: [registerAllRoutes] });
  await app.ready();

  /** Minimal cookie-jar client over app.inject. */
  const client = (opts: { bearer?: string } = {}) => {
    const jar = new Map<string, string>();
    let csrf = '';
    const call = async (method: string, url: string, body?: unknown, extra: { csrf?: boolean; headers?: Record<string, string> } = {}) => {
      const headers: Record<string, string> = { ...(extra.headers ?? {}) };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
      if (csrf && extra.csrf !== false) headers['x-csrf-token'] = csrf;
      const res = await app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers });
      for (const c of res.cookies) { if (c.value) jar.set(c.name, c.value); else jar.delete(c.name); }
      let json: any; try { json = res.json(); } catch { json = undefined; }
      if (json && typeof json.csrf === 'string') csrf = json.csrf;
      return { status: res.statusCode, json, body: res.body, headers: res.headers };
    };
    return { call, get: (u: string) => call('GET', u), post: (u: string, b?: unknown) => call('POST', u, b ?? {}), put: (u: string, b?: unknown) => call('PUT', u, b), del: (u: string) => call('DELETE', u), jar };
  };

  const close = async () => {
    await app.close();
    await ctx.db.destroy();
    const c = await mysql.createConnection(admin);
    await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await c.end();
  };
  return { app, ctx, client, close, dbName };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

/** Creates the first admin and returns a logged-in client. */
export async function loggedInAdmin(t: TestApp) {
  const c = t.client();
  const r = await c.post('/api/setup', { username: 'admin', password: 'correct-horse-battery-1' });
  if (r.status !== 200) throw new Error(`setup failed: ${r.status} ${r.body}`);
  return c;
}
