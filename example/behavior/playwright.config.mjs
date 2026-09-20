import { defineConfig } from 'playwright/test';

/**
 * Consumer-owned runner configuration. The named project is part of the
 * strict catalog identity; the engine's supervised runner synthesizes its
 * own trusted config during a gate run.
 */
export default defineConfig({
  testDir: './e2e',
  projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: true } }],
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: process.env.GATEFORGE_APP_BASE_URL ?? 'http://127.0.0.1:4175',
    trace: 'off',
  },
  webServer: {
    command: 'node server.js --port 4175',
    url: 'http://127.0.0.1:4175/imports/accounts',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
