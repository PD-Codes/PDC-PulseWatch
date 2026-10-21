import { defineConfig } from '@playwright/test';

// Runs against the built server in demo mode (npm run build first). Needs a MariaDB; see test/integration/harness.ts for defaults.
const port = 3500;
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'en-US',
    launchOptions: process.env.PW_E2E_CHROMIUM ? { executablePath: process.env.PW_E2E_CHROMIUM } : {},
  },
  webServer: {
    command: 'node e2e/prepare-db.mjs && node dist/server/main.js',
    url: `http://127.0.0.1:${port}/ready`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      PW_PORT: String(port), PW_HOST: '127.0.0.1', PW_DEMO: 'true', PW_DEMO_PASSWORD: 'e2e-password-1', PW_LOG_LEVEL: 'warn',
      PW_DB_HOST: process.env.PW_TEST_DB_HOST ?? '127.0.0.1', PW_DB_PORT: process.env.PW_TEST_DB_PORT ?? '3306',
      PW_DB_USER: process.env.PW_TEST_DB_USER ?? 'root', PW_DB_PASSWORD: process.env.PW_TEST_DB_PASSWORD ?? 'dev', PW_DB_NAME: 'pw_e2e',
      PW_DATA_DIR: '.e2e-data', PW_SECRET_KEY: 'e2e-secret-key-not-for-production', PW_RATE_LIMIT_LOGIN: '1000', PW_RATE_LIMIT_MAX: '100000',
    },
  },
});
