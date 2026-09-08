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
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ledgerMac, recordIdOf } from '@gateforge/core';
import { canonicalOf } from '../json.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, KNOWN_RECORD_KINDS, LOOPBACK_HOSTNAME, PERSISTENCE_KIND, RUN_HEADER, VERIFIER_HEADER, } from '../constants.js';
import { loadAdapters, makeAdapterContext } from './adapter-registry.js';
import { AttestationError, assertLoopback, envFingerprintMismatch, probeEnvFingerprint, } from './env-attestation.js';
import { loadClassifications, toClassificationView } from './classifications.js';
const MAX_BODY_BYTES = 1024 * 1024;
const OBLIGATION_ID_PATTERN = /^[^:]+:.+$/;
/**
 * Bounded response snapshot the observation proxy keeps per forwarded
 * exchange: at most this many body bytes are hashed into the snapshot,
 * while the TOTAL byte count is tracked separately. The response still
 * streams to the browser unbuffered — the snapshot is a tap, not a gate.
 */
const OBSERVED_BODY_SNAPSHOT_BYTES = 16384;
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
/**
 * Normalizes the declared observation-proxy mount prefix (null when
 * unset/empty). Fail-closed on values that can never be a plain path
 * prefix — a malformed declaration would otherwise silently mismatch
 * obligation identities, the exact failure the option exists to prevent.
 */
function normalizeMountPath(raw) {
    if (raw === null || raw === undefined || raw === '')
        return null;
    let path = raw.trim();
    if (!path.startsWith('/'))
        path = `/${path}`;
    if (path.length > 1)
        path = path.replace(/\/+$/, '');
    if (path === '/' || /[\s?#]/.test(path)) {
        throw new WitnessStartupError(`invalid mountPath '${raw}': declare the browser-facing mount prefix as a non-empty ` +
            "absolute path like '/api'");
    }
    return path;
}
/**
 * Strips the declared mount prefix from a proxied request URL (path
 * plus possible query/fragment), returning the backend-facing URL the
 * proxy forwards AND records. A request outside the prefix passes
 * through untouched, and with no declared prefix the URL is returned
 * byte-identical (the unmounted proxy's behavior).
 */
function stripMountPath(rawUrl, mountPath) {
    if (mountPath === null)
        return rawUrl;
    const queryStart = rawUrl.search(/[?#]/);
    const pathPart = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
    const suffix = queryStart === -1 ? '' : rawUrl.slice(queryStart);
    if (pathPart === mountPath)
        return `/${suffix}`;
    if (pathPart.startsWith(`${mountPath}/`)) {
        return `${pathPart.slice(mountPath.length)}${suffix}`;
    }
    return rawUrl;
}
function isPlainObject(value) {
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
    // The mount prefix declares how the browser-facing deployment mounts
    // the backend for the OBSERVATION PROXY; it is meaningless without one.
    const mountPath = normalizeMountPath(options.mountPath);
    if (mountPath !== null && (options.proxyTarget === undefined || options.proxyTarget === '')) {
        throw new WitnessStartupError('witness option mountPath requires proxyTarget: the mount prefix declares how the ' +
            'observation proxy bridges the browser-facing deployment and the backend');
    }
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
            mountPath,
            verifierKey: typeof options.verifierKey === 'string' && options.verifierKey.length > 0
                ? options.verifierKey
                : null,
            requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            host: options.host ?? LOOPBACK_HOSTNAME,
        },
        adapters,
        classifications,
        ledger: new Map(),
        preObservations: new Map(),
        observed: [],
        observedSeq: 0,
        proxyServer: null,
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
    // ADR 0004 D7: the witness-owned loopback reverse proxy. Browser
    // traffic aimed at the proxy is forwarded to the attested target and
    // (method, path, status, bounded body snapshot, total body bytes)
    // recorded as an ENGINE observation; a suite-callable endpoint consumes
    // a matching observation to issue a witnessed record. The proxy never
    // needs the run token: it serves the browser, holds no authority, and
    // can only add observations the engine itself saw.
    let proxyUrl = null;
    if (typeof state.options.proxyTarget === 'string' && state.options.proxyTarget.length > 0) {
        assertLoopback(state.options.proxyTarget, 'observation proxy target');
        const proxyTargetUrl = new URL(state.options.proxyTarget);
        state.proxyServer = createServer((req, res) => {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                const body = Buffer.concat(chunks);
                // Mount-prefix handling: forward the backend-facing (STRIPPED)
                // URL, and record the same STRIPPED path below, so observations
                // match the backend-derived obligation identities the suite
                // claims. With no declared mount path the URL is forwarded and
                // recorded byte-identical to today.
                const forwardUrl = stripMountPath(req.url ?? '/', state.options.mountPath);
                const forward = request({
                    protocol: proxyTargetUrl.protocol,
                    hostname: proxyTargetUrl.hostname,
                    port: proxyTargetUrl.port,
                    method: req.method,
                    path: forwardUrl,
                    headers: { ...req.headers, host: proxyTargetUrl.host },
                }, (upstream) => {
                    const status = upstream.statusCode ?? 0;
                    const observedPath = normalizeObservedPath(forwardUrl);
                    // Bounded response-body snapshot: the tap is attached BEFORE
                    // piping so both consumers receive the stream; forwarding to
                    // the browser stays unbuffered (the snapshot never gates the
                    // response). Total bytes are counted even beyond the snapshot
                    // limit; only the snapshot is hashed.
                    const snapshot = [];
                    let snapshotBytes = 0;
                    let totalBytes = 0;
                    upstream.on('data', (chunk) => {
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
                        });
                    });
                    res.writeHead(status, upstream.headers);
                    upstream.pipe(res);
                });
                forward.on('error', () => {
                    if (!res.headersSent)
                        sendJson(res, 502, { error: 'observation proxy upstream failed' });
                    else
                        res.end();
                });
                if (body.length > 0)
                    forward.write(body);
                forward.end();
            });
        });
        await new Promise((resolveListen, rejectListen) => {
            state.proxyServer?.once('error', rejectListen);
            state.proxyServer?.listen(0, state.options.host, () => resolveListen());
        });
        const proxyAddress = state.proxyServer.address();
        if (proxyAddress === null || typeof proxyAddress === 'string') {
            await stopWitness(state);
            throw new WitnessStartupError('observation proxy failed to bind an OS-assigned port');
        }
        proxyUrl = `http://${formatHost(state.options.host)}:${proxyAddress.port}`;
    }
    const handle = Object.freeze({
        url,
        proxyUrl,
        stop: () => stopWitness(state),
    });
    return handle;
}
/** Canonicalizes an observed request path (query stripped, one slash). */
function normalizeObservedPath(rawPath) {
    let path = rawPath.split('?')[0]?.split('#')[0] ?? '/';
    if (!path.startsWith('/'))
        path = `/${path}`;
    if (path.length > 1)
        path = path.replace(/\/+$/, '');
    return path;
}
/**
 * Consumes one engine-observed request matching (method, path) and
 * issues witnessed `http.request` records bound to the declaring test's
 * obligation claims (ADR 0004 D7). Single-use at the EXCHANGE level: an
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
async function handleHttpObservation(state, res, body) {
    const testId = body['testId'];
    const method = body['method'];
    const path = body['path'];
    const expectedStatus = body['expectedStatus'];
    // Claim binding: `claimIds` (the declaring test's claimed obligation
    // ids for this endpoint) — with the singular legacy `claimId` /
    // `obligationId` pair still accepted and folded in.
    const rawClaimIds = Array.isArray(body['claimIds'])
        ? [...body['claimIds'], body['claimId'], body['obligationId']]
        : [body['claimIds'], body['claimId'], body['obligationId']];
    const claimIds = [];
    for (const entry of rawClaimIds) {
        if (entry === undefined || entry === null)
            continue;
        if (typeof entry !== 'string' || !OBLIGATION_ID_PATTERN.test(entry)) {
            sendJson(res, 400, {
                error: 'http observation requires claimIds as obligation-id strings ' +
                    "'<resourceId>:<contract>' (a singular legacy claimId/obligationId is still accepted)",
            });
            return;
        }
        if (!claimIds.includes(entry))
            claimIds.push(entry);
    }
    if (claimIds.length === 0 ||
        typeof testId !== 'string' ||
        testId.length === 0 ||
        typeof method !== 'string' ||
        typeof path !== 'string' ||
        path.length === 0 ||
        (expectedStatus !== undefined &&
            (typeof expectedStatus !== 'number' || !Number.isInteger(expectedStatus)))) {
        sendJson(res, 400, {
            error: 'http observation requires testId, method, and path strings plus at least one ' +
                "claimed obligation id ('<resourceId>:<contract>'); expectedStatus, when present, " +
                'must be an integer status code',
        });
        return;
    }
    const wanted = normalizeObservedPath(path);
    const index = state.observed.findIndex((entry) => entry.method === method.toUpperCase() &&
        entry.path === wanted &&
        (expectedStatus === undefined || entry.status === expectedStatus));
    if (index === -1) {
        sendJson(res, 409, {
            error: `no engine-observed request matches ${method.toUpperCase()} ${wanted}` +
                `${expectedStatus === undefined ? '' : ` with status ${String(expectedStatus)}`}; drive the ` +
                'browser through the observation proxy before claiming the obligation',
        });
        return;
    }
    const observedRequest = state.observed[index];
    // Consume the exchange FIRST (single-use), then issue one record per
    // distinct claimed obligation id — same payload, per-claim identity.
    state.observed.splice(index, 1);
    const payload = {
        method: observedRequest.method,
        url: observedRequest.path,
        status: observedRequest.status,
        bodySha256: observedRequest.bodySha256,
        bodyBytes: observedRequest.bodyBytes,
    };
    const issued = claimIds.map((claimId) => issueRecord(state, claimId, 'http.request', testId, payload, 'engine-observed'));
    const first = issued[0];
    sendJson(res, 200, {
        recordId: first.recordId,
        runId: first.runId,
        trust: first.trust,
        status: observedRequest.status,
        records: issued.map((record) => ({ recordId: record.recordId, obligationId: record.obligationId })),
    });
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
        if (req.method === 'GET' && path === '/ledger-attestation') {
            handleLedgerAttestation(state, res, req.headers[VERIFIER_HEADER]);
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
        if (req.method === 'POST' && path === '/witness/pre-observation') {
            await handlePreObservation(state, res, (await readBody(req)));
            return;
        }
        if (req.method === 'POST' && path === '/witness/persistence') {
            await handlePersistence(state, res, (await readBody(req)));
            return;
        }
        if (req.method === 'POST' && path === '/witness/http-observation') {
            await handleHttpObservation(state, res, (await readBody(req)));
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
 * `POST /records`: validates and issues a submitted evidence record.
 * Unknown primitive kinds → 400 (GF-11: an unregistered primitive name
 * has no registration path; GF-14: the audit-event primitive is
 * implementation-gated and does not exist yet). Only the two UI
 * primitives are suite-submittable; `http.request` and persistence
 * records are witness-issued only (engine-side observation), so no
 * claimed-side path can mint them.
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
            '(http.request and persistence records are witness-issued only: /witness/http-observation ' +
            'and /witness/persistence)');
    }
    if (typeof testId !== 'string' || testId.length === 0) {
        throw new HttpError(400, 'testId must be a non-empty string');
    }
    if (!isPlainObject(payload)) {
        throw new HttpError(400, 'payload must be a JSON object');
    }
    const record = issueRecord(state, claimId, kind, testId, payload, 'suite-submitted');
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
 *
 * The issued record's payload is the ENGINE OBSERVATION the verdict
 * engine grades postconditions against (audit rounds 4-5): `{resourceId,
 * entityId, found, fields?, before?}`. Expectations NEVER come from the
 * tested suite; `before` links a consumed pre-observation (id-set
 * absence for create, entity-fields snapshot for update).
 */
async function handlePersistence(state, res, body) {
    if (!isPlainObject(body)) {
        throw new HttpError(400, 'request body must be an object');
    }
    const { resourceId, entityId, testId, claimId, preObservationId } = body;
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
        throw new HttpError(400, 'resourceId must be a non-empty string');
    }
    if (typeof testId !== 'string' || testId.length === 0) {
        throw new HttpError(400, 'testId must be a non-empty string');
    }
    if (typeof claimId !== 'string' || !OBLIGATION_ID_PATTERN.test(claimId)) {
        throw new HttpError(400, "claimId must be an obligation id '<resourceId>:<contract>'");
    }
    if (preObservationId !== undefined &&
        (typeof preObservationId !== 'string' || preObservationId.length === 0)) {
        throw new HttpError(400, 'preObservationId must be a non-empty string when present');
    }
    const { adapterName, adapter, baseUrl } = await adapterReadContext(state, resourceId);
    // Consume the referenced pre-observation, if any (single-use). Its
    // contents — never suite-declared expectations — are what the engine
    // grades create/update postconditions against.
    let before;
    let consumed;
    if (typeof preObservationId === 'string') {
        const observation = state.preObservations.get(preObservationId);
        if (observation === undefined || observation.resourceId !== resourceId) {
            throw new HttpError(400, `pre-observation '${preObservationId}' is unknown, already consumed, or belongs to another resource`);
        }
        state.preObservations.delete(preObservationId);
        consumed = observation;
        before = { entityAbsent: true }; // refined below for ids-kind snapshots
    }
    // Execute the adapter's GET-only read through the mediated transport.
    const adapterHeaders = state.options.adapterReadAuthorization
        ? { authorization: state.options.adapterReadAuthorization }
        : undefined;
    const ctx = makeAdapterContext(baseUrl, resourceId, (path) => adapterGet(baseUrl, state.options.requestTimeoutMs, path, state.options.adapterReadAuthorization), adapterHeaders);
    let bodyRaw;
    try {
        bodyRaw = await adapter.read(ctx, entityId);
    }
    catch (error) {
        throw new HttpError(409, `adapter '${adapterName}' read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const found = bodyRaw !== null && bodyRaw !== undefined;
    let normalized = null;
    if (found) {
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
    }
    // Report-only observations; the ENGINE judges identity binding (GF-05).
    const mismatches = [];
    let entityAgrees = true;
    if (found && entityId !== undefined && normalized !== null) {
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
    // Build `before` from the consumed pre-observation's OWN contents —
    // never from anything the suite declared.
    if (consumed !== undefined && before !== undefined) {
        if (consumed.kind === 'ids') {
            const observedId = normalized !== null && normalized.entityId !== undefined ? normalized.entityId : entityId;
            let absent = true;
            try {
                absent = !consumed.ids.includes(canonicalOf(observedId));
            }
            catch {
                absent = true; // unrepresentable id: treat as not previously observed
            }
            before = { entityAbsent: absent };
        }
        else {
            before = {
                found: consumed.found,
                ...(consumed.found ? { fields: consumed.fields } : {}),
            };
        }
    }
    // The payload IS the engine observation (hashed into the record id).
    const payload = {
        resourceId,
        entityId: found && normalized !== null ? normalized.entityId : entityId ?? null,
        found,
        ...(found && normalized !== null ? { fields: normalized.fields } : {}),
        ...(before !== undefined ? { before } : {}),
    };
    const issued = issuePersistenceRecord(state, String(claimId), testId, payload);
    const response = {
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
async function handlePreObservation(state, res, body) {
    if (!isPlainObject(body)) {
        throw new HttpError(400, 'request body must be an object');
    }
    const { resourceId, testId, claimId, entityId } = body;
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
    const adapterHeaders = state.options.adapterReadAuthorization
        ? { authorization: state.options.adapterReadAuthorization }
        : undefined;
    const ctx = makeAdapterContext(baseUrl, resourceId, (path) => adapterGet(baseUrl, state.options.requestTimeoutMs, path, state.options.adapterReadAuthorization), adapterHeaders);
    const observationId = randomUUID();
    if (entityId !== undefined) {
        // Entity-fields snapshot (update postconditions).
        let bodyRaw;
        try {
            bodyRaw = await adapter.read(ctx, entityId);
        }
        catch (error) {
            throw new HttpError(409, `adapter '${adapterName}' read failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const found = bodyRaw !== null && bodyRaw !== undefined;
        let fields = undefined;
        if (found) {
            try {
                const candidate = adapter.normalize(bodyRaw);
                if (!isPlainObject(candidate) || !('fields' in candidate)) {
                    throw new Error('normalize must return {entityId, fields}');
                }
                fields = candidate['fields'];
            }
            catch (error) {
                throw new HttpError(409, `adapter '${adapterName}' normalize failed during pre-observation: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        state.preObservations.set(observationId, {
            resourceId,
            kind: 'entity',
            entityId: canonicalOf(entityId),
            found,
            ...(found ? { fields } : {}),
        });
        const response = { observationId, observed: found ? 1 : 0 };
        sendJson(res, 200, response);
        return;
    }
    // Resource id-set snapshot (create postconditions).
    if (typeof adapter.list !== 'function') {
        throw new HttpError(409, `adapter '${adapterName}' does not support resource-level pre-observation ` +
            '(no list export); create postconditions cannot be observed for this resource');
    }
    let raw;
    try {
        raw = await adapter.list(ctx);
    }
    catch (error) {
        throw new HttpError(409, `adapter '${adapterName}' list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(raw)) {
        throw new HttpError(409, `adapter '${adapterName}' list must return an array of entities`);
    }
    const ids = [];
    for (const entity of raw) {
        try {
            const candidate = adapter.normalize(entity);
            if (!isPlainObject(candidate) || !('entityId' in candidate)) {
                throw new Error('normalize must return {entityId, fields}');
            }
            ids.push(canonicalOf(candidate['entityId']));
        }
        catch (error) {
            throw new HttpError(409, `adapter '${adapterName}' normalize failed during pre-observation: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    state.preObservations.set(observationId, { resourceId, kind: 'ids', ids: ids.sort(compareStrings) });
    const response = { observationId, observed: ids.length };
    sendJson(res, 200, response);
}
/**
 * Resolves the reviewed adapter + mediated read base for one resource,
 * enforcing the full attestation chain (ADR 0001 adapter, GF-10
 * loopback, GF-13 fingerprint). Shared by persistence reads and
 * pre-observations.
 */
async function adapterReadContext(state, resourceId) {
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
    return { adapterName, adapter, baseUrl };
}
/**
 * The GET-only transport adapters use. `path` may be absolute
 * (http(s)://…) or relative to the adapter base. Timeout is enforced by
 * aborting the underlying fetch.
 */
async function adapterGet(baseUrl, timeoutMs, path, readAuthorization) {
    const target = /^https?:\/\//.test(path) ? path : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(target, {
            method: 'GET',
            headers: {
                accept: 'application/json, text/html',
                // Operator-issued read-only service credential for the ENGINE's own
                // adapter reads (see WitnessOptions.adapterReadAuthorization); never
                // forwarded to the suite and never attached to browser traffic.
                ...(readAuthorization ? { authorization: readAuthorization } : {}),
            },
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
function issueRecord(state, obligationId, kind, testId, payload, origin) {
    const issuedAt = state.nowIso();
    const recordId = recordIdOf({
        runId: state.options.runId,
        obligationId,
        kind,
        testId,
        origin,
        payload,
    });
    const record = {
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
function issuePersistenceRecord(state, claimId, testId, payload) {
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
function handleLedgerAttestation(state, res, verifier) {
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
async function stopWitness(state) {
    if (state.stopped)
        return;
    state.stopped = true;
    if (state.proxyServer !== null) {
        const proxy = state.proxyServer;
        state.proxyServer = null;
        await new Promise((resolveClose) => {
            proxy.close(() => resolveClose());
        });
    }
    await new Promise((resolveClose) => {
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
    // The authenticated set is EXACTLY what this witness issued — nothing
    // more. The pre-existing `recordIds` in the manifest came from the
    // suite-writable file, so merging them in would let a hostile suite
    // have its forged computed ids signed as issued (audit round 3).
    // They are discarded, not merged.
    const issued = [...state.ledger.keys()].sort(compareStrings);
    const updated = { ...manifest, recordIds: issued };
    const verifierKey = state.options.verifierKey;
    const manifestRunId = typeof manifest['runId'] === 'string' ? manifest['runId'] : null;
    if (verifierKey !== null &&
        verifierKey !== undefined &&
        manifestRunId !== null &&
        manifestRunId.length > 0) {
        // Bind the set to the MANIFEST's runId: the CLI verifies against the
        // same value it checks each record's runId against.
        updated['recordIdsMac'] = ledgerMac(verifierKey, manifestRunId, issued);
    }
    writeFileSync(manifestPath, `${canonicalOf(updated)}\n`, 'utf8');
}
//# sourceMappingURL=server.js.map