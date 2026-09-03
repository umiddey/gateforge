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
function recordIdsOf(evidence, predicate) {
    return [...new Set(evidence.filter(predicate).map((entry) => String(entry.record.recordId)))].sort();
}
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
    // obligation. Absent resource (test harnesses) keeps the historical
    // any-endpoint behavior; the real CLI always supplies it.
    if (input.resource !== null && input.resource !== undefined && input.resource.kind === 'http.endpoint') {
        const expectedMethod = String(input.resource.attributes['method']).toUpperCase();
        const expectedPath = String(input.resource.attributes['canonicalPath']);
        const observedMethod = payload['method'].toUpperCase();
        const observedPath = normalizeObservedPath(payload['url']);
        if (observedMethod !== expectedMethod || observedPath !== expectedPath) {
            return {
                status: 'invalid',
                reason: `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
                    `'${String(proven.record.recordId)}' observed ${observedMethod} ${payload['url']} but the ` +
                    `obligation's endpoint is ${expectedMethod} ${expectedPath}; evidence from a different ` +
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
const NAMESPACE_SPECS = [
    {
        namespace: 'auth',
        kind: 'auth.check',
        scenarios: {
            'role-allowed': {},
            'role-denied': { requiresObservedFalse: true },
            'tenant-isolated': { requiresObservedFalse: true },
            'denied-no-side-effect': { requiresObservedFalse: true },
            'forged-token-rejected': { requiresObservedFalse: true },
        },
    },
    {
        namespace: 'workflow',
        kind: 'workflow.check',
        scenarios: {
            'transition-allowed': {},
            'transition-rejected': { requiresObservedFalse: true },
            'terminal-immutable': { requiresObservedFalse: true },
            'audit-emitted': {},
            'persisted-final-state': {},
        },
    },
    {
        namespace: 'webhook',
        kind: 'webhook.check',
        scenarios: {
            'signature-accepted': {},
            'signature-rejected': { requiresObservedFalse: true },
            'malformed-rejected': { requiresObservedFalse: true },
            'replay-idempotent': {},
            'retry-bounded': {},
        },
    },
    {
        namespace: 'task',
        kind: 'task.check',
        scenarios: {
            'retry-policy-enforced': {},
            idempotent: {},
            'terminal-handled': {},
            'observability-recorded': {},
            'duplicate-delivery-handled': {},
        },
    },
    {
        namespace: 'validation',
        kind: 'validation.check',
        scenarios: {
            'boundary-accepted': {},
            'boundary-rejected': { requiresObservedFalse: true },
            'no-side-effect-on-reject': { requiresObservedFalse: true },
            'error-message-explicit': {},
            'envelope-shape-stable': {},
        },
    },
];
/** Builds one namespace's verifier from its spec (table-driven). */
function packVerifier(spec) {
    return (input) => {
        const verb = input.obligation.contract.slice(spec.namespace.length + 1);
        const scenarioSpec = spec.scenarios[verb];
        if (scenarioSpec === undefined) {
            return unknownContract(input);
        }
        const anchorFailure = uiAnchorFailure(input);
        if (anchorFailure !== null)
            return anchorFailure;
        const checks = input.evidence.filter((entry) => entry.record.kind === spec.kind);
        if (checks.length === 0) {
            return {
                status: 'missing',
                reason: `'${input.obligation.id}': no '${spec.kind}' record for scenario '${verb}'; ` +
                    'the pack-specific check must be observed by the witness',
                recordIds: [],
            };
        }
        const untrusted = checks.find((entry) => entry.record.origin !== 'engine-observed');
        if (untrusted !== undefined) {
            return {
                status: 'missing',
                reason: `'${input.obligation.id}': '${spec.kind}' records exist only as suite-submitted ` +
                    '(claimed) observations; independent witnessed evidence is still owed',
            };
        }
        const proven = checks.find((entry) => entry.trust === 'witnessed' && isProvenancedRecord(entry.record));
        if (proven === undefined) {
            return {
                status: 'missing',
                reason: `'${input.obligation.id}': observed '${spec.kind}' records exist but none carries ` +
                    'witnessed provenance bound to this run',
            };
        }
        const payload = payloadOf(proven.record);
        if (payload === null || payload['scenario'] !== verb) {
            const got = payload === null ? '<no payload>' : String(payload['scenario']);
            return {
                status: 'invalid',
                reason: `'${input.obligation.id}': witnessed '${spec.kind}' record ` +
                    `'${String(proven.record.recordId)}' asserts scenario '${got}' but ` +
                    `'${input.obligation.contract}' requires '${verb}'`,
            };
        }
        if (scenarioSpec.requiresObservedFalse) {
            if (payload['allowed'] !== false && payload['observed'] !== false) {
                return {
                    status: 'invalid',
                    reason: `'${input.obligation.id}': witnessed record ` +
                        `'${String(proven.record.recordId)}' does not assert the negative outcome ` +
                        `required by '${input.obligation.contract}'`,
                };
            }
        }
        return {
            status: 'satisfied',
            recordIds: [String(proven.record.recordId)],
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
    for (const spec of NAMESPACE_SPECS) {
        registerContractVerifier(spec.namespace, packVerifier(spec));
    }
}
//# sourceMappingURL=pack-verifiers.js.map