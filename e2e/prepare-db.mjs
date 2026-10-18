import mysql from 'mysql2/promise';

// Fresh database for every run so the demo seed always starts from scratch.
async function main() {
  const c = await mysql.createConnection({
    host: process.env.PW_TEST_DB_HOST ?? '127.0.0.1', port: Number(process.env.PW_TEST_DB_PORT ?? 3306),
    user: process.env.PW_TEST_DB_USER ?? 'root', password: process.env.PW_TEST_DB_PASSWORD ?? 'dev',
  });
  await c.query('DROP DATABASE IF EXISTS pw_e2e');
  await c.query('CREATE DATABASE pw_e2e CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await c.end();
}
main();
