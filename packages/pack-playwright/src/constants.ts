/**
 * Compatibility re-export: `constants` now lives in the runner-neutral
 * `@gate-forge/witness` package (plan 2026-09-25 phase 1).
 *
 * The move is physical, not behavioural: this module forwards every
 * export unchanged so `@gate-forge/pack-playwright`'s published import
 * paths — which consumers pin — keep resolving to the same values.
 */
export * from '@gate-forge/witness/constants';

/**
 * Non-secret runner-child context: the absolute directory holding the
 * consumer's Playwright config, handed to the supervised runner so the
 * evidence fixture can bind to the SAME consumer runner the enumeration
 * and the supervised execution use (see fixture/consumer-runner.ts).
 * A path, never a secret; unset is normal (a repository that relies on the
 * pack's own pinned runner).
 */
export const ENV_PLAYWRIGHT_CONFIG_DIR = 'GATEFORGE_PLAYWRIGHT_CONFIG_DIR';
