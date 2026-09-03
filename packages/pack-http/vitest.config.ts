import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their built dist/, but tests run from
// source without a prior build: alias straight to the TS entries.
export default defineConfig({
  resolve: {
    alias: {
      '@gateforge/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@gateforge/plugin-protocol': fileURLToPath(
        new URL('../plugin-protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
