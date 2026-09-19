/**
 * The loopback witness service (pin #7, owner G6).
 *
 * A node:http server on an OS-assigned port, reachable ONLY on loopback.
 * Every request must carry `x-gateforge-run: <token>` (per-run token);
 * without it the witness answers 401. The run token is the SUITE's
 * credential; a second, stronger capability — the verifier key
 * (`x-gateforge-verifier`), which the tested suite NEVER receives —
 * guards the supervisor surface. Endpoint authority (enforcement-review
 * fix 3: the runner child holds NO supervisor rights):
 *
 * | Endpoint                          | Required authority                      |
 * |-----------------------------------|-----------------------------------------|
 * | `GET /health`                     | run token                               |
 * | `GET /records`                    | run token                               |
 * | `GET /classifications`            | run token                               |
 * | `POST /records`                   | run token + OPEN session credential     |
 * | `POST /witness/pre-observation`   | run token + OPEN session credential     |
 * | `POST /witness/persistence`       | run token + OPEN session credential     |
 * | `POST /witness/http-observation`  | run token + OPEN session credential     |
 * | `POST /sessions/resolve`          | run token (worker proves its identity;  |
 * |                                   | answers only OPEN supervisor sessions)  |
 * | `POST /sessions/intervals/*`      | run token + OPEN session credential     |
 * | `POST /browser/surface`           | run token + OPEN session credential     |
 * | `POST /browser/action`            | run token + OPEN session credential     |
 * | `POST /browser/visible`           | run token + OPEN session credential     |
 * | `POST /run-context`               | run token + verifier key (supervisor)   |
 * | `GET /ledger-attestation`         | run token + verifier key (supervisor)   |
 * | `POST /runs/expected-set`         | run token + verifier key (supervisor)   |
 * | `POST /runs/server-e2e-declarations` | run token + verifier key (supervisor)|
  * | `POST /runs/observe-declarations` | run token + verifier key (supervisor)   |
  * | `POST /observe/finalize`      | run token + verifier key (supervisor)   |
 * | `POST /witness/server-persistence` | run token + verifier key (supervisor;  |
 * |                                   | the drain forwards intents — the suite |
 * |                                   | can only WRITE spool lines)            |
 * | `GET /runs/execution-trace`       | run token + verifier key (supervisor)   |
 * | `POST /sessions/open`             | run token + verifier key (supervisor);  |
 * |                                   | test must be in the registered set      |
 * | `POST /sessions/close`            | run token + verifier key (supervisor)   |
 *
 * Endpoints:
 *
 * - `POST /runs/expected-set` — SUPERVISOR ONLY: registers the expected
 *   test set BEFORE the run (enforcement-review fix 2a), bound to this
 *   run; identical re-registration is idempotent, any change or late
 *   registration is 409. Returns the domain-separated enumeration digest.
 * - `POST /sessions/open`    — SUPERVISOR ONLY: registers one started
 *   test as a session binding (runId, sessionId, testId, worker). One
 *   OPEN session per worker; an identical open (worker, testId)
 *   re-binds idempotently. When an expected set is registered, the test
 *   must belong to it (an invented testId is refused typed).
 * - `POST /sessions/close`   — SUPERVISOR ONLY: seals the session with
 *   the observed outcome. Closing SEALS: every later submission for the
 *   session is rejected (no post-hoc record injection).
 * - `GET /runs/execution-trace` — SUPERVISOR ONLY: the witness-side
 *   session record (enforcement-review fix 2b) — per expected test,
 *   every session with its open/seal ticks and outcome. THE execution
 *   authority supervision grades completeness from.
 * - `POST /sessions/resolve` — the worker-side fixture proves WHICH open
 *   session it runs under by the exact (workerIndex, testId) pair; only
 *   an open session answers, with the session credential.
 * - `POST /sessions/intervals/{open,close}` — the fixture marks a
 *   witness-recorded observation interval per UI action (start/end ticks
 *   from the witness's monotonic clock). Proxy exchanges observed
 *   OUTSIDE every interval of a session are never consumable as that
 *   session's evidence — direct setup traffic cannot become browser
 *   evidence.
 * - `POST /records`          — test-side primitives submit UI evidence
 *   ({claimId, kind, payload, testId, sessionId, sessionToken}) → the
 *   witness ISSUES a record with service-computed provenance ONLY under
 *   a valid OPEN session (the record's testId is forced to the
 *   session's supervisor-registered value; a mismatching testId is
 *   refused). Unknown primitive kinds → 400 (GF-11, GF-14).
 * - `POST /witness/persistence` — the fixture asks the witness to run
 *   the engine-side adapter (GET-only) for one entity → the witness
 *   executes the read, stamps a `persistence.entity` record from the
 *   ADAPTER RESPONSE, and returns {recordId, runId, verdictRelevant}.
 *   Raw adapter bodies never cross back into the test process. Wire is
 *   the pin-#7 shape extended with `testId` + `claimId` + the session
 *   credential so persistence records bind to the claim the engine
 *   grades, under the session the supervisor opened.
 * - `POST /witness/server-persistence` — SUPERVISOR ONLY: the trusted
 *   drain forwards one persistence claim INTENT (drained from the
 *   runner-side `persistence-intents.jsonl` spool the supervised suite
 *   may only WRITE); the witness executes the resource's adapter SERVER
 *   PROBE itself (behind the same attestation chain as every adapter
 *   read) and stamps a WITNESSED `persistence.entity` record carrying
 *   `channel: 'server'` + `declaredKind: 'server-e2e'` — the
 *   server-witnessed channel for backend-only tables (a transactional
 *   outbox) that can never honestly appear in a UI. Probes run ONLY in
 *   this trusted process; missing adapter/probe/declaration and replayed
 *   sequences resolve to typed failures, never to satisfaction.
  * - `POST /runs/observe-declarations` — SUPERVISOR ONLY: registers the
  *   `observed-e2e` obligations BEFORE the run (same bind-once contract
  *   as the server-e2e set).
  * - `POST /observe/finalize` — SUPERVISOR ONLY: resolves one OPEN
  *   session's observe-declared claims against its own proxied traffic
  *   plus independent adapter reads; stamps witnessed
  *   `persistence.observed` records (`channel: 'observe'`) for whatever
  *   resolves. Non-resolutions are typed notes — never satisfaction,
  *   never a run failure.
 * - `POST /witness/http-observation` — consumes one engine-observed
 *   proxied exchange for an http:* claim. Phase 1: the caller must hold
 *   a valid OPEN session and the exchange must have been observed
 *   through THAT session's proxy prefix WITHIN one of its recorded
 *   action intervals — another test's/worker's request can never
 *   satisfy a claim (E11/E12 foundation).
 * - `GET /records`           — the issued ledger (the ONLY input the
 *   reporter copies into `records.json`; fabricated bundles never enter
 *   it — GF-23).
 * - `GET /classifications`   — per-resource primaryKey/exposure/plane/
 *   lifecycle projection for the reporter's per-claim ledger.
 * - `GET /health`            — readiness + attestation scope identity.
 *
 * Attestation (GF-10, GF-13): the attestation subject and every adapter
 * read base must be loopback; adapter bases must present an
 * `x-gateforge-env-fingerprint` marker matching the adapter's declared
 * fingerprint (and the run's pinned target fingerprint when set).
 * Mismatches REJECT the record — never `satisfied`.
 *
 * At shutdown the witness appends the record ids it issued to
 * `manifest.json` in the run-state dir (pin #4/#7).
 */
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ATTESTATION_VERSION,
  attestationMac,
  enumerationDigestOf,
  pathMatchesShape,
  recordIdOf,
  type Classification,
  type RecordOrigin,
  type TracedSession,
} from '@gate-forge/core';
import { canonicalOf } from '../json.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  KNOWN_RECORD_KINDS,
  LOOPBACK_HOSTNAME,
  OBSERVED_KIND,
  PERSISTENCE_KIND,
  RUN_HEADER,
  VERIFIER_HEADER,
} from '../constants.js';
import { loadAdapters, makeAdapterContext } from './adapter-registry.js';
import {
  AttestationError,
  assertLoopback,
  envFingerprintMismatch,
  probeEnvFingerprint,
} from './env-attestation.js';
import { hostResolverRules, pinnedLoopbackIps, pinnedGet } from './loopback-pins.js';
import { loadClassifications, toClassificationView } from './classifications.js';
import {
  EngineBrowserError,
  EngineBrowserManager,
  driveEngineAction,
  readEngineVisible,
  type EngineOperation,
} from './browser.js';
import {
  SURFACE_DESCRIPTOR_VERSION,
  validateSurface,
  type SurfaceDescriptor,
} from '../surface.js';
import type {
  AdapterContext,
  BrowserActionRequest,
  BrowserActionResponse,
  BrowserSurfaceRequest,
  BrowserVisibleRequest,
  BrowserVisibleResponse,
  EvidenceAdapter,
  ExpectedSetRequest,
  ExpectedSetResponse,
  ExecutionTraceResponse,
  IssuedRecord,
  ObserveDeclarationsRequest,
  ObserveFinalizeRequest,
  ObserveFinalizeResponse,
  ObserveFinalizedObligation,
  PersistenceRequest,
  PersistenceResponse,
  PreObservationRequest,
  PreObservationResponse,
  RecordsRequest,
  RecordsResponse,
  ServerE2eDeclarationsRequest,
  ServerE2eDeclarationsResponse,
  ServerPersistenceIntentRequest,
  ServerPersistenceResponse,
  ServerPreObservationResponse,
  SessionCloseRequest,
  SessionOpenRequest,
  SessionResolveRequest,
  TestSession,
  WitnessHandle,
  WitnessOptions,
} from './types.js';
import { OBSERVE_CHANNEL, OBSERVED_E2E_TEST_KIND, SERVER_CHANNEL, SERVER_E2E_TEST_KIND } from '../constants.js';

const MAX_BODY_BYTES = 1024 * 1024;
const OBLIGATION_ID_PATTERN = /^[^:]+:.+$/;
/**
 * Bounded response snapshot the observation proxy keeps per forwarded
 * exchange: at most this many body bytes are hashed into the snapshot,
 * while the TOTAL byte count is tracked separately. The response still
 * streams to the browser unbuffered — the snapshot is a tap, not a gate.
 */
const OBSERVED_BODY_SNAPSHOT_BYTES = 16384;
/**
 * Bounded request-body snapshot the observation proxy keeps per
 * forwarded exchange (Observe channel, Phase 2): the request body is
 * already buffered for forwarding, so retaining a capped copy costs one
 * slice. Bodies beyond the cap are flagged truncated — an observe
 * finalize can never echo what it cannot see, so oversized intents
 * grade typed-missing instead of satisfying on a prefix. Binary-safe:
 * stored raw; the finalize path parses JSON/form text from it.
 */
const OBSERVED_REQUEST_BODY_BYTES = 65536;
/** One engine-observed proxied exchange (arrival order via `seq`). */
interface ObservedExchange {
  method: string;
  path: string;
  status: number;
  seq: number;
  /** sha256 hex of the bounded response-body snapshot. */
  bodySha256: string;
  /** TOTAL response body bytes observed (may exceed the snapshot). */
  bodyBytes: number;
  /**
   * Capped copy of the request body (Observe channel): the first
   * OBSERVED_REQUEST_BODY_BYTES bytes the client sent, retained from
   * the forward buffer. Null when the request carried no body.
   */
  requestBody: Buffer | null;
  /** True when the request body exceeded the snapshot cap. */
  requestTruncated: boolean;
  /** TOTAL request body bytes received. */
  requestBytes: number;
  /** Lowercased request content-type without parameters, or null. */
  requestContentType: string | null;
  /**
   * The OPEN-or-later session whose proxy prefix the exchange arrived
   * through (Phase 1 attribution); null when the exchange bypassed every
   * session channel — such exchanges are never consumable as evidence.
   */
  sessionId: string | null;
  /** Witness-monotonic tick stamped when the exchange completed. */
  tick: number;
}

/** Fail-closed witness configuration/startup error. */
export class WitnessStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WitnessStartupError';
  }
}

/**
 * One resource's Observe before-snapshot: the witness's own adapter-list
 * observation at session open (canonical-entity-key → normalized id +
 * fields), or the error that made the resource unobservable. Snapshots
 * are taken with the SAME attested adapter transport as every read, so
 * the finalize path grades before/after from witness-held state only.
 */
interface ObserveResourceSnapshot {
  resourceId: string;
  adapterName: string;
  before: Map<string, { entityId: unknown; fields: unknown }>;
  error: string | null;
}

/** An HTTP JSON error the witness answers (status + {error, detail?}). */
class HttpError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** Running witness state. */
interface WitnessState {
  options: Required<
    Pick<WitnessOptions, 'runId' | 'token' | 'requestTimeoutMs' | 'host'>
  > & {
    mountPath: string | null;
  } & WitnessOptions;
  adapters: Map<string, EvidenceAdapter>;
  classifications: Record<string, Classification>;
  ledger: Map<string, IssuedRecord>;
  /**
   * Engine-side pre-observations (audit rounds 4-5): snapshots taken
   * BEFORE a claimed action, consumed by the matching persistence read.
   * Two kinds — an id-set snapshot (create: was the entity absent?) and
   * an entity-fields snapshot (update: what changed?). In-memory,
   * single-use: the suite can reference real observations but can never
   * fabricate, replay, or mutate their contents, and expectations never
   * come from the suite.
   */
  preObservations: Map<
    string,
    | { resourceId: string; kind: 'ids'; ids: string[] }
    | { resourceId: string; kind: 'entity'; entityId: string; found: boolean; fields?: unknown }
  >;
  /**
   * SERVER-WITNESSED channel state. `serverE2eDeclarations` holds the
   * obligation ids the TRUSTED supervisor registered as mapping kind
   * 'server-e2e' BEFORE the run (verifier-key surface, same authority
   * as the expected set) — null until bound; a server intent for an
   * unregistered obligation is refused typed, so a browser-kind claim
   * can never be satisfied through this channel. `serverPreObservations`
   * holds the witness's own probe observations taken BEFORE a claimed
   * mutation (create absence / update before-state), single-use, keyed
   * by claimId + canonical entity key. `serverIntentSequences` is the
   * last accepted intent sequence per claimId — strictly increasing, so
   * a replayed or reordered spool line resolves to a typed failure and
   * no bearer of an intent can re-drive a stale observation.
   */
  serverE2eDeclarations: Set<string> | null;
  serverPreObservations: Map<
    string,
    { resourceId: string; kind: 'absence' | 'entity'; found: boolean; fields?: unknown }
  >;
  serverIntentSequences: Map<string, number>;
  /**
   * OBSERVE channel state (Phase 2). `observeDeclarations` holds the
   * obligation ids the TRUSTED supervisor registered as mapping kind
   * 'observed-e2e' BEFORE the run (verifier-key surface, same authority
   * as the server-e2e set) — null until bound; the finalize path
   * stamps `channel: 'observe'` records only for these obligations.
   * `observeSnapshots` holds the witness's own adapter-list snapshots
   * taken at session open, keyed by session then resource: the
   * before-state every observe postcondition grades against. A snapshot
   * error (no adapter, no list, probe/read trouble) is DATA the
   * finalize reports as a typed note — sessions still open and tests
   * still run; the claim simply stays blocking.
   */
  observeDeclarations: Set<string> | null;
  observeSnapshots: Map<string, Map<string, ObserveResourceSnapshot>>;
  server: Server;
  /**
   * ADR 0004 D7: requests the witness-owned loopback observation proxy
   * actually forwarded during this run, in arrival order. Suite-callable
   * endpoints may CONSUME a matching observation to issue a witnessed
   * `http.request` record — they can never fabricate or mutate one.
   */
  observed: ObservedExchange[];
  observedSeq: number;
  proxyServer: Server | null;
  nowIso: () => string;
  stopped: boolean;
  /**
   * Witness-monotonic clock (plan Phase 1): a strictly increasing
   * counter stamped at session open/close, interval open/close, and
   * exchange completion. It orders the session-relative evidence rules
   * (interval membership) WITHOUT trusting any suite-supplied time.
   */
  tick: number;
  /**
   * Supervisor-opened test sessions (plan Phase 1) keyed by sessionId.
   * The suite cannot create, extend, or resurrect one: only the
   * supervisor channel (`/sessions/open`) mints sessions, and closing
   * seals permanently.
   */
  sessions: Map<string, TestSession>;
  /** workerIndex → the OPEN session on that worker (one at a time). */
  workerSessions: Map<number, string>;
  /**
   * Trusted run context bound via `POST /run-context` (plan §11.4): the
   * frozen `{runId, invocationId, inputDigest}` the witness attests.
   * Set once, before any observation or issuance; a witness that already
   * observed, issued, or holds an in-flight proxy exchange refuses
   * binding (409). `observedSeqAtBind` watermarks observations that
   * completed before binding — they are never consumable under the new
   * context, closing the bind/observe race.
   */
  runContext: { runId: string; invocationId: string; inputDigest: string } | null;
  observedSeqAtBind: number;
  /** Proxy exchanges currently in flight (request received, response open). */
  proxyInFlight: number;
  /**
   * The expected test set the supervisor registered BEFORE the run
   * (enforcement-review fix 2a), keyed by the identity join key
   * (project, file, titlePath). Once bound, `/sessions/open` accepts
   * only tests in this set, and the execution trace reports sessions
   * grouped by these registered identities.
   */
  expectedTests: Map<string, { testId: string | null; project: string | null; file: string; titlePath: string[] }>;
  /** Domain-separated digest over the registered expected set. */
  enumerationDigest: string | null;
  /**
   * The engine-owned browser (plan Phase 1 item 4): Chromium contexts
   * the witness drives itself, one per session. Test code holds no
   * handle over these pages — every browser proof comes from engine
   * observation, never suite assertion.
   */
  engineBrowser: EngineBrowserManager;
}

/** Codepoint-wise comparison for deterministic ordering. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The expected-set identity join key (project, file, titlePath). */
function expectedKey(project: string | null, file: string, titlePath: readonly string[]): string {
  return `${project ?? '-'}\u0000${file}\u0000${titlePath.join('>')}`;
}

/**
 * Normalizes the declared observation-proxy mount prefix (null when
 * unset/empty). Fail-closed on values that can never be a plain path
 * prefix — a malformed declaration would otherwise silently mismatch
 * obligation identities, the exact failure the option exists to prevent.
 */
function normalizeMountPath(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let path = raw.trim();
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/' || /[\s?#]/.test(path)) {
    throw new WitnessStartupError(
      `invalid mountPath '${raw}': declare the browser-facing mount prefix as a non-empty ` +
        "absolute path like '/api'",
    );
  }
  return path;
}

/**
 * Lowercases a request content-type header to its media type without
 * parameters (`'Application/JSON; charset=utf-8'` → `'application/json'`),
 * or null when absent/unparseable. The Observe finalize path uses it to
 * decide body parsing (JSON vs form); anything else is ineligible.
 */
function contentTypeOf(raw: string | string[] | undefined): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return null;
  const media = first.split(';')[0]?.trim().toLowerCase() ?? '';
  return media.length > 0 ? media : null;
}

/**
 * Strips the declared mount prefix from a proxied request URL (path
 * plus possible query/fragment), returning the backend-facing URL the
 * proxy forwards AND records. A request outside the prefix passes
 * through untouched, and with no declared prefix the URL is returned
 * byte-identical (the unmounted proxy's behavior).
 */
function stripMountPath(rawUrl: string, mountPath: string | null): string {
  if (mountPath === null) return rawUrl;
  const queryStart = rawUrl.search(/[?#]/);
  const pathPart = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const suffix = queryStart === -1 ? '' : rawUrl.slice(queryStart);
  if (pathPart === mountPath) return `/${suffix}`;
  if (pathPart.startsWith(`${mountPath}/`)) {
    return `${pathPart.slice(mountPath.length)}${suffix}`;
  }
  return rawUrl;
}

/**
 * Starts one loopback reverse-proxy server forwarding to the run's
 * attested proxy target. `sessionId` names the session the port belongs
 * to (null = the shared unattributed proxy): every exchange completing
 * on this port is recorded as an engine observation stamped with that
 * session id and the witness-monotonic completion tick.
 *
 * Args:
 *   state: running witness state.
 *   sessionId: owning session id, or null for the shared proxy.
 *
 * Returns:
 *   Promise<Server>: the listening server (OS-assigned loopback port).
 *
 * Throws:
 *   Error: when the server fails to bind.
 */
async function startObservedProxy(state: WitnessState, sessionId: string | null): Promise<Server> {
  const proxyTargetUrl = new URL(state.options.proxyTarget as string);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // Mount-prefix handling: forward the backend-facing (STRIPPED)
      // URL, and record the same STRIPPED path below, so observations
      // match the backend-derived obligation identities the suite
      // claims. With no declared mount path the URL is forwarded and
      // recorded byte-identical to today.
      const forwardUrl = stripMountPath(req.url ?? '/', state.options.mountPath);
      // In-flight accounting (plan §11.4): a proxy exchange that starts
      // before `/run-context` binds must refuse the bind — otherwise
      // traffic from an older invocation could be signed under the new
      // context.
      state.proxyInFlight += 1;
      let settledFlight = false;
      const settleFlight = (): void => {
        if (!settledFlight) {
          settledFlight = true;
          state.proxyInFlight -= 1;
        }
      };
      // b59/b60 lesson (phase7-runtime e22ec24): `agent: false` is
      // load-bearing. On Node >=19 the default global agent keeps sockets
      // alive while dev servers close idle keep-alive sockets at their
      // keepAliveTimeout — reusing a socket the target closed mid-handshake
      // intermittently killed exactly one browser exchange per batch. A
      // fresh loopback connection per forwarded exchange costs nothing and
      // removes the reuse race.
      const forward = request(
        {
          protocol: proxyTargetUrl.protocol,
          hostname: proxyTargetUrl.hostname,
          port: proxyTargetUrl.port,
          method: req.method,
          path: forwardUrl,
          headers: { ...req.headers, host: proxyTargetUrl.host },
          agent: false,
        },
        (upstream) => {
          const status = upstream.statusCode ?? 0;
          const observedPath = normalizeObservedPath(forwardUrl);
          // Bounded response-body snapshot: the tap is attached BEFORE
          // piping so both consumers receive the stream; forwarding to
          // the browser stays unbuffered (the snapshot never gates the
          // response). Total bytes are counted even beyond the snapshot
          // limit; only the snapshot is hashed.
          const snapshot: Buffer[] = [];
          let snapshotBytes = 0;
          let totalBytes = 0;
          upstream.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (snapshotBytes < OBSERVED_BODY_SNAPSHOT_BYTES) {
              const room = OBSERVED_BODY_SNAPSHOT_BYTES - snapshotBytes;
              const taken = chunk.length > room ? chunk.subarray(0, room) : chunk;
              snapshot.push(Buffer.from(taken)); // copy: detach from the stream pool
              snapshotBytes += taken.length;
            }
          });
          upstream.on('end', () => {
            state.observed.push({
              method: (req.method ?? 'GET').toUpperCase(),
              path: observedPath,
              status,
              seq: (state.observedSeq += 1),
              bodySha256: createHash('sha256').update(Buffer.concat(snapshot)).digest('hex'),
              bodyBytes: totalBytes,
              requestBody: body.length === 0 ? null : Buffer.from(body.subarray(0, OBSERVED_REQUEST_BODY_BYTES)),
              requestTruncated: body.length > OBSERVED_REQUEST_BODY_BYTES,
              requestBytes: body.length,
              requestContentType: contentTypeOf(req.headers['content-type']),
              sessionId,
              tick: (state.tick += 1),
            });
            settleFlight();
          });
          upstream.on('error', settleFlight);
          res.writeHead(status, upstream.headers);
          upstream.pipe(res);
        },
      );
      forward.on('error', () => {
        settleFlight();
        if (!res.headersSent) sendJson(res, 502, { error: 'observation proxy upstream failed' });
        else res.end();
      });
      if (body.length > 0) forward.write(body);
      forward.end();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, state.options.host, () => resolveListen());
  });
  server.removeAllListeners('error');
  return server;
}

/** The base URL of a started observation-proxy server. */
function proxyUrlOf(state: WitnessState, server: Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new WitnessStartupError('observation proxy failed to bind an OS-assigned port');
  }
  return `http://${formatHost(state.options.host)}:${address.port}`;
}

/**
 * Starts the DEDICATED session proxy port (plan Phase 1) and stores it
 * on the session. Only called when the run wires an observation proxy;
 * the worker's browser uses this origin for the whole test, so all of
 * its traffic — absolute paths included — is attributed to the session.
 *
 * Args:
 *   state: running witness state.
 *   session: the freshly opened session.
 */
async function startSessionProxy(state: WitnessState, session: TestSession): Promise<void> {
  if (
    typeof state.options.proxyTarget !== 'string' ||
    state.options.proxyTarget.length === 0
  ) {
    session.proxyUrl = null;
    return;
  }
  const server = await startObservedProxy(state, session.sessionId);
  session.proxyServer = server;
  session.proxyUrl = proxyUrlOf(state, server);
}

/** Closes one session's dedicated proxy port (sealed = channel gone). */
async function stopSessionProxy(session: TestSession): Promise<void> {
  const server = session.proxyServer;
  session.proxyServer = null;
  if (server === null) return;
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The service-issued recordId comes from the frozen core primitive
 * (`recordIdOf`, pin #1/#7): sha256 over GF-canonical JSON of the record
 * identity. Sharing one implementation with the engine's provenance
 * verifier guarantees the witness issues exactly what evaluation can
 * recompute — an entry that never passed through the service has no
 * matching hash, so shape-level fabrication (a hex string the service
 * never issued) cannot line up with the ledger the reporter copies.
 */
export { recordIdOf };

/** Reads the JSON request body (sized; malformed → HttpError). */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        rejectBody(new HttpError(400, 'request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (raw.length === 0) {
        rejectBody(new HttpError(400, 'request body is required'));
        return;
      }
      try {
        resolveBody(JSON.parse(raw) as unknown);
      } catch (error) {
        rejectBody(new HttpError(400, `request body is not valid JSON: ${(error as Error).message}`));
      }
    });
    req.on('error', rejectBody);
  });
}

/**
 * Starts the witness service.
 *
 * Args:
 *   options: run identity + token (required), state dir, adapters dir,
 *     classifications path, target/attestation config, timeout, clock.
 *
 * Returns:
 *   WitnessHandle: {url, stop} once the server listens.
 *
 * Throws:
 *   WitnessStartupError / AdapterRegistryError / AttestationError:
 *     fail-closed startup problems (GF-10 blocks non-loopback targets
 *     HERE, before any adapter request can be constructed).
 */
export async function startWitness(options: WitnessOptions): Promise<WitnessHandle> {
  if (typeof options.runId !== 'string' || options.runId.length === 0) {
    throw new WitnessStartupError('witness requires a runId (GATEFORGE_RUN_ID)');
  }
  if (typeof options.token !== 'string' || options.token.length === 0) {
    throw new WitnessStartupError('witness requires a token (GATEFORGE_RUN_TOKEN)');
  }
  const cwd = process.cwd();
  const adaptersDir =
    options.adaptersDir === null || options.adaptersDir === undefined
      ? null
      : resolve(cwd, options.adaptersDir);
  const classificationsPath =
    options.classificationsPath === null || options.classificationsPath === undefined
      ? null
      : resolve(cwd, options.classificationsPath);

  const adapters =
    adaptersDir === null ? new Map<string, EvidenceAdapter>() : await loadAdapters(adaptersDir);
  const classifications = loadClassifications(classificationsPath);

  const targetBaseUrl = options.targetBaseUrl ?? null;
  // The mount prefix declares how the browser-facing deployment mounts
  // the backend for the OBSERVATION PROXY; it is meaningless without one.
  const mountPath = normalizeMountPath(options.mountPath);
  if (mountPath !== null && (options.proxyTarget === undefined || options.proxyTarget === '')) {
    throw new WitnessStartupError(
      'witness option mountPath requires proxyTarget: the mount prefix declares how the ' +
        'observation proxy bridges the browser-facing deployment and the backend',
    );
  }
  // GF-10: the attestation subject must be loopback — block at startup,
  // before any mutation-capable request surface exists.
  if (targetBaseUrl !== null) {
    await assertLoopback(targetBaseUrl, 'attestation subject');
  }
  // GF-13 minimal v1: when the run pins a fingerprint, the subject's
  // marker must match before the service opens for business.
  if (
    targetBaseUrl !== null &&
    options.targetFingerprint !== null &&
    options.targetFingerprint !== undefined
  ) {
    const probe = await probeEnvFingerprint(
      targetBaseUrl,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const mismatch = envFingerprintMismatch(
      probe,
      options.targetFingerprint,
      options.targetFingerprint,
    );
    if (mismatch !== null) {
      throw new AttestationError(
        `attestation subject '${targetBaseUrl}' failed startup attestation: ${mismatch}`,
      );
    }
  }

  const state: WitnessState = {
    options: {
      ...options,
      runId: options.runId,
      token: options.token,
      mountPath,
      verifierKey:
        typeof options.verifierKey === 'string' && options.verifierKey.length > 0
          ? options.verifierKey
          : null,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      host: options.host ?? LOOPBACK_HOSTNAME,
    },
    adapters,
    classifications,
    ledger: new Map(),
    preObservations: new Map(),
    serverE2eDeclarations: null,
    serverPreObservations: new Map(),
    serverIntentSequences: new Map(),
    observeDeclarations: null,
    observeSnapshots: new Map(),
    observed: [],
    observedSeq: 0,
    runContext: null,
    observedSeqAtBind: 0,
    proxyInFlight: 0,
    expectedTests: new Map(),
    enumerationDigest: null,
    tick: 0,
    sessions: new Map(),
    workerSessions: new Map(),
    engineBrowser: new EngineBrowserManager(options.engineBrowserLauncher),
    proxyServer: null,
    server: undefined as unknown as Server,
    nowIso: options.now ?? (() => new Date().toISOString()),
    stopped: false,
  };

  state.server = createServer((req, res) => {
    void handleRequest(state, req, res);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    state.server.once('error', rejectListen);
    state.server.listen(0, state.options.host, () => resolveListen());
  });
  state.server.removeAllListeners('error');

  const address = state.server.address();
  if (address === null || typeof address === 'string') {
    await stopWitness(state);
    throw new WitnessStartupError('witness failed to bind an OS-assigned port');
  }
  const url = `http://${formatHost(state.options.host)}:${address.port}`;

  // ADR 0004 D7: the witness-owned loopback reverse proxy. Traffic
  // aimed at a witness proxy is forwarded to the attested target and
  // (method, path, status, bounded body snapshot, total body bytes)
  // recorded as an ENGINE observation; a suite-callable endpoint consumes
  // a matching observation to issue a witnessed record. A proxy never
  // needs the run token: it serves the browser, holds no authority, and
  // can only add observations the engine itself saw.
  //
  // Phase 1 session channels: the shared proxy (below) stays the
  // UNATTRIBUTED channel — its exchanges carry sessionId null and are
  // never consumable as a test's evidence. Each supervisor-opened
  // session additionally gets a DEDICATED loopback proxy port (see
  // `startSessionProxy`): the worker's browser uses that origin for the
  // whole test, so every absolute-path form action, link, and fetch on
  // it lands on the session's own channel — attribution by ORIGIN, not
  // by URL rewriting.
  let proxyUrl: string | null = null;
  if (typeof state.options.proxyTarget === 'string' && state.options.proxyTarget.length > 0) {
    await assertLoopback(state.options.proxyTarget, 'observation proxy target');
    state.proxyServer = await startObservedProxy(state, null);
    proxyUrl = proxyUrlOf(state, state.proxyServer);
  }

  // DNS binding (loopback-pins): the startup asserts above pinned every
  // operator-provided hostname to its approved loopback IPs. Hand the
  // resulting resolver rules to the engine browser BEFORE it can launch —
  // its traffic for those names then cannot leave loopback even if DNS
  // changes mid-run, while Host headers and origins (tenant routing)
  // stay exactly as the suite addresses them.
  state.engineBrowser.setDnsPinRules(hostResolverRules(pinnedLoopbackIps()));

  const handle = Object.freeze({
    url,
    proxyUrl,
    stop: (): Promise<void> => stopWitness(state),
  });
  return handle;
}

/**
 * Canonicalizes an observed request path (query/fragment stripped, one
 * leading slash, trailing slashes dropped, root '/' stays '/').
 * Lockstep with core's `interpretObservedPath` (plan §9 steps 1-3):
 * duplicate slashes are NOT collapsed and percent-encodings are NEVER
 * decoded on either side — noncanonical routing meaning stays visible
 * so the verifier blocks instead of matching a different endpoint.
 */
function normalizeObservedPath(rawPath: string): string {
  let path = rawPath.split('?')[0]?.split('#')[0] ?? '/';
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
}

/**
 * Consumes one engine-observed request matching (method, path) and
 * issues witnessed `http.request` records bound to the declaring test's
 * obligation claims (ADR 0004 D7, plan §8 / D1 transport-only semantics).
 * The witness observes that an HTTP exchange traversed the proxy; WHICH
 * browser, UI action, or test produced it is suite-claimed attribution,
 * never independent proof. Single-use at the EXCHANGE level: an
 * observation proves exactly one real request — it is consumed on first
 * match and can never be re-claimed, replayed, or extended later. One
 * genuine exchange genuinely instantiates every contract its endpoint
 * declares of it (a compiler emits `http:frontend-request-observed` AND
 * `http:response-status-ok` per consumed endpoint; ADR 0004 D8 calls the
 * latter "the same witnessed record carrying a 2xx status"), so the
 * consumed exchange issues one record PER claim id the declaring test
 * itself declared — all carrying the identical engine-observed payload,
 * each still independently provenance-verified and shape/status-checked
 * by the verdict engine. The payload is
 * `{method, url, status, bodySha256, bodyBytes}` — the bounded response
 * snapshot hash and total byte count ride in the record, a tamper-evident
 * trace of exactly what the engine observed.
 *
 * An optional `expectedStatus` narrows the consume match to exchanges
 * the target answered with that exact status. This stays honest: the
 * suite still cannot fabricate or mutate observations — it only selects
 * WHICH real exchange it is accounting for. It exists because one
 * (method, path) shape can legitimately fire several times per run with
 * different statuses (e.g. the SPA's unauthenticated `/me` probe ahead of
 * the authenticated one); FIFO-without-status would bind a `:response-
 * status-ok` claim to an observed 401 the journey never intended.
 */
async function handleHttpObservation(
  state: WitnessState,
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const testId = body['testId'];
  const method = body['method'];
  const path = body['path'];
  const expectedStatus = body['expectedStatus'];
  // A split legacy assignment (distinct `claimId` vs `obligationId`)
  // is ambiguous caller intent — fail closed instead of silently
  // picking one (plan §8 step 7: no silent wrong-obligation binding).
  if (
    typeof body['claimId'] === 'string' &&
    body['claimId'].length > 0 &&
    typeof body['obligationId'] === 'string' &&
    body['obligationId'].length > 0 &&
    body['claimId'] !== body['obligationId']
  ) {
    sendJson(res, 400, {
      error:
        'http observation refuses a split claimId/obligationId assignment: supply one ' +
        'explicit obligation id (or a claimIds list)',
    });
    return;
  }
  // Claim binding: `claimIds` (the declaring test's claimed obligation
  // ids for this endpoint) — with the singular legacy `claimId` /
  // `obligationId` pair still accepted and folded in.
  const rawClaimIds = Array.isArray(body['claimIds'])
    ? [...body['claimIds'], body['claimId'], body['obligationId']]
    : [body['claimIds'], body['claimId'], body['obligationId']];
  const claimIds: string[] = [];
  for (const entry of rawClaimIds) {
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'string' || !OBLIGATION_ID_PATTERN.test(entry)) {
      sendJson(res, 400, {
        error:
          'http observation requires claimIds as obligation-id strings ' +
          "'<resourceId>:<contract>' (a singular legacy claimId/obligationId is still accepted)",
      });
      return;
    }
    if (!claimIds.includes(entry)) claimIds.push(entry);
  }
  if (
    claimIds.length === 0 ||
    typeof testId !== 'string' ||
    testId.length === 0 ||
    typeof method !== 'string' ||
    typeof path !== 'string' ||
    path.length === 0 ||
    (expectedStatus !== undefined &&
      (typeof expectedStatus !== 'number' || !Number.isInteger(expectedStatus)))
  ) {
    sendJson(res, 400, {
      error:
        'http observation requires testId, method, and path strings plus at least one ' +
        "claimed obligation id ('<resourceId>:<contract>'); expectedStatus, when present, " +
        'must be an integer status code',
    });
    return;
  }
  const wanted = normalizeObservedPath(path);
  // Phase 1 (E11/E12 foundation): the consuming side must hold a valid
  // OPEN session, and only an exchange observed through THAT session's
  // proxy prefix WITHIN one of its recorded action intervals can be
  // consumed — a request supplied by another test/worker (different
  // session channel) or by setup traffic outside every interval is
  // never credited to this test's claims.
  const session = requireOpenSession(state, body);
  requireSessionTestId(session, testId);
  // Bind watermark (plan §11.4): observations that completed before the
  // trusted context bound predate it and are never consumable under the
  // new invocation — closing the proxy/bind race where a request started
  // before binding but its response ends after it.
  const watermark = state.runContext === null ? 0 : state.observedSeqAtBind;
  const matchesShape = (entry: ObservedExchange): boolean =>
    entry.seq > watermark &&
    entry.method === method.toUpperCase() &&
    entry.path === wanted &&
    (expectedStatus === undefined || entry.status === expectedStatus);
  const index = state.observed.findIndex(
    (entry) =>
      entry.sessionId === session.sessionId &&
      tickWithinSessionInterval(session, entry.tick) &&
      matchesShape(entry),
  );
  if (index === -1) {
    // Precise fail-closed diagnostics: distinguish "outside every
    // interval" from "another session's channel" from "no such traffic".
    const unattributed = state.observed.find((entry) => entry.sessionId === null && matchesShape(entry));
    const foreign = state.observed.find(
      (entry) => entry.sessionId !== null && entry.sessionId !== session.sessionId && matchesShape(entry),
    );
    const outsideInterval = state.observed.find(
      (entry) => entry.sessionId === session.sessionId && matchesShape(entry),
    );
    if (outsideInterval !== undefined) {
      sendJson(res, 409, {
        error:
          `an engine-observed ${method.toUpperCase()} ${wanted} exists for this session but its ` +
          'completion tick falls outside every recorded UI-action observation interval — the ' +
          'fixture marks an interval per UI action, so traffic outside those windows (setup ' +
          'calls, stray navigation) is never browser evidence',
      });
      return;
    }
    if (foreign !== undefined) {
      sendJson(res, 409, {
        error:
          `the engine-observed ${method.toUpperCase()} ${wanted} traversed ANOTHER session's ` +
          'channel; exchanges are consumable only by the session whose proxy prefix they ' +
          'arrived through (a request supplied by another test/worker is never credited)',
      });
      return;
    }
    sendJson(res, 409, {
      error:
        `no engine-observed request matches ${method.toUpperCase()} ${wanted}` +
        `${expectedStatus === undefined ? '' : ` with status ${String(expectedStatus)}`}` +
        `${unattributed === undefined ? '' : ' (traffic bypassed every session channel)'}; drive ` +
        'traffic through this session\'s observation-proxy prefix before claiming the obligation',
    });
    return;
  }
  const observedRequest = state.observed[index] as ObservedExchange;
  // Consume the exchange FIRST (single-use), then issue one record per
  // distinct claimed obligation id — same payload, per-claim identity.
  state.observed.splice(index, 1);
  // Witness-side activity (review recheck fix 2026-09-14): consuming an
  // engine-observed session exchange is an observation the witness made;
  // count it.
  session.activity += 1;
  const payload = {
    method: observedRequest.method,
    url: observedRequest.path,
    status: observedRequest.status,
    bodySha256: observedRequest.bodySha256,
    bodyBytes: observedRequest.bodyBytes,
    sessionId: session.sessionId,
  };
  const issued = claimIds.map((claimId) =>
    issueRecord(state, claimId, 'http.request', session.testId, payload, 'engine-observed'),
  );
  const first = issued[0] as IssuedRecord;
  sendJson(res, 200, {
    recordId: first.recordId,
    runId: first.runId,
    trust: first.trust,
    status: observedRequest.status,
    records: issued.map((record) => ({ recordId: record.recordId, obligationId: record.obligationId })),
  });
}

/**
 * Resolves the engine browser's UI subject — the ONE attested
 * application origin the engine may drive (fake-frontend fix
 * 2026-09-14): `targetBaseUrl`, provisioned through trusted witness
 * configuration (orchestrator env/flags), never from suite input. A
 * copyable fingerprint header cannot authenticate application identity,
 * so origin equality with this provisioned subject is the identity —
 * loopback + fingerprint remain as attestation defense in depth, never
 * as identity.
 *
 * Args:
 *   state: running witness state.
 *
 * Returns:
 *   string: the normalized trusted base (no trailing slash).
 *
 * Throws:
 *   HttpError: 409 when no attested subject is provisioned (browser
 *     proof without a provisioned subject fails closed — it never
 *     falls back to a suite-supplied origin).
 */
function requireTrustedUiBase(state: WitnessState): string {
  const base = state.options.targetBaseUrl;
  if (base === null || base === undefined || base === '') {
    throw new HttpError(
      409,
      'no attested UI subject is provisioned for this witness (targetBaseUrl): browser proof ' +
        'requires the orchestrator to provision the application origin through trusted ' +
        'configuration — the engine never drives a suite-supplied origin',
    );
  }
  return base.replace(/\/+$/, '');
}

/**
 * `POST /browser/surface` (plan Phase 1 item 4): registers the
 * consumer-declared surface descriptor for one open session. The
 * descriptor is validated structurally engine-side; selectors are
 * locators only — registration proves nothing by itself.
 *
 * The driven origin is NOT negotiable here (fake-frontend fix
 * 2026-09-14): a `appBaseUrl` field is rejected outright (400) — the
 * engine drives exactly the provisioned attested subject
 * (`requireTrustedUiBase`), which must be loopback (GF-10) and, when
 * the run pins a target fingerprint, must present it (GF-13). A test
 * that could name its own frontend could point the engine at a fake
 * that replays the real API — origin equality with trusted
 * configuration is the only application identity.
 */
async function handleBrowserSurface(
  state: WitnessState,
  res: ServerResponse,
  body: BrowserSurfaceRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'browser surface body must be an object');
  }
  const { testId, surface } = body as Record<string, unknown>;
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'browser surface requires a non-empty testId');
  }
  if ((body as Record<string, unknown>)['appBaseUrl'] !== undefined) {
    throw new HttpError(
      400,
      'browser surface rejects appBaseUrl: the engine drives exactly the provisioned attested ' +
        'subject from trusted witness configuration — suite-supplied origins are never accepted ' +
        '(a test-named frontend could replay the real API behind a copied fingerprint header)',
    );
  }
  const session = requireOpenSession(state, body);
  requireSessionTestId(session, testId);
  let validated: SurfaceDescriptor;
  try {
    validated = validateSurface(surface as SurfaceDescriptor);
  } catch (error) {
    throw new HttpError(
      400,
      `browser surface descriptor rejected: ${(error as Error).message}`,
    );
  }
  // The trusted subject, resolved BEFORE any browser exists: loopback
  // attestation (GF-10/GF-13) runs against the provisioned origin, never
  // a suite URL.
  const trustedBase = requireTrustedUiBase(state);
  await assertLoopback(trustedBase, 'engine browser base');
  const pinned = state.options.targetFingerprint ?? null;
  if (pinned !== null) {
    const probe = await probeEnvFingerprint(trustedBase, state.options.requestTimeoutMs);
    const mismatch = envFingerprintMismatch(probe, pinned, pinned);
    if (mismatch !== null) {
      throw new HttpError(409, `engine browser subject rejected: ${mismatch}`);
    }
  }
  session.engineSurface = {
    surface: validated as unknown as Record<string, unknown>,
  };
  sendJson(res, 200, { registered: true as const });
}

/** Requires the session's registered engine surface (409 when absent). */
function requireEngineSurface(
  session: TestSession,
): { surface: SurfaceDescriptor } {
  const registered = session.engineSurface;
  if (registered === null) {
    throw new HttpError(
      409,
      'no engine surface is registered for this session: the fixture must register the ' +
        'consumer-declared surface descriptor first (POST /browser/surface) — the engine ' +
        'drives no browser without it',
    );
  }
  return {
    surface: registered.surface as unknown as SurfaceDescriptor,
  };
}

/** Validates browser claim ids: non-empty, obligation-shaped, one resource. */
function requireBrowserClaims(body: Record<string, unknown>): { claimIds: string[]; resourceId: string } {
  const raw = body['claimIds'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'browser calls require a non-empty claimIds array of obligation ids');
  }
  const claimIds: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !OBLIGATION_ID_PATTERN.test(entry)) {
      throw new HttpError(
        400,
        `browser claimIds must be obligation ids '<resourceId>:<contract>' (got '${String(entry)}')`,
      );
    }
    if (!claimIds.includes(entry)) claimIds.push(entry);
  }
  const resources = new Set(claimIds.map((id) => id.slice(0, id.indexOf(':'))));
  if (resources.size !== 1) {
    throw new HttpError(
      400,
      'browser calls bind one resource per action: claimIds span several resources ' +
        `(${[...resources].sort(compareStrings).join(', ')}) — drive one action per resource`,
    );
  }
  return { claimIds, resourceId: [...resources][0] as string };
}

/**
 * `POST /browser/action` (plan Phase 1 item 4): performs ONE constrained
 * surface operation on the session's engine-owned page and issues
 * engine-observed records for exactly what the engine did. The full
 * binding in one call: the relevant rendered control + entered values,
 * the actual action, the resulting application request + entity
 * identity, the visible outcome — plus the engine-side pre-observation
 * the persistence read later consumes (create/update). The captured
 * exchanges join the witness observation log inside the engine's own
 * action interval, so the existing http-observation consume path binds
 * them with single-use semantics.
 */
async function handleBrowserAction(
  state: WitnessState,
  res: ServerResponse,
  body: BrowserActionRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'browser action body must be an object');
  }
  const { testId, operation, fields, entityId } = body as Record<string, unknown>;
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'browser action requires a non-empty testId');
  }
  if (operation !== 'create' && operation !== 'read' && operation !== 'update' && operation !== 'delete') {
    throw new HttpError(400, "browser action operation must be one of 'create' | 'read' | 'update' | 'delete'");
  }
  if (fields !== undefined && !isPlainObject(fields)) {
    throw new HttpError(400, 'browser action fields, when present, must be a string-valued object');
  }
  if (entityId !== undefined && typeof entityId !== 'string') {
    throw new HttpError(400, 'browser action entityId, when present, must be a string');
  }
  const session = requireOpenSession(state, body);
  const boundTestId = requireSessionTestId(session, testId);
  const { claimIds, resourceId } = requireBrowserClaims(body);
  const { surface } = requireEngineSurface(session);
  // The driven origin comes from trusted configuration on EVERY call —
  // never from stored suite input (there is none anymore).
  const appBaseUrl = requireTrustedUiBase(state);

  // The engine's own observation interval (witness clock, never suite
  // time): exchanges captured during the drive land inside it.
  const { intervalId } = openActionInterval(state, session, operation);
  // Engine-side pre-observation BEFORE the drive (create: id-set
  // absence; update: entity-fields delta) — the persistence read later
  // consumes it under the same session.
  let preObservationId: string | null = null;
  if (operation === 'create' || operation === 'update') {
    const pre = await takePreObservation(
      state,
      session,
      resourceId,
      operation === 'update' ? (entityId ?? '') : undefined,
    );
    preObservationId = pre.observationId;
  }
  try {
    const page = await state.engineBrowser.pageFor(session.sessionId);
    const observation = await driveEngineAction(page, appBaseUrl, surface, operation as EngineOperation, {
      ...(fields !== undefined ? { fields: fields as Record<string, string> } : {}),
      ...(entityId !== undefined ? { entityId } : {}),
    });
    // Publish the captured exchanges into the witness observation log
    // INSIDE the engine interval (ticks between open and close), so the
    // existing single-use http-observation consume path binds them.
    for (const exchange of observation.exchanges) {
      state.observed.push({
        method: exchange.method,
        path: exchange.path,
        status: exchange.status,
        seq: (state.observedSeq += 1),
        bodySha256: createHash('sha256').update(exchange.body).digest('hex'),
        bodyBytes: exchange.body.length,
        // Engine-captured exchanges carry no request body (the engine
        // typed the input; entered fields ride the ui.action record) —
        // they can never serve an observe finalize, which requires the
        // proxied request bytes.
        requestBody: null,
        requestTruncated: false,
        requestBytes: 0,
        requestContentType: null,
        sessionId: session.sessionId,
        tick: (state.tick += 1),
      });
    }
    // Suite-submittable intervals/records stay open-submission; the
    // ENGINE's own window closes here — late suite traffic after this
    // tick is outside the engine interval and never credited.
    closeActionInterval(state, session, intervalId);
    // Witness-side activity: the engine drove a real browser action
    // under the session; count it.
    session.activity += 1;
    // One engine-observed ui.action per claimed obligation (same
    // payload, per-claim identity — the http-observation convention).
    // The payload carries what the ENGINE observed: the operation, the
    // rendered entity id, and the ENTERED input (exact-value echo
    // source) — never suite-declared outcomes.
    const issued = claimIds.map((claimId) =>
      issueRecord(
        state,
        claimId,
        'ui.action',
        boundTestId,
        {
          operation,
          entityId: observation.entityId,
          fields: observation.enteredFields,
          sessionId: session.sessionId,
        },
        'engine-observed',
      ),
    );
    const appStatus =
      operation === 'read'
        ? (observation.exchanges[0]?.status ?? 0)
        : (observation.exchanges.find((entry) => entry.method !== 'GET' && entry.method !== 'HEAD' && entry.status < 400)?.status ?? 0);
    const response: BrowserActionResponse = {
      entityId: observation.entityId,
      enteredFields: observation.enteredFields,
      renderedFields: observation.renderedFields,
      appStatus,
      preObservationId,
      recordIds: issued.map((record) => record.recordId),
    };
    sendJson(res, 200, response);
  } catch (error) {
    // The drive failed AFTER the interval opened: seal the window so a
    // failed action never leaves a dangling interval for later traffic
    // to borrow, then fail the call (the test fails; the gate blocks).
    try {
      closeActionInterval(state, session, intervalId);
    } catch {
      // already closed — ignore
    }
    if (error instanceof EngineBrowserError) {
      throw new HttpError(409, `engine browser action failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * `POST /browser/visible` (plan Phase 1 item 4): re-reads the rendered
 * result for the engine-observed entity on the session's engine page
 * and issues engine-observed visible-result records (row readback for
 * mutations, form readback for reads).
 */
async function handleBrowserVisible(
  state: WitnessState,
  res: ServerResponse,
  body: BrowserVisibleRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'browser visible body must be an object');
  }
  const { testId, entityId, operation } = body as Record<string, unknown>;
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'browser visible requires a non-empty testId');
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new HttpError(400, 'browser visible requires a non-empty entityId');
  }
  if (operation !== 'create' && operation !== 'read' && operation !== 'update' && operation !== 'delete') {
    throw new HttpError(400, "browser visible operation must be one of 'create' | 'read' | 'update' | 'delete'");
  }
  const session = requireOpenSession(state, body);
  const boundTestId = requireSessionTestId(session, testId);
  const { claimIds } = requireBrowserClaims(body);
  const { surface } = requireEngineSurface(session);
  // The driven origin comes from trusted configuration on EVERY call —
  // never from stored suite input (there is none anymore).
  const appBaseUrl = requireTrustedUiBase(state);
  try {
    const page = await state.engineBrowser.pageFor(session.sessionId);
    const fields = await readEngineVisible(page, appBaseUrl, surface, operation as EngineOperation, entityId);
    session.activity += 1;
    const issued = claimIds.map((claimId) =>
      issueRecord(
        state,
        claimId,
        'ui.visible-result',
        boundTestId,
        { entityId, fields, sessionId: session.sessionId },
        'engine-observed',
      ),
    );
    const response: BrowserVisibleResponse = {
      entityId,
      fields,
      recordIds: issued.map((record) => record.recordId),
    };
    sendJson(res, 200, response);
  } catch (error) {
    if (error instanceof EngineBrowserError) {
      throw new HttpError(409, `engine browser visible read failed: ${error.message}`);
    }
    throw error;
  }
}

/** Formats the bind host into a URL host (bracketing IPv6 literals). */
function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Routes one request through auth + body parse + dispatch. */
async function handleRequest(
  state: WitnessState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const token = req.headers[RUN_HEADER];
    if (typeof token !== 'string' || !timingSafeEqual(token, state.options.token)) {
      sendJson(res, 401, { error: 'unauthorized: expected x-gateforge-run with the run token' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://witness');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        ok: true,
        runId: state.options.runId,
        attestationScope: 'loopback+env-fingerprint',
        adapterCount: state.adapters.size,
        recordCount: state.ledger.size,
      });
      return;
    }
    if (req.method === 'GET' && path === '/records') {
      const records = [...state.ledger.values()].sort((a, b) => compareStrings(a.recordId, b.recordId));
      sendJson(res, 200, { records });
      return;
    }
    if (req.method === 'GET' && path === '/ledger-attestation') {
      handleLedgerAttestation(state, res, req.headers[VERIFIER_HEADER]);
      return;
    }
    if (req.method === 'POST' && path === '/run-context') {
      await handleRunContext(state, res, req.headers[VERIFIER_HEADER], await readBody(req));
      return;
    }
    if (req.method === 'GET' && path === '/classifications') {
      const resources: Record<string, unknown> = {};
      for (const key of Object.keys(state.classifications).sort(compareStrings)) {
        resources[key] = toClassificationView(state.classifications[key] as Classification);
      }
      sendJson(res, 200, { resources });
      return;
    }
    if (req.method === 'POST' && path === '/records') {
      await handleRecords(state, res, (await readBody(req)) as RecordsRequest);
      return;
    }
    if (req.method === 'POST' && path === '/runs/expected-set') {
      await handleExpectedSet(
        state,
        res,
        req.headers[VERIFIER_HEADER],
        (await readBody(req)) as ExpectedSetRequest,
      );
      return;
    }
    if (req.method === 'POST' && path === '/runs/server-e2e-declarations') {
      await handleServerE2eDeclarations(
        state,
        res,
        req.headers[VERIFIER_HEADER],
        (await readBody(req)) as ServerE2eDeclarationsRequest,
      );
      return;
    }
    if (req.method === 'POST' && path === '/runs/observe-declarations') {
      await handleObserveDeclarations(
        state,
        res,
        req.headers[VERIFIER_HEADER],
        (await readBody(req)) as ObserveDeclarationsRequest,
      );
      return;
    }
    if (req.method === 'POST' && path === '/observe/finalize') {
      await handleObserveFinalize(
        state,
        res,
        req.headers[VERIFIER_HEADER],
        (await readBody(req)) as ObserveFinalizeRequest,
      );
      return;
    }
    if (req.method === 'GET' && path === '/runs/execution-trace') {
      requireSupervisor(state, req.headers[VERIFIER_HEADER]);
      sendJson(res, 200, executionTraceOf(state));
      return;
    }
    if (req.method === 'POST' && path === '/sessions/open') {
      requireSupervisor(state, req.headers[VERIFIER_HEADER]);
      await handleSessionOpen(state, res, (await readBody(req)) as SessionOpenRequest);
      return;
    }
    if (req.method === 'POST' && path === '/sessions/close') {
      requireSupervisor(state, req.headers[VERIFIER_HEADER]);
      await handleSessionClose(state, res, (await readBody(req)) as SessionCloseRequest);
      return;
    }
    if (req.method === 'POST' && path === '/sessions/resolve') {
      await handleSessionResolve(state, res, (await readBody(req)) as SessionResolveRequest);
      return;
    }
    if (req.method === 'POST' && path === '/sessions/intervals/open') {
      await handleIntervalOpen(state, res, (await readBody(req)) as Record<string, unknown>);
      return;
    }
    if (req.method === 'POST' && path === '/sessions/intervals/close') {
      await handleIntervalClose(state, res, (await readBody(req)) as Record<string, unknown>);
      return;
    }
    if (req.method === 'POST' && path === '/witness/pre-observation') {
      await handlePreObservation(state, res, (await readBody(req)) as PreObservationRequest);
      return;
    }
    if (req.method === 'POST' && path === '/witness/persistence') {
      await handlePersistence(state, res, (await readBody(req)) as PersistenceRequest);
      return;
    }
    if (req.method === 'POST' && path === '/witness/server-persistence') {
      await handleServerPersistence(
        state,
        res,
        req.headers[VERIFIER_HEADER],
        (await readBody(req)) as ServerPersistenceIntentRequest,
      );
      return;
    }
    if (req.method === 'POST' && path === '/witness/http-observation') {
      await handleHttpObservation(state, res, (await readBody(req)) as Record<string, unknown>);
      return;
    }
    if (req.method === 'POST' && path === '/browser/surface') {
      await handleBrowserSurface(state, res, (await readBody(req)) as BrowserSurfaceRequest);
      return;
    }
    if (req.method === 'POST' && path === '/browser/action') {
      await handleBrowserAction(state, res, (await readBody(req)) as BrowserActionRequest);
      return;
    }
    if (req.method === 'POST' && path === '/browser/visible') {
      await handleBrowserVisible(state, res, (await readBody(req)) as BrowserVisibleRequest);
      return;
    }
    sendJson(res, 404, { error: `no witness endpoint at ${req.method} ${path}` });
  } catch (error) {
    if (error instanceof HttpError) {
      const detail = error.detail;
      sendJson(
        res,
        error.status,
        detail === null ? { error: error.message } : { error: error.message, detail },
      );
      return;
    }
    if (error instanceof AttestationError) {
      sendJson(res, 409, { error: 'attestation blocked', detail: error.message });
      return;
    }
    sendJson(
      res,
      500,
      { error: `witness internal error: ${error instanceof Error ? error.message : String(error)}` },
    );
  }
}

/** Constant-time token comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Enforces the SUPERVISOR capability (enforcement-review fix 3): the
 * verifier key — the secret the tested suite never receives. The suite's
 * run token authorizes evidence submission and session resolution, never
 * session lifecycle, expected-set registration, traces, or attestation.
 * A witness without a configured verifier key has NO supervisor
 * capability at all: every supervisor endpoint answers 403 (fail closed)
 * rather than degrading to run-token authority.
 *
 * Args:
 *   state: running witness state.
 *   verifier: the `x-gateforge-verifier` header value.
 *
 * Throws:
 *   HttpError: 403 when the witness holds no verifier key (typed
 *     'supervisor authorization required') or 401 on a key mismatch.
 */
function requireSupervisor(state: WitnessState, verifier: unknown): void {
  const verifierKey = state.options.verifierKey;
  if (verifierKey === null || verifierKey === undefined) {
    throw new HttpError(
      403,
      'supervisor authorization required: this witness runs without a verifier key, so the ' +
        'supervisor surface (expected set, session open/close, execution trace) is unavailable — ' +
        'start the witness with GATEFORGE_WITNESS_VERIFIER_KEY from the orchestrating CLI',
    );
  }
  if (typeof verifier !== 'string' || !timingSafeEqual(verifier, verifierKey)) {
    throw new HttpError(
      401,
      'unauthorized: supervisor endpoints require x-gateforge-verifier with the verifier key ' +
        '(the run token never authorizes session lifecycle)',
    );
  }
}

/** Sends a GF-canonical JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(canonicalOf(body));
}

/**
 * `POST /runs/expected-set` (enforcement-review fix 2a) — SUPERVISOR
 * ONLY: registers the expected test set BEFORE the run, bound to this
 * run in witness memory. Once registered, `/sessions/open` accepts only
 * tests in this set (an invented testId is refused), and the execution
 * trace groups sessions by these registered identities. Identical
 * re-registration is idempotent (200); any change is 409; registration
 * after any session was opened is 409 (the expected set is a PRE-run
 * fact). The response carries the domain-separated enumeration digest
 * the sealed execution result binds.
 *
 * Args:
 *   state: running witness state.
 *   res: response to answer.
 *   verifier: the `x-gateforge-verifier` header value.
 *   body: the parsed request body ({tests: [...]}, identity-shaped).
 */
async function handleExpectedSet(
  state: WitnessState,
  res: ServerResponse,
  verifier: unknown,
  body: ExpectedSetRequest,
): Promise<void> {
  requireSupervisor(state, verifier);
  if (!isPlainObject(body) || !Array.isArray(body['tests'])) {
    throw new HttpError(400, 'expected-set body must be {tests: [...]}');
  }
  const tests: Array<{ testId: string | null; project: string | null; file: string; titlePath: string[] }> = [];
  for (const entry of body['tests']) {
    if (typeof entry !== 'object' || entry === null) {
      throw new HttpError(400, 'expected-set tests must be objects');
    }
    const row = entry as Record<string, unknown>;
    const testId = row['testId'] === undefined || row['testId'] === null ? null : row['testId'];
    const project = row['project'] === undefined || row['project'] === null ? null : row['project'];
    if (
      (testId !== null && typeof testId !== 'string') ||
      (project !== null && typeof project !== 'string') ||
      typeof row['file'] !== 'string' ||
      row['file'].length === 0 ||
      !Array.isArray(row['titlePath']) ||
      (row['titlePath'] as unknown[]).length === 0 ||
      !(row['titlePath'] as unknown[]).every((part) => typeof part === 'string' && part.length > 0)
    ) {
      throw new HttpError(
        400,
        'expected-set tests require file (non-empty string), titlePath (non-empty string array), ' +
          'and optional testId/project strings',
      );
    }
    tests.push({
      testId: testId,
      project: project,
      file: row['file'],
      titlePath: row['titlePath'] as string[],
    });
  }
  const digest = enumerationDigestOf(tests);
  if (state.enumerationDigest !== null) {
    if (state.enumerationDigest === digest) {
      sendJson(res, 200, { bound: true as const, enumerationDigest: digest, count: state.expectedTests.size });
      return;
    }
    sendJson(res, 409, {
      error:
        'an expected set is already bound to this run and differs; the expected set is a PRE-run ' +
        'fact and is never relabeled — start a fresh witness for a new invocation',
    });
    return;
  }
  if (state.sessions.size > 0) {
    sendJson(res, 409, {
      error:
        'sessions were already opened on this witness; the expected set must be registered ' +
        'BEFORE the run — start a fresh witness for a new invocation',
    });
    return;
  }
  state.expectedTests.clear();
  for (const test of tests) {
    state.expectedTests.set(expectedKey(test.project, test.file, test.titlePath), test);
  }
  state.enumerationDigest = digest;
  sendJson(res, 200, { bound: true as const, enumerationDigest: digest, count: state.expectedTests.size });
}

/**
 * Builds the witness-side execution trace (enforcement-review fix 2b):
 * per registered expected test, every recorded session with its open/
 * seal ticks and outcome. When no expected set is registered, sessions
 * are grouped by their own open identity (the legacy/standalone shape).
 * This record lives ONLY in witness memory — the suite cannot mint,
 * alter, or replay it — and is the authority supervision grades
 * completeness from.
 */
function executionTraceOf(state: WitnessState): ExecutionTraceResponse {
  const byKey = new Map<
    string,
    ExecutionTraceResponse['tests'][number]
  >();
  for (const session of state.sessions.values()) {
    const key =
      session.registered !== null
        ? expectedKey(session.registered.project, session.registered.file, session.registered.titlePath)
        : `runtime\u0000${session.sessionId}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        testId: session.registered?.testId ?? session.testId,
        project: session.registered?.project ?? null,
        file: session.registered?.file ?? '',
        titlePath: session.registered?.titlePath ?? [],
        sessions: [],
      };
      byKey.set(key, entry);
    }
    const traced: TracedSession = {
      sessionId: session.sessionId,
      openedTick: session.openedTick,
      sealedTick: session.sealedTick,
      outcome: session.outcome,
      // Witness-side activity (review recheck fix 2026-09-14): the count
      // of session-bound observations the witness itself made. A sealed
      // 'passed' session with zero activity blocks supervision — the
      // runner-reported outcome alone proves nothing.
      activity: session.activity,
    };
    entry.sessions.push(traced);
  }
  return {
    enumerationDigest: state.enumerationDigest,
    tests: [...byKey.entries()]
      .sort((a, b) => compareStrings(a[0], b[0]))
      .map(([, entry]) => ({ ...entry, sessions: [...entry.sessions].sort((a, b) => a.openedTick - b.openedTick) })),
  };
}

/**
 * `POST /sessions/open` (plan Phase 1; enforcement-review fix 3) —
 * SUPERVISOR ONLY: the trusted CLI (which owns the verifier key) registers
 * one started test. The witness issues the session binding — (runId,
 * sessionId, testId, worker) — and, when an observation proxy is active,
 * a per-session browser mount segment. One session may be OPEN per worker
 * at a time (a worker runs one test at a time; overlapping sessions would
 * make interval attribution ambiguous — fail closed instead). Re-opening
 * the identical (worker, testId) pair while it is still open is
 * idempotent (double `testBegin` dispatch safety).
 *
 * When an expected set is registered (fix 2a), the opened test must
 * belong to it — matched by the registered (project, file, titlePath)
 * identity the supervisor carries from the runner's lifecycle spool — so
 * a suite-invented testId can never mint a session.
 *
 * The suite holds the run token but CANNOT mint sessions with it: the
 * run token alone answers 403 typed.
 */
async function handleSessionOpen(
  state: WitnessState,
  res: ServerResponse,
  body: SessionOpenRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'session open body must be an object');
  }
  const { testId, workerIndex } = body;
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'session open requires a non-empty testId (the runner-assigned test id)');
  }
  if (typeof workerIndex !== 'number' || !Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new HttpError(400, 'session open requires a non-negative integer workerIndex');
  }
  // Expected-set membership (fix 2a): once the supervisor registered the
  // expected tests, sessions exist only for them. Identity comes from the
  // supervisor's spool drain (file + titlePath + project).
  let registered: { testId: string | null; project: string | null; file: string; titlePath: string[] } | null = null;
  if (state.enumerationDigest !== null) {
    const file = typeof body['file'] === 'string' ? body['file'] : null;
    const rawTitlePath = Array.isArray(body['titlePath'])
      ? (body['titlePath'] as unknown[]).filter((part): part is string => typeof part === 'string')
      : null;
    const project = typeof body['project'] === 'string' ? body['project'] : null;
    registered =
      file !== null && rawTitlePath !== null && rawTitlePath.length > 0
        ? state.expectedTests.get(expectedKey(project, file, rawTitlePath)) ?? null
        : null;
    if (registered === null) {
      throw new HttpError(
        403,
        `session open refused: test '${testId}' is not in the registered expected set — ` +
          'sessions are minted only for the tests the supervisor registered before the run',
      );
    }
  }
  const existingWorkerSession = state.workerSessions.get(workerIndex);
  if (existingWorkerSession !== undefined) {
    const open = state.sessions.get(existingWorkerSession) as TestSession | undefined;
    if (open !== undefined && open.testId === testId) {
      // Idempotent re-open of the identical (worker, testId) session.
      sendJson(res, 200, sessionView(state, open));
      return;
    }
    sendJson(res, 409, {
      error:
        `worker ${String(workerIndex)} already carries an open session for testId ` +
        `'${open === undefined ? existingWorkerSession : open.testId}'; a worker runs one test ` +
        'at a time — close the session before opening another',
    });
    return;
  }
  // Phase 4 claim injection: the supervisor carries the mapped obligation
  // claims for this test on the session-open path. Claims stay
  // DECLARATIONS (they never satisfy anything by themselves), but the
  // witness normalizes them — obligation-id-shaped, sorted, deduplicated
  // — and refuses malformed values so a typo cannot silently redirect
  // evidence to a nonexistent claim identity.
  const rawClaims = body['claims'];
  let claims: string[] = [];
  if (rawClaims !== undefined) {
    if (!Array.isArray(rawClaims)) {
      throw new HttpError(400, 'session open claims, when present, must be an array of obligation ids');
    }
    const seen = new Set<string>();
    for (const claim of rawClaims) {
      if (typeof claim !== 'string' || !OBLIGATION_ID_PATTERN.test(claim)) {
        throw new HttpError(
          400,
          `session open claims must be obligation ids '<resourceId>:<contract>' (got '${String(claim)}')`,
        );
      }
      seen.add(claim);
    }
    claims = [...seen].sort(compareStrings);
  }
  const sessionId = randomUUID();
  const session: TestSession = {
    sessionId,
    token: randomUUID(),
    testId,
    workerIndex,
    status: 'open',
    openedTick: (state.tick += 1),
    sealedTick: null,
    outcome: null,
    intervals: new Map(),
    // Filled below: the session's DEDICATED observation-proxy port.
    proxyUrl: null,
    proxyServer: null,
    claims,
    // The registered expected-set identity this session was minted for
    // (enforcement-review fix 2b); null when no expected set is bound.
    registered:
      registered !== null
        ? {
            testId: registered.testId,
            project: registered.project,
            file: registered.file,
            titlePath: [...registered.titlePath],
          }
        : null,
    // Witness-side activity counter: incremented at every observation
    // the witness itself makes under this session (records, intervals,
    // exchanges, pre-observations). Diagnostic corroboration only —
    // execution authority is the supervisor-observed trusted lifecycle,
    // not this count.
    activity: 0,
    // Engine-browser surface registration (plan Phase 1 item 4): the
    // validated consumer descriptor + loopback app base the engine
    // drives for this session. Null until the fixture registers it.
    engineSurface: null,
  };
  // Session attribution channel (plan Phase 1): a dedicated loopback
  // proxy port whose traffic is attributed to THIS session. Exists only
  // when an observation proxy is wired; otherwise nothing browser-side
  // is attributable.
  await startSessionProxy(state, session);
  state.sessions.set(sessionId, session);
  state.workerSessions.set(workerIndex, sessionId);
  // Observe before-snapshots (Phase 2): the witness lists the
  // observe-declared resources ITSELF at open. Total by construction —
  // a snapshot failure is finalize data, never an open failure.
  try {
    await takeObserveSnapshots(state, session);
  } catch {
    state.observeSnapshots.delete(sessionId);
  }
  sendJson(res, 200, sessionView(state, session));
}

/** The session view returned to supervisor and worker (the credential). */
function sessionView(state: WitnessState, session: TestSession): {
  sessionId: string;
  sessionToken: string;
  testId: string;
  workerIndex: number;
  openedTick: number;
  proxyUrl: string | null;
  claims: string[];
} {
  void state;
  return {
    sessionId: session.sessionId,
    sessionToken: session.token,
    testId: session.testId,
    workerIndex: session.workerIndex,
    openedTick: session.openedTick,
    proxyUrl: session.proxyUrl,
    claims: [...session.claims],
  };
}

/**
 * `POST /sessions/close` (plan Phase 1; enforcement-review fix 3) —
 * SUPERVISOR ONLY (enforced at dispatch): the supervisor seals the
 * session with the observed outcome. Sealing is FINAL — every later
 * submission, interval, or resolve for the session is rejected, so
 * records cannot be injected after the test ended. Closing an unknown
 * session fails (400); closing an already-sealed session is idempotent
 * (safe re-delivery). The suite has NO reachable close path: the run
 * token alone answers 403 before this handler runs.
 */
async function handleSessionClose(
  state: WitnessState,
  res: ServerResponse,
  body: SessionCloseRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'session close body must be an object');
  }
  const { sessionId, outcome } = body;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new HttpError(400, 'session close requires a sessionId');
  }
  if (outcome !== undefined && typeof outcome !== 'string') {
    throw new HttpError(400, 'session close outcome, when present, must be a string');
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    throw new HttpError(400, `session '${sessionId}' is unknown (never opened on this witness)`);
  }
  if (session.status === 'open') {
    session.status = 'sealed';
    session.sealedTick = (state.tick += 1);
    session.outcome = typeof outcome === 'string' ? outcome : null;
    state.workerSessions.delete(session.workerIndex);
    // Observe snapshots die with the session: finalize runs BEFORE seal
    // (the drain finalizes a passed test, then seals), so anything left
    // here belongs to a test that never finalized — unsealed evidence
    // must not linger for a later call to consume.
    state.observeSnapshots.delete(sessionId);
    // The dedicated channel dies with the session: nothing can observe
    // (or submit) through it afterwards. The engine browser context dies
    // too — a sealed session's pages are never driven again.
    await stopSessionProxy(session);
    await state.engineBrowser.closeSession(session.sessionId);
  }
  sendJson(res, 200, { sealed: true as const });
}

/**
 * `POST /sessions/resolve` (plan Phase 1): the worker-side fixture asks
 * for the session credential of the OPEN session bound to its exact
 * (workerIndex, testId) pair. Only an open session answers — a sealed
 * or never-opened session 404s — so the fixture can never obtain a
 * credential for a session the supervisor did not open for exactly this
 * test instance.
 */
async function handleSessionResolve(
  state: WitnessState,
  res: ServerResponse,
  body: SessionResolveRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'session resolve body must be an object');
  }
  const { testId, workerIndex } = body;
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'session resolve requires a non-empty testId');
  }
  if (typeof workerIndex !== 'number' || !Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new HttpError(400, 'session resolve requires a non-negative integer workerIndex');
  }
  const sessionId = state.workerSessions.get(workerIndex);
  const session = sessionId === undefined ? undefined : state.sessions.get(sessionId);
  if (session === undefined || session.status !== 'open' || session.testId !== testId) {
    sendJson(res, 404, {
      error:
        `no open session for (workerIndex ${String(workerIndex)}, testId '${testId}'); the ` +
        'supervisor (the gateforge reporter) opens a session per started test — run under ' +
        'the pack reporter so evidence primitives can resolve their session',
    });
    return;
  }
  sendJson(res, 200, sessionView(state, session));
}

/**
 * Enforces the supervisor-issued session credential on a submission:
 * the session must EXIST (403 otherwise), carry a token that matches
 * (timing-safe), and still be OPEN (409 once sealed — late submissions
 * after close are rejected fail closed).
 */
function requireOpenSession(state: WitnessState, body: Record<string, unknown>): TestSession {
  const sessionId = body['sessionId'];
  const sessionToken = body['sessionToken'];
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof sessionToken !== 'string') {
    throw new HttpError(
      400,
      'submissions require the supervisor-issued session credential (sessionId + sessionToken); ' +
        'run under the gateforge reporter so the test session is opened and resolved',
    );
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined || !timingSafeEqual(sessionToken, session.token)) {
    throw new HttpError(
      403,
      'session credential is unknown to this witness: sessions are issued only by the ' +
        'supervisor channel (/sessions/open) and cannot be minted from the run token',
    );
  }
  if (session.status !== 'open') {
    throw new HttpError(
      409,
      `session for testId '${session.testId}' was sealed at tick ${String(session.sealedTick)}: ` +
        'late submissions after session close are rejected (no post-hoc record injection)',
    );
  }
  return session;
}

/**
 * Forces the submission's testId onto the session: the record's test
 * identity is the supervisor-registered one, never a caller-declared
 * value — a suite-supplied testId cannot assign evidence to another
 * test (plan Phase 1 work item 2).
 */
function requireSessionTestId(session: TestSession, testId: unknown): string {
  if (testId !== session.testId) {
    throw new HttpError(
      403,
      `submission testId '${String(testId)}' does not match the open session's ` +
        `supervisor-registered testId '${session.testId}' — records bind to the session ` +
        'the supervisor opened, never to a caller-declared test id',
    );
  }
  return session.testId;
}

/**
 * Opens a UI-action observation interval on the witness clock (at most
 * one open per session — opening auto-closes the previous). Shared by
 * the suite-callable endpoint and the engine browser driver: both
 * produce witness-stamped windows, never suite-supplied times.
 */
function openActionInterval(
  state: WitnessState,
  session: TestSession,
  operation: string,
): { intervalId: string; startTick: number } {
  for (const interval of session.intervals.values()) {
    if (interval.endTick === null) interval.endTick = (state.tick += 1);
  }
  const intervalId = randomUUID();
  const startTick = (state.tick += 1);
  session.intervals.set(intervalId, { startTick, endTick: null, operation });
  // Witness-side activity: a recorded UI-action interval is a
  // witness-kept window; count it.
  session.activity += 1;
  return { intervalId, startTick };
}

/** Seals one UI-action observation interval (unknown/duplicate → throw). */
function closeActionInterval(
  state: WitnessState,
  session: TestSession,
  intervalId: string,
): { startTick: number; endTick: number } {
  const interval = session.intervals.get(intervalId);
  if (interval === undefined) {
    throw new HttpError(400, `interval '${intervalId}' is unknown for this session`);
  }
  if (interval.endTick !== null) {
    throw new HttpError(409, `interval '${intervalId}' is already closed (endTick ${String(interval.endTick)})`);
  }
  interval.endTick = (state.tick += 1);
  return { startTick: interval.startTick, endTick: interval.endTick };
}

/**
 * `POST /sessions/intervals/open`: the fixture marks the START of a
 * UI-action observation interval on the witness's monotonic clock. At
 * most one interval is open per session — opening a new one auto-closes
 * the previous (a dangling interval must not silently widen the
 * evidence window).
 */
async function handleIntervalOpen(
  state: WitnessState,
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const session = requireOpenSession(state, body);
  const operation = body['operation'];
  if (typeof operation !== 'string' || operation.length === 0) {
    throw new HttpError(400, 'interval open requires a non-empty operation label');
  }
  const { intervalId, startTick } = openActionInterval(state, session, operation);
  sendJson(res, 200, { intervalId, startTick });
}

/**
 * `POST /sessions/intervals/close`: seals a UI-action observation
 * interval. Closing an unknown interval fails (400); closing twice is
 * refused (409) — a sealed window must not be stretched after the fact.
 */
async function handleIntervalClose(
  state: WitnessState,
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const session = requireOpenSession(state, body);
  const intervalId = body['intervalId'];
  if (typeof intervalId !== 'string' || intervalId.length === 0) {
    throw new HttpError(400, 'interval close requires an intervalId');
  }
  const { startTick, endTick } = closeActionInterval(state, session, intervalId);
  sendJson(res, 200, { startTick, endTick });
}

/**
 * Whether an exchange observed at `tick` falls inside one of the
 * session's recorded UI-action intervals (open intervals extend to the
 * current moment — an observe arriving between action end and interval
 * close still sees the window). Exchanges outside every interval are
 * NEVER credited: that is setup traffic, not the browser action
 * (plan Phase 1 item 6).
 */
function tickWithinSessionInterval(session: TestSession, tick: number): boolean {
  for (const interval of session.intervals.values()) {
    if (tick >= interval.startTick && (interval.endTick === null || tick <= interval.endTick)) {
      return true;
    }
  }
  return false;
}

/**
 * `POST /records`: validates and issues a submitted evidence record.
 * Unknown primitive kinds → 400 (GF-11: an unregistered primitive name
 * has no registration path; GF-14: the audit-event primitive is
 * implementation-gated and does not exist yet). Only the two UI
 * primitives are suite-submittable; `http.request` and persistence
 * records are witness-issued only (engine-side observation), so no
 * claimed-side path can mint them. Phase 1: issuance requires a valid
 * OPEN session — the record's testId is forced onto the session's
 * supervisor-registered value and the payload carries the session id,
 * so every record self-describes the channel it was minted through.
 */
async function handleRecords(
  state: WitnessState,
  res: ServerResponse,
  body: RecordsRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'request body must be an object');
  }
  const { claimId, kind, payload, testId } = body as Record<string, unknown>;
  if (typeof claimId !== 'string' || !OBLIGATION_ID_PATTERN.test(claimId)) {
    throw new HttpError(400, "claimId must be an obligation id '<resourceId>:<contract>'");
  }
  if (typeof kind !== 'string' || !KNOWN_RECORD_KINDS.includes(kind)) {
    throw new HttpError(
      400,
      `unknown evidence primitive '${String(kind)}'; accepted kinds: ${KNOWN_RECORD_KINDS.join(', ')} ` +
        '(http.request and persistence records are witness-issued only: /witness/http-observation ' +
        'and /witness/persistence)',
    );
  }
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'testId must be a non-empty string');
  }
  if (!isPlainObject(payload)) {
    throw new HttpError(400, 'payload must be a JSON object');
  }
  const session = requireOpenSession(state, body);
  requireSessionTestId(session, testId);
  const record = issueRecord(
    state,
    claimId,
    kind,
    session.testId,
    { ...payload, sessionId: session.sessionId },
    'suite-submitted',
  );
  // Witness-side activity (review recheck fix 2026-09-14): a submitted
  // record under an open session is a session-bound event the witness
  // issued; count it. (Content trust stays claimed — the count only
  // corroborates session liveness for supervision, never evidence
  // strength.)
  session.activity += 1;
  const response: RecordsResponse = {
    recordId: record.recordId,
    trust: record.trust,
    runId: record.runId,
  };
  sendJson(res, 200, response);
}

/**
 * `POST /witness/persistence`: runs the engine-side adapter (GET-only)
 * for one entity, stamps a persistence record from the ADAPTER RESPONSE,
 * and returns the verdict-relevant comparison. Attestation failures
 * (GF-10 non-loopback base, GF-13 fingerprint mismatch) REJECT the
 * record with 409 — raw adapter responses never leave this process.
 *
 * The issued record's payload is the ENGINE OBSERVATION the verdict
 * engine grades postconditions against (audit rounds 4-5): `{resourceId,
 * entityId, found, fields?, before?}`. Expectations NEVER come from the
 * tested suite; `before` links a consumed pre-observation (id-set
 * absence for create, entity-fields snapshot for update).
 */
async function handlePersistence(
  state: WitnessState,
  res: ServerResponse,
  body: PersistenceRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'request body must be an object');
  }
  const { resourceId, entityId, testId, claimId, preObservationId } = body as Record<
    string,
    unknown
  >;
  if (typeof resourceId !== 'string' || resourceId.length === 0) {
    throw new HttpError(400, 'resourceId must be a non-empty string');
  }
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'testId must be a non-empty string');
  }
  if (typeof claimId !== 'string' || !OBLIGATION_ID_PATTERN.test(claimId)) {
    throw new HttpError(400, "claimId must be an obligation id '<resourceId>:<contract>'");
  }
  if (
    preObservationId !== undefined &&
    (typeof preObservationId !== 'string' || preObservationId.length === 0)
  ) {
    throw new HttpError(400, 'preObservationId must be a non-empty string when present');
  }
  // Phase 1: engine-side reads run under the supervisor-opened session,
  // so the persistence record binds to the same channel the UI action
  // used (and the record's testId is the session's, never caller-declared).
  const session = requireOpenSession(state, body);
  const boundTestId = requireSessionTestId(session, testId);
  const boundClaimId = String(claimId);

  const { adapterName, adapter, baseUrl } = await adapterReadContext(state, resourceId);

  // Consume the referenced pre-observation, if any (single-use). Its
  // contents — never suite-declared expectations — are what the engine
  // grades create/update postconditions against.
  let before: { entityAbsent: boolean } | { found: boolean; fields?: unknown } | undefined;
  let consumed:
    | { resourceId: string; kind: 'ids'; ids: string[] }
    | { resourceId: string; kind: 'entity'; entityId: string; found: boolean; fields?: unknown }
    | undefined;
  if (typeof preObservationId === 'string') {
    const observation = state.preObservations.get(preObservationId);
    if (observation === undefined || observation.resourceId !== resourceId) {
      throw new HttpError(
        400,
        `pre-observation '${preObservationId}' is unknown, already consumed, or belongs to another resource`,
      );
    }
    state.preObservations.delete(preObservationId);
    consumed = observation;
    before = { entityAbsent: true }; // refined below for ids-kind snapshots
  }

  // Execute the adapter's GET-only read through the mediated transport.
  const adapterHeaders = state.options.adapterReadAuthorization
    ? { authorization: state.options.adapterReadAuthorization }
    : undefined;
  const ctx = makeAdapterContext(baseUrl, resourceId, (path: string) =>
    adapterGet(baseUrl, state.options.requestTimeoutMs, path, state.options.adapterReadAuthorization),
    adapterHeaders,
  );
  let bodyRaw: unknown;
  try {
    bodyRaw = await adapter.read(ctx, entityId);
  } catch (error) {
    throw new HttpError(
      409,
      `adapter '${adapterName}' read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const found = bodyRaw !== null && bodyRaw !== undefined;

  let normalized: { entityId: unknown; fields: unknown } | null = null;
  if (found) {
    try {
      const candidate = adapter.normalize(bodyRaw);
      if (!isPlainObject(candidate) || !('entityId' in candidate) || !('fields' in candidate)) {
        throw new Error('normalize must return {entityId, fields}');
      }
      normalized = { entityId: candidate['entityId'], fields: candidate['fields'] };
    } catch (error) {
      throw new HttpError(
        409,
        `adapter '${adapterName}' normalize failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Report-only observations; the ENGINE judges identity binding (GF-05).
  const mismatches: string[] = [];
  let entityAgrees = true;
  if (found && entityId !== undefined && normalized !== null) {
    try {
      if (canonicalOf(entityId) !== canonicalOf(normalized.entityId)) {
        entityAgrees = false;
        mismatches.push(
          `entityId mismatch: adapter returned ${canonicalOf(normalized.entityId)} for requested ${canonicalOf(entityId)}`,
        );
      }
    } catch {
      entityAgrees = false;
    }
  }
  // Build `before` from the consumed pre-observation's OWN contents —
  // never from anything the suite declared.
  if (consumed !== undefined && before !== undefined) {
    if (consumed.kind === 'ids') {
      const observedId =
        normalized !== null && normalized.entityId !== undefined ? normalized.entityId : entityId;
      let absent = true;
      try {
        absent = !consumed.ids.includes(canonicalOf(observedId));
      } catch {
        absent = true; // unrepresentable id: treat as not previously observed
      }
      before = { entityAbsent: absent };
    } else {
      before = {
        found: consumed.found,
        ...(consumed.found ? { fields: consumed.fields } : {}),
      };
    }
  }

  // The payload IS the engine observation (hashed into the record id).
  const payload: Record<string, unknown> = {
    resourceId,
    entityId: found && normalized !== null ? normalized.entityId : entityId ?? null,
    found,
    ...(found && normalized !== null ? { fields: normalized.fields } : {}),
    ...(before !== undefined ? { before } : {}),
    sessionId: session.sessionId,
  };
  const issued = issuePersistenceRecord(state, boundClaimId, boundTestId, payload);
  // Witness-side activity (review recheck fix 2026-09-14): an
  // engine-observed persistence read under the session is real work the
  // witness performed; count it so supervision can corroborate execution.
  session.activity += 1;

  const response: PersistenceResponse = {
    recordId: issued.recordId,
    runId: issued.runId,
    verdictRelevant: {
      found,
      fieldsMatch: entityAgrees,
      ...(mismatches.length > 0 ? { mismatches } : {}),
    },
  };
  sendJson(res, 200, response);
}

/**
 * `POST /witness/pre-observation` (audit rounds 4-5): takes an
 * engine-side snapshot BEFORE a claimed action, stored in witness
 * memory and consumed single-use by the paired persistence read. Two
 * modes:
 * - with `entityId`: snapshots that entity's observed fields (for
 *   update postconditions — the engine grades the before/after delta);
 * - without: snapshots the resource's observed id set via the adapter's
 *   optional `list` (for create postconditions — the engine grades
 *   absence-before).
 * A suite can reference a real observation but cannot fabricate,
 * replay, or mutate its contents.
 */
async function handlePreObservation(
  state: WitnessState,
  res: ServerResponse,
  body: PreObservationRequest,
): Promise<void> {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'request body must be an object');
  }
  const { resourceId, testId, claimId, entityId } = body as Record<string, unknown>;
  if (typeof resourceId !== 'string' || resourceId.length === 0) {
    throw new HttpError(400, 'resourceId must be a non-empty string');
  }
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'testId must be a non-empty string');
  }
  if (typeof claimId !== 'string' || !OBLIGATION_ID_PATTERN.test(claimId)) {
    throw new HttpError(400, "claimId must be an obligation id '<resourceId>:<contract>'");
  }
  // Phase 1: pre-observations belong to the supervisor-opened session of
  // the claiming test (the persistence read later consumes them under
  // the same session).
  const session = requireOpenSession(state, body);
  requireSessionTestId(session, testId);

  const { observationId, observed } = await takePreObservation(state, session, resourceId, entityId);
  const response: PreObservationResponse = { observationId, observed };
  sendJson(res, 200, response);
}

/**
 * Takes an engine-side pre-observation snapshot (shared by the
 * suite-callable endpoint and the engine browser driver): with
 * `entityId` an entity-fields snapshot (update postconditions),
 * without it the resource id-set snapshot (create postconditions).
 * Snapshots live in witness memory, single-use, and their contents —
 * never suite-declared expectations — are what the engine grades
 * against. A suite can reference a real observation but cannot
 * fabricate, replay, or mutate its contents.
 */
async function takePreObservation(
  state: WitnessState,
  session: TestSession,
  resourceId: string,
  entityId: unknown,
): Promise<{ observationId: string; observed: number }> {
  const { adapterName, adapter, baseUrl } = await adapterReadContext(state, resourceId);
  const adapterHeaders = state.options.adapterReadAuthorization
    ? { authorization: state.options.adapterReadAuthorization }
    : undefined;
  const ctx = makeAdapterContext(baseUrl, resourceId, (path: string) =>
    adapterGet(baseUrl, state.options.requestTimeoutMs, path, state.options.adapterReadAuthorization),
    adapterHeaders,
  );
  const observationId = randomUUID();

  if (entityId !== undefined) {
    // Entity-fields snapshot (update postconditions).
    let bodyRaw: unknown;
    try {
      bodyRaw = await adapter.read(ctx, entityId);
    } catch (error) {
      throw new HttpError(
        409,
        `adapter '${adapterName}' read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const found = bodyRaw !== null && bodyRaw !== undefined;
    let fields: unknown = undefined;
    if (found) {
      try {
        const candidate = adapter.normalize(bodyRaw);
        if (!isPlainObject(candidate) || !('fields' in candidate)) {
          throw new Error('normalize must return {entityId, fields}');
        }
        fields = candidate['fields'];
      } catch (error) {
        throw new HttpError(
          409,
          `adapter '${adapterName}' normalize failed during pre-observation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    state.preObservations.set(observationId, {
      resourceId,
      kind: 'entity',
      entityId: canonicalOf(entityId),
      found,
      ...(found ? { fields } : {}),
    });
    // Witness-side activity: the engine-side snapshot ran under the
    // session; count it.
    session.activity += 1;
    return { observationId, observed: found ? 1 : 0 };
  }

  // Resource id-set snapshot (create postconditions).
  if (typeof adapter.list !== 'function') {
    throw new HttpError(
      409,
      `adapter '${adapterName}' does not support resource-level pre-observation ` +
        '(no list export); create postconditions cannot be observed for this resource',
    );
  }
  let raw: unknown;
  try {
    raw = await adapter.list(ctx);
  } catch (error) {
    throw new HttpError(
      409,
      `adapter '${adapterName}' list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new HttpError(409, `adapter '${adapterName}' list must return an array of entities`);
  }
  const ids: string[] = [];
  for (const entity of raw) {
    try {
      const candidate = adapter.normalize(entity);
      if (!isPlainObject(candidate) || !('entityId' in candidate)) {
        throw new Error('normalize must return {entityId, fields}');
      }
      ids.push(canonicalOf(candidate['entityId']));
    } catch (error) {
      throw new HttpError(
        409,
        `adapter '${adapterName}' normalize failed during pre-observation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  state.preObservations.set(observationId, { resourceId, kind: 'ids', ids: ids.sort(compareStrings) });
  // Witness-side activity: the engine-side id-set snapshot ran under
  // the session; count it.
  session.activity += 1;

  return { observationId, observed: ids.length };
}

/**
 * `POST /runs/server-e2e-declarations` — SUPERVISOR ONLY (verifier key;
 * the same authority as `POST /runs/expected-set`): registers the
 * obligation ids the trusted mapping layer declared kind `server-e2e`.
 * This is the gate that makes the server-witnessed channel kind-honest:
 * the witness refuses (`409`) any server intent whose claimId is not in
 * this set, so a browser-kind claim can never be satisfied through the
 * channel and a suite-written intent can never self-declare its kind
 * (the kind resolves in the trusted CLI mapping layer, which is exactly
 * why the fact enters through a verifier-key surface, never through the
 * suite-writable spool). Bound once BEFORE any issuance — identical
 * re-registration is idempotent, any change or late registration is 409.
 */
async function handleServerE2eDeclarations(
  state: WitnessState,
  res: ServerResponse,
  verifier: unknown,
  body: ServerE2eDeclarationsRequest,
): Promise<void> {
  requireSupervisor(state, verifier);
  if (!isPlainObject(body) || !Array.isArray(body['obligations'])) {
    throw new HttpError(400, 'server-e2e declarations body must be {obligations: [...]}');
  }
  const obligations = new Set<string>();
  for (const entry of body['obligations']) {
    if (typeof entry !== 'string' || !OBLIGATION_ID_PATTERN.test(entry)) {
      throw new HttpError(
        400,
        `server-e2e declarations must be obligation ids '<resourceId>:<contract>' (got '${String(entry)}')`,
      );
    }
    obligations.add(entry);
  }
  if (state.serverE2eDeclarations !== null) {
    const identical =
      state.serverE2eDeclarations.size === obligations.size &&
      [...obligations].every((id) => state.serverE2eDeclarations?.has(id));
    if (identical) {
      sendJson(res, 200, {
        bound: true as const,
        count: state.serverE2eDeclarations.size,
        obligations: [...state.serverE2eDeclarations].sort(compareStrings),
      });
      return;
    }
    sendJson(res, 409, {
      error:
        'server-e2e declarations are already bound to this run and differ; the declaration set ' +
        'is a PRE-run fact and is never relabeled — start a fresh witness for a new invocation',
    });
    return;
  }
  if (state.ledger.size > 0 || state.sessions.size > 0 || state.serverPreObservations.size > 0) {
    sendJson(res, 409, {
      error:
        'witness already issued evidence or holds open sessions; server-e2e declarations must be ' +
        'registered BEFORE the run — start a fresh witness for a new invocation',
    });
    return;
  }
  state.serverE2eDeclarations = obligations;
  sendJson(res, 200, {
    bound: true as const,
    count: obligations.size,
    obligations: [...obligations].sort(compareStrings),
  });
}

/**
 * `POST /runs/observe-declarations` — SUPERVISOR ONLY: registers the
 * obligation ids the trusted mapping layer declared kind `observed-e2e`
 * (Observe channel, Phase 2) BEFORE the run. Same binding contract as
 * the server-e2e set: bound once, identical re-registration idempotent,
 * any change or late registration refused — the witness stamps
 * `channel: 'observe'` records for these obligations only.
 */
async function handleObserveDeclarations(
  state: WitnessState,
  res: ServerResponse,
  verifier: unknown,
  body: ObserveDeclarationsRequest,
): Promise<void> {
  requireSupervisor(state, verifier);
  if (!isPlainObject(body) || !Array.isArray(body['obligations'])) {
    throw new HttpError(400, 'observe declarations body must be {obligations: [...]}');
  }
  const obligations = new Set<string>();
  for (const entry of body['obligations']) {
    if (typeof entry !== 'string' || !OBLIGATION_ID_PATTERN.test(entry)) {
      throw new HttpError(
        400,
        `observe declarations must be obligation ids '<resourceId>:<contract>' (got '${String(entry)}')`,
      );
    }
    obligations.add(entry);
  }
  if (state.observeDeclarations !== null) {
    const identical =
      state.observeDeclarations.size === obligations.size &&
      [...obligations].every((id) => state.observeDeclarations?.has(id));
    if (identical) {
      sendJson(res, 200, {
        bound: true as const,
        count: state.observeDeclarations.size,
        obligations: [...state.observeDeclarations].sort(compareStrings),
      });
      return;
    }
    sendJson(res, 409, {
      error:
        'observe declarations are already bound to this run and differ; the declaration set ' +
        'is a PRE-run fact and is never relabeled — start a fresh witness for a new invocation',
    });
    return;
  }
  if (state.ledger.size > 0 || state.sessions.size > 0) {
    sendJson(res, 409, {
      error:
        'witness already issued evidence or holds open sessions; observe declarations must be ' +
        'registered BEFORE the run — start a fresh witness for a new invocation',
    });
    return;
  }
  state.observeDeclarations = obligations;
  sendJson(res, 200, {
    bound: true as const,
    count: obligations.size,
    obligations: [...obligations].sort(compareStrings),
  });
}

/** Splits `<resourceId>:<contract>` at the first colon (obligation id grammar). */
function resourceIdOfObligation(obligationId: string): string {
  const colon = obligationId.indexOf(':');
  return colon === -1 ? obligationId : obligationId.slice(0, colon);
}

/** The CRUD operation a `persistence:<op>` contract requires; null otherwise. */
function observeOperation(contract: string): 'create' | 'read' | 'update' | 'delete' | null {
  if (!contract.startsWith('persistence:')) return null;
  const operation = contract.slice('persistence:'.length);
  if (operation === 'create' || operation === 'read' || operation === 'update' || operation === 'delete') {
    return operation;
  }
  return null;
}

/**
 * Takes Observe before-snapshots for one freshly opened session: for
 * every resource its observe-declared claims name, the witness runs the
 * resource's adapter `list()` ITSELF and normalizes each body. The
 * snapshot is the before-state every observe postcondition grades
 * against — expectations never come from the suite. Per-resource
 * trouble (no adapter, no list, probe/read/normalize failure) is
 * stored as an error snapshot: the session still opens and the test
 * still runs; finalize reports the resource as unobservable instead of
 * satisfying anything. Total: never throws out of session open.
 */
async function takeObserveSnapshots(state: WitnessState, session: TestSession): Promise<void> {
  if (state.observeDeclarations === null || state.observeDeclarations.size === 0) return;
  const resources = new Set<string>();
  for (const claim of session.claims) {
    if (state.observeDeclarations.has(claim)) resources.add(resourceIdOfObligation(claim));
  }
  if (resources.size === 0) return;
  const perSession = new Map<string, ObserveResourceSnapshot>();
  state.observeSnapshots.set(session.sessionId, perSession);
  for (const resourceId of [...resources].sort(compareStrings)) {
    perSession.set(resourceId, await snapshotObserveResource(state, resourceId));
  }
  session.activity += 1;
}

/** Snapshots one resource's adapter-listed entities (never throws). */
async function snapshotObserveResource(
  state: WitnessState,
  resourceId: string,
): Promise<ObserveResourceSnapshot> {
  const failure = (adapterName: string, error: string): ObserveResourceSnapshot => ({
    resourceId,
    adapterName,
    before: new Map(),
    error,
  });
  let adapterName = resourceId;
  try {
    const context = await adapterReadContext(state, resourceId);
    adapterName = context.adapterName;
    const adapter = context.adapter;
    if (typeof adapter.list !== 'function') {
      return failure(
        adapterName,
        `adapter '${adapterName}' exports no list() — Observe needs a before-snapshot, so ` +
          `resource '${resourceId}' is unobservable until the adapter lists its entities`,
      );
    }
    const ctx = observeAdapterContext(state, context.baseUrl, resourceId);
    return { resourceId, adapterName, before: await observeListEntities(adapterName, adapter, ctx), error: null };
  } catch (error) {
    const detail = error instanceof HttpError ? error.message : (error as Error).message;
    return failure(adapterName, detail);
  }
}

/** Builds the GET-only adapter transport for observe snapshots/reads. */
function observeAdapterContext(state: WitnessState, baseUrl: string, resourceId: string): AdapterContext {
  const headers = state.options.adapterReadAuthorization
    ? { authorization: state.options.adapterReadAuthorization }
    : undefined;
  return makeAdapterContext(
    baseUrl,
    resourceId,
    (path: string) => adapterGet(baseUrl, state.options.requestTimeoutMs, path, state.options.adapterReadAuthorization),
    headers,
  );
}

/**
 * Lists + normalizes a resource's entities through its adapter (the
 * witness's own observation). Throws HttpError (409) on list/normalize
 * trouble — callers turn it into a typed observe note, never
 * satisfaction.
 */
async function observeListEntities(
  adapterName: string,
  adapter: EvidenceAdapter,
  ctx: AdapterContext,
): Promise<Map<string, { entityId: unknown; fields: unknown }>> {
  if (typeof adapter.list !== 'function') {
    throw new HttpError(
      409,
      `adapter '${adapterName}' exports no list() — Observe needs entity snapshots`,
    );
  }
  let listed: unknown;
  try {
    listed = await adapter.list(ctx);
  } catch (error) {
    throw new HttpError(409, `adapter '${adapterName}' list failed: ${(error as Error).message}`);
  }
  if (!Array.isArray(listed)) {
    throw new HttpError(409, `adapter '${adapterName}' list must return an array of entities`);
  }
  const out = new Map<string, { entityId: unknown; fields: unknown }>();
  for (const raw of listed) {
    let normalized: { entityId: unknown; fields: unknown };
    try {
      const candidate = adapter.normalize(raw);
      if (!isPlainObject(candidate) || !('entityId' in candidate) || !('fields' in candidate)) {
        throw new Error('normalize must return {entityId, fields}');
      }
      normalized = { entityId: candidate['entityId'], fields: candidate['fields'] };
    } catch (error) {
      throw new HttpError(409, `adapter '${adapterName}' normalize failed: ${(error as Error).message}`);
    }
    let key: string;
    try {
      key = canonicalOf(normalized.entityId);
    } catch {
      throw new HttpError(409, `adapter '${adapterName}' normalized an entity id with no canonical form`);
    }
    out.set(key, normalized);
  }
  return out;
}

/**
 * Matches a recorded observed path against an adapter observe path
 * template. `{id}` binds exactly one non-empty segment; every other
 * segment must be literally equal (case-sensitive). Matching reuses
 * core's canonical shape semantics (`{id}` → `{}`).
 *
 * Returns `{id}` (null for id-less create templates) on match, null
 * otherwise.
 */
function matchObserveTemplate(observedPath: string, template: string): { id: string | null } | null {
  const segments = template.split('/').filter((segment) => segment.length > 0);
  const idIndex = segments.indexOf('{id}');
  const canonical = segments.map((segment) => (segment === '{id}' ? '{}' : segment)).join('/');
  if (!pathMatchesShape(observedPath, canonical.startsWith('/') ? canonical : `/${canonical}`)) {
    return null;
  }
  if (idIndex === -1) return { id: null };
  const observedSegments = observedPath.split('/').filter((segment) => segment.length > 0);
  const id = observedSegments[idIndex];
  if (id === undefined || id.length === 0) return null;
  return { id };
}

/** Finds a snapshot key for a path id segment (canonical or numeric-string form). */
function beforeKeyForSegment(
  before: Map<string, { entityId: unknown; fields: unknown }>,
  segment: string,
): string | null {
  try {
    const canonical = canonicalOf(segment);
    if (before.has(canonical)) return canonical;
  } catch {
    return null;
  }
  for (const [key, entry] of before) {
    if (typeof entry.entityId === 'number' && String(entry.entityId) === segment) return key;
  }
  return null;
}

/**
 * Parses a proxied request body into echoable fields (Observe channel):
 * JSON objects and form bodies project their top-level scalar
 * (string/number/boolean) fields — the witness-observed statement of
 * what the test sent, graded by echo against the adapter read. Nested
 * envelopes are not entity fields and are skipped (documented); empty,
 * truncated, oversized, unparsable, or otherwise-typed bodies are
 * INELIGIBLE (typed error), never echoed from a prefix or a guess.
 */
function parseObserveBody(exchange: ObservedExchange): { fields: Record<string, unknown> } | { error: string } {
  if (exchange.requestBody === null || exchange.requestBytes === 0) {
    return { error: 'the proxied exchange carried no request body — there is nothing to echo' };
  }
  if (exchange.requestTruncated) {
    return {
      error:
        `the request body exceeds the ${String(OBSERVED_REQUEST_BODY_BYTES)}-byte witness snapshot ` +
        'cap — oversized intents are never echoed from a prefix',
    };
  }
  const contentType = exchange.requestContentType;
  if (contentType === 'application/json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(exchange.requestBody.toString('utf8'));
    } catch {
      return { error: 'the request body is not parseable JSON' };
    }
    if (!isPlainObject(parsed)) {
      return { error: 'the JSON request body is not an object' };
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        fields[key] = value;
      }
    }
    if (Object.keys(fields).length === 0) {
      return { error: 'the JSON request body carries no echoable scalar fields' };
    }
    return { fields };
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of new URLSearchParams(exchange.requestBody.toString('utf8'))) {
      fields[key] = value;
    }
    if (Object.keys(fields).length === 0) {
      return { error: 'the form request body carries no fields' };
    }
    return { fields };
  }
  return {
    error:
      `unsupported request content-type '${contentType ?? '<none>'}' — observe echoes JSON and ` +
      'form bodies only',
  };
}

/**
 * Reads one entity through its adapter at finalize time (the
 * witness's own after-observation). Throws HttpError (409) on
 * adapter/normalize trouble — callers note it, never satisfy on it.
 */
async function readObserveEntity(
  state: WitnessState,
  resourceId: string,
  id: unknown,
): Promise<{ adapterName: string; found: boolean; fields: unknown; entityId: unknown }> {
  const { adapterName, adapter, baseUrl } = await adapterReadContext(state, resourceId);
  const ctx = observeAdapterContext(state, baseUrl, resourceId);
  let bodyRaw: unknown;
  try {
    bodyRaw = await adapter.read(ctx, id);
  } catch (error) {
    throw new HttpError(409, `adapter '${adapterName}' read failed: ${(error as Error).message}`);
  }
  const found = bodyRaw !== null && bodyRaw !== undefined;
  if (!found) return { adapterName, found: false, fields: null, entityId: id };
  try {
    const candidate = adapter.normalize(bodyRaw);
    if (!isPlainObject(candidate) || !('entityId' in candidate) || !('fields' in candidate)) {
      throw new Error('normalize must return {entityId, fields}');
    }
    return { adapterName, found: true, fields: candidate['fields'], entityId: candidate['entityId'] };
  } catch (error) {
    throw new HttpError(409, `adapter '${adapterName}' normalize failed: ${(error as Error).message}`);
  }
}

/**
 * `POST /observe/finalize` — SUPERVISOR ONLY: resolves one OPEN
 * session's observe-declared claims against the session's own proxied
 * traffic plus independent adapter reads, stamping witnessed
 * `persistence.observed` records for whatever resolves. The session
 * must be OPEN (the drain finalizes after a passed test, before seal);
 * sealed/unknown sessions are refused, so records are never injected
 * after the test ended. Every non-resolution is a typed NOTE in the
 * response — never satisfaction, never a run failure (the obligation
 * stays blocking through verdicts, which is the honest outcome).
 *
 * Per obligation (`<resourceId>:persistence:<op>`):
 * - adapter binding + before-snapshot must exist (else typed note);
 * - exactly one 2xx session exchange must match the binding (zero →
 *   missing-traffic note; several → ambiguity note);
 * - create resolves its id from the list-diff (exactly one new entity);
 *   read/update/delete bind `{id}` from the path against the snapshot;
 * - create/update echo the parsed request-body scalars against the
 *   adapter read (the record carries both; the ENGINE grades the echo);
 * - the matched exchange is consumed single-use.
 */
async function handleObserveFinalize(
  state: WitnessState,
  res: ServerResponse,
  verifier: unknown,
  body: ObserveFinalizeRequest,
): Promise<void> {
  requireSupervisor(state, verifier);
  if (!isPlainObject(body) || typeof body['sessionId'] !== 'string' || body['sessionId'].length === 0) {
    throw new HttpError(400, 'observe finalize body must be {sessionId}');
  }
  const sessionId = body['sessionId'];
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    throw new HttpError(400, `session '${sessionId}' is unknown (never opened on this witness)`);
  }
  if (session.status !== 'open') {
    throw new HttpError(
      409,
      `session '${sessionId}' is sealed — observe finalizes before seal, never after (records cannot be injected after the test ended)`,
    );
  }
  if (state.observeDeclarations === null) {
    throw new HttpError(409, 'observe declarations are not bound on this witness — register them before the run');
  }
  const finalized: ObserveFinalizedObligation[] = [];
  const notes: string[] = [];
  const claims = session.claims.filter((claim) => state.observeDeclarations?.has(claim));
  for (const claimId of claims) {
    const outcome = await finalizeObserveClaim(state, session, claimId);
    if ('record' in outcome) finalized.push(outcome.record);
    else notes.push(outcome.note);
  }
  const response: ObserveFinalizeResponse = { finalized, notes };
  sendJson(res, 200, response);
}

/** Resolves one observe-declared claim (record or typed note, never throws). */
async function finalizeObserveClaim(
  state: WitnessState,
  session: TestSession,
  claimId: string,
): Promise<{ record: ObserveFinalizedObligation } | { note: string }> {
  const note = (detail: string): { note: string } => ({ note: `observe '${claimId}': ${detail}` });
  const resourceId = resourceIdOfObligation(claimId);
  const operation = observeOperation(claimId.slice(resourceId.length + 1));
  if (operation === null) {
    return note('the Observe channel proves persistence:* contracts only — this claim stays blocking');
  }
  let adapterName: string;
  let adapter: EvidenceAdapter;
  let adapterBaseUrl: string;
  try {
    const context = await adapterReadContext(state, resourceId);
    adapterName = context.adapterName;
    adapter = context.adapter;
    adapterBaseUrl = context.baseUrl;
  } catch (error) {
    return note(error instanceof HttpError ? error.message : (error as Error).message);
  }
  const binding = adapter.observe?.[operation];
  if (binding === undefined) {
    return note(
      `adapter '${adapterName}' declares no observe binding for '${operation}' — declare it in ` +
        `'.gateforge/adapters/${adapterName}.mjs' to make this obligation observable`,
    );
  }
  const snapshot = state.observeSnapshots.get(session.sessionId)?.get(resourceId);
  if (snapshot === undefined || snapshot.error !== null) {
    return note(
      snapshot?.error !== null && snapshot?.error !== undefined
        ? `no usable before-snapshot: ${snapshot.error as string}`
        : 'no before-snapshot for this session — the session opened before observe declarations bound, or the snapshot failed',
    );
  }
  // Bind watermark (plan §11.4, same as http-observation): exchanges
  // that completed before the trusted context bound predate it.
  const watermark = state.runContext === null ? 0 : state.observedSeqAtBind;
  const matches: Array<{ exchange: ObservedExchange; id: string | null }> = [];
  for (const exchange of state.observed) {
    if (exchange.sessionId !== session.sessionId || exchange.seq <= watermark) continue;
    if (exchange.method !== binding.method) continue;
    if (exchange.status < 200 || exchange.status > 299) continue;
    const matched = matchObserveTemplate(exchange.path, binding.path);
    if (matched === null) continue;
    matches.push({ exchange, id: matched.id });
  }
  if (matches.length === 0) {
    return note(
      `no ${binding.method} ${binding.path} exchange (2xx) for this session through the observation ` +
        'proxy — drive traffic through the session proxy prefix before claiming the obligation',
    );
  }
  if (matches.length > 1) {
    return note(
      `${String(matches.length)} matching ${binding.method} ${binding.path} exchanges — ambiguous, ` +
        'refusing to pick one (seed through untracked channels so the mutation stands alone)',
    );
  }
  const matched = matches[0] as { exchange: ObservedExchange; id: string | null };
  // Resolve the entity id: create diffs the witness-held lists (the new
  // id is observed, never declared); read/update/delete bind `{id}`
  // against the session-open snapshot.
  let entityIdForRead: unknown;
  let before: { entityAbsent: boolean } | { found: boolean; fields?: unknown } | undefined;
  if (operation === 'create') {
    let after: Map<string, { entityId: unknown; fields: unknown }>;
    try {
      const ctx = observeAdapterContext(state, adapterBaseUrl, resourceId);
      after = await observeListEntities(adapterName, adapter, ctx);
    } catch (error) {
      return note(error instanceof HttpError ? error.message : (error as Error).message);
    }
    const fresh = [...after.keys()].filter((key) => !snapshot.before.has(key));
    if (fresh.length !== 1) {
      return note(
        `expected exactly one new entity after the observed create, found ${String(fresh.length)} — ` +
          'the creation is ambiguous, so no record is issued',
      );
    }
    const created = after.get(fresh[0] as string) as { entityId: unknown; fields: unknown };
    entityIdForRead = created.entityId;
    before = { entityAbsent: true };
  } else {
    if (matched.id === null) {
      return note('the observe binding carries no {id} segment for a non-create operation');
    }
    const beforeKey = beforeKeyForSegment(snapshot.before, matched.id);
    if (beforeKey === null) {
      return note(
        `entity '${matched.id}' was not in the session-open snapshot — observe binds {id} ` +
          'against witness-held before-state, never against suite-declared ids',
      );
    }
    const beforeEntry = snapshot.before.get(beforeKey) as { entityId: unknown; fields: unknown };
    entityIdForRead = beforeEntry.entityId;
    if (operation === 'update') before = { found: true, fields: beforeEntry.fields };
  }
  // Echo source (create/update only): the witness-observed request
  // fields. Read/delete carry no echo — presence/absence grades them.
  let observedFields: Record<string, unknown> = {};
  if (operation === 'create' || operation === 'update') {
    const parsed = parseObserveBody(matched.exchange);
    if ('error' in parsed) return note(parsed.error);
    observedFields = parsed.fields;
  }
  let read: { adapterName: string; found: boolean; fields: unknown; entityId: unknown };
  try {
    read = await readObserveEntity(state, resourceId, entityIdForRead);
  } catch (error) {
    return note(error instanceof HttpError ? error.message : (error as Error).message);
  }
  const payload: Record<string, unknown> = {
    resourceId,
    entityId: read.entityId,
    found: read.found,
    ...(read.found ? { fields: read.fields ?? {} } : {}),
    ...(before !== undefined ? { before } : {}),
    observedFields,
    exchange: {
      method: matched.exchange.method,
      path: matched.exchange.path,
      status: matched.exchange.status,
      seq: matched.exchange.seq,
    },
    sessionId: session.sessionId,
    channel: OBSERVE_CHANNEL,
  };
  // The record binds runId/claimId/testId and rides the same ledger
  // attestation MAC as every witnessed record. Contents are
  // witness-produced (proxy capture + adapter read) — `engine-observed`
  // origin, witnessed trust; the suite-driven-browser distinction rides
  // `channel: 'observe'`, which the grader keys off explicitly.
  const issued = issueRecord(state, claimId, OBSERVED_KIND, session.testId, payload, 'engine-observed');
  // Single-use: the matched exchange can never credit another claim.
  const consumed = state.observed.indexOf(matched.exchange);
  if (consumed !== -1) state.observed.splice(consumed, 1);
  session.activity += 1;
  return {
    record: { obligationId: claimId, recordId: issued.recordId, operation, entityId: read.entityId },
  };
}

/**
 * `POST /witness/server-persistence` — SUPERVISOR ONLY (run token +
 * verifier key; the trusted CLI drain forwards intents the supervised
 * suite could only WRITE to the spool): one persistence claim intent
 * resolved against the app's real state. The WITNESS — never the test
 * process — executes the resource's adapter SERVER PROBE (witness-side,
 * behind the same attestation chain as every adapter read: GF-10
 * loopback + GF-13 fingerprint) and, only on a successful observation,
 * stamps a WITNESSED `persistence.entity` record carrying
 * `channel: 'server'` + `declaredKind: 'server-e2e'`, bound to
 * runId/claimId/testId and covered by the ledger attestation exactly
 * like every witnessed record.
 *
 * Fail-closed resolution (typed causes on the error `detail`):
 * - obligation not registered `server-e2e` → 409, detail
 *   `TEST_KIND_UNKNOWN` (declare `kind: server-e2e` in the test map);
 * - replayed/out-of-order intent sequence → 409 (no stale re-drive);
 * - create/update post intent without the paired pre intent → 409
 *   (the engine grades before/after; without a witness-side before
 *   observation there is nothing to stamp);
 * - missing adapter / missing `probeServer` export / probe throw or
 *   malformed probe result → 409 with detail `SERVER_PROBE_UNAVAILABLE`
 *   — the intent NEVER resolves to satisfaction on probe trouble.
 *
 * The intent line itself is suite-writable and proves nothing; it only
 * selects WHICH entity the witness probes and what the suite expects.
 * Expectation CONTRADICTION (e.g. create-post but the entity is still
 * absent) is not a probe failure: the record stamps what the witness
 * observed and the verdict engine grades the postcondition — one
 * grading site, engine-owned.
 */
async function handleServerPersistence(
  state: WitnessState,
  res: ServerResponse,
  verifier: unknown,
  body: ServerPersistenceIntentRequest,
): Promise<void> {
  requireSupervisor(state, verifier);
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'server persistence body must be an object');
  }
  const { resourceId, claimId, operation, phase, intent, key, sequence, testId } = body;
  if (typeof resourceId !== 'string' || resourceId.length === 0) {
    throw new HttpError(400, 'resourceId must be a non-empty string');
  }
  if (typeof claimId !== 'string' || !OBLIGATION_ID_PATTERN.test(claimId)) {
    throw new HttpError(400, "claimId must be an obligation id '<resourceId>:<contract>'");
  }
  if (operation !== 'create' && operation !== 'read' && operation !== 'update' && operation !== 'delete') {
    throw new HttpError(400, "operation must be one of 'create' | 'read' | 'update' | 'delete'");
  }
  // Claim/operation/resource agreement: an intent never steers evidence
  // onto a different obligation identity than the one it names.
  if (claimId !== `${resourceId}:persistence:${operation}`) {
    throw new HttpError(
      400,
      `claimId '${claimId}' must equal '<resourceId>:persistence:${operation}' for this intent ` +
        '(claim, resource, and operation must agree — an intent never redirects evidence)',
    );
  }
  if (phase !== 'pre' && phase !== 'post') {
    throw new HttpError(400, "phase must be 'pre' or 'post'");
  }
  if (intent !== 'expect-present' && intent !== 'expect-absent') {
    throw new HttpError(400, "intent must be 'expect-present' or 'expect-absent'");
  }
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) {
    throw new HttpError(400, 'sequence must be an integer >= 1');
  }
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'testId must be a non-empty string');
  }
  // The entity key is the probe subject: scalar or column-keyed object,
  // always GF-canonical-JSON-representable (it hashes into the record).
  let entityKey: string;
  try {
    entityKey = canonicalOf(key);
  } catch {
    throw new HttpError(400, 'key must be a JSON scalar or a column-keyed JSON object');
  }

  // Kind gate (trusted mapping layer, never the suite): the witness
  // stamps the server channel ONLY for obligations the supervisor
  // registered as mapping kind 'server-e2e'.
  if (
    state.serverE2eDeclarations === null ||
    !state.serverE2eDeclarations.has(claimId)
  ) {
    throw new HttpError(
      409,
      `server persistence intent refused: obligation '${claimId}' is not registered kind ` +
        `'${SERVER_E2E_TEST_KIND}' on this witness — declare 'kind: ${SERVER_E2E_TEST_KIND}' in the ` +
        'test-map sidecar and pass the resolved obligations to the supervisor drain ' +
        '(a browser-kind claim is never satisfied through the server channel)',
      'TEST_KIND_UNKNOWN',
    );
  }
  // Replay gate: strictly increasing per claimId. A duplicate line (drain
  // restart, spool replay, forged re-append) resolves to a typed failure
  // — an intent is resolved at most once per sequence.
  const lastSequence = state.serverIntentSequences.get(claimId);
  if (lastSequence !== undefined && sequence <= lastSequence) {
    throw new HttpError(
      409,
      `server persistence intent refused: sequence ${String(sequence)} for '${claimId}' does not ` +
        `exceed the last accepted (${String(lastSequence)}) — intents are strictly increasing per ` +
        'claim and a replayed line is never re-driven',
    );
  }
  state.serverIntentSequences.set(claimId, sequence);

  // WITNESS-SIDE probe: the same attestation chain as every adapter read
  // (reviewed adapter, GF-10 loopback, GF-13 fingerprint), then the
  // adapter's own probeServer against the app database. Any trouble here
  // is a typed SERVER_PROBE_UNAVAILABLE failure — never satisfaction.
  const { adapterName, adapter } = await serverProbeContext(state, resourceId, claimId);
  const observation = await runServerProbe(state, adapterName, adapter, resourceId, key);

  if (phase === 'pre') {
    // Pre intents STORE the witness observation; they stamp no record.
    if (operation === 'create') {
      if (intent !== 'expect-absent') {
        throw new HttpError(400, "create pre intents must declare intent 'expect-absent'");
      }
    } else if (operation === 'update') {
      if (intent !== 'expect-present') {
        throw new HttpError(400, "update pre intents must declare intent 'expect-present'");
      }
    } else {
      throw new HttpError(
        400,
        `pre intents apply only to create/update (operation '${operation}' postconditions need no before-state)`,
      );
    }
    const preKey = `${claimId}\u0000${entityKey}`;
    if (state.serverPreObservations.has(preKey)) {
      throw new HttpError(
        409,
        `server persistence intent refused: claim '${claimId}' already holds a pending ` +
          'pre-observation for this entity — advance the sequence and post the mutation first',
      );
    }
    state.serverPreObservations.set(preKey, {
      resourceId,
      kind: operation === 'create' ? 'absence' : 'entity',
      found: observation.found,
      ...(observation.found ? { fields: observation.fields ?? {} } : {}),
    });
    const response: ServerPreObservationResponse = { resolved: 'pre', found: observation.found };
    sendJson(res, 200, response);
    return;
  }

  // Post intents consume the paired pre-observation (create/update) and
  // stamp ONE self-contained witnessed record — the same `before` shapes
  // the browser path's persistence reads carry, so the verdict engine
  // grades BOTH channels with the same postcondition code.
  let before: { entityAbsent: boolean } | { found: boolean; fields?: unknown } | undefined;
  if (operation === 'create' || operation === 'update') {
    const preKey = `${claimId}\u0000${entityKey}`;
    const pre = state.serverPreObservations.get(preKey);
    const wantedKind = operation === 'create' ? 'absence' : 'entity';
    if (pre === undefined || pre.resourceId !== resourceId || pre.kind !== wantedKind) {
      throw new HttpError(
        409,
        `server persistence intent refused: no witness-side pre-observation for '${claimId}' on ` +
          `entity ${entityKey} — write the pre intent (before the mutation) so the engine can ` +
          'grade the before/after postcondition from its OWN observations',
      );
    }
    state.serverPreObservations.delete(preKey);
    before =
      pre.kind === 'absence'
        ? { entityAbsent: !pre.found }
        : pre.found
          ? { found: true, fields: pre.fields }
          : { found: false };
  }
  const payload: Record<string, unknown> = {
    resourceId,
    entityId: key,
    found: observation.found,
    ...(observation.found ? { fields: observation.fields ?? {} } : {}),
    ...(before !== undefined ? { before } : {}),
    channel: SERVER_CHANNEL,
    declaredKind: SERVER_E2E_TEST_KIND,
    intent: { phase: 'post', expectation: intent, sequence },
  };
  // The record binds runId/claimId/testId (hashed into its provenance id)
  // and rides the same ledger attestation MAC as every witnessed record.
  const issued = issuePersistenceRecord(state, claimId, testId, payload);
  const response: ServerPersistenceResponse = {
    recordId: issued.recordId,
    runId: issued.runId,
    trust: issued.trust,
    channel: SERVER_CHANNEL,
    verdictRelevant: { found: observation.found },
  };
  sendJson(res, 200, response);
}

/**
 * Resolves the reviewed adapter for a server probe, enforcing the FULL
 * browser-path attestation chain (ADR 0001 reviewed adapter, GF-10
 * loopback, GF-13 fingerprint) so a server observation is exactly as
 * trustworthy as an engine-side adapter read. A missing adapter or a
 * missing `probeServer` export resolves typed SERVER_PROBE_UNAVAILABLE
 * (actionable; the intent never resolves to satisfaction).
 */
async function serverProbeContext(
  state: WitnessState,
  resourceId: string,
  claimId: string,
): Promise<{ adapterName: string; adapter: EvidenceAdapter }> {
  let adapterName: string;
  let adapter: EvidenceAdapter | undefined;
  try {
    const context = await adapterReadContext(state, resourceId);
    adapterName = context.adapterName;
    adapter = context.adapter;
  } catch (error) {
    if (error instanceof HttpError) {
      throw new HttpError(
        error.status,
        `server persistence intent for '${claimId}' failed: ${error.message}`,
        'SERVER_PROBE_UNAVAILABLE',
      );
    }
    throw error;
  }
  if (typeof adapter.probeServer !== 'function') {
    throw new HttpError(
      409,
      `adapter '${adapterName}' for resource '${resourceId}' exports no server probe ` +
        `(add 'async probeServer(ctx, subject) => ({found, fields})' to ` +
        `'.gateforge/adapters/${adapterName}.mjs'); server-witnessed persistence intents ` +
        'fail closed without one',
      'SERVER_PROBE_UNAVAILABLE',
    );
  }
  return { adapterName, adapter };
}

/**
 * Executes one adapter server probe (witness process ONLY) and validates
 * the result shape. A throw or a malformed return is a typed
 * SERVER_PROBE_UNAVAILABLE failure; a well-shaped result — even one that
 * contradicts the suite's expectation — is an honest observation the
 * verdict engine grades.
 */
async function runServerProbe(
  state: WitnessState,
  adapterName: string,
  adapter: EvidenceAdapter,
  resourceId: string,
  key: unknown,
): Promise<{ found: boolean; fields: Record<string, unknown> | null }> {
  const baseUrl = adapter.baseUrl ?? state.options.adapterBaseUrl ?? state.options.targetBaseUrl;
  const ctx = makeAdapterContext(
    baseUrl ?? '',
    resourceId,
    (path: string) => adapterGet(baseUrl ?? '', state.options.requestTimeoutMs, path, state.options.adapterReadAuthorization),
    state.options.adapterReadAuthorization
      ? { authorization: state.options.adapterReadAuthorization }
      : undefined,
  );
  let raw: unknown;
  try {
    raw = await adapter.probeServer?.(ctx, key);
  } catch (error) {
    throw new HttpError(
      409,
      `adapter '${adapterName}' server probe failed for resource '${resourceId}': ` +
        `${error instanceof Error ? error.message : String(error)}`,
      'SERVER_PROBE_UNAVAILABLE',
    );
  }
  if (
    !isPlainObject(raw) ||
    typeof raw['found'] !== 'boolean' ||
    !(raw['fields'] === null || raw['fields'] === undefined || isPlainObject(raw['fields']))
  ) {
    throw new HttpError(
      409,
      `adapter '${adapterName}' server probe must return {found: boolean, fields: object|null} ` +
        `for resource '${resourceId}' (got ${(() => {
          try {
            return canonicalOf(raw);
          } catch {
            return '<non-JSON>';
          }
        })()})`,
      'SERVER_PROBE_UNAVAILABLE',
    );
  }
  return {
    found: raw['found'] as boolean,
    fields: (raw['fields'] as Record<string, unknown> | null | undefined) ?? null,
  };
}

/**
 * Resolves the reviewed adapter + mediated read base for one resource,
 * enforcing the full attestation chain (ADR 0001 adapter, GF-10
 * loopback, GF-13 fingerprint). Shared by persistence reads and
 * pre-observations.
 */
async function adapterReadContext(
  state: WitnessState,
  resourceId: string,
): Promise<{ adapterName: string; adapter: EvidenceAdapter; baseUrl: string }> {
  const classification = state.classifications[resourceId] as Classification | undefined;
  const adapterName = classification?.evidenceAdapter ?? resourceId;
  const adapter = state.adapters.get(adapterName);
  if (adapter === undefined) {
    throw new HttpError(
      400,
      `no reviewed evidence adapter registered for resource '${resourceId}' ` +
        `(looked for '.gateforge/adapters/${adapterName}.mjs'); ` +
        'user-facing resources cannot be proven without a trusted adapter (ADR 0001)',
    );
  }

  const baseUrl = adapter.baseUrl ?? state.options.adapterBaseUrl ?? state.options.targetBaseUrl;
  if (baseUrl === null || baseUrl === undefined || baseUrl === '') {
    throw new HttpError(
      400,
      `adapter '${adapterName}' has no read base (set GATEFORGE_ADAPTER_BASE_URL, ` +
        'the adapter baseUrl export, or the attestation target)',
    );
  }

  // GF-10 (per-read mediation): never build a request against a
  // non-loopback base.
  await assertLoopback(baseUrl, `adapter '${adapterName}'`);

  // GF-13 minimal v1 attestation: the adapter target must present the
  // marker the adapter declares, and match the run's attested env.
  const probe = await probeEnvFingerprint(baseUrl, state.options.requestTimeoutMs);
  const mismatch = envFingerprintMismatch(
    probe,
    adapter.environmentFingerprint,
    state.options.targetFingerprint ?? null,
  );
  if (mismatch !== null) {
    throw new HttpError(
      409,
      `persistence record for resource '${resourceId}' rejected: ${mismatch}`,
      mismatch,
    );
  }
  return { adapterName, adapter, baseUrl };
}

/**
 * The GET-only transport adapters use. `path` may be absolute
 * (http(s)://…) or relative to the adapter base. Timeout is enforced by
 * aborting the underlying fetch.
 */
async function adapterGet(
  baseUrl: string,
  timeoutMs: number,
  path: string,
  readAuthorization?: string | null,
): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string>; headers: Headers }> {
  const target = /^https?:\/\//.test(path) ? path : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Pinned egress: attested hostnames connect to their
    // startup-approved loopback IPs (Host preserved for tenant
    // routing); unpinned names behave exactly as before.
    const response = await pinnedGet(target, {
      timeoutMs,
      headers: {
        // Operator-issued read-only service credential for the ENGINE's own
        // adapter reads (see WitnessOptions.adapterReadAuthorization); never
        // forwarded to the suite and never attached to browser traffic.
        ...(readAuthorization ? { authorization: readAuthorization } : {}),
      },
      signal: controller.signal,
    });
    return {
      status: response.status,
      headers: response.headers,
      json: () => response.json() as Promise<unknown>,
      text: () => response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Issues one witness-stamped record into the ledger.
 *
 * Trust follows ORIGIN, not channel (GF-23, audit round 3): the tested
 * suite owns the browser and holds the run token, so a submitted
 * `ui.action`/`ui.visible-result` payload proves only that the suite
 * asserted it — those records are stamped `trust: 'claimed'` with
 * `origin: 'suite-submitted'`. Records whose contents the witness
 * itself observed engine-side (the adapter read behind
 * `persistence.entity`) are stamped `trust: 'witnessed'` with
 * `origin: 'engine-observed'`. Attestation (the ledger MAC) proves the
 * witness issued a record; it can never prove a UI event happened.
 */
function issueRecord(
  state: WitnessState,
  obligationId: string,
  kind: string,
  testId: string,
  payload: unknown,
  origin: RecordOrigin,
): IssuedRecord {
  const issuedAt = state.nowIso();
  const recordId = recordIdOf({
    runId: state.options.runId,
    obligationId,
    kind,
    testId,
    origin,
    payload,
  });
  const record: IssuedRecord = {
    schemaVersion: 1,
    recordId,
    runId: state.options.runId,
    trust: origin === 'engine-observed' ? 'witnessed' : 'claimed',
    obligationId,
    kind,
    testId,
    origin,
    payload,
    issuedAt,
  };
  state.ledger.set(recordId, record);
  return record;
}

/**
 * Issues a persistence record bound to the claim that requested the
 * adapter read (same testId/obligationId as the claim). The payload is
 * the ENGINE OBSERVATION assembled by the caller — entityId + fields
 * from the ADAPTER RESPONSE (never from caller args), plus the
 * presence/expectation/before data the engine grades postconditions
 * against.
 */
function issuePersistenceRecord(
  state: WitnessState,
  claimId: string,
  testId: string,
  payload: Record<string, unknown>,
): IssuedRecord {
  return issueRecord(state, claimId, PERSISTENCE_KIND, testId, payload, 'engine-observed');
}

/** UUID shape for run/invocation identities (validated, never compared across runs). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 64-char lowercase hex shape for input digests. */
const INPUT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Binds the trusted run context (plan §11.4): the validated current
 * `{runId, invocationId, inputDigest}` from the trusted CLI/orchestrator
 * is frozen in witness memory. Requires BOTH the run token (outer gate)
 * and the verifier key header — a suite holding only the run token gets
 * 401 and the context is unchanged. Binding is allowed only before any
 * proxy exchange, pre-observation, or evidence issuance, and while no
 * proxy exchange is in flight; a used witness answers 409. Repeating the
 * identical binding is idempotent (200); any change to a bound value is
 * 409 — bound state is never relabeled.
 *
 * Args:
 *   state: running witness state.
 *   res: response to answer.
 *   verifier: the `x-gateforge-verifier` header value.
 *   body: parsed request body (must carry runId/invocationId/inputDigest).
 */
async function handleRunContext(
  state: WitnessState,
  res: ServerResponse,
  verifier: unknown,
  body: unknown,
): Promise<void> {
  const verifierKey = state.options.verifierKey;
  if (verifierKey === null || verifierKey === undefined) {
    sendJson(res, 409, { error: 'witness has no verifier key; run-context binding is unavailable' });
    return;
  }
  if (typeof verifier !== 'string' || !timingSafeEqual(verifier, verifierKey)) {
    sendJson(res, 401, { error: 'unauthorized: expected x-gateforge-verifier with the verifier key' });
    return;
  }
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'run-context body must be an object');
  }
  const record = body as Record<string, unknown>;
  const runId = record['runId'];
  const invocationId = record['invocationId'];
  const inputDigest = record['inputDigest'];
  if (
    typeof runId !== 'string' ||
    !UUID_PATTERN.test(runId) ||
    typeof invocationId !== 'string' ||
    !UUID_PATTERN.test(invocationId) ||
    typeof inputDigest !== 'string' ||
    !INPUT_DIGEST_PATTERN.test(inputDigest)
  ) {
    throw new HttpError(
      400,
      'run-context requires runId (UUID), invocationId (UUID), and inputDigest (64-char lowercase hex)',
    );
  }
  if (runId !== state.options.runId) {
    sendJson(res, 409, {
      error:
        `run-context runId '${runId}' does not match this witness run '${state.options.runId}'; ` +
        'adopt the witness run id first, then bind — a witness already used by an older ' +
        'invocation is rejected, start a fresh witness for a new invocation',
    });
    return;
  }
  const existing = state.runContext;
  if (existing !== null) {
    if (
      existing.runId === runId &&
      existing.invocationId === invocationId &&
      existing.inputDigest === inputDigest
    ) {
      sendJson(res, 200, { bound: true, ...existing });
      return;
    }
    sendJson(res, 409, {
      error:
        'run context is already bound and differs; bound state is never relabeled — ' +
        'start a fresh witness for a new invocation',
    });
    return;
  }
  if (
    state.ledger.size > 0 ||
    state.observed.length > 0 ||
    state.preObservations.size > 0 ||
    state.serverPreObservations.size > 0 ||
    state.serverIntentSequences.size > 0 ||
    state.sessions.size > 0 ||
    state.proxyInFlight > 0
  ) {
    sendJson(res, 409, {
      error:
        'witness already observed or issued evidence (or holds an open test session); ' +
        'run-context binding is allowed only before any proxy exchange, pre-observation, ' +
        'server probe, session, or issuance — start a fresh witness for a new invocation',
    });
    return;
  }
  state.runContext = { runId, invocationId, inputDigest };
  state.observedSeqAtBind = state.observedSeq;
  sendJson(res, 200, { bound: true, runId, invocationId, inputDigest });
}

/**
 * Serves the authenticated live attestation (pin #7, GF-23, plan §11.3):
 * the SAME v2 signed envelope object the shutdown append writes —
 * `{attestationVersion: 2, runId, invocationId, inputDigest, recordIds,
 * mac}` with the MAC over the domain-tagged body. Requires the verifier
 * key — a secret the tested suite never receives — so only an
 * orchestrator-grade caller (the evaluating CLI) can certify issuance;
 * the suite's run token authorizes submissions, never attestation.
 * Without a configured verifier key the witness answers 409, and an
 * unbound witness answers 409 as well: it must not sign whatever digest
 * a suite-writable manifest happens to carry.
 */
function handleLedgerAttestation(
  state: WitnessState,
  res: ServerResponse,
  verifier: unknown,
): void {
  const verifierKey = state.options.verifierKey;
  if (verifierKey === null || verifierKey === undefined) {
    sendJson(res, 409, { error: 'witness has no verifier key; attestation is unavailable' });
    return;
  }
  if (typeof verifier !== 'string' || !timingSafeEqual(verifier, verifierKey)) {
    sendJson(res, 401, { error: 'unauthorized: expected x-gateforge-verifier with the verifier key' });
    return;
  }
  const bound = state.runContext;
  if (bound === null) {
    sendJson(res, 409, {
      error:
        'witness has no bound run context; bind POST /run-context before observation — ' +
        'an unbound witness issues no authenticated attestation',
    });
    return;
  }
  const recordIds = [...state.ledger.keys()].sort(compareStrings);
  sendJson(res, 200, {
    attestationVersion: ATTESTATION_VERSION,
    runId: bound.runId,
    invocationId: bound.invocationId,
    inputDigest: bound.inputDigest,
    recordIds,
    mac: attestationMac(verifierKey, {
      runId: bound.runId,
      invocationId: bound.invocationId,
      inputDigest: bound.inputDigest,
      recordIds,
    }),
  });
}

/** Stops the server and appends issued recordIds to the run manifest. */
async function stopWitness(state: WitnessState): Promise<void> {
  if (state.stopped) return;
  state.stopped = true;
  if (state.proxyServer !== null) {
    const proxy = state.proxyServer;
    state.proxyServer = null;
    await new Promise<void>((resolveClose) => {
      proxy.close(() => resolveClose());
    });
  }
  for (const session of state.sessions.values()) {
    await stopSessionProxy(session);
  }
  await state.engineBrowser.closeAll();
  await new Promise<void>((resolveClose) => {
    state.server.close(() => resolveClose());
  });
  appendRecordIdsToManifest(state);
}

/**
 * Pin #4/#7, plan §11.3–§11.4: at shutdown, append the issued recordIds
 * to the run manifest in the state dir (sorted, deduplicated; preserves
 * every other field). Absent manifest → no-op (standalone witness).
 *
 * The append NEVER reads a digest from the suite-writable manifest: the
 * v2 `attestation` envelope is built from the FROZEN bound context
 * (bound via authenticated `POST /run-context` before any observation)
 * plus EXACTLY the ids this witness issued — nothing more. The
 * pre-existing `recordIds` in the manifest came from the suite-writable
 * file, so merging them in would let a hostile suite have its forged
 * computed ids signed as issued (audit round 3). They are discarded,
 * not merged. An unbound witness appends the bare ids for reporting
 * only — no attestation, so downstream evaluation fails closed.
 * No legacy `recordIdsMac` is written: v1 MACs never authorize evidence.
 */
function appendRecordIdsToManifest(state: WitnessState): void {
  const stateDir = state.options.stateDir;
  if (stateDir === null || stateDir === undefined || stateDir === '') return;
  const manifestPath = join(resolve(process.cwd(), stateDir), 'manifest.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return;
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return; // malformed manifest: never corrupt it; evaluation reads it leniently
  }
  const issued = [...state.ledger.keys()].sort(compareStrings);
  const updated: Record<string, unknown> = { ...manifest, recordIds: issued };
  // Drop any legacy v1 MAC the suite (or an older writer) left behind:
  // it must never authorize evidence, not even when it verifies.
  delete updated['recordIdsMac'];
  const verifierKey = state.options.verifierKey;
  const bound = state.runContext;
  if (verifierKey !== null && verifierKey !== undefined && bound !== null) {
    updated['invocationId'] = bound.invocationId;
    updated['inputDigest'] = bound.inputDigest;
    updated['attestation'] = {
      attestationVersion: ATTESTATION_VERSION,
      runId: bound.runId,
      invocationId: bound.invocationId,
      inputDigest: bound.inputDigest,
      recordIds: issued,
      mac: attestationMac(verifierKey, {
        runId: bound.runId,
        invocationId: bound.invocationId,
        inputDigest: bound.inputDigest,
        recordIds: issued,
      }),
    };
  }
  writeFileSync(manifestPath, `${canonicalOf(updated)}\n`, 'utf8');
}

export type { WitnessHandle } from './types.js';
