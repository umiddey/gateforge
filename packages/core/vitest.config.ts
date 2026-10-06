import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Running from a package directory must not fan out to one worker per CPU.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
