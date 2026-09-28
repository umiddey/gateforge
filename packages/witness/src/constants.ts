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
 * Observe-channel persistence kind (Phase 2): issued ONLY by the
 * witness's observe finalize (engine-side proxy capture + adapter
 * read) — never suite-submittable (`/records` rejects it like every
 * persistence kind) and never engine-driven.
 */
export const OBSERVED_KIND = 'persistence.observed';
export const KNOWN_RECORD_KINDS: readonly string[] = [
  UI_ACTION_KIND,
  UI_VISIBLE_RESULT_KIND,
];
/** Persistence kinds are ONLY issued by the witness (engine-side adapter reads). */
export const KNOWN_PERSISTENCE_KINDS: readonly string[] = [PERSISTENCE_KIND, OBSERVED_KIND];

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
/** Observation proxy target (loopback base URL the proxy forwards to). */
export const ENV_PROXY_TARGET = 'GATEFORGE_PROXY_TARGET';
/**
 * Observation-proxy mount prefix (e.g. `/api`): the browser-facing path
 * prefix a frontend dev proxy adds before backend routes. The proxy
 * strips it before forwarding and before recording observations, so
 * records match backend-derived obligation identities.
 */
export const ENV_MOUNT_PATH = 'GATEFORGE_MOUNT_PATH';
/**
 * Verifier key for the witness attestation surface. Environment ONLY —
 * never argv (a process's cmdline is world-readable via /proc), and
 * never exported to the tested suite. Same variable the orchestrating
 * CLI reads (`gateforge test-gates`).
 */
export const ENV_WITNESS_VERIFIER_KEY = 'GATEFORGE_WITNESS_VERIFIER_KEY';

/** Opt-in reporter exit-code semantics (standalone runs only). */
export const ENV_REPORTER_FAIL_RUN = 'GATEFORGE_REPORTER_FAIL_RUN';

/**
 * Absolute path of the runner-outcomes document the gateforge reporter
 * writes for trusted runner supervision (plan Phase 4 item 4, ADR 0005
 * D2): per-instance outcomes, attempts, expected failures, and the
 * run-level fixture/teardown outcome. Set by the supervised adapter
 * (`test-gates --changed`); when absent the reporter writes nothing —
 * supervision then fails closed on the missing outcomes file.
 */
export const ENV_OUTCOMES_FILE = 'GATEFORGE_OUTCOMES_FILE';

/**
 * Run-state file (written by the orchestrating CLI) carrying the mapped
 * obligation claims for sidecar/native-mapped tests, keyed by
 * `<file>#<titlePath.join('>')>` (the reconciliation key). The reporter
 * carries these claims on the session-open path (Phase 4 claim
 * injection) so their evidence lands on the right claims; native
 * annotations keep working unchanged.
 */
export const CLAIM_INJECTIONS_FILE = 'claim-injections.json';

/** Run-state file carrying the sealed supervision execution result. */
export const EXECUTION_RESULT_FILE = 'execution-result.json';

/**
 * Run-state spool directory (enforcement-review fix 3): the runner-side
 * reporter writes test lifecycle events (testBegin/testEnd with outcome)
 * as NUL-safe JSON lines under `<stateDir>/spool/<runId>/`; the trusted
 * CLI drains them and performs the witness supervisor calls (session
 * open/close) with credentials that exist ONLY in the CLI process. The
 * runner child holds no supervisor rights.
 */
export const SPOOL_DIR_NAME = 'spool';

/** The spool's event file (JSON lines; consumed by the CLI drain loop). */
export const SPOOL_EVENTS_FILE = 'events.jsonl';

/**
 * The spool's persistence-claim-intent file (JSON lines; same NUL-safe
 * line protocol as `events.jsonl`): the supervised (UNTRUSTED) test
 * process reports claim INTENTS here — {entity, operation, phase, intent,
 * key, claimId, testId, sequence}. The suite can only write intents; it
 * can NEVER stamp evidence. The trusted CLI's spool drain forwards each
 * intent to the witness over the verifier-key supervisor surface, where
 * the resource's adapter SERVER PROBE runs (witness-side) and — only
 * then — a witnessed `persistence.entity` record stamped
 * `channel: 'server'` may be issued.
 */
export const SPOOL_INTENTS_FILE = 'persistence-intents.jsonl';

/**
 * Payload discriminant the witness stamps on server-probed persistence
 * records (core's verdict engine keys the server-witnessed channel off
 * this + {@link SERVER_E2E_TEST_KIND}).
 */
export const SERVER_CHANNEL = 'server';

/** The mapping kind that unlocks the server-witnessed channel. */
export const SERVER_E2E_TEST_KIND = 'server-e2e';

/**
 * Payload discriminant the witness stamps on observe-finalized
 * persistence records (Observe channel, Phase 2: core's verdict engine
 * keys the observe branch off this channel on `persistence.observed`
 * records).
 */
export const OBSERVE_CHANNEL = 'observe';

/** The mapping kind that unlocks the Observe channel. */
export const OBSERVED_E2E_TEST_KIND = 'observed-e2e';

/** Run-state file carrying the authenticated gate receipt. */
export const GATE_RECEIPT_FILE = 'receipt.json';

/** Run-state diagnostics report (plan §3.5; never witness evidence). */
export const DIAGNOSTICS_REPORT_FILE = 'diagnostics.json';

/** Witness file inside the state dir carrying the spawned URL. */
export const WITNESS_URL_FILE = 'witness-url.json';

/** Default per-witness-call timeout (pin #7: 5s). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** The loopback hostname the witness, proxy, and fixture servers bind. */
export const LOOPBACK_HOSTNAME = '127.0.0.1';

/** Loopback-equivalent hostnames the witness accepts as attestation subjects. */
export const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  '[::1]': true,
  '::1': true,
  '127.0.0.1': true,
};