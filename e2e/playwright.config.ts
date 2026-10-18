import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// Zufällige Zugangsdaten je Lauf; der Testserver nutzt eine eigene Datenbank (dev_log_e2e).
process.env.E2E_USERNAME ??= 'e2e-tester';
process.env.E2E_PASSWORD ??= randomBytes(16).toString('hex');
const PORT = Number(process.env.E2E_PORT ?? 3195);

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'handy', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npx tsx e2e/serve.ts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DEV_LOG_HOST: '127.0.0.1',
      DEV_LOG_USERNAME: process.env.E2E_USERNAME,
      DEV_LOG_PASSWORD: process.env.E2E_PASSWORD,
      E2E_ADMIN_DATABASE_URL:
        process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://devlog:devlog_local_dev@localhost:5433/postgres',
    },
  },
});
