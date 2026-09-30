/**
 * `@gate-forge/witness` — the runner-neutral gateforge witness.
 *
 * Phase 0 of plan 2026-09-25 lands the runner-adapter contract and its
 * conformance suite here, so the contract lives with the witness it
 * serves rather than inside a package named after one runner. Later
 * phases move the witness service itself (`witness/`), the per-test
 * session client, and the non-Playwright runner adapters into this
 * package; `@gate-forge/pack-playwright` re-exports them so existing
 * imports keep working.
 */
export * from './adapter/index.js';
// The seeded timing-chaos plan (E63). Exported so a run's schedule can
// be recomputed from (seed, session, route key, k) without replaying
// the whole suite - that is what makes a finding reproducible.
export * from './witness/chaos.js';
