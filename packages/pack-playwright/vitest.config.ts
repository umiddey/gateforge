import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The real-Playwright e2e boots chromium against the example app
    // through the loopback witness; give the honest+cheat runs room.
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});