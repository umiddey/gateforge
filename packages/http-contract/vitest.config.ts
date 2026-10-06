import { defineConfig } from 'vitest/config';

// Standalone package: no workspace aliases needed (zod is the only runtime
// dependency), so the default resolution is already deterministic.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Running from a package directory must not fan out to one worker per CPU.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
