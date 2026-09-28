import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The contract suite boots the real loopback witness and spawns
    // runner children; give each honest run room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
