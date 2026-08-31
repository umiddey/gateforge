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
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256Hex } from '@gateforge/core';
import { canonicalOf } from '../json.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, KNOWN_RECORD_KINDS, LOOPBACK_HOSTNAME, PERSISTENCE_KIND, RUN_HEADER, } from '../constants.js';
import { loadAdapters, makeAdapterContext } from './adapter-registry.js';
import { AttestationError, assertLoopback, envFingerprintMismatch, probeEnvFingerprint, } from './env-attestation.js';
import { loadClassifications, toClassificationView } from './classifications.js';
const MAX_BODY_BYTES = 1024 * 1024;
const OBLIGATION_ID_PATTERN = /^[^:]+:.+$/;
/** Fail-closed witness configuration/startup error. */
export class WitnessStartupError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WitnessStartupError';
    }
}
/** An HTTP JSON error the witness answers (status + {error, detail?}). */
class HttpError extends Error {
    status;
    detail;
    constructor(status, message, detail = null) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.detail = detail;
    }
}
/** Codepoint-wise comparison for deterministic ordering. */
function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Derives the service-issued recordId: sha256 over GF-canonical JSON of
 * the record identity (pin #1). Deterministic and stable across runs;
 * an entry that never passed through the service has no matching hash,
 * so shape-level fabrication (a hex string the service never issued)
 * cannot line up with the ledger the reporter copies.
 */
export function recordIdOf(identity) {
    return sha256Hex(canonicalOf({
        runId: identity.runId,
        obligationId: identity.obligationId,
        kind: identity.kind,
        testId: identity.testId,
        payload: identity.payload,
    }));
}
/** Reads the JSON request body (sized; malformed → HttpError). */
function readBody(req) {
    return new Promise((resolveBody, rejectBody) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
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
                resolveBody(JSON.parse(raw));
            }
            catch (error) {
                rejectBody(new HttpError(400, `request body is not valid JSON: ${error.message}`));
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
export async function startWitness(options) {
    if (typeof options.runId !== 'string' || options.runId.length === 0) {
        throw new WitnessStartupError('witness requires a runId (GATEFORGE_RUN_ID)');
    }
    if (typeof options.token !== 'string' || options.token.length === 0) {
        throw new WitnessStartupError('witness requires a token (GATEFORGE_RUN_TOKEN)');
    }
    const cwd = process.cwd();
    const adaptersDir = options.adaptersDir === null || options.adaptersDir === undefined
        ? null
        : resolve(cwd, options.adaptersDir);
    const classificationsPath = options.classificationsPath === null || options.classificationsPath === undefined
        ? null
        : resolve(cwd, options.classificationsPath);
    const adapters = adaptersDir === null ? new Map() : await loadAdapters(adaptersDir);
    const classifications = loadClassifications(classificationsPath);
    const targetBaseUrl = options.targetBaseUrl ?? null;
    // GF-10: the attestation subject must be loopback — block at startup,
    // before any mutation-capable request surface exists.
    if (targetBaseUrl !== null) {
        assertLoopback(targetBaseUrl, 'attestation subject');
    }
    // GF-13 minimal v1: when the run pins a fingerprint, the subject's
    // marker must match before the service opens for business.
    if (targetBaseUrl !== null &&
        options.targetFingerprint !== null &&
        options.targetFingerprint !== undefined) {
        const probe = await probeEnvFingerprint(targetBaseUrl, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        const mismatch = envFingerprintMismatch(probe, options.targetFingerprint, options.targetFingerprint);
        if (mismatch !== null) {
            throw new AttestationError(`attestation subject '${targetBaseUrl}' failed startup attestation: ${mismatch}`);
        }
    }
    const state = {
        options: {
            ...options,
            runId: options.runId,
            token: options.token,
            requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            host: options.host ?? LOOPBACK_HOSTNAME,
        },
        adapters,
        classifications,
        ledger: new Map(),
        server: undefined,
        nowIso: options.now ?? (() => new Date().toISOString()),
        stopped: false,
    };
    state.server = createServer((req, res) => {
        void handleRequest(state, req, res);
    });
    await new Promise((resolveListen, rejectListen) => {
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
        stop: () => stopWitness(state),
    });
    return handle;
}
/** Formats the bind host into a URL host (bracketing IPv6 literals). */
function formatHost(host) {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
/** Routes one request through auth + body parse + dispatch. */
async function handleRequest(state, req, res) {
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
        if (req.method === 'GET' && path === '/classifications') {
            const resources = {};
            for (const key of Object.keys(state.classifications).sort(compareStrings)) {
                resources[key] = toClassificationView(state.classifications[key]);
            }
            sendJson(res, 200, { resources });
            return;
        }
        if (req.method === 'POST' && path === '/records') {
            await handleRecords(state, res, (await readBody(req)));
            return;
        }
        if (req.method === 'POST' && path === '/witness/persistence') {
            await handlePersistence(state, res, (await readBody(req)));
            return;
        }
        sendJson(res, 404, { error: `no witness endpoint at ${req.method} ${path}` });
    }
    catch (error) {
        if (error instanceof HttpError) {
            const detail = error.detail;
            sendJson(res, error.status, detail === null ? { error: error.message } : { error: error.message, detail });
            return;
        }
        if (error instanceof AttestationError) {
            sendJson(res, 409, { error: 'attestation blocked', detail: error.message });
            return;
        }
        sendJson(res, 500, { error: `witness internal error: ${error instanceof Error ? error.message : String(error)}` });
    }
}
/** Constant-time token comparison. */
function timingSafeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
/** Sends a GF-canonical JSON response. */
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(canonicalOf(body));
}
/**
 * `POST /records`: validates and issues a UI-evidence record. Unknown
 * primitive kinds → 400 (GF-11: an unregistered primitive name has no
 * registration path; GF-14: the audit-event primitive is
 * implementation-gated and does not exist yet).
 */
async function handleRecords(state, res, body) {
    if (!isPlainObject(body)) {
        throw new HttpError(400, 'request body must be an object');
    }
    const { claimId, kind, payload, testId } = body;
    if (typeof claimId !== 'string' || !OBLIGATION_ID_PATTERN.test(claimId)) {
        throw new HttpError(400, "claimId must be an obligation id '<resourceId>:<contract>'");
    }
    if (typeof kind !== 'string' || !KNOWN_RECORD_KINDS.includes(kind)) {
        throw new HttpError(400, `unknown evidence primitive '${String(kind)}'; accepted kinds: ${KNOWN_RECORD_KINDS.join(', ')} ` +
            '(persistence records are issued only by the witness via /witness/persistence)');
    }
    if (typeof testId !== 'string' || testId.length === 0) {
        throw new HttpError(400, 'testId must be a non-empty string');
    }
    if (!isPlainObject(payload)) {
        throw new HttpError(400, 'payload must be a JSON object');
    }
    const record = issueRecord(state, claimId, kind, testId, payload);
    const response = {
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
 */
async function handlePersistence(state, res, body) {
    if (!isPlainObject(body)) {
        throw new HttpError(400, 'request body must be an object');
    }
    const { resourceId, entityId, expectFields, testId, claimId } = body;
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
        throw new HttpError(400, 'resourceId must be a non-empty string');
    }
    if (typeof testId !== 'string' || testId.length === 0) {
        throw new HttpError(400, 'testId must be a non-empty string');
    }
    if (typeof claimId !== 'string' || !OBLIGATION_ID_PATTERN.test(claimId)) {
        throw new HttpError(400, "claimId must be an obligation id '<resourceId>:<contract>'");
    }
    if (expectFields !== undefined && expectFields !== null && !isPlainObject(expectFields)) {
        throw new HttpError(400, 'expectFields must be a JSON object when present');
    }
    const classification = state.classifications[resourceId];
    const adapterName = classification?.evidenceAdapter ?? resourceId;
    const adapter = state.adapters.get(adapterName);
    if (adapter === undefined) {
        throw new HttpError(400, `no reviewed evidence adapter registered for resource '${resourceId}' ` +
            `(looked for '.gateforge/adapters/${adapterName}.mjs'); ` +
            'user-facing resources cannot be proven without a trusted adapter (ADR 0001)');
    }
    const baseUrl = adapter.baseUrl ?? state.options.adapterBaseUrl ?? state.options.targetBaseUrl;
    if (baseUrl === null || baseUrl === undefined || baseUrl === '') {
        throw new HttpError(400, `adapter '${adapterName}' has no read base (set GATEFORGE_ADAPTER_BASE_URL, ` +
            'the adapter baseUrl export, or the attestation target)');
    }
    // GF-10 (per-read mediation): never build a request against a
    // non-loopback base.
    assertLoopback(baseUrl, `adapter '${adapterName}'`);
    // GF-13 minimal v1 attestation: the adapter target must present the
    // marker the adapter declares, and match the run's attested env.
    const probe = await probeEnvFingerprint(baseUrl, state.options.requestTimeoutMs);
    const mismatch = envFingerprintMismatch(probe, adapter.environmentFingerprint, state.options.targetFingerprint ?? null);
    if (mismatch !== null) {
        throw new HttpError(409, `persistence record for resource '${resourceId}' rejected: ${mismatch}`, mismatch);
    }
    // Execute the adapter's GET-only read through the mediated transport.
    const ctx = makeAdapterContext(baseUrl, resourceId, (path) => adapterGet(baseUrl, state.options.requestTimeoutMs, path));
    let bodyRaw;
    try {
        bodyRaw = await adapter.read(ctx, entityId);
    }
    catch (error) {
        throw new HttpError(409, `adapter '${adapterName}' read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const found = bodyRaw !== null && bodyRaw !== undefined;
    let normalized;
    try {
        const candidate = adapter.normalize(bodyRaw);
        if (!isPlainObject(candidate) || !('entityId' in candidate) || !('fields' in candidate)) {
            throw new Error('normalize must return {entityId, fields}');
        }
        normalized = { entityId: candidate['entityId'], fields: candidate['fields'] };
    }
    catch (error) {
        throw new HttpError(409, `adapter '${adapterName}' normalize failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Report-only observations; the ENGINE judges identity binding (GF-05).
    const mismatches = [];
    let entityAgrees = true;
    if (entityId !== undefined) {
        try {
            if (canonicalOf(entityId) !== canonicalOf(normalized.entityId)) {
                entityAgrees = false;
                mismatches.push(`entityId mismatch: adapter returned ${canonicalOf(normalized.entityId)} for requested ${canonicalOf(entityId)}`);
            }
        }
        catch {
            entityAgrees = false;
        }
    }
    const fieldsAgreeResult = fieldsAgree(expectFields, normalized.fields, mismatches);
    const issued = issuePersistenceRecord(state, String(claimId), testId, resourceId, normalized);
    const response = {
        recordId: issued.recordId,
        runId: issued.runId,
        verdictRelevant: {
            found,
            fieldsMatch: entityAgrees && fieldsAgreeResult,
            ...(mismatches.length > 0 ? { mismatches } : {}),
        },
    };
    sendJson(res, 200, response);
}
/**
 * The GET-only transport adapters use. `path` may be absolute
 * (http(s)://…) or relative to the adapter base. Timeout is enforced by
 * aborting the underlying fetch.
 */
async function adapterGet(baseUrl, timeoutMs, path) {
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
            json: () => response.json(),
            text: () => response.text(),
        };
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Compares `expectFields` against the persisted field map (shared keys;
 * canonical equality). Mismatching or missing keys append diagnostics.
 */
function fieldsAgree(expectFields, actualFields, mismatches) {
    if (!isPlainObject(expectFields))
        return true; // nothing declared to agree
    if (!isPlainObject(actualFields)) {
        mismatches.push('persisted fields are not an object');
        return false;
    }
    let agree = true;
    for (const [key, expected] of Object.entries(expectFields)) {
        if (!(key in actualFields)) {
            mismatches.push(`'${key}': expected ${canonicalOf(expected)} but the persisted entity has no such field`);
            agree = false;
            continue;
        }
        let actual;
        try {
            actual = canonicalOf(actualFields[key]);
        }
        catch {
            mismatches.push(`'${key}': persisted value is not JSON-comparable`);
            agree = false;
            continue;
        }
        if (actual !== canonicalOf(expected)) {
            mismatches.push(`'${key}': expected ${canonicalOf(expected)}, persisted ${actual}`);
            agree = false;
        }
    }
    return agree;
}
/** Issues one witness-stamped record into the ledger. */
function issueRecord(state, obligationId, kind, testId, payload) {
    const issuedAt = state.nowIso();
    const recordId = recordIdOf({ runId: state.options.runId, obligationId, kind, testId, payload });
    const record = {
        schemaVersion: 1,
        recordId,
        runId: state.options.runId,
        trust: 'witnessed',
        obligationId,
        kind,
        testId,
        payload,
        issuedAt,
    };
    state.ledger.set(recordId, record);
    return record;
}
/**
 * Issues a persistence record bound to the claim that requested the
 * adapter read (same testId/obligationId as the claim), with entityId +
 * fields stamped from the ADAPTER RESPONSE (never from caller args).
 */
function issuePersistenceRecord(state, claimId, testId, resourceId, normalized) {
    return issueRecord(state, claimId, PERSISTENCE_KIND, testId, {
        resourceId,
        entityId: normalized.entityId,
        fields: normalized.fields,
    });
}
/** Stops the server and appends issued recordIds to the run manifest. */
async function stopWitness(state) {
    if (state.stopped)
        return;
    state.stopped = true;
    await new Promise((resolveClose) => {
        state.server.close(() => resolveClose());
    });
    appendRecordIdsToManifest(state);
}
/**
 * Pin #4/#7: at shutdown, append the issued recordIds to the run
 * manifest in the state dir (sorted, deduplicated; preserves every
 * other field). Absent manifest → no-op (standalone witness).
 */
function appendRecordIdsToManifest(state) {
    const stateDir = state.options.stateDir;
    if (stateDir === null || stateDir === undefined || stateDir === '')
        return;
    const manifestPath = join(resolve(process.cwd(), stateDir), 'manifest.json');
    let raw;
    try {
        raw = readFileSync(manifestPath, 'utf8');
    }
    catch {
        return;
    }
    let manifest;
    try {
        manifest = JSON.parse(raw);
    }
    catch {
        return; // malformed manifest: never corrupt it; evaluation reads it leniently
    }
    const existing = Array.isArray(manifest['recordIds']) ? manifest['recordIds'] : [];
    const issued = [...state.ledger.keys()];
    const merged = [...new Set([...existing.map(String), ...issued])].sort(compareStrings);
    writeFileSync(manifestPath, `${canonicalOf({ ...manifest, recordIds: merged })}\n`, 'utf8');
}
//# sourceMappingURL=server.js.map