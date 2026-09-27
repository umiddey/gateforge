import { defineConfig } from 'vitest/config';

// Each workspace package opts in with its own vitest.config.ts; the root
// config never needs edits when new packages appear.
export default defineConfig({
  test: {
    // Build shared workspace dists before any project worker starts.
    globalSetup: ['packages/pack-playwright/test/global-setup.ts'],
    projects: ['packages/*/vitest.config.ts'],
  },
});
