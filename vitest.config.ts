import { defineConfig } from 'vitest/config';

// Each workspace package opts in with its own vitest.config.ts; the root
// config never needs edits when new packages appear.
export default defineConfig({
  test: {
    // Build shared workspace dists before any project worker starts.
    globalSetup: ['packages/pack-playwright/test/global-setup.ts'],
    projects: ['packages/*/vitest.config.ts'],
    // Each outer file worker can boot several real runner/browser children
    // (playwright browsers, witness subprocesses, alembic/pack servers), so a
    // CPU-count-sized outer pool can oversubscribe the CPUs and starve those
    // children. Cap outer file parallelism; every worker still runs its own
    // subprocesses.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
