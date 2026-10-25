import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SMOKE_PORT ?? 4174);

// Smoke-Test gegen den gebauten Stand (npm run test:smoke baut vorher).
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  reporter: process.env.CI ? 'line' : 'list',
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
