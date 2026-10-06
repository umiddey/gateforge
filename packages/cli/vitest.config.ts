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
      '@gate-forge/pack-alembic': fileURLToPath(new URL('../pack-alembic/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    // Verifier-keyring isolation: the suite must never read the developer's
    // real `~/.config/gateforge/verifier-keyring.json` (see the file).
    setupFiles: ['test/setup-verifier-isolation.ts'],
    // Running from a package directory must not fan out to one worker per CPU.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
