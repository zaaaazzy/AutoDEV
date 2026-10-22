import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { localDatabaseUrl, readEnvValues } from '../src/core/local-database.js';

// Zufällige Zugangsdaten je Lauf; der Testserver nutzt eine eigene Datenbank (dev_log_e2e).
process.env.E2E_USERNAME ??= 'e2e-tester';
process.env.E2E_PASSWORD ??= randomBytes(16).toString('hex');
// Eigener Schlüssel je Lauf: Zwei-Faktor lässt sich nur mit DEV_LOG_SECRET_KEY einrichten (verschlüsselt gespeichert).
process.env.E2E_SECRET_KEY ??= randomBytes(32).toString('hex');
const PORT = Number(process.env.E2E_PORT ?? 3195);
// Admin-Zugang der lokalen Datenbank: vorgegeben (test:full, Worker) oder aus der .env, nie fest das Standardpasswort.
// Hier gesetzt, damit auch die Tests selbst (gleiche Umgebung in den Playwright-Workern) denselben Zugang nutzen.
process.env.E2E_ADMIN_DATABASE_URL ??= localDatabaseUrl(
  readEnvValues(join(import.meta.dirname, '..')),
  'postgres',
  'localhost',
);

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // In der CI zusätzlich Annotationen am Commit; die Fehler selbst stehen in beiden Fällen im Log (list).
  reporter: process.env.GITHUB_ACTIONS ? [['list'], ['github']] : [['list']],
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
      DEV_LOG_SECRET_KEY: process.env.E2E_SECRET_KEY,
      E2E_ADMIN_DATABASE_URL: process.env.E2E_ADMIN_DATABASE_URL,
      // Eigene Wegwerf-Datenbank des Testservers: das lokale Standardpasswort ist hier ausdrücklich erlaubt.
      DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD: '1',
    },
  },
});
