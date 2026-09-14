import { CLAIM_ANNOTATION_TYPE } from '../constants.js';
import { SURFACE_DESCRIPTOR_VERSION, declaredSurfaceFields, validateSurface, } from '../surface.js';
import { WitnessClient } from './witness-client.js';
export { SURFACE_DESCRIPTOR_VERSION };
/** Receipt branding: per-instance symbol, own-property checked (GF-22). */
function makeReceiptBrand() {
    const token = Symbol('gateforge.receipt');
    return {
        stamp(receipt) {
            return Object.freeze({ ...receipt, kind: 'ui', [token]: true });
        },
        isGenuine(receipt) {
            return (receipt !== null &&
                typeof receipt === 'object' &&
                Object.prototype.hasOwnProperty.call(receipt, token) &&
                receipt[token] === true);
        },
    };
}
/** Claims from the test annotations (`{type: 'gateforge', description}`). */
export function claimsFromAnnotations(annotations) {
    return annotations
        .filter((annotation) => annotation.type === CLAIM_ANNOTATION_TYPE)
        .map((annotation) => annotation.description ?? '')
        .filter((description) => description.length > 0);
}
/** Splits `<resourceId>:<contract>` at the first colon. */
export function resourceIdOfClaim(claim) {
    const colon = claim.indexOf(':');
    return colon === -1 ? claim : claim.slice(0, colon);
}
/** Bounded wait while the supervisor's session open lands (see below). */
const DEFAULT_SESSION_RESOLVE_TIMEOUT_MS = 5000;
/** Poll cadence for the session resolve (supervisor→witness RPC latency). */
const SESSION_RESOLVE_POLL_MS = 50;
/**
 * Resolves the supervisor-issued session credential for this test: the
 * fixture proves it runs on (workerIndex, testId) and the witness
 * answers only while THAT session is open. `onTestBegin` (supervisor)
 * and the test body (worker) race, so a bounded poll absorbs the
 * dispatch latency; a missing session at the deadline fails closed —
 * there is no fixture path that mints a credential itself.
 */
async function resolveSessionCredential(witness, testInfo, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const resolved = await witness.resolveSession({
            testId: testInfo.testId,
            workerIndex: testInfo.workerIndex,
        });
        if (resolved !== null) {
            if (resolved.testId !== testInfo.testId) {
                throw new Error(`session resolve returned testId '${resolved.testId}' for test '${testInfo.title}' ` +
                    `(expected '${testInfo.testId}') — refusing a mismatched session binding`);
            }
            return resolved;
        }
        if (Date.now() > deadline) {
            throw new Error(`no open witness session for test '${testInfo.title}' (workerIndex ` +
                `${String(testInfo.workerIndex)}, testId '${testInfo.testId}'): the trusted supervisor ` +
                '(the gateforge Playwright reporter) opens one session per started test and evidence ' +
                'primitives submit only under it — records without a valid open session are rejected ' +
                'by the witness (fail closed)');
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, SESSION_RESOLVE_POLL_MS));
    }
}
/**
 * Creates the evidence API for one test.
 *
 * Args:
 *   page: IGNORED for evidence (kept for call-shape compatibility) —
 *     the engine drives its own page; the worker page is never an
 *     evidence channel.
 *   testInfo: the running test's info (annotations, testId, workerIndex).
 *   surface: REQUIRED consumer-declared {@link SurfaceDescriptor} — the
 *     pack carries no application-specific selectors (plan Phase 1
 *     item 7). Registered with the witness; the ENGINE drives it
 *     against the provisioned attested subject (fake-frontend fix:
 *     the driven origin comes from trusted witness configuration,
 *     never from suite input — there is no app-base parameter here
 *     by design).
 *   client: witness transport override (tests inject their own).
 *   session: pre-resolved session credential (harnesses that opened the
 *     session themselves); default resolves it from the supervisor
 *     channel. A credential whose testId differs from this test's is
 *     refused.
 *   sessionResolveTimeoutMs: bounded wait for the supervisor's session
 *     open (harness tuning; default 5s).
 *
 * Returns:
 *   Promise<EvidenceApi>: the frozen primitive surface.
 *
 * Throws:
 *   Error: on a missing/outdated surface descriptor (migration error
 *     naming the new required `surface` parameter), when the test
 *     declares no gateforge claim and its session carries no
 *     supervisor-registered (mapped) claims, when no app base or witness
 *     or OPEN session is wired, or when an action/verification fails
 *     fail-closed.
 */
export async function createEvidence({ page, testInfo, surface, client, session, sessionResolveTimeoutMs = DEFAULT_SESSION_RESOLVE_TIMEOUT_MS, }) {
    void page; // the engine drives its own page; the worker page is never evidence
    // Versioned compatibility (plan Phase 1 item 7): the old no-surface
    // shape carried Accounts selectors INSIDE the pack — that behavior was
    // moved to the consumer. Never silently keep it.
    if (surface === undefined || surface === null) {
        throw new Error("createEvidence now requires a consumer-declared 'surface' descriptor " +
            `(SurfaceDescriptor, schemaVersion ${String(SURFACE_DESCRIPTOR_VERSION)}): pass the ` +
            'declarative surface (list page, row/field selectors, form templates, archive control, ' +
            'status values) with the evidence call or via `test.extend({ surface })`. The previous ' +
            'Accounts-specific fixture was removed from the pack (plan Phase 1 item 7) — see ' +
            'example/e2e/accounts-surface.js for a complete consumer declaration');
    }
    // Worker-side structural validation (fail fast with the exact missing
    // piece); the ENGINE re-validates authoritatively at registration —
    // worker approval never substitutes for it.
    const descriptor = validateSurface(surface);
    const testId = testInfo.testId;
    // The witness transport is built LAZILY: supplying a pre-resolved
    // session credential (harnesses) must not require witness env wiring
    // until a primitive actually talks to the witness.
    let witnessInstance = null;
    function witness() {
        witnessInstance ??= client ?? new WitnessClient();
        return witnessInstance;
    }
    // The supervisor-issued session credential (Phase 1). Every engine
    // call carries it; the witness forces the record's testId onto the
    // session's supervisor-registered value.
    const credential = session ??
        (await resolveSessionCredential(witness(), {
            testId,
            workerIndex: testInfo.workerIndex,
            title: testInfo.title,
        }, sessionResolveTimeoutMs));
    if (credential.testId !== testId) {
        throw new Error(`the supplied session binds testId '${credential.testId}' but this test is '${testId}' — ` +
            'records can only be minted for the supervisor-registered test of the open session');
    }
    // Effective claims: native annotations first, plus the
    // supervisor-registered claims this session was opened with (Phase 4
    // claim injection). The injection covers helper-based journeys with NO
    // annotation whose obligation claims come from the tracked
    // `.gateforge/test-map.yml` sidecar (plan E02): the orchestrating CLI
    // resolves the sidecar against the catalog and the supervisor carries
    // the mapped claims on the session-open path. Claims remain
    // DECLARATIONS — they route evidence onto obligation identities; the
    // witness still forces every record onto the supervisor-registered
    // session/test identity and the gate grades witnessed evidence only.
    const claims = [
        ...new Set([...claimsFromAnnotations(testInfo.annotations), ...(credential.claims ?? [])]),
    ].sort();
    if (claims.length === 0) {
        throw new Error(`test '${testInfo.title}' uses gateforge evidence primitives but declares no ` +
            `'${CLAIM_ANNOTATION_TYPE}' annotation and its session carries no supervisor-registered ` +
            '(mapped) claims — annotate the test or map it in .gateforge/test-map.yml');
    }
    const sessionChannel = {
        sessionId: credential.sessionId,
        sessionToken: credential.sessionToken,
    };
    // Register the consumer surface with the witness lazily on the first
    // UI call (construction performs no I/O): the engine validates it and
    // drives every later action against the provisioned attested subject.
    // No origin crosses here — the driven target comes from trusted
    // witness configuration only. Registration proves nothing by itself.
    const receiptBrand = makeReceiptBrand();
    let surfaceRegistered = false;
    async function ensureSurfaceRegistered() {
        if (surfaceRegistered)
            return;
        await witness().registerBrowserSurface({
            ...sessionChannel,
            testId,
            surface: descriptor,
        });
        surfaceRegistered = true;
    }
    /**
     * Asks the ENGINE to perform one constrained surface operation and
     * wraps its observation in a branded receipt. The engine verified the
     * rendered control, the application request, and the visible outcome
     * itself — the receipt carries the engine-observed entity id and the
     * ENTERED input (exact-value echo source), never suite assertions.
     */
    async function engineAction(operation, resourceId, input) {
        await ensureSurfaceRegistered();
        const response = await witness().browserAction({
            ...sessionChannel,
            testId,
            claimIds: [...claims],
            operation,
            ...(input.fields !== undefined ? { fields: input.fields } : {}),
            ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
        });
        const receipt = {
            operation,
            resourceId,
            entityId: response.entityId,
            fields: response.enteredFields,
            mode: operation === 'read' ? 'form' : 'row',
            ...(response.preObservationId !== null ? { preObservationId: response.preObservationId } : {}),
        };
        return { receipt, preObservationId: response.preObservationId };
    }
    // ---------- UI primitives (engine-driven) ----------
    const ui = {
        async create(input) {
            const fields = declaredSurfaceFields('ui.create', input.fields, descriptor.create.fields);
            const resourceId = resourceIdOfClaim(claims[0]);
            const { receipt } = await engineAction('create', resourceId, { fields });
            return receiptBrand.stamp(receipt);
        },
        async read(input) {
            const { entityId } = input;
            if (!entityId)
                throw new Error('ui.read requires { entityId }');
            const resourceId = resourceIdOfClaim(claims[0]);
            const { receipt } = await engineAction('read', resourceId, { entityId });
            return receiptBrand.stamp(receipt);
        },
        async update(input) {
            const { entityId } = input;
            const fields = declaredSurfaceFields('ui.update', input.fields, descriptor.edit.fields);
            const resourceId = resourceIdOfClaim(claims[0]);
            const { receipt } = await engineAction('update', resourceId, { fields, entityId });
            return receiptBrand.stamp(receipt);
        },
        async archive(input) {
            const { entityId } = input;
            if (!entityId)
                throw new Error('ui.archive requires { entityId }');
            const resourceId = resourceIdOfClaim(claims[0]);
            const { receipt } = await engineAction('delete', resourceId, { entityId });
            return receiptBrand.stamp({ ...receipt, operation: 'delete' });
        },
    };
    // ---------- visible-result primitive (engine re-read) ----------
    const visible = {
        async confirm(receipt) {
            if (!receiptBrand.isGenuine(receipt)) {
                throw new Error('visible.confirm requires a receipt issued by an evidence.ui primitive ' +
                    '(hand-rolled objects are rejected — GF-22)');
            }
            const response = await witness().browserVisible({
                ...sessionChannel,
                testId,
                claimIds: [...claims],
                entityId: receipt.entityId,
                operation: receipt.operation,
            });
            return { entityId: response.entityId, fields: response.fields };
        },
    };
    // ---------- persistence primitive (plan §5.3 steps 3-4) ----------
    const persistence = {
        async verify(receipt) {
            if (!receiptBrand.isGenuine(receipt)) {
                throw new Error('persistence.verify requires a receipt issued by an evidence.ui primitive ' +
                    '(hand-rolled objects are rejected — GF-22)');
            }
            const response = await witness().verifyPersistence({
                resourceId: receipt.resourceId,
                entityId: receipt.entityId,
                testId,
                claimId: claims[0],
                ...sessionChannel,
                ...(receipt.preObservationId !== undefined
                    ? { preObservationId: receipt.preObservationId }
                    : {}),
            });
            return {
                recordId: response.recordId,
                runId: response.runId,
                verdictRelevant: response.verdictRelevant,
            };
        },
    };
    // ---------- http observation (ADR 0004 D7, plan §8 / D1) ----------
    // Consumes one ENGINE-CAPTURED exchange the engine's own action caused
    // and binds the witnessed `http.request` record to the declared http:*
    // obligation claims. Only an exchange the engine captured inside its
    // own action interval can be consumed — without a real engine action
    // the witness answers 409 — the suite cannot mint network evidence,
    // borrow another test's request, or credit setup traffic.
    async function observeHttp(request) {
        // Explicit claim selection (plan §8 step 7): an explicit target
        // outside the test's declared claims is caller error, never a
        // silent binding to the wrong obligation.
        if (request.obligationId !== undefined) {
            if (!claims.includes(request.obligationId)) {
                throw new Error(`http.observe targets '${request.obligationId}' which this test did not declare ` +
                    `(declared: ${claims.join(', ') || '<none>'})`);
            }
            const targets = [request.obligationId];
            const result = await witness().observeHttp({
                claimIds: [...targets],
                testId,
                method: request.method.toUpperCase(),
                path: request.path,
                ...sessionChannel,
                ...(request.expectedStatus !== undefined ? { expectedStatus: request.expectedStatus } : {}),
            });
            return {
                status: result.status,
                recordId: result.records[0]?.recordId ?? '',
                recordIds: result.records.map((record) => record.recordId),
            };
        }
        const httpClaims = claims.filter((claim) => claim.includes(':http:'));
        const candidates = httpClaims.length > 0 ? httpClaims : claims;
        // Ambiguous omitted selection must fail with a useful error — never
        // silently assign evidence to the first claim.
        if (candidates.length > 1) {
            throw new Error(`http.observe is ambiguous: the test declares ${candidates.length} claims ` +
                `(${candidates.join(', ')}); pass an explicit obligationId`);
        }
        const targets = candidates;
        const result = await witness().observeHttp({
            claimIds: [...targets],
            testId,
            method: request.method.toUpperCase(),
            path: request.path,
            ...sessionChannel,
            ...(request.expectedStatus !== undefined ? { expectedStatus: request.expectedStatus } : {}),
        });
        return {
            status: result.status,
            recordId: result.records[0]?.recordId ?? '',
            recordIds: result.records.map((record) => record.recordId),
        };
    }
    // ---------- finalize (fail-fast + ledger cross-check) ----------
    async function finalize() {
        const ledger = await witness().listRecords();
        const mine = ledger.records.filter((record) => record['testId'] === testId);
        for (const claim of claims) {
            const count = mine.filter((record) => record['obligationId'] === claim).length;
            if (count === 0) {
                throw new Error(`claim '${claim}' produced no witness records (finalize fail-fast; the gate would grade it missing)`);
            }
        }
        const records = mine.map((record) => {
            const entry = record;
            return {
                recordId: String(entry['recordId'] ?? ''),
                runId: String(entry['runId'] ?? ''),
                obligationId: String(entry['obligationId'] ?? ''),
                kind: String(entry['kind'] ?? ''),
                payload: entry['payload'],
            };
        });
        return { claims: [...claims], records };
    }
    // Freeze the surface: no method can be added/replaced from the test;
    // the transcript stays closure-private (no escape hatch, invariant 6).
    return Object.freeze({
        ui: Object.freeze(ui),
        visible: Object.freeze(visible),
        persistence: Object.freeze(persistence),
        http: Object.freeze({ observe: observeHttp }),
        finalize,
    });
}
//# sourceMappingURL=evidence.js.map