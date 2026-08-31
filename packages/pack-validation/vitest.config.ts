import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@gateforge/pack-validation',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
