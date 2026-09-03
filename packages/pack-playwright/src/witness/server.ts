/**
 * The loopback witness service (pin #7, owner G6).
 *
 * A node:http server on an OS-assigned port, reachable ONLY on loopback.
 * Every request must carry `x-gateforge-run: <token>` (per-run token);
 * without it the witness answers 401. Endpoints:
 *
 * - `POST /records`          — test-side primitives submit UI evidence
 *   ({claimId, kind, payload, testId}) → the witness ISSUES a record
 *   with service-computed provenance and answers {recordId, trust,
 *   runId}. Unknown primitive kinds → 400 (GF-11, GF-14).
 * - `POST /witness/persistence` — the fixture asks the witness to run
 *   the engine-side adapter (GET-only) for one entity → the witness
 *   executes the read, stamps a `persistence.entity` record from the
 *   ADAPTER RESPONSE, and returns {recordId, runId, verdictRelevant}.
 *   Raw adapter bodies never cross back into the test process. Wire is
 *   the pin-#7 shape extended with `testId` + `claimId` (the pinned
 *   fields stay honored) so persistence records bind to the claim the
 *   engine grades.
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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ledgerMac, recordIdOf, type Classification, type RecordOrigin } from '@gateforge/core';
import { canonicalOf } from '../json.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  KNOWN_RECORD_KINDS,
  LOOPBACK_HOSTNAME,
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
import { loadClassifications, toClassificationView } from './classifications.js';
import type {
  EvidenceAdapter,
  IssuedRecord,
  PersistenceRequest,
  PersistenceResponse,
  PreObservationRequest,
  PreObservationResponse,
  RecordsRequest,
  RecordsResponse,
  WitnessHandle,
  WitnessOptions,
} from './types.js';

const MAX_BODY_BYTES = 1024 * 1024;
const OBLIGATION_ID_PATTERN = /^[^:]+:.+$/;

/** Fail-closed witness configuration/startup error. */
export class WitnessStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WitnessStartupError';
  }
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
  > &
    WitnessOptions;
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
  server: Server;
  nowIso: () => string;
  stopped: boolean;
}

/** Codepoint-wise comparison for deterministic ordering. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  // GF-10: the attestation subject must be loopback — block at startup,
  // before any mutation-capable request surface exists.
  if (targetBaseUrl !== null) {
    assertLoopback(targetBaseUrl, 'attestation subject');
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

  const handle = Object.freeze({
    url,
    stop: (): Promise<void> => stopWitness(state),
  });
  return handle;
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
    if (req.method === 'POST' && path === '/witness/pre-observation') {
      await handlePreObservation(state, res, (await readBody(req)) as PreObservationRequest);
      return;
    }
    if (req.method === 'POST' && path === '/witness/persistence') {
      await handlePersistence(state, res, (await readBody(req)) as PersistenceRequest);
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

/** Sends a GF-canonical JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(canonicalOf(body));
}

/**
 * `POST /records`: validates and issues a UI-evidence record. Unknown
 * primitive kinds → 400 (GF-11: an unregistered primitive name has no
 * registration path; GF-14: the audit-event primitive is
 * implementation-gated and does not exist yet).
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
        '(persistence records are issued only by the witness via /witness/persistence)',
    );
  }
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new HttpError(400, 'testId must be a non-empty string');
  }
  if (!isPlainObject(payload)) {
    throw new HttpError(400, 'payload must be a JSON object');
  }
  const record = issueRecord(state, claimId, kind, testId, payload, 'suite-submitted');
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
  const ctx = makeAdapterContext(baseUrl, resourceId, (path: string) =>
    adapterGet(baseUrl, state.options.requestTimeoutMs, path),
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
  };
  const issued = issuePersistenceRecord(state, String(claimId), testId, payload);

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

  const { adapterName, adapter, baseUrl } = await adapterReadContext(state, resourceId);
  const ctx = makeAdapterContext(baseUrl, resourceId, (path: string) =>
    adapterGet(baseUrl, state.options.requestTimeoutMs, path),
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
    const response: PreObservationResponse = { observationId, observed: found ? 1 : 0 };
    sendJson(res, 200, response);
    return;
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

  const response: PreObservationResponse = { observationId, observed: ids.length };
  sendJson(res, 200, response);
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
  assertLoopback(baseUrl, `adapter '${adapterName}'`);

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
): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string>; headers: Headers }> {
  const target = /^https?:\/\//.test(path) ? path : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json, text/html' },
      signal: controller.signal,
      redirect: 'follow',
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

/**
 * Serves the authenticated live ledger set (pin #7, GF-23): runId plus
 * the issued recordIds, bound by a verifier-key MAC. Requires the
 * verifier key — a secret the tested suite never receives — so only an
 * orchestrator-grade caller (the evaluating CLI) can certify issuance;
 * the suite's run token authorizes submissions, never attestation.
 * Without a configured verifier key the witness answers 409: an
 * unauthenticated ledger is not an attestation.
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
  const recordIds = [...state.ledger.keys()].sort(compareStrings);
  sendJson(res, 200, {
    runId: state.options.runId,
    recordIds,
    mac: ledgerMac(verifierKey, state.options.runId, recordIds),
  });
}

/** Stops the server and appends issued recordIds to the run manifest. */
async function stopWitness(state: WitnessState): Promise<void> {
  if (state.stopped) return;
  state.stopped = true;
  await new Promise<void>((resolveClose) => {
    state.server.close(() => resolveClose());
  });
  appendRecordIdsToManifest(state);
}

/**
 * Pin #4/#7: at shutdown, append the issued recordIds to the run
 * manifest in the state dir (sorted, deduplicated; preserves every
 * other field). Absent manifest → no-op (standalone witness).
 *
 * With a verifier key configured, the append is AUTHENTICATED: a
 * `recordIdsMac` (HMAC over the canonical `{runId, recordIds}`) is
 * stamped alongside the ids, making the suite-writable manifest
 * tamper-evident for the evaluating CLI (GF-23). Without one the ids
 * are appended for reporting only — downstream evaluation treats an
 * unauthenticated set as untrusted and fails closed.
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
  // The authenticated set is EXACTLY what this witness issued — nothing
  // more. The pre-existing `recordIds` in the manifest came from the
  // suite-writable file, so merging them in would let a hostile suite
  // have its forged computed ids signed as issued (audit round 3).
  // They are discarded, not merged.
  const issued = [...state.ledger.keys()].sort(compareStrings);
  const updated: Record<string, unknown> = { ...manifest, recordIds: issued };
  const verifierKey = state.options.verifierKey;
  const manifestRunId = typeof manifest['runId'] === 'string' ? manifest['runId'] : null;
  if (
    verifierKey !== null &&
    verifierKey !== undefined &&
    manifestRunId !== null &&
    manifestRunId.length > 0
  ) {
    // Bind the set to the MANIFEST's runId: the CLI verifies against the
    // same value it checks each record's runId against.
    updated['recordIdsMac'] = ledgerMac(verifierKey, manifestRunId, issued);
  }
  writeFileSync(manifestPath, `${canonicalOf(updated)}\n`, 'utf8');
}
