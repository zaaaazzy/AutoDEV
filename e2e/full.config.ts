import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Kompletter Oberflächentest (npm run test:full): alle Seiten, Tabellen und Abläufe, mit Video und Screenshots.
 * Nutzt denselben Testserver wie die E2E-Tests (eigene Datenbank dev_log_e2e).
 */
export default defineConfig({
  ...base,
  testMatch: 'full-ui.check.ts',
  timeout: 180_000,
  outputDir: '../test-results/full-ui',
  reporter: [['list'], ['json', { outputFile: process.env.FULL_UI_JSON ?? '../test-results/full-ui.json' }]],
  use: { ...base.use, video: 'on', screenshot: 'on', trace: 'off' },
});
