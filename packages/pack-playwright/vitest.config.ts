import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The real-Playwright e2e boots chromium against the example app
    // through the loopback witness; give the honest+cheat runs room.
    testTimeout: 240_000,
    hookTimeout: 60_000,
    // Running from a package directory must not fan out to one worker per CPU.
    maxWorkers: 2,
    minWorkers: 1,
  },
});