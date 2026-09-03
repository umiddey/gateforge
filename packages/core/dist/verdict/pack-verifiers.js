/**
 * Built-in semantic verifiers for the pack contract namespaces (ADR 0004
 * D8, plan phase 5). Registered once at module init; the registry rejects
 * re-registration, so no pack can override another namespace.
 *
 * Trust model (invariant, ADR 0001): ONLY witnessed records satisfy.
 * Suite-submitted records are claimed-tier at issuance. Fabricated
 * provenance is rejected before verifiers run (the engine re-computes
 * record hashes).
 *
 * HTTP namespace: `http:frontend-request-observed` requires an
 * engine-observed `http.request` record bound to the run (the
 * witness-owned observation channel, phase 6) PLUS a provenanced
 * claimed `ui.action` anchor from the declaring test; a suite-submitted
 * network record can never satisfy (`HTTP_OBSERVATION_UNTRUSTED`).
 * `http:response-status-ok` additionally requires a 2xx status. Proxy
 * observation plus the endpoint shape binding genuinely prove that the
 * frontend request was observed and the response status was ok — that is
 * exactly as far as transport evidence reaches, and the verifier claims
 * nothing beyond it.
 *
 * Domain namespaces (`auth:*`, `task:*`, `validation:*`, `webhook:*`,
 * `workflow:*`): FAIL-CLOSED, unconditionally, for EVERY contract of the
 * namespace. Proving these behaviors requires an engine-owned observer
 * over application state — audit logs, FSM/state observation,
 * identity/role material (plan §6) — and no such producer exists yet.
 * Grading them from a witnessed check record whose witness-derived
 * outcome is merely the observed HTTP status class (2xx → accepted, 4xx
 * → rejected) is forged green: any 2xx would "prove" `audit-emitted` or
 * `persisted-final-state`, any 4xx would "prove" `tenant-isolated` or
 * `denied-no-side-effect`, and a response hash proves nothing about
 * `error-message-explicit`. Every contract of these namespaces therefore
 * grades `missing` with a reason naming the missing channel — never
 * `satisfied`, never `invalid`, whatever evidence arrives.
 */
import { isProvenancedRecord } from '../provenance.js';
/**
 * Stable typed code for untrusted runtime observations. Mirrors
 * `HTTP_OBSERVATION_UNTRUSTED` in `@gateforge/http-contract` (core
 * cannot depend on it); keep the two in lockstep.
 */
const HTTP_OBSERVATION_UNTRUSTED = 'HTTP_OBSERVATION_UNTRUSTED';
import { registerContractVerifier, } from './registry.js';
/** Record kinds the witness and suites exchange. */
const UI_ACTION_KIND = 'ui.action';
const HTTP_REQUEST_KIND = 'http.request';
function payloadOf(record) {
    const payload = record.payload;
    return payload !== null && typeof payload === 'object' ? payload : null;
}
/**
 * The provenanced claimed `ui.action` anchor: proves the declaring test
 * actually drove the UI (suite-asserted, hash-verified issuance). Any
 * tier anchors — satisfaction weight lives in the witnessed records.
 */
function uiAnchorFailure(input) {
    const actions = input.evidence.filter((entry) => entry.record.kind === UI_ACTION_KIND);
    const anchor = actions.find((entry) => isProvenancedRecord(entry.record));
    if (anchor === undefined) {
        const detail = actions.length === 0
            ? `no '${UI_ACTION_KIND}' anchor from the declaring test`
            : `'${UI_ACTION_KIND}' records exist but none verifies its provenance`;
        return {
            status: 'missing',
            reason: `'${input.obligation.id}': ${detail}`,
        };
    }
    return null;
}
/**
 * Canonicalizes an observed request path the same way the witness does
 * (query/hash stripped, one leading slash, trailing slashes dropped,
 * root '/' stays '/'); duplicate slashes collapse so a path can never
 * masquerade across segment boundaries. Local on purpose: core must not
 * depend on `@gateforge/http-contract`.
 */
function normalizeObservedPath(rawUrl) {
    let path = rawUrl.split('?')[0]?.split('#')[0] ?? '/';
    if (!path.startsWith('/'))
        path = `/${path}`;
    path = path.replace(/\/{2,}/g, '/');
    if (path.length > 1)
        path = path.replace(/\/+$/, '');
    return path;
}
/**
 * Positional match of a concrete observed path against a compiled
 * canonical shape (ADR 0004 D2/D3 semantics): literal segments must be
 * equal, `{}` matches any single non-empty segment, and a TRAILING `{*}`
 * matches one or more trailing segments. Non-trailing wildcards and any
 * other shape never match. Case-sensitive.
 *
 * Args:
 *   observedPath: the concrete observed path (query already stripped).
 *   canonicalPath: the endpoint's compiled canonical shape.
 *
 * Returns:
 *   boolean: true only when the observed path instantiates the shape.
 */
export function pathMatchesShape(observedPath, canonicalPath) {
    const observed = observedPath.split('/').filter((segment) => segment.length > 0);
    const shape = canonicalPath.split('/').filter((segment) => segment.length > 0);
    const wildcardIndex = shape.indexOf('{*}');
    // Fail closed: only a TRAILING `{*}` is a wildcard — a shape that
    // carries one anywhere else (or more than once) never matches.
    if (wildcardIndex !== -1 && wildcardIndex !== shape.length - 1)
        return false;
    if (wildcardIndex !== -1) {
        // The wildcard consumes one or more trailing segments, so the
        // observed path needs at least the shape's leading literals.
        if (observed.length < shape.length)
            return false;
    }
    else if (observed.length !== shape.length) {
        return false;
    }
    const literalPositions = wildcardIndex === -1 ? shape.length : wildcardIndex;
    for (let i = 0; i < literalPositions; i++) {
        const pattern = shape[i];
        // `{}` matches any single (non-empty — empties were dropped)
        // segment; anything else must be literally equal. Case-sensitive.
        if (pattern !== '{}' && pattern !== observed[i])
            return false;
    }
    return true;
}
/** Grades the HTTP runtime-observation contracts (phase 5/6 semantics). */
function httpVerifier(input) {
    const anchorFailure = uiAnchorFailure(input);
    if (anchorFailure !== null)
        return anchorFailure;
    const requests = input.evidence.filter((entry) => entry.record.kind === HTTP_REQUEST_KIND);
    if (requests.length === 0) {
        return {
            status: 'missing',
            reason: `'${input.obligation.id}': no '${HTTP_REQUEST_KIND}' record; the browser request ` +
                'must be observed by the witness-owned channel',
            recordIds: [],
        };
    }
    const untrusted = requests.find((entry) => entry.record.origin !== 'engine-observed');
    if (untrusted !== undefined) {
        return {
            status: 'invalid',
            reason: `'${input.obligation.id}': suite-submitted network record ` +
                `'${String(untrusted.record.recordId)}' cannot satisfy an HTTP runtime contract ` +
                `(${HTTP_OBSERVATION_UNTRUSTED}); only the witness-owned observation channel proves ` +
                'that the browser issued the request',
        };
    }
    const proven = requests.find((entry) => entry.trust === 'witnessed' && isProvenancedRecord(entry.record));
    if (proven === undefined) {
        return {
            status: 'missing',
            reason: `'${input.obligation.id}': observed requests exist but none carries witnessed ` +
                'provenance bound to this run',
        };
    }
    const payload = payloadOf(proven.record);
    if (payload === null || typeof payload['method'] !== 'string' || typeof payload['url'] !== 'string') {
        return {
            status: 'invalid',
            reason: `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
                `'${String(proven.record.recordId)}' carries no method/url pair`,
        };
    }
    // Identity match (fail-closed): when the host supplies the obligation's
    // graph resource, the witnessed observation must come from THAT
    // endpoint — a `/health` observation can never satisfy a `/contracts`
    // obligation. The comparison is positional against the endpoint's
    // canonical SHAPE (ADR 0004 D2/D3): `/accounts/123` satisfies
    // `/accounts/{}`; evidence from a different endpoint shape never does.
    // Absent resource (test harnesses) keeps the historical any-endpoint
    // behavior; the real CLI always supplies it.
    if (input.resource !== null && input.resource !== undefined && input.resource.kind === 'http.endpoint') {
        const expectedMethod = String(input.resource.attributes['method']).toUpperCase();
        const expectedPath = String(input.resource.attributes['canonicalPath']);
        const observedMethod = payload['method'].toUpperCase();
        const observedPath = normalizeObservedPath(payload['url']);
        if (observedMethod !== expectedMethod || !pathMatchesShape(observedPath, expectedPath)) {
            return {
                status: 'invalid',
                reason: `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
                    `'${String(proven.record.recordId)}' observed ${observedMethod} ${payload['url']} does not ` +
                    `match endpoint shape ${expectedMethod} ${expectedPath}; evidence from a different ` +
                    'endpoint can never satisfy it',
            };
        }
    }
    if (input.obligation.contract === 'http:response-status-ok') {
        const status = payload['status'];
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 299) {
            return {
                status: 'invalid',
                reason: `'${input.obligation.id}': observed status ` +
                    `'${String(status)}' is not a 2xx response`,
            };
        }
    }
    return {
        status: 'satisfied',
        recordIds: [String(proven.record.recordId)],
    };
}
/**
 * The honest evidence channel each domain namespace would need. Wording
 * is per-namespace on purpose: the fail-closed reason must name WHAT is
 * missing, not a generic unsupported hole.
 */
const DOMAIN_NAMESPACES = [
    {
        namespace: 'auth',
        channel: 'identity/role material and tenant-scoped application state',
    },
    {
        namespace: 'task',
        channel: 'queue/job delivery state',
    },
    {
        namespace: 'validation',
        channel: 'boundary semantics over application state and the response envelope',
    },
    {
        namespace: 'webhook',
        channel: 'signature/replay verification over application-received deliveries',
    },
    {
        namespace: 'workflow',
        channel: 'the workflow state machine and its audit log',
    },
];
/**
 * Builds the honest fail-closed reason for one domain contract: it names
 * the contract, the behavior to prove, the missing engine-owned channel,
 * and why transport evidence can never substitute for it.
 */
function failClosedReason(namespace, channel, input) {
    const verb = input.obligation.contract.slice(namespace.length + 1);
    const behavior = verb.length > 0 ? verb : input.obligation.contract;
    return (`contract '${input.obligation.contract}' has no honest evidence channel: proving '${behavior}' ` +
        `requires an engine-owned observer over application state (${channel} per plan §6), and no such ` +
        'producer exists yet; transport exchanges (status codes, response bytes) cannot prove these ' +
        `semantics, so '${input.obligation.id}' stays blocking. Do not add this contract to policies ` +
        'until its pack ships a state-observing producer.');
}
/**
 * The domain namespaces' verifier: fail-closed for EVERY contract of the
 * namespace, whatever evidence arrives — old-shape check records,
 * claimed or witnessed, perfectly formed. It never returns `satisfied`
 * and never `invalid`: no existing record can honestly evidence these
 * semantics, and hostile evidence deserves no sharper verdict than the
 * honest-channel reason.
 */
function failClosedVerifier(namespace, channel) {
    return (input) => {
        // A contract string that does not parse into this namespace is
        // genuinely unknown, not merely unproducible.
        if (!input.obligation.contract.startsWith(`${namespace}:`)) {
            return unknownContract(input);
        }
        return {
            status: 'missing',
            reason: failClosedReason(namespace, channel, input),
            recordIds: [],
        };
    };
}
/** A contract the namespace's spec does not know: fail closed. */
function unknownContract(input) {
    return {
        status: 'missing',
        reason: `no semantic verifier is registered for contract '${input.obligation.contract}'; ` +
            `'${input.obligation.id}' stays blocking`,
        recordIds: [],
    };
}
/** True once registrations have run (idempotent across imports). */
let registered = false;
/** Registers every pack namespace + the http namespace. Idempotent. */
export function registerPackVerifiers() {
    if (registered)
        return;
    registered = true;
    registerContractVerifier('http', httpVerifier);
    for (const { namespace, channel } of DOMAIN_NAMESPACES) {
        registerContractVerifier(namespace, failClosedVerifier(namespace, channel));
    }
}
//# sourceMappingURL=pack-verifiers.js.map