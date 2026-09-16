import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The workspace resolves @gate-forge/core to its built dist/, but tests run
// from source without a prior build: alias straight to core's TS entry.
export default defineConfig({
  resolve: {
    alias: {
      '@gate-forge/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
