import { defineConfig } from 'vitest/config';

// Standalone package: no workspace aliases needed (zod is the only runtime
// dependency), so the default resolution is already deterministic.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
