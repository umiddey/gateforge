import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace deps resolve to their built dist/ via node_modules; tests run
// from source without a prior build, so alias straight to TS entries.
export default defineConfig({
  resolve: {
    alias: {
      '@gate-forge/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@gate-forge/http-contract': fileURLToPath(
        new URL('../http-contract/src/index.ts', import.meta.url),
      ),
      '@gate-forge/plugin-protocol': fileURLToPath(
        new URL('../plugin-protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
