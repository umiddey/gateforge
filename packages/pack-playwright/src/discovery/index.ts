/**
 * Test discovery surface of the Playwright pack (plan 2026-09-13
 * phase 2): bounded static scanning, native reconciliation, kind
 * inference, the runner adapters, and the pytest diagnostic adapter.
 */
export * from './adapter-projection.js';
export * from './static-discovery.js';
export * from './git-ignore.js';
export * from './inference.js';
export * from './reconcile.js';
export * from './prepare-barrier.js';
export { localPlaywrightCliCandidates } from '../runner-resolution.js';
export { CONFIG_SEARCH_PRUNED_DIRS, PLAYWRIGHT_CONFIG_NAMES } from './config-locations.js';
export * from './runner-config-paths.js';
export * from './pytest-adapter.js';
export * from './discover.js';
export * from './adapters.js';
export * from './supervised-run.js';
export * from './trusted-config.js';
export * from './runner-env.js';
export * from './runner-file-scope.js';
export * from './surface-doctor.js';
export * from './playwright-runner-adapter.js';
export * from './pytest-runner-adapter.js';
export * from './vitest-runner-adapter.js';
export * from './cypress-runner-adapter.js';
