import { defineConfig } from 'vitest/config';

// Each workspace package opts in with its own vitest.config.ts; the root
// config never needs edits when new packages appear.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
  },
});
