import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

/**
 * Kompletter Oberflächentest (npm run test:full): alle Seiten, Tabellen und Abläufe, mit Video und Screenshots.
 * Eigener Port, eigene Datenbank (dev_log_full) und eigener Ausgabeordner, damit er neben den E2E-Tests laufen kann.
 */
const PORT = Number(process.env.FULL_UI_PORT ?? 3196);
const baseServer = base.webServer;
if (!baseServer || Array.isArray(baseServer))
  throw new Error('e2e/playwright.config.ts braucht genau einen webServer.');

export default defineConfig({
  ...base,
  testMatch: 'full-ui.check.ts',
  timeout: 180_000,
  outputDir: process.env.FULL_UI_OUTPUT ?? join(tmpdir(), 'dev-log-full-ui'),
  reporter: [['list'], ['json', { outputFile: process.env.FULL_UI_JSON ?? join(tmpdir(), 'dev-log-full-ui.json') }]],
  use: {
    ...base.use,
    baseURL: `http://127.0.0.1:${PORT}`,
    actionTimeout: 15_000,
    // Video nur, wenn ein Test scheitert: Aufzeichnen kostet bei jedem Test Rechenzeit und Hunderte MB.
    video: 'retain-on-failure',
    screenshot: 'on',
    trace: 'off',
  },
  webServer: {
    ...baseServer,
    url: `http://127.0.0.1:${PORT}/health`,
    env: {
      ...baseServer.env,
      PORT: String(PORT),
      E2E_DATABASE: process.env.FULL_UI_DATABASE ?? 'dev_log_full',
    },
  },
});
