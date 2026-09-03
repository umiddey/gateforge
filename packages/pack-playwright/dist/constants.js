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
export const CLAIM_ANNOTATION_TYPE = 'gateforge';
/** Per-run auth header on every witness call (pin #7). */
export const RUN_HEADER = 'x-gateforge-run';
/**
 * Verifier auth header on the witness attestation surface
 * (`GET /ledger-attestation` and the manifest MAC). Carries the
 * verifier key — a secret the orchestrator shares with the witness and
 * the evaluating CLI but NEVER with the tested suite (the suite's run
 * token authorizes evidence submission; it must not authorize
 * attestation, or a hostile suite could certify its own fabrications).
 */
export const VERIFIER_HEADER = 'x-gateforge-verifier';
/** Marker header the SUT (or its attestation proxy) must present. */
export const ENV_FINGERPRINT_HEADER = 'x-gateforge-env-fingerprint';
/** Marker header the SUT (or its attestation proxy) may present. */
export const ATTESTATION_SCOPE_HEADER = 'x-gateforge-attestation-scope';
/** Evidence kinds the witness /records endpoint accepts (plan §5.3). */
export const UI_ACTION_KIND = 'ui.action';
export const UI_VISIBLE_RESULT_KIND = 'ui.visible-result';
export const PERSISTENCE_KIND = 'persistence.entity';
/**
 * Domain-check kinds (ADR 0004 D8 pack namespaces). Suite-submitted
 * records of these kinds are accepted at the CLAIMED tier (trust follows
 * origin: the suite only asserts the scenario); witnessed check records
 * are issued ONLY by the engine-side `POST /witness/domain-check`
 * endpoint from proxy observations.
 */
export const AUTH_CHECK_KIND = 'auth.check';
export const WORKFLOW_CHECK_KIND = 'workflow.check';
export const WEBHOOK_CHECK_KIND = 'webhook.check';
export const TASK_CHECK_KIND = 'task.check';
export const VALIDATION_CHECK_KIND = 'validation.check';
export const DOMAIN_CHECK_KINDS = [
    AUTH_CHECK_KIND,
    WORKFLOW_CHECK_KIND,
    WEBHOOK_CHECK_KIND,
    TASK_CHECK_KIND,
    VALIDATION_CHECK_KIND,
];
export const KNOWN_RECORD_KINDS = [
    UI_ACTION_KIND,
    UI_VISIBLE_RESULT_KIND,
    ...DOMAIN_CHECK_KINDS,
];
/** Persistence kinds are ONLY issued by the witness (engine-side adapter reads). */
export const KNOWN_PERSISTENCE_KINDS = [PERSISTENCE_KIND];
/** Env the CLI test-gates suite already receives (documented contract). */
export const ENV_RUN_ID = 'GATEFORGE_RUN_ID';
export const ENV_RUN_TOKEN = 'GATEFORGE_RUN_TOKEN';
export const ENV_STATE_DIR = 'GATEFORGE_STATE_DIR';
export const ENV_OBLIGATIONS = 'GATEFORGE_OBLIGATIONS';
export const ENV_WITNESS_URL = 'GATEFORGE_WITNESS_URL';
/** Pack-extended env surface (documented in this package's README). */
export const ENV_APP_BASE_URL = 'GATEFORGE_APP_BASE_URL';
export const ENV_TARGET_BASE_URL = 'GATEFORGE_TARGET_BASE_URL';
export const ENV_TARGET_FINGERPRINT = 'GATEFORGE_TARGET_FINGERPRINT';
export const ENV_ADAPTERS_DIR = 'GATEFORGE_ADAPTERS_DIR';
export const ENV_CLASSIFICATIONS = 'GATEFORGE_CLASSIFICATIONS';
export const ENV_ADAPTER_BASE_URL = 'GATEFORGE_ADAPTER_BASE_URL';
/** Opt-in reporter exit-code semantics (standalone runs only). */
export const ENV_REPORTER_FAIL_RUN = 'GATEFORGE_REPORTER_FAIL_RUN';
/** Witness file inside the state dir carrying the spawned URL. */
export const WITNESS_URL_FILE = 'witness-url.json';
/** Default per-witness-call timeout (pin #7: 5s). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
/** The loopback hostname the witness, proxy, and fixture servers bind. */
export const LOOPBACK_HOSTNAME = '127.0.0.1';
/** Loopback-equivalent hostnames the witness accepts as attestation subjects. */
export const LOOPBACK_HOSTS = {
    localhost: true,
    '[::1]': true,
    '::1': true,
    '127.0.0.1': true,
};
//# sourceMappingURL=constants.js.map