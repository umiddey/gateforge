/**
 * Witness-side data shapes (pin #7 wire + adapter contract, pin #8).
 */
import type { Server } from 'node:http';
import type { EvidenceRecord, TracedSession, TrustTier } from '@gate-forge/core';

/**
 * Supervisor-issued session credential (plan Phase 1, work item 2): the
 * trusted supervisor (the Playwright reporter process) opens one session
 * per started test and the worker-side fixture RESOLVES it by the exact
 * (workerIndex, testId) pair. The session token is issued by the witness,
 * never derivable by the suite: submissions without a valid OPEN session
 * are rejected fail-closed, so a suite-supplied testId or annotation
 * alone cannot mint records for an arbitrary session.
 */
export interface SessionCredential {
  /** Witness-issued session id (UUID). */
  sessionId: string;
  /** Per-session secret; required on every submission. */
  sessionToken: string;
  /** The supervisor-registered testId (records are forced onto it). */
  testId: string;
  /** The worker the session is bound to. */
  workerIndex: number;
  /**
   * The session's DEDICATED observation-proxy origin (its own loopback
   * port), when the run wires an observation proxy: the worker's browser
   * uses this origin for the whole test, so every request on it —
   * absolute paths included — is attributed to THIS session. Null when
   * no observation proxy is active (nothing to attribute).
   */
  proxyUrl: string | null;
  /**
   * The supervisor-registered obligation claims for this test (Phase 4
   * claim injection): the merged native-annotation + sidecar-mapping
   * claims the orchestrating CLI resolved from the tracked mappings and
   * the supervisor carried on the session-open path. Declarations only —
   * they route evidence onto obligation identities and never satisfy
   * anything by themselves; every record is still forced onto the
   * supervisor-registered session/test identity and graded from
   * witnessed evidence. Empty/absent for runs without mappings.
   */
  claims?: string[];
}

/**
 * `POST /records` body (pin #7, Phase 1 extension): a test-side primitive
 * submitting UI-observed evidence. `claimId` is the claimed obligation id —
 * the annotation's `<resourceId>:<contract>` — and `testId` binds the record
 * to the test that produced the claim. Phase 1: `sessionId` +
 * `sessionToken` carry the supervisor-issued session credential; the
 * witness rejects submissions without a valid OPEN session and forces the
 * record's testId onto the session's supervisor-registered value.
 */
export interface RecordsRequest {
  claimId: string;
  kind: string;
  payload: unknown;
  testId: string;
  sessionId: string;
  sessionToken: string;
}

/** `POST /records` response (pin #7, minimal wire contract). */
export interface RecordsResponse {
  recordId: string;
  trust: TrustTier;
  runId: string;
}

/**
 * `POST /witness/persistence` body (pin #7): the fixture asks the
 * engine-side witness to run the resource's reviewed adapter (GET-only)
 * for one entity. The issued record carries the ENGINE OBSERVATION
 * (`found`, adapter-normalized `fields`, and a `before` link when a
 * pre-observation was consumed) — expectations NEVER come from the
 * suite (audit round 5).
 *
 * `preObservationId` references a witness-issued pre-observation (`POST
 * /witness/pre-observation`): an id-set snapshot for create
 * postconditions (`before: {entityAbsent}`), or an entity-fields
 * snapshot for update postconditions (`before: {found, fields}`).
 */
export interface PersistenceRequest {
  resourceId: string;
  entityId: unknown;
  preObservationId?: string;
}

/**
 * `POST /witness/pre-observation` body: an engine-side snapshot taken
 * BEFORE a claimed action. With `entityId` the witness snapshots that
 * entity's observed fields (update postconditions); without it, the
 * resource's observed id set (create postconditions). Phase 1: requires
 * the supervisor-issued session credential.
 */
export interface PreObservationRequest {
  resourceId: string;
  testId: string;
  claimId: string;
  entityId?: unknown;
  sessionId: string;
  sessionToken: string;
}

/** `POST /witness/pre-observation` response. */
export interface PreObservationResponse {
  observationId: string;
  observed: number;
}

/** `POST /witness/persistence` response (pin #7). */
export interface PersistenceResponse {
  recordId: string;
  runId: string;
  verdictRelevant: {
    found: boolean;
    fieldsMatch: boolean;
    mismatches?: string[];
  };
}

/**
 * `POST /runs/server-e2e-declarations` body (SUPERVISOR ONLY): the
 * obligation ids the trusted mapping layer declared kind `server-e2e`.
 * Registration is a PRE-run fact (like the expected set): bound once,
 * identical re-registration idempotent, any change or late registration
 * refused — the witness never stamps `channel: 'server'` records for
 * obligations outside this set, so the suite cannot steer an intent onto
 * a browser-kind obligation and a bearer of an intent can never
 * self-verify.
 */
export interface ServerE2eDeclarationsRequest {
  obligations: readonly string[];
}

/** `POST /runs/server-e2e-declarations` response. */
export interface ServerE2eDeclarationsResponse {
  bound: true;
  count: number;
  obligations: string[];
}

/**
 * `POST /witness/server-persistence` body (SUPERVISOR ONLY — the drain
 * forwards it with the verifier key; the suite can only write intent
 * spool lines, never call this): one persistence claim intent, already
 * drained from the runner-side intents spool.
 *
 * - create: `pre` (expect-absent) BEFORE the mutation stores a witness
 *   pre-observation; `post` (expect-present) probes, consumes it, and
 *   stamps `before: {entityAbsent}` into the record — the same shape the
 *   browser path grades.
 * - update: `pre` (expect-present) snapshots the entity's fields;
 *   `post` consumes it into `before: {found, fields}` (the update delta
 *   grades against the classification's updateableFields in the engine).
 * - read: `post` (expect-present) only. delete: `post` (expect-absent
 *   for hard; expect-present for archive states) only.
 *
 * `sequence` is strictly increasing per claimId; a replayed or
 * out-of-order line resolves to a typed failure (fail closed), so no
 * bearer of an intent can re-drive a stale observation.
 */
export interface ServerPersistenceIntentRequest {
  resourceId: string;
  /** Obligation id `<resourceId>:persistence:<op>` the intent serves. */
  claimId: string;
  operation: 'create' | 'read' | 'update' | 'delete';
  phase: 'pre' | 'post';
  intent: 'expect-present' | 'expect-absent';
  /** The entity key: scalar for single-column PKs, column-keyed object for composite. */
  key: unknown;
  /** Strictly increasing per claimId (replay → typed failure). */
  sequence: number;
  /** The claiming test's id (diagnostic attribution; the claim join key). */
  testId: string;
}

/** `POST /witness/server-persistence` response for a `pre` intent. */
export interface ServerPreObservationResponse {
  resolved: 'pre';
  found: boolean;
}

/** `POST /witness/server-persistence` response for a `post` intent. */
export interface ServerPersistenceResponse {
  recordId: string;
  runId: string;
  trust: TrustTier;
  channel: 'server';
  verdictRelevant: { found: boolean };
}

/** `POST /sessions/open` body (Phase 1; Phase 4 adds claim injection). */
export interface SessionOpenRequest {
  /** The test's runner-assigned id (same id the reporter writes to claims.json). */
  testId: string;
  /** The worker the test runs on (binds worker → session). */
  workerIndex: number;
  /**
   * Supervisor-carried identity of the started test (enforcement-review
   * fix 2a/3): repo-relative file + title path + project, as drained from
   * the runner's lifecycle spool. When an expected set is registered,
   * THIS identity decides membership — a test outside the registered set
   * is refused. Optional only for runs without a registered expected set.
   */
  file?: string;
  titlePath?: readonly string[];
  project?: string | null;
  /**
   * Phase 4 claim injection: the mapped obligation claims this test must
   * land its evidence on (resolved from the sidecar/native mappings by
   * the orchestrating CLI and carried by the supervisor on the
   * session-open path). Obligation-id-shaped, deduplicated by the
   * witness; empty/absent for annotation-claimed tests, which keep
   * working unchanged. Claims remain DECLARATIONS: they never satisfy
   * anything by themselves.
   */
  claims?: readonly string[];
}

/** `POST /sessions/open` response: the session binding (runId, sessionId, testId, worker). */
export interface SessionOpenResponse extends SessionCredential {
  /** Witness-monotonic tick at open (the session clock origin). */
  openedTick: number;
}

/** `POST /sessions/close` body: the supervisor seals the session with the observed outcome. */
export interface SessionCloseRequest {
  sessionId: string;
  /** The observed test outcome (e.g. 'passed' | 'failed'); recorded, never graded here. */
  outcome?: string;
}

/** `POST /sessions/close` response. */
export interface SessionCloseResponse {
  sealed: true;
}

/** `POST /sessions/resolve` body: the worker proves WHICH open session it runs under. */
export interface SessionResolveRequest {
  testId: string;
  workerIndex: number;
}

/** `POST /sessions/resolve` response (a resolvable credential, proxy prefix included). */
export interface SessionResolveResponse extends SessionCredential {
  openedTick: number;
}

/** `POST /sessions/intervals/open` body: the fixture marks a UI-action observation interval. */
export interface IntervalOpenRequest {
  sessionId: string;
  sessionToken: string;
  /** The UI operation the interval covers ('create' | 'read' | 'update' | 'delete'). */
  operation: string;
}

/** `POST /sessions/intervals/open` response. */
export interface IntervalOpenResponse {
  intervalId: string;
  startTick: number;
}

/** `POST /sessions/intervals/close` body. */
export interface IntervalCloseRequest {
  sessionId: string;
  sessionToken: string;
  intervalId: string;
}

/** `POST /sessions/intervals/close` response. */
export interface IntervalCloseResponse {
  startTick: number;
  endTick: number;
}

/**
 * `POST /browser/surface` body (plan Phase 1 item 4): the worker-side
 * fixture registers the consumer-declared surface descriptor for one
 * open session. The descriptor's selectors are locators only — the
 * engine verifies every outcome itself. The driven ORIGIN is never part
 * of this body (a present `appBaseUrl` is rejected): the engine drives
 * exactly the provisioned attested subject from trusted witness
 * configuration. Requires the supervisor-issued session credential on
 * an OPEN session; the record's testId is forced onto the session's
 * value.
 */
export interface BrowserSurfaceRequest {
  sessionId: string;
  sessionToken: string;
  testId: string;
  /** The consumer-declared surface descriptor (validated engine-side). */
  surface: unknown;
}

/**
 * `POST /browser/action` body: perform ONE constrained surface
 * operation on the session's engine-owned page and issue
 * engine-observed records for it.
 */
export interface BrowserActionRequest {
  sessionId: string;
  sessionToken: string;
  testId: string;
  /** Obligation ids to issue the engine-observed records under. */
  claimIds: string[];
  /** The constrained operation to perform. */
  operation: 'create' | 'read' | 'update' | 'delete';
  /** Entered input (create/update); target entity (read/update/delete). */
  fields?: Record<string, string>;
  entityId?: string;
}

/** `POST /browser/action` response: the engine's own observation. */
export interface BrowserActionResponse {
  /** Entity id OBSERVED from the rendered list (never declared). */
  entityId: string;
  /** The exact input values the engine typed. */
  enteredFields: Record<string, string>;
  /** The rendered fields the engine read back. */
  renderedFields: Record<string, string>;
  /** The app response status the engine captured for the mutation. */
  appStatus: number;
  /** Engine-side pre-observation id (create/update; consumed by persistence verify). */
  preObservationId: string | null;
  /** Record ids the engine issued for this action (per claim). */
  recordIds: string[];
}

/**
 * `POST /browser/visible` body: re-read the rendered result for the
 * engine-observed entity on the session's engine page and issue
 * engine-observed visible-result records.
 */
export interface BrowserVisibleRequest {
  sessionId: string;
  sessionToken: string;
  testId: string;
  /** Obligation ids to issue the engine-observed records under. */
  claimIds: string[];
  /** The engine-observed entity id (must match the action's). */
  entityId: string;
  /** The original action (decides row vs form readback). */
  operation: 'create' | 'read' | 'update' | 'delete';
}

/** `POST /browser/visible` response. */
export interface BrowserVisibleResponse {
  entityId: string;
  /** The rendered fields the engine read. */
  fields: Record<string, string>;
  /** Record ids the engine issued (per claim). */
  recordIds: string[];
}

/**
 * Witness-held session state (plan Phase 1). Created only by
 * `POST /sessions/open` (the trusted supervisor, verifier-key
 * authenticated — enforcement-review fix 3); sealed by
 * `POST /sessions/close` (same authority). Sealed sessions answer no
 * submission, no interval, and no resolve call.
 */
export interface TestSession {
  /** Witness-issued session id (UUID). */
  sessionId: string;
  /** Per-session secret required on every submission. */
  token: string;
  /** The supervisor-registered testId (every record is forced onto it). */
  testId: string;
  /** The worker the session is bound to (one OPEN session per worker). */
  workerIndex: number;
  /** `open` accepts submissions; `sealed` rejects everything (fail closed). */
  status: 'open' | 'sealed';
  /** Witness-monotonic tick at open. */
  openedTick: number;
  /** Witness-monotonic tick at seal (null while open). */
  sealedTick: number | null;
  /** The outcome the supervisor observed at close (recorded, never graded). */
  outcome: string | null;
  /**
   * UI-action observation intervals keyed by intervalId. End ticks are
   * null while the interval is open. Exchanges are consumable as this
   * session's evidence only when their tick falls inside one of these
   * intervals — setup traffic outside every interval is never credited.
   */
  intervals: Map<string, { startTick: number; endTick: number | null; operation: string }>;
  /**
   * The session's dedicated observation-proxy origin when the run wires
   * an observation proxy; null otherwise.
   */
  proxyUrl: string | null;
  /** The dedicated proxy server (closed when the session seals). */
  proxyServer: Server | null;
  /**
   * Phase 4 claim injection: the mapped obligation claims the supervisor
   * registered at open (sorted, deduplicated, obligation-id-shaped;
   * empty for annotation-only tests). Echoed in the session view so the
   * supervisor writes claims.json from what the witness registered.
   */
  claims: string[];
  /**
   * The registered expected-set identity this session was minted for
   * (enforcement-review fix 2a/2b); null when the run has no registered
   * expected set. Groups the execution trace by expected test.
   */
  registered: { testId: string | null; project: string | null; file: string; titlePath: string[] } | null;
  /**
   * Witness-side activity bound to this session: a monotonically
   * increasing count of everything the witness itself observed under
   * the session — ledger records issued with the session credential,
   * recorded UI-action intervals, consumed engine-observed exchanges,
   * and pre-observations. Diagnostic corroboration only (execution
   * authority is the supervisor-observed trusted lifecycle).
   */
  activity: number;
  /**
   * Engine-browser surface registration (plan Phase 1 item 4): the
   * validated consumer descriptor the engine drives for this session.
   * The driven ORIGIN is never stored here — it resolves from trusted
   * witness configuration (`targetBaseUrl`) on every call, so a
   * suite-named frontend can never become the engine target.
   */
  engineSurface: { surface: Record<string, unknown> } | null;
}

/**
 * One expected test registered by the supervisor BEFORE the run
 * (enforcement-review fix 2a). Identity is (project, file, titlePath);
 * `testId` is diagnostic (runner-assigned ids are not stable across
 * enumeration and execution).
 */
export interface ExpectedTestRegistration {
  /** The runner-assigned test id, when enumeration bound one. */
  testId?: string | null;
  /** Runner project, or null when the runner reports none. */
  project: string | null;
  /** Repo-relative posix file (the identity join key). */
  file: string;
  /** Full title path (the identity join key). */
  titlePath: readonly string[];
}

/** `POST /runs/expected-set` body (SUPERVISOR ONLY). */
export interface ExpectedSetRequest {
  /** The expected tests, fixed before the run. */
  tests: readonly ExpectedTestRegistration[];
}

/** `POST /runs/expected-set` response. */
export interface ExpectedSetResponse {
  /** The set is bound to this run. */
  bound: true;
  /** Domain-separated digest over the registered set. */
  enumerationDigest: string;
  /** Number of registered expected tests. */
  count: number;
}

/** `GET /runs/execution-trace` response (SUPERVISOR ONLY; fix 2b). */
export interface ExecutionTraceResponse {
  /** The digest of the registered expected set (null when none). */
  enumerationDigest: string | null;
  /** Per expected test, every session the witness recorded. */
  tests: Array<{
    testId: string | null;
    project: string | null;
    file: string;
    titlePath: string[];
    sessions: TracedSession[];
  }>;
}

/** Witness runtime configuration (env-derived by the bin, explicit in tests). */
export interface WitnessOptions {
  /**
   * ADR 0004 D7 (plan §8 / D1): when set, the witness also starts a
   * loopback reverse proxy forwarding to this base URL and records
   * every forwarded request as an engine observation (the runtime HTTP
   * evidence channel). Transport-only: the observation proves the
   * witness observed an HTTP exchange; test attribution is
   * suite-claimed. Must be loopback.
   */
  proxyTarget?: string;
  /**
   * Observation-proxy mount prefix (with `proxyTarget`; e.g. `/api`).
   *
   * WHY this is an explicit deployment-topology declaration (same
   * philosophy as `urlBuilders[].base`): in a real deployment the
   * browser reaches the backend THROUGH the frontend — a dev proxy or
   * edge serves `/api/ops/...` while the backend route is `/ops/...`.
   * Whether such a prefix exists is a property of the deployment the
   * engine cannot derive from source, and guessing wrong would silently
   * mismatch obligation identities. When set, the observation proxy
   * forwards the STRIPPED path to the proxy target AND records the
   * STRIPPED path in observation records, so observations match the
   * backend-derived obligation identities the suite claims
   * (`evidence.http.observe({path: '/ops/x'})`). Requests outside the
   * prefix pass through and are recorded unstripped. Absent/null strips
   * nothing — forwarding and recording stay byte-identical to an
   * unmounted proxy.
   */
  mountPath?: string | null;
  /** Run manifest identity (pin #4). */
  runId: string;
  /** Per-run token; every call must carry `x-gateforge-run: <token>`. */
  token: string;
  /**
   * Verifier key for the attestation surface (authenticated
   * `POST /run-context` binding, `GET /ledger-attestation`, and the
   * manifest v2 `attestation` envelope): shared by the orchestrator
   * with the witness and the evaluating CLI, NEVER with the tested
   * suite. When absent the witness serves no attestation and its
   * manifest append stays unauthenticated (downstream evaluation fails
   * closed for witnessed records). Environment ONLY (see
   * `witness/bin.ts`) — never argv, stdout, state files, or suite env.
   */
  verifierKey?: string | null;
  /** Run-state dir; the witness appends its issued recordIds to manifest.json at shutdown. */
  stateDir?: string | null;
  /** Directory of reviewed `.mjs` adapters (default `.gateforge/adapters`). */
  adaptersDir?: string | null;
  /**
   * Operator-issued credential the witness presents on its OWN engine-side
   * adapter reads (GF-10 mediation; dogfood deployment, 2026-09-05/07).
   *
   * WHY: adapters perform GET-only reads of the app's own collection
   * routes to observe persisted state, and those routes authenticate —
   * an unauthenticated loopback read is a 401, so the engine could not
   * observe state at all. The credential is issued by the DEPLOYMENT
   * OPERATOR to the WITNESS ONLY (env `GATEFORGE_ADAPTER_READ_AUTHORIZATION`
   * or `--adapter-read-authorization`), never to the tested suite, and is
   * a read-only service principal of the same trust class as the verifier
   * key. When unset, adapter reads stay unauthenticated (previous
   * behavior) and protected collections simply fail closed with 401/409.
   */
  adapterReadAuthorization?: string | null;
  /** Classifications document path (YAML) for the primaryKey map + adapter aliases. */
  classificationsPath?: string | null;
  /**
   * Attestation subject (the SUT the UI drives). MUST be loopback
   * (GF-10); the witness probes its env-fingerprint marker at startup
   * when `targetFingerprint` is set (GF-13 minimal v1 attestation).
   */
  targetBaseUrl?: string | null;
  /** Expected `x-gateforge-env-fingerprint` marker at the attestation subject. */
  targetFingerprint?: string | null;
  /** Default base for adapter reads; a per-adapter `baseUrl` wins. */
  adapterBaseUrl?: string | null;
  /** Per-witness-call timeout (pin #7 default 5s). */
  requestTimeoutMs?: number;
  /** Injected clock for `issuedAt` (ISO-8601); default = system now. */
  now?: () => string;
  /** Host to bind; default `127.0.0.1` (loopback). */
  host?: string;
  /**
   * Engine-browser launcher override (programmatic use only — never
   * env-derived): the executable the engine drives stays engine code
   * regardless of which Chromium launches. Tests inject a failing
   * launcher to prove the fail-closed path (E16); production leaves it
   * unset for the pinned Chromium.
   */
  engineBrowserLauncher?: import('./browser.js').EngineBrowserLauncher;
}

/**
 * The normalized adapter module contract (pin #8).
 *
 * `probeServer` (optional; the server-witnessed persistence channel) is
 * the adapter's server-side probe: the witness executes it ONLY in the
 * witness process (trusted side) against the app's own database/state —
 * for backend-only tables (a transactional outbox) that can never
 * honestly appear in a UI. Contract:
 *
 * ```js
 * export default {
 *   ...,
 *   async probeServer(ctx, subject) {
 *     const row = await db.query('select * from outbox where id = $1', [subject]);
 *     return { found: row !== undefined, fields: row ?? null };
 *   },
 * };
 * ```
 *
 * `subject` is the entity key EXACTLY as the persistence intent declared
 * it (scalar for single-column primary keys, column-keyed object for
 * composite keys); the return MUST be
 * `{found: boolean, fields: Record<string, unknown> | null}`. A throw or
 * a malformed shape resolves the intent as a typed
 * SERVER_PROBE_UNAVAILABLE failure — never to satisfaction (fail
 * closed). Adapters without the export simply cannot serve the server
 * channel; the browser path is unaffected.
 */
export interface EvidenceAdapter {
  /** GET-only transport. Returns the raw entity body, or null when absent. */
  read: (ctx: AdapterContext, id: unknown) => Promise<unknown> | unknown;
  /**
   * Optional GET-only listing of the resource's entities (raw bodies).
   * Powers engine-side pre-observations for create postconditions; when
   * absent the witness refuses pre-observations for the resource.
   */
  list?: (ctx: AdapterContext) => Promise<unknown[]> | unknown[];
  /** Projects the raw body onto {entityId, fields} — stamped from the RESPONSE. */
  normalize: (body: unknown) => { entityId: unknown; fields: unknown };
  /** Removal semantics the adapter's resource uses. */
  deletion: 'hard' | 'archive';
  /** Fingerprint the adapter's target environment must present. */
  environmentFingerprint: string;
  /** Optional base override for THIS adapter's reads. */
  baseUrl?: string;
  /**
   * Optional SERVER PROBE, executed witness-side only (see the interface
   * doc): observes the app database directly and reports the entity's
   * presence + observed column state.
   */
  probeServer?: (
    ctx: AdapterContext,
    subject: unknown,
  ) => Promise<ServerProbeResult> | ServerProbeResult;
}

/** The shape an adapter `probeServer` must return (validated witness-side). */
export interface ServerProbeResult {
  /** Whether the probed entity exists in the engine-observed state. */
  found: boolean;
  /** The observed column state when found (null when absent). */
  fields: Record<string, unknown> | null;
}

/** The transport handed to `read` (GET-only, engine-mediated). */
export interface AdapterContext {
  /** The resolved read base for this adapter. */
  baseUrl: string;
  /** The resource this adapter serves. */
  resourceId: string;
  /**
   * The ONLY outbound primitive available to adapters: a GET returning
   * a minimal response view (status + JSON/text body + headers).
   */
  get: (
    path: string,
  ) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string>; headers: Headers }>;
  /**
   * Headers adapters MUST attach to any direct fetch they perform
   * instead of `get` (dogfood, 2026-09-05): carries the operator-issued
   * engine read credential (`WitnessOptions.adapterReadAuthorization`)
   * so engine-side GET-only state observation can authenticate against
   * the app's own collection routes. Never suite-supplied, never
   * attached to browser traffic.
   */
  headers?: Record<string, string>;
}

/** Full witness-issued record (superset of the pinned wire response). */
export type IssuedRecord = EvidenceRecord;

/** Result of spawning/attaching a witness service. */
export interface WitnessHandle {
  /** Base URL (loopback, OS-assigned port). */
  url: string;
  /** Stop the server; appends issued recordIds to the run manifest (pin #4/#7). */
  proxyUrl: string | null;
  stop: () => Promise<void>;
}