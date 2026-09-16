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
export { createEvidence, claimsFromAnnotations, resourceIdOfClaim, SURFACE_DESCRIPTOR_VERSION, } from './fixture/evidence.js';
export { WitnessClient, WitnessRequestError, resolveWitnessUrl } from './fixture/witness-client.js';
export { GateforgeReporter, gateSummaryLine } from './reporter/reporter.js';
export { startWitness, WitnessStartupError, recordIdOf } from './witness/server.js';
export { loadAdapters, validateAdapter, AdapterRegistryError } from './witness/adapter-registry.js';
export { isLoopbackUrl, isLoopbackUrlResolving, clearLoopbackCacheForTests, probeEnvFingerprint, envFingerprintMismatch, AttestationError, } from './witness/env-attestation.js';
export { loadClassifications, toClassificationView } from './witness/classifications.js';
export { startAttestationProxy } from './attestation/proxy.js';
export { gateforgeGlobalSetup, gateforgeGlobalTeardown, startWitnessProcess } from './setup.js';
/**
 * Supervisor surface (enforcement-review fixes 2a/3): the lifecycle
 * spool (runner → CLI), the verifier-key-authenticated supervisor
 * client, and the spool drain the trusted CLI runs while the suite
 * executes. The runner child itself holds no supervisor rights.
 *
 * Server-witnessed persistence channel: `appendPersistenceIntent` is the
 * documented TS writer for the suite-side intents spool (the CONTRACT is
 * the JSONL line — a ~30-line Python equivalent ships in
 * `packages/pack-playwright/python/gateforge_persistence_intents.py`);
 * the drain forwards intents to the witness, whose adapter SERVER PROBE
 * (probeServer) runs witness-side and stamps `channel: 'server'`
 * records for obligations registered `kind: server-e2e`.
 */
export { appendSpoolEvent, readSpoolEvents, spoolPathFor, appendPersistenceIntent, readPersistenceIntents, persistenceIntentsPathFor, startSupervisorSpoolDrain, SupervisorClient, DEFAULT_DRAIN_POLL_MS, } from './supervisor/index.js';
export { buildRunnerChildEnv, RunnerEnvError, RUNNER_SECRET_ENV, RUNNER_PARENT_SIDE_ENV, RUNNER_GATEFORGE_ALLOWLIST, RUNNER_SYSTEM_ALLOWLIST, } from './discovery/runner-env.js';
export { synthesizeTrustedConfig, trustedReporterEntry, TRUSTED_CONFIG_FILE, TRUSTED_REPORTER_OPTIONS_FILE, } from './discovery/trusted-config.js';
/**
 * Test discovery (plan 2026-09-13 phase 2): bounded static scanning,
 * native `--list` reconciliation, kind/category inference, the
 * runner-adapter implementations, and the bounded pytest diagnostic
 * adapter.
 */
export { discoverTestCatalog, inferTestKind, listNativePlaywrightTests, findPlaywrightConfig, untrustedEnv, reconciliationKey, splitPytestNodeId, fileDigest, scanTestFiles, parseJunitXml, pytestCollectArgv, pytestExecutionArgv, collectPytestSuite, executePytestSuite, executeSupervisedPlaywright, readRunnerOutcomes, playwrightVersion, PlaywrightAdapter, PytestAdapter, TestDiscoveryError, JunitParseError, AdapterCapabilityError, DEFAULT_LIST_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS, UNRESOLVED_TITLE_PLACEHOLDER, DEFAULT_MAX_TRAVERSED_FILES, DEFAULT_MAX_IMPORT_DEPTH, BROWSER_FIXTURE_PARAMS, API_FIXTURE_PARAMS, } from './discovery/index.js';
export { CLAIM_ANNOTATION_TYPE, RUN_HEADER, VERIFIER_HEADER, ENV_FINGERPRINT_HEADER, ATTESTATION_SCOPE_HEADER, UI_ACTION_KIND, UI_VISIBLE_RESULT_KIND, PERSISTENCE_KIND, ENV_RUN_ID, ENV_RUN_TOKEN, ENV_STATE_DIR, ENV_OBLIGATIONS, ENV_WITNESS_URL, ENV_APP_BASE_URL, ENV_TARGET_BASE_URL, ENV_TARGET_FINGERPRINT, ENV_ADAPTERS_DIR, ENV_CLASSIFICATIONS, ENV_ADAPTER_BASE_URL, WITNESS_URL_FILE, ENV_REPORTER_FAIL_RUN, ENV_OUTCOMES_FILE, CLAIM_INJECTIONS_FILE, EXECUTION_RESULT_FILE, GATE_RECEIPT_FILE, DIAGNOSTICS_REPORT_FILE, SPOOL_DIR_NAME, SPOOL_EVENTS_FILE, SPOOL_INTENTS_FILE, SERVER_CHANNEL, SERVER_E2E_TEST_KIND, DEFAULT_REQUEST_TIMEOUT_MS, } from './constants.js';
//# sourceMappingURL=index.js.map