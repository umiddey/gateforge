import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@gate-forge/pack-validation',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Running from a package directory must not fan out to one worker per CPU.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
