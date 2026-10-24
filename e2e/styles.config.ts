import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
import { reserveDatabase, reservePort } from './test-ports.js';

/**
 * Style-Schnappschüsse (npm run check:styles): berechnete Styles und Screenshots aller Seiten, Desktop und Handy.
 * Eigener Port und eigene Datenbank (dev_log_styles), damit der Lauf neben E2E- und Oberflächentests laufen kann.
 */
const PORT = reservePort('STYLES_PORT', 3197);
const DATABASE = reserveDatabase('STYLES_DATABASE', 'dev_log_styles', PORT, 3197);
const baseServer = base.webServer;
if (!baseServer || Array.isArray(baseServer))
  throw new Error('e2e/playwright.config.ts braucht genau einen webServer.');

export default defineConfig({
  ...base,
  testMatch: 'styles-snapshot.check.ts',
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  webServer: {
    ...baseServer,
    url: `http://127.0.0.1:${PORT}/health`,
    env: { ...baseServer.env, PORT: String(PORT), E2E_DATABASE: DATABASE },
  },
});
