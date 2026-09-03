/**
 * Shared constants of the Playwright evidence pack (pin #7, plan §5.3).
 *
 * These names are the wire contract between the fixture (test process),
 * the reporter (runner process), and the witness service (engine
 * process). They are also the documented env surface of `gateforge
 * test-gates` (packages/cli/README.md "test-gates protocol") — the CLI
 * already exports GATEFORGE_RUN_ID / GATEFORGE_RUN_TOKEN /
 * GATEFORGE_STATE_DIR / GATEFORGE_OBLIGATIONS / GATEFORGE_WITNESS_URL;
 * the pack augments the target/attestation/adapter surface below.
 */
/** Claim annotation type: `{type: 'gateforge', description: '<obligation id>'}`. */
export declare const CLAIM_ANNOTATION_TYPE = "gateforge";
/** Per-run auth header on every witness call (pin #7). */
export declare const RUN_HEADER = "x-gateforge-run";
/**
 * Verifier auth header on the witness attestation surface
 * (`GET /ledger-attestation` and the manifest MAC). Carries the
 * verifier key — a secret the orchestrator shares with the witness and
 * the evaluating CLI but NEVER with the tested suite (the suite's run
 * token authorizes evidence submission; it must not authorize
 * attestation, or a hostile suite could certify its own fabrications).
 */
export declare const VERIFIER_HEADER = "x-gateforge-verifier";
/** Marker header the SUT (or its attestation proxy) must present. */
export declare const ENV_FINGERPRINT_HEADER = "x-gateforge-env-fingerprint";
/** Marker header the SUT (or its attestation proxy) may present. */
export declare const ATTESTATION_SCOPE_HEADER = "x-gateforge-attestation-scope";
/** Evidence kinds the witness /records endpoint accepts (plan §5.3). */
export declare const UI_ACTION_KIND = "ui.action";
export declare const UI_VISIBLE_RESULT_KIND = "ui.visible-result";
export declare const PERSISTENCE_KIND = "persistence.entity";
export declare const KNOWN_RECORD_KINDS: readonly string[];
/** Persistence kinds are ONLY issued by the witness (engine-side adapter reads). */
export declare const KNOWN_PERSISTENCE_KINDS: readonly string[];
/** Env the CLI test-gates suite already receives (documented contract). */
export declare const ENV_RUN_ID = "GATEFORGE_RUN_ID";
export declare const ENV_RUN_TOKEN = "GATEFORGE_RUN_TOKEN";
export declare const ENV_STATE_DIR = "GATEFORGE_STATE_DIR";
export declare const ENV_OBLIGATIONS = "GATEFORGE_OBLIGATIONS";
export declare const ENV_WITNESS_URL = "GATEFORGE_WITNESS_URL";
/** Pack-extended env surface (documented in this package's README). */
export declare const ENV_APP_BASE_URL = "GATEFORGE_APP_BASE_URL";
export declare const ENV_TARGET_BASE_URL = "GATEFORGE_TARGET_BASE_URL";
export declare const ENV_TARGET_FINGERPRINT = "GATEFORGE_TARGET_FINGERPRINT";
export declare const ENV_ADAPTERS_DIR = "GATEFORGE_ADAPTERS_DIR";
export declare const ENV_CLASSIFICATIONS = "GATEFORGE_CLASSIFICATIONS";
export declare const ENV_ADAPTER_BASE_URL = "GATEFORGE_ADAPTER_BASE_URL";
/** Opt-in reporter exit-code semantics (standalone runs only). */
export declare const ENV_REPORTER_FAIL_RUN = "GATEFORGE_REPORTER_FAIL_RUN";
/** Witness file inside the state dir carrying the spawned URL. */
export declare const WITNESS_URL_FILE = "witness-url.json";
/** Default per-witness-call timeout (pin #7: 5s). */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
/** The loopback hostname the witness, proxy, and fixture servers bind. */
export declare const LOOPBACK_HOSTNAME = "127.0.0.1";
/** Loopback-equivalent hostnames the witness accepts as attestation subjects. */
export declare const LOOPBACK_HOSTS: Record<string, true>;
//# sourceMappingURL=constants.d.ts.map