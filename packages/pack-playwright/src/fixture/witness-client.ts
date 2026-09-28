/**
 * Compatibility re-export: `client` now lives in the runner-neutral
 * `@gate-forge/witness` package (plan 2026-09-25 phase 1).
 *
 * The move is physical, not behavioural: this module forwards every
 * export unchanged so `@gate-forge/pack-playwright`'s published import
 * paths — which consumers pin — keep resolving to the same values.
 */
export * from '@gate-forge/witness/client';
