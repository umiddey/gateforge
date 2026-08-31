/**
 * @gateforge/pack-playwright — the Playwright evidence pack.
 *
 * Public surface:
 *
 * - Fixture: `{ test, expect }` — the extended runner exposing the
 *   trusted `evidence` primitives (tests import from THIS package,
 *   never raw `playwright/test` — GF-24).
 * - Reporter: `GateforgeReporter` — annotations → claims.json +
 *   records.json into the run-state dir, per-claim verdicts via the
 *   engine, gate pass/fail summary (GF-23 enforcement).
 * - Witness: `startWitness` + `startWitnessProcess` — loopback
 *   engine-side service (GF-10/11/13), plus the `gateforge-witness`
 *   bin.
 * - Attestation: `startAttestationProxy` — stamps a disposable loopback
 *   app with the env-fingerprint markers (GF-13).
 * - Setup: `gateforgeGlobalSetup` / `gateforgeGlobalTeardown` — spawn
 *   the witness deterministically before workers (no races).
 */
export { test, expect } from './fixture/fixture.js';
export { createEvidence, claimsFromAnnotations, resourceIdOfClaim, } from './fixture/evidence.js';
export { WitnessClient, WitnessRequestError, resolveWitnessUrl } from './fixture/witness-client.js';
export { GateforgeReporter } from './reporter/reporter.js';
export { startWitness, WitnessStartupError, recordIdOf } from './witness/server.js';
export { loadAdapters, validateAdapter, AdapterRegistryError } from './witness/adapter-registry.js';
export { isLoopbackUrl, probeEnvFingerprint, envFingerprintMismatch, AttestationError, } from './witness/env-attestation.js';
export { loadClassifications, toClassificationView } from './witness/classifications.js';
export { startAttestationProxy } from './attestation/proxy.js';
export { gateforgeGlobalSetup, gateforgeGlobalTeardown, startWitnessProcess } from './setup.js';
export { CLAIM_ANNOTATION_TYPE, RUN_HEADER, ENV_FINGERPRINT_HEADER, ATTESTATION_SCOPE_HEADER, UI_ACTION_KIND, UI_VISIBLE_RESULT_KIND, PERSISTENCE_KIND, ENV_RUN_ID, ENV_RUN_TOKEN, ENV_STATE_DIR, ENV_OBLIGATIONS, ENV_WITNESS_URL, ENV_APP_BASE_URL, ENV_TARGET_BASE_URL, ENV_TARGET_FINGERPRINT, ENV_ADAPTERS_DIR, ENV_CLASSIFICATIONS, ENV_ADAPTER_BASE_URL, WITNESS_URL_FILE, ENV_REPORTER_FAIL_RUN, DEFAULT_REQUEST_TIMEOUT_MS, } from './constants.js';
//# sourceMappingURL=index.js.map