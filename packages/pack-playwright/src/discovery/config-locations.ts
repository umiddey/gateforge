/** Configuration search convention shared by enumeration and sealed-tree re-sealing. */
export const PLAYWRIGHT_CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
] as const;

/** Dependency trees, build output, VCS state, and runner artifacts are not projects. */
export const CONFIG_SEARCH_PRUNED_DIRS: Readonly<Record<string, true>> = {
  node_modules: true,
  dist: true,
  '.git': true,
  'test-results': true,
  coverage: true,
  build: true,
};
