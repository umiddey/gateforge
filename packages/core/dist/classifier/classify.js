/**
 * The deterministic classification engine (ADR 0003 D2): pure function
 * from (resources, signals, policy, adapters, scan findings) to one
 * decision or typed blocks per resource — no clock, no network, no
 * filesystem, no framework syntax. Uncertainty resolves toward MORE
 * obligations: unknown exposure defaults `user-facing`, unknown
 * lifecycle operations default enabled, `internal` requires a complete
 * closed-world certificate, and delete semantics are never guessed.
 *
 * Determinism contract: identical inputs produce byte-identical output.
 * Every array in the result is totally ordered; all rule applications
 * are sorted-set operations; no weighted confidence exists anywhere.
 *
 * Monotonicity invariant (property-tested): adding a positive
 * exposure/lifecycle signal never removes an obligation — it can only
 * add obligations or turn a certificate into a contradiction (which
 * itself blocks while the conservative decision stands).
 */
import { sha256Canonical } from '../canonical-json.js';
import { compareLocations, compareStrings } from '../graph/util.js';
import { ClassificationSchema } from '../schemas/classification.js';
import { signalId } from '../schemas/classification-signal.js';
import { BLOCK_DIMENSIONS, } from './schema.js';
import { globMatch } from './glob.js';
import { HTTP_ENDPOINT_RESOURCE_KIND } from '../graph/schema.js';
/** Stable rule ids rendered in decision traces (ADR 0003 D2). */
export const RULES = {
    exposurePositive: 'EXPOSURE_POSITIVE_SIGNAL',
    exposureInternalCertificate: 'EXPOSURE_INTERNAL_CERTIFICATE',
    exposureDefault: 'EXPOSURE_DEFAULT_USER_FACING',
    exposureOperationalProbe: 'EXPOSURE_OPERATIONAL_PROBE',
    lifecyclePositive: 'LIFECYCLE_POSITIVE_SIGNAL',
    lifecycleDeclaredSupported: 'LIFECYCLE_DECLARED_SUPPORTED',
    lifecycleClosedWorldDisabled: 'LIFECYCLE_CLOSED_WORLD_DISABLED',
    lifecycleDefault: 'LIFECYCLE_DEFAULT_ENABLED',
    deleteProvenHard: 'DELETE_SEMANTICS_PROVEN_HARD',
    deleteProvenArchive: 'DELETE_SEMANTICS_PROVEN_ARCHIVE',
    planeEvidence: 'PLANE_DETECTOR_EVIDENCE',
    lifecycleEndpointHttp: 'LIFECYCLE_ENDPOINT_HTTP',
    identityEvidence: 'IDENTITY_DETECTOR_EVIDENCE',
    adapterNameMatch: 'ADAPTER_NAME_MATCH',
    orgInternalRule: 'ORGANIZATION_INTERNAL_RULE',
};
/** The four lifecycle-gated operations, in canonical order. */
const OPERATIONS = ['create', 'read', 'update', 'delete'];
/** Location sorter (codepoint, then line, then col). */
/** Locations sorted deterministically and DEDUPLICATED: a location is a
 * set member — a detector emitting the same signal twice must not change
 * any detail text (and therefore no decision fingerprint). */
function sortLocations(locations) {
    const seen = new Set();
    const unique = [];
    for (const location of locations) {
        const key = `${location.file}\u0000${location.line}\u0000${location.col}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(location);
    }
    return unique.sort(compareLocations);
}
/** Blocks sorted by code, then resourceId/name, then detail. */
function sortBlocks(blocks) {
    return [...blocks].sort((a, b) => compareStrings(a.code, b.code) ||
        compareStrings(a.resourceId ?? '', b.resourceId ?? '') ||
        compareStrings(a.name ?? '', b.name ?? '') ||
        compareStrings(a.detail, b.detail));
}
/** Contradictions sorted by dimension, then detail. */
function sortContradictions(entries) {
    return [...entries].sort((a, b) => compareStrings(a.dimension, b.dimension) || compareStrings(a.detail, b.detail));
}
function locationText(location) {
    return `${location.file}:${String(location.line)}`;
}
/**
 * Whether a signal addresses the resource: exact plane-qualified id,
 * bare name, or symbol (matched against the resource's `classQname` or
 * `symbol` attribute).
 */
function signalMatchesResource(signal, resource) {
    const target = signal.target;
    if (target.resourceId !== undefined && resource.id !== null && target.resourceId === resource.id) {
        return true;
    }
    if (target.resourceName !== undefined && target.resourceName === resource.name)
        return true;
    if (target.symbol !== undefined) {
        const classQname = resource.attributes['classQname'];
        if (typeof classQname === 'string' && classQname === target.symbol)
            return true;
        const symbol = resource.attributes['symbol'];
        if (typeof symbol === 'string' && symbol === target.symbol)
            return true;
    }
    return false;
}
/** Narrows a signal assertion to a boolean, when it is one. */
function assertionBoolean(assertion) {
    return typeof assertion === 'boolean' ? assertion : null;
}
/** Narrows a signal assertion to a non-empty string, when it is one. */
function assertionString(assertion) {
    return typeof assertion === 'string' ? assertion : null;
}
/** Narrows a signal assertion to an ordered string list, when it is one. */
function assertionStringList(assertion) {
    return Array.isArray(assertion) ? assertion : null;
}
/** Narrows a signal assertion to a record, when it is one. */
function assertionRecord(assertion) {
    if (Array.isArray(assertion) || typeof assertion !== 'object')
        return null;
    return assertion;
}
/** Reads the `{category}` payload of an internality reachability signal. */
function internalityCategory(signal) {
    const record = assertionRecord(signal.assertion);
    if (record !== null) {
        const category = record['category'];
        return typeof category === 'string' && category.length > 0 ? category : null;
    }
    return assertionString(signal.assertion);
}
/** Whether the signal positively asserts external reachability. */
function isPositiveExposure(signal) {
    return signal.basis === 'code-positive' && signal.assertion !== false;
}
/**
 * The precise operational-endpoint class (plan §6 "Health/operations",
 * ADR 0004 D5): an `http.endpoint` whose compiled capabilities are
 * EXACTLY `health-operations` and that has NO linked business resource —
 * the same class the operational plane rule resolves to `global`
 * (`resolveEndpointPlanes`). The capability set comes from the
 * deterministic compiler rule `HEALTH_PATH_NO_SCHEMA` (GET/HEAD, no
 * request schema, no business link, and a root-hung infrastructure-probe
 * path shape — segment-exact probe words at depth <= 2 or the bare root).
 * Positive detector facts, never absence-as-internal. Any additional
 * capability (a health-path route whose response model also corroborated
 * crud-read, a command suffix, …) or any business link keeps the endpoint
 * in the full user-facing lattice: fail closed.
 */
function isOperationalEndpoint(resource) {
    if (resource.kind !== HTTP_ENDPOINT_RESOURCE_KIND)
        return false;
    const linked = resource.attributes['linkedResourceName'];
    if (typeof linked === 'string' && linked.length > 0)
        return false;
    const capabilities = resource.attributes['capabilities'];
    return (Array.isArray(capabilities) &&
        capabilities.length === 1 &&
        capabilities[0] === 'health-operations');
}
/**
 * Whether the complete-scan attestation holds (ADR 0003 D4): the policy
 * declares scan roots, and no finding or unresolved entry falls inside
 * the attested scope. One shared judgment per run — the scope is the
 * union of the configured roots, so a hole anywhere in the attested
 * range invalidates every closed-world proof in this run.
 */
function completeScanHolds(policy, scan) {
    if (policy.scanRoots.length === 0 ||
        (scan.configuredDetectors !== undefined &&
            scan.successfulDetectors !== undefined &&
            scan.successfulDetectors !== scan.configuredDetectors)) {
        return false;
    }
    const requested = scan.requestedPaths ?? [];
    if (requested.length === 0) {
        return false;
    }
    // Coverage rules (red-team round 3): per-detector, per-file — never a
    // flattened union. Declaring NO rules means no scan is provably
    // complete: closed-world proofs stay unavailable (fail closed).
    const rules = policy.coverage ?? [];
    if (rules.length === 0)
        return false;
    for (const rule of rules) {
        const report = scan.coverage?.find((entry) => entry.detector === rule.detector);
        // The rule's detector must be configured AND must have reported
        // coverage; a missing report is a hole, not an empty pass.
        if (report === undefined)
            return false;
        const seen = new Set(report.scannedPaths);
        for (const path of requested) {
            const applicable = rule.appliesTo.some((pattern) => globMatch(path, pattern));
            if (applicable && !seen.has(path))
                return false;
        }
    }
    // Coverage gaps (red-team round 4): every requested file must be
    // applicable to at least one rule. A file no rule covers is a hole in
    // the proof scope — the policy is incomplete, not the scan complete.
    for (const path of requested) {
        const covered = rules.some((rule) => rule.appliesTo.some((pattern) => globMatch(path, pattern)));
        if (!covered)
            return false;
    }
    for (const finding of scan.findings) {
        for (const location of finding.locations) {
            if (pathInRoots(location.file, policy))
                return false;
        }
    }
    for (const entry of scan.unresolved) {
        if (pathInRoots(entry.location.file, policy))
            return false;
    }
    return true;
}
/**
 * Whether EXPOSURE-negative coverage holds (red-team round 6): every
 * requested file must be covered by an EXHAUSTIVE `exposure.*` capability
 * rule whose detector reported the file. Reading a file with a
 * non-exhaustive (regex) detector proves nothing about the ABSENCE of
 * exposure — so without an explicitly declared exhaustive exposure
 * authority, the internality certificate is unavailable for the scope.
 */
function exposureCoverageHolds(policy, scan) {
    const rules = (policy.coverage ?? []).filter((rule) => rule.capability.startsWith('exposure.') && rule.exhaustive === true);
    if (rules.length === 0)
        return false;
    const requested = scan.requestedPaths ?? [];
    for (const path of requested) {
        const granting = rules.filter((rule) => rule.appliesTo.some((pattern) => globMatch(path, pattern)));
        if (granting.length === 0)
            return false;
        const covered = granting.some((rule) => scan.coverage
            ?.filter((report) => report.detector === rule.detector)
            .some((report) => report.scannedPaths.includes(path)));
        if (!covered)
            return false;
    }
    return true;
}
/** Whether a repo-root-relative path falls inside ANY configured scan root. */
function pathInRoots(path, policy) {
    for (const root of policy.scanRoots) {
        if (globMatch(path, root))
            return true;
    }
    return false;
}
/** Fingerprint input: everything the decision deterministically depends on. */
function decisionFingerprint(input) {
    return sha256Canonical({
        target: input.resourceId ?? input.name,
        kind: input.kind,
        classification: input.classification,
        rules: [...input.rules].sort(compareStrings),
        defaultsApplied: [...input.defaultsApplied].sort(compareStrings),
        signalIds: [...input.signalIds].sort(compareStrings),
        detectors: [...input.detectors].sort(compareStrings),
        contradictions: input.contradictions,
    });
}
/**
 * Validates a DETECTOR-channel reachability signal (internality,
 * code-positive) against the trusted entry-point registry and the scan's
 * coverage knowledge. Returns a single-cause rejection reason, or null
 * when the signal is admissible for certificate use.
 */
function reachabilityRejection(signal, trustedEntries, scan) {
    const category = internalityCategory(signal);
    if (category === null)
        return 'the signal asserts no entry-point category';
    const entry = trustedEntries.find((candidate) => candidate.category === category);
    if (entry === undefined) {
        return `category '${category}' is not a trusted internal entry point`;
    }
    if (entry.detector === undefined) {
        return (`category '${category}' declares no trusted detector; reachability must be ` +
            'asserted by a bundled detector bound in classification-policy');
    }
    if (signal.detector.id !== entry.detector) {
        return (`category '${category}' trusts detector '${entry.detector}' but the signal claims ` +
            `'${signal.detector.id}'`);
    }
    const report = scan.coverage?.find((candidate) => candidate.detector === entry.detector);
    if (report === undefined) {
        return `trusted detector '${entry.detector}' reported no coverage`;
    }
    if (!report.scannedPaths.includes(signal.location.file)) {
        return (`the signal's location '${signal.location.file}' is not in trusted detector ` +
            `'${entry.detector}' reported coverage`);
    }
    if (scan.requestedPaths !== undefined && scan.requestedPaths.length > 0) {
        if (!scan.requestedPaths.includes(signal.location.file)) {
            return `the signal's location '${signal.location.file}' was never requested for scanning`;
        }
    }
    return null;
}
/**
 * Whether a signal's dimension/basis combination is SUPPRESSIVE — it can
 * only ever remove obligations or disable operations. Such signals are
 * authoritative exclusively through the host-owned `authority` channel:
 * on the detector channel they are rejected by CHANNEL, whatever
 * detector identity they claim.
 */
function isSuppressiveShape(signal) {
    if (signal.dimension === 'internality') {
        return signal.basis === 'declaration' || signal.basis === 'organization-policy';
    }
    return ((signal.dimension === 'lifecycle.create' ||
        signal.dimension === 'lifecycle.read' ||
        signal.dimension === 'lifecycle.update' ||
        signal.dimension === 'lifecycle.delete') &&
        signal.basis === 'code-negative-closed-world');
}
/**
 * Whether an AUTHORITY-channel declaration names a configured source
 * (a `declarations` value, or an explicit `gateforge.declaration:<key>`
 * reference to a configured key). The channel carries the authority; the
 * configured source keeps the organization in control of the syntax.
 */
function isConfiguredDeclarationSource(signal, policy) {
    if (Object.values(policy.declarations).includes(signal.source))
        return true;
    if (signal.source.startsWith('gateforge.declaration:')) {
        const key = signal.source.slice('gateforge.declaration:'.length);
        return Object.prototype.hasOwnProperty.call(policy.declarations, key);
    }
    return false;
}
/**
 * Classifies every resource through the deterministic lattice (ADR 0003 D2).
 *
 * Args:
 *   input: resources, detector signals, host-issued authority signals,
 *   policy, adapters, and scan knowledge.
 *
 * Returns:
 *   ClassificationResult: one decision (or typed blocks) per resource,
 *   plus document-level stale/invalid/unauthorized-signal blocks — all
 *   sorted.
 */
export function classifyResources(input) {
    const staleTargets = [];
    const invalidSignals = [];
    const unauthorizedSuppressive = [];
    const pluginSignals = [...input.signals].sort((a, b) => compareStrings(signalId(a), signalId(b)));
    const authoritySignals = [...(input.authority ?? [])].sort((a, b) => compareStrings(signalId(a), signalId(b)));
    const trustedEntries = input.policy.trustedInternalEntryPoints;
    // Document-level signal hygiene first: stale targets, dimension/
    // assertion shape mismatches, and CHANNEL violations are typed blocks,
    // never silent drops.
    const byResource = input.resources.map(() => []);
    const authorityByResource = input.resources.map(() => []);
    const route = (signal, channel, matched, index) => {
        if (!matched) {
            staleTargets.push({
                code: 'STALE_SIGNAL_TARGET',
                resourceId: signal.target.resourceId ?? null,
                name: signal.target.resourceName ?? null,
                detail: `signal from ${signal.source} (${signal.dimension}) targets ` +
                    `${describeTarget(signal)} which matches no discovered resource; ` +
                    'the resource was removed, renamed, or the signal predates it',
                locations: [signal.location],
            });
            return;
        }
        const shapeError = assertionShapeError(signal);
        if (shapeError !== null) {
            invalidSignals.push({
                code: 'INVALID_SIGNAL',
                resourceId: null,
                name: null,
                detail: `signal from ${signal.source} (${signal.dimension}): ${shapeError}`,
                locations: [signal.location],
            });
            return;
        }
        for (const i of index)
            (channel === 'authority' ? authorityByResource : byResource)[i]?.push(signal);
    };
    for (const signal of pluginSignals) {
        if (signal.dimension === 'internality' && signal.basis === 'code-positive') {
            // Reachability is LOAD-BEARING for the internality certificate —
            // suppressive in effect (red-team round 5). Accept it only from the
            // category's declared trusted detector, only at a location that
            // detector's own coverage report includes and that was requested.
            const rejection = reachabilityRejection(signal, trustedEntries, input.scan);
            if (rejection !== null) {
                unauthorizedSuppressive.push({
                    code: 'UNAUTHORIZED_SUPPRESSIVE_SIGNAL',
                    resourceId: null,
                    name: null,
                    detail: `reachability signal from ${signal.source} (${signal.detector.id}@` +
                        `${signal.detector.version}) asserting category '${internalityCategory(signal) ?? '<unknown>'}' ` +
                        `was rejected: ${rejection}; the certificate can only use reachability ` +
                        'asserted by the category\'s declared trusted detector over files it actually examined',
                    locations: [signal.location],
                });
                continue;
            }
        }
        if (isSuppressiveShape(signal)) {
            // Channel violation: the detector channel can never carry
            // suppressive intent. Fail LOUD — the attempt blocks the gate.
            unauthorizedSuppressive.push({
                code: 'UNAUTHORIZED_SUPPRESSIVE_SIGNAL',
                resourceId: null,
                name: null,
                detail: `signal from ${signal.source} (${signal.dimension}, ${signal.basis}) arrived on the ` +
                    'detector channel claiming ' +
                    `${signal.detector.id}@${signal.detector.version}; suppressive authority ` +
                    '(internality declarations, closed-world lifecycle proofs) is host-issued only — ' +
                    'mint it through the engine (source declarations / policy), never via plugin output',
                locations: [signal.location],
            });
            continue;
        }
        const matched = [];
        for (let i = 0; i < input.resources.length; i++) {
            const resource = input.resources[i];
            if (resource === undefined)
                continue;
            if (signalMatchesResource(signal, resource))
                matched.push(i);
        }
        route(signal, 'detector', matched.length > 0, matched);
    }
    for (const signal of authoritySignals) {
        const matched = [];
        for (let i = 0; i < input.resources.length; i++) {
            const resource = input.resources[i];
            if (resource === undefined)
                continue;
            if (signalMatchesResource(signal, resource))
                matched.push(i);
        }
        route(signal, 'authority', matched.length > 0, matched);
    }
    const scanComplete = completeScanHolds(input.policy, input.scan);
    const exposureComplete = exposureCoverageHolds(input.policy, input.scan);
    const trustedCategories = new Set(input.policy.trustedInternalEntryPoints.map((entry) => entry.category));
    const ctx = {
        policy: input.policy,
        adapters: input.adapters,
        scanComplete,
        exposureComplete,
        trustedCategories,
        trustedEntries,
    };
    const pools = input.resources.map((_, index) => ({
        plugin: byResource[index] ?? [],
        authority: authorityByResource[index] ?? [],
    }));
    const decisions = input.resources.map((resource, index) => classifyOne(resource, pools[index] ?? { plugin: [], authority: [] }, ctx));
    resolveEndpointPlanes(input.resources, decisions, pools, ctx);
    return {
        schemaVersion: 1,
        decisions: sortDecisions(decisions),
        staleTargets: sortBlocks(staleTargets),
        invalidSignals: sortBlocks(invalidSignals),
        unauthorizedSuppressive: sortBlocks(unauthorizedSuppressive),
    };
}
/**
 * Endpoint plane inheritance (ADR 0004 D5): an `http.endpoint` resource
 * whose plane stayed unresolved inherits the plane of exactly one linked
 * business resource with a resolved plane; operational endpoints
 * (capability `health-operations`, no business link) resolve to
 * `global`. Derivation is engine-issued (authority channel) and runs as
 * ONE deterministic pass — never chained endpoint-to-endpoint, never
 * guessed when the link is ambiguous.
 */
function resolveEndpointPlanes(resources, decisions, pools, ctx) {
    const decisionsByName = new Map();
    for (const decision of decisions) {
        const list = decisionsByName.get(decision.name);
        if (list !== undefined)
            list.push(decision);
        else
            decisionsByName.set(decision.name, [decision]);
    }
    for (let index = 0; index < decisions.length; index += 1) {
        const resource = resources[index];
        const decision = decisions[index];
        if (resource === undefined || decision === undefined)
            continue;
        if (resource.kind !== HTTP_ENDPOINT_RESOURCE_KIND)
            continue;
        if (decision.classification !== null)
            continue;
        if (!decision.blocks.some((block) => block.code === 'PLANE_UNRESOLVED'))
            continue;
        let plane = null;
        let derivedFrom = null;
        const linkedName = resource.attributes['linkedResourceName'];
        if (typeof linkedName === 'string' && linkedName.length > 0) {
            const linkedDecisions = decisionsByName.get(linkedName) ?? [];
            const resolvedPlanes = new Set();
            for (const linked of linkedDecisions) {
                // Never chain through another endpoint; only business decisions count.
                if (linked.kind === HTTP_ENDPOINT_RESOURCE_KIND)
                    continue;
                if (linked.classification !== null)
                    resolvedPlanes.add(linked.classification.plane);
            }
            if (resolvedPlanes.size === 1) {
                const only = [...resolvedPlanes][0];
                if (only !== undefined) {
                    plane = only;
                    derivedFrom = 'linked-resource';
                }
            }
        }
        if (plane === null) {
            const capabilities = resource.attributes['capabilities'];
            const healthOperational = Array.isArray(capabilities) &&
                capabilities.includes('health-operations') &&
                typeof linkedName !== 'string';
            if (healthOperational) {
                plane = 'global';
                derivedFrom = 'operational';
            }
        }
        if (plane === null || derivedFrom === null)
            continue;
        const derived = {
            schemaVersion: 1,
            target: { resourceName: resource.name },
            dimension: 'plane',
            assertion: plane,
            basis: 'declaration',
            source: `gateforge.endpoint-compiler:${derivedFrom}`,
            location: resource.location,
            detector: { id: 'gateforge.endpoint-compiler', version: '1' },
        };
        const pool = pools[index];
        decisions[index] = classifyOne(resource, {
            plugin: pool?.plugin ?? [],
            authority: [...(pool?.authority ?? []), derived],
        }, ctx);
    }
}
/** Renders a signal target for diagnostics. */
function describeTarget(signal) {
    const target = signal.target;
    if (target.resourceId !== undefined)
        return `id '${target.resourceId}'`;
    if (target.resourceName !== undefined)
        return `name '${target.resourceName}'`;
    if (target.symbol !== undefined)
        return `symbol '${target.symbol}'`;
    return '<unaddressed>';
}
/**
 * Cross-field assertion validation (the zod schema is per-field): each
 * dimension accepts only the assertion shapes its lattice rules read.
 * Returns a single-cause error string, or null when the signal is
 * well-formed for its dimension.
 */
function assertionShapeError(signal) {
    const assertion = signal.assertion;
    switch (signal.dimension) {
        case 'exposure':
        case 'lifecycle.create':
        case 'lifecycle.read':
        case 'lifecycle.update':
        case 'lifecycle.delete':
            if (typeof assertion !== 'boolean' && typeof assertion !== 'string') {
                return 'assertion must be a boolean or a channel string';
            }
            return null;
        case 'plane':
            if (!(assertion === 'tenant' || assertion === 'master' || assertion === 'global')) {
                return "assertion must be one of: 'tenant', 'master', 'global'";
            }
            return null;
        case 'identity':
            if (!Array.isArray(assertion)) {
                return 'assertion must be the ordered primary-key column list';
            }
            return null;
        case 'delete-semantics':
            if (!(assertion === 'hard' || assertion === 'archive')) {
                return "assertion must be 'hard' or 'archive'";
            }
            return null;
        case 'archive-state':
            if (Array.isArray(assertion) || typeof assertion !== 'object') {
                return 'assertion must be the owner-owned archived field-value record';
            }
            return null;
        case 'internality':
        case 'adapter-binding':
            return null; // free-form: boolean intent, category string/record, adapter name
        default:
            return null;
    }
}
/** Sorts decisions like graph resources: id-bearing first, then by name. */
function sortDecisions(decisions) {
    return [...decisions].sort((a, b) => {
        if (a.resourceId !== null && b.resourceId !== null) {
            const byId = compareStrings(a.resourceId, b.resourceId);
            if (byId !== 0)
                return byId;
        }
        if (a.resourceId !== null)
            return -1;
        if (b.resourceId !== null)
            return 1;
        return compareStrings(a.name, b.name);
    });
}
/**
 * Runs the lattice for one resource. See ADR 0003 D2 for the normative
 * rule order; every failure mode lands in `blocks` with a single-cause
 * detail — nothing is guessed and nothing silently disappears.
 *
 * The channel pool separates DETECTOR-origin signals (structurally
 * non-suppressive; document-level hygiene already rejected violations)
 * from HOST-ISSUED authority signals (the only source of internality
 * declarations and closed-world lifecycle proofs).
 */
function classifyOne(resource, pool, ctx) {
    // Non-suppressive reads (exposure, plane, identity, semantics,
    // reachability, additive declarations) see both channels merged;
    // suppressive reads use `pool.authority` exclusively.
    const signals = [...pool.plugin, ...pool.authority];
    const blocks = [];
    const contradictions = [];
    const rules = [];
    const defaultsApplied = [];
    const contributing = [];
    const contribute = (...signalList) => {
        contributing.push(...signalList);
    };
    // -- Plane ----------------------------------------------------------------
    const planeCandidates = new Set();
    const attributePlane = resource.attributes['plane'];
    if (attributePlane === 'tenant' || attributePlane === 'master' || attributePlane === 'global') {
        planeCandidates.add(attributePlane);
    }
    const planeSignals = signals.filter((s) => s.dimension === 'plane' && typeof s.assertion === 'string');
    for (const signal of planeSignals)
        planeCandidates.add(signal.assertion);
    let plane;
    if (planeCandidates.size === 1) {
        const value = [...planeCandidates][0];
        if (value === undefined) {
            return blocked(resource, [planeUnresolvedBlock(resource, 'no plane evidence')]);
        }
        plane = value;
        rules.push(RULES.planeEvidence);
        contribute(...planeSignals);
    }
    else if (planeCandidates.size === 0) {
        return blocked(resource, [
            planeUnresolvedBlock(resource, 'no plane evidence (no plane signal and no detector plane attribute); ' +
                'identity normalization never guesses across tenant/master/global'),
        ]);
    }
    else {
        return blocked(resource, [
            {
                code: 'PLANE_CONTRADICTION',
                resourceId: resource.id,
                name: resource.name,
                detail: `resource '${resource.name}' has ${planeCandidates.size} conflicting plane assertions ` +
                    `(${[...planeCandidates].sort(compareStrings).join(', ')}); ` +
                    'add or remove plane evidence until one plane remains',
                locations: sortLocations(planeSignals.map((s) => s.location)),
            },
        ]);
    }
    // -- Identity (ordered primary key) ---------------------------------------
    const identitySignals = signals.filter((s) => s.dimension === 'identity' && Array.isArray(s.assertion));
    const identityKeys = new Set();
    for (const signal of identitySignals) {
        identityKeys.add(joinKeys(signal.assertion));
    }
    let primaryKey;
    if (identityKeys.size === 1) {
        const only = [...identityKeys][0];
        primaryKey = splitKeys(only);
        rules.push(RULES.identityEvidence);
        contribute(...identitySignals);
    }
    else if (identityKeys.size === 0) {
        return blocked(resource, [
            identityUnresolvedBlock(resource, 'no primary-key evidence (no identity signal); the key is never defaulted to `id`'),
        ]);
    }
    else {
        const distinct = [...identityKeys].map(splitKeys);
        return blocked(resource, [
            {
                code: 'IDENTITY_CONTRADICTION',
                resourceId: resource.id,
                name: resource.name,
                detail: `resource '${resource.name}' has ${distinct.length} conflicting primary-key assertions ` +
                    `(${distinct.map((keys) => keys.join('+')).sort(compareStrings).join(' vs ')}); ` +
                    'the ordered key is never guessed',
                locations: sortLocations(identitySignals.map((s) => s.location)),
            },
        ]);
    }
    // -- Exposure --------------------------------------------------------------
    const positiveExposure = signals.filter((s) => s.dimension === 'exposure' && isPositiveExposure(s));
    const positiveLifecycle = signals.filter((s) => (s.dimension === 'lifecycle.create' ||
        s.dimension === 'lifecycle.read' ||
        s.dimension === 'lifecycle.update' ||
        s.dimension === 'lifecycle.delete') &&
        s.basis === 'code-positive' &&
        assertionBoolean(s.assertion) === true);
    const internalDeclarations = pool.authority.filter((s) => s.dimension === 'internality' &&
        (s.basis === 'declaration' || s.basis === 'organization-policy') &&
        isConfiguredDeclarationSource(s, ctx.policy) &&
        assertionBoolean(s.assertion) !== false);
    const matchedInternalRules = ctx.policy.internalRules.filter((rule) => (rule.match.resourceName === undefined || globMatch(resource.name, rule.match.resourceName)) &&
        (rule.match.resourceKind === undefined || rule.match.resourceKind === resource.kind));
    const hasInternalIntent = internalDeclarations.length > 0 || matchedInternalRules.length > 0;
    let exposure;
    if (isOperationalEndpoint(resource)) {
        // Operational probes (plan §6 "Health/operations") resolve through an
        // engine-issued exposure lane, NOT the user-facing default and NOT an
        // internality certificate: the class itself is positive compiler
        // evidence (HEALTH_PATH_NO_SCHEMA, no business resource link). The
        // architecture assigns these endpoints dependency-ready/degraded
        // behavior evidence and explicitly "no artificial browser UI
        // obligation" — so they must never demand a reviewed UI evidence
        // adapter (ADAPTER_MISSING) they can never honestly carry.
        // `internal` is the obligation posture that encodes exactly that (no
        // CRUD/UI evidence lane, adapter optional), and the rule id below
        // records WHY in the decision trace so the resolution is explainable
        // rather than a silent internality claim. The global "unknown
        // exposure defaults user-facing" default is untouched: every other
        // resource without exposure facts still defaults user-facing.
        exposure = 'internal';
        rules.push(RULES.exposureOperationalProbe);
        contribute(...positiveExposure);
    }
    else if (positiveExposure.length > 0) {
        contribute(...positiveExposure);
        exposure = 'user-facing';
        rules.push(RULES.exposurePositive);
        if (hasInternalIntent) {
            const declarationLocations = sortLocations(internalDeclarations.map((s) => s.location));
            const positiveLocations = sortLocations(positiveExposure.map((s) => s.location));
            const intentWhere = declarationLocations.length > 0
                ? declarationLocations.map(locationText).join(', ')
                : matchedInternalRules.map((rule) => `organization rule '${rule.reason}'`).join(', ');
            const detail = `internal intent at ${intentWhere} contradicted by positive external signal at ` +
                `${positiveLocations.map(locationText).join(', ')}; ` +
                'decision: user-facing (conservative) — remove the false internal declaration ' +
                'or remove the public exposure';
            const locations = sortLocations([...declarationLocations, ...positiveLocations, resource.location]);
            blocks.push({
                code: 'CLASSIFICATION_CONTRADICTION',
                resourceId: `${plane}.${resource.name}`,
                name: resource.name,
                detail,
                locations,
            });
            contradictions.push({ dimension: 'exposure', detail, locations });
        }
    }
    else if (hasInternalIntent) {
        contribute(...internalDeclarations);
        const reachability = signals.filter((s) => s.dimension === 'internality' && s.basis === 'code-positive');
        const categories = [];
        for (const signal of reachability) {
            const category = internalityCategory(signal);
            if (category !== null)
                categories.push(category);
        }
        const untrusted = [
            ...new Set(reachability
                .filter((signal) => {
                const category = internalityCategory(signal);
                const entry = ctx.trustedEntries.find((candidate) => candidate.category === category);
                return entry === undefined || (entry.patterns !== undefined && !entry.patterns.some((pattern) => globMatch(signal.location.file, pattern)));
            })
                .map((signal) => internalityCategory(signal) ?? '<unknown>')),
        ];
        if (!ctx.scanComplete) {
            exposure = 'user-facing';
            rules.push(RULES.exposureDefault);
            defaultsApplied.push(RULES.exposureDefault);
            blocks.push({
                code: 'INCOMPLETE_PROOF_SCOPE',
                resourceId: `${plane}.${resource.name}`,
                name: resource.name,
                detail: 'internal intent cannot be certified: the complete-scan attestation fails ' +
                    '(findings or unresolved entries intersect the configured scanRoots, or scanRoots are empty); ' +
                    'decision: user-facing (conservative) until the scan scope is complete',
                locations: [resource.location],
            });
        }
        else if (!ctx.exposureComplete) {
            exposure = 'user-facing';
            rules.push(RULES.exposureDefault);
            defaultsApplied.push(RULES.exposureDefault);
            blocks.push({
                code: 'INCOMPLETE_PROOF_SCOPE',
                resourceId: `${plane}.${resource.name}`,
                name: resource.name,
                detail: 'internal intent cannot be certified: no EXHAUSTIVE exposure.* coverage rule covers ' +
                    'every requested file with a detector-reported scan; reading a file with a ' +
                    'non-exhaustive (e.g. regex) detector proves nothing about the absence of exposure, ' +
                    'so internality stays unavailable for this scope until an exhaustive exposure ' +
                    'parser is declared and covers it; decision: user-facing (conservative)',
                locations: [resource.location],
            });
        }
        else if (untrusted.length > 0) {
            exposure = 'user-facing';
            rules.push(RULES.exposureDefault);
            defaultsApplied.push(RULES.exposureDefault);
            blocks.push({
                code: 'INCOMPLETE_PROOF_SCOPE',
                resourceId: `${plane}.${resource.name}`,
                name: resource.name,
                detail: `internal intent cannot be certified: reachability signal(s) assert untrusted ` +
                    `entry-point category(es) ${untrusted.sort(compareStrings).join(', ')} ` +
                    `(trusted: ${[...ctx.trustedCategories].sort(compareStrings).join(', ') || '<none declared>'}); ` +
                    'decision: user-facing (conservative)',
                locations: sortLocations(reachability.map((s) => s.location)),
            });
        }
        else if (categories.length === 0 || positiveLifecycle.length > 0) {
            exposure = 'user-facing';
            rules.push(RULES.exposureDefault);
            defaultsApplied.push(RULES.exposureDefault);
            blocks.push({
                code: 'INCOMPLETE_PROOF_SCOPE',
                resourceId: `${plane}.${resource.name}`,
                name: resource.name,
                detail: categories.length === 0
                    ? 'internal intent cannot be certified: no trusted-internal reachability signal ' +
                        `binds this resource (declared categories: ` +
                        `${[...ctx.trustedCategories].sort(compareStrings).join(', ') || '<none>'}); ` +
                        'decision: user-facing (conservative)'
                    : 'internal intent cannot be certified: positive lifecycle mutation signal(s) exist ' +
                        'in scope, so reachable entry points are not exclusively internal; ' +
                        'decision: user-facing (conservative)',
                locations: categories.length === 0
                    ? [resource.location]
                    : sortLocations(positiveLifecycle.map((s) => s.location)),
            });
        }
        else {
            exposure = 'internal';
            rules.push(RULES.exposureInternalCertificate);
            contribute(...reachability);
            for (const rule of matchedInternalRules) {
                rules.push(`${RULES.orgInternalRule}(${rule.reason})`);
            }
        }
    }
    else {
        exposure = 'user-facing';
        rules.push(RULES.exposureDefault);
        defaultsApplied.push(RULES.exposureDefault);
    }
    // -- Lifecycle (per operation, independently) ------------------------------
    // ADR 0004 D5/D8: HTTP endpoints carry no lifecycle lattice. Their
    // route semantics live in the compiled capabilities attribute, and the
    // policy engine never generates crud:*/persistence:* contracts against
    // the endpoint kind — so lifecycle defaults (which exist to gate those
    // contracts) have no honest meaning here and would only demand
    // delete-semantics evidence no route can carry.
    const lifecycle = { create: true, read: true, update: true, delete: true };
    if (resource.kind === HTTP_ENDPOINT_RESOURCE_KIND) {
        // ADR 0004 D5/D8: HTTP endpoints carry no lifecycle lattice. Their
        // route semantics live in the compiled capabilities attribute, and
        // the policy engine never generates crud:*/persistence:* contracts
        // against the endpoint kind — so lifecycle defaults (which exist to
        // gate those contracts) have no honest meaning here and would only
        // demand delete-semantics evidence no route can carry.
        lifecycle.create = false;
        lifecycle.read = false;
        lifecycle.update = false;
        lifecycle.delete = false;
        rules.push(RULES.lifecycleEndpointHttp);
    }
    else
        for (const operation of OPERATIONS) {
            const dimension = `lifecycle.${operation}`;
            const positives = signals.filter((s) => s.dimension === dimension &&
                s.basis === 'code-positive' &&
                assertionBoolean(s.assertion) === true);
            const closedWorld = pool.authority.filter((s) => s.dimension === dimension &&
                s.basis === 'code-negative-closed-world' &&
                assertionBoolean(s.assertion) === false);
            const declaredSupported = signals.filter((s) => s.dimension === dimension &&
                (s.basis === 'declaration' || s.basis === 'organization-policy') &&
                assertionBoolean(s.assertion) === true);
            const declaredUnsupported = signals.filter((s) => s.dimension === dimension &&
                (s.basis === 'declaration' || s.basis === 'organization-policy') &&
                assertionBoolean(s.assertion) === false);
            if (positives.length > 0) {
                contribute(...positives);
                lifecycle[operation] = true;
                rules.push(`${RULES.lifecyclePositive}(${operation})`);
                if (declaredUnsupported.length > 0) {
                    const detail = `lifecycle.${operation} has both positive evidence and unsupported declarations; ` +
                        'the operation stays enabled (conservative) and the conflict blocks';
                    const locations = sortLocations([...positives, ...declaredUnsupported].map((s) => s.location));
                    blocks.push({
                        code: 'LIFECYCLE_CONTRADICTION',
                        resourceId: `${plane}.${resource.name}`,
                        name: resource.name,
                        detail,
                        locations,
                    });
                    contradictions.push({ dimension, detail, locations });
                }
            }
            else if (closedWorld.length > 0 && ctx.scanComplete && declaredSupported.length === 0) {
                contribute(...closedWorld);
                lifecycle[operation] = false;
                rules.push(`${RULES.lifecycleClosedWorldDisabled}(${operation})`);
            }
            else if (closedWorld.length > 0) {
                // A closed-world assertion whose proof does not hold: the intent to
                // suppress is unproven, so the conservative default applies AND the
                // unproven claim blocks (fail closed on suppressive evidence).
                lifecycle[operation] = true;
                defaultsApplied.push(`${RULES.lifecycleDefault}(${operation})`);
                const reason = !ctx.scanComplete
                    ? 'the complete-scan attestation fails'
                    : 'contradicting supported declarations exist';
                blocks.push({
                    code: 'INCOMPLETE_PROOF_SCOPE',
                    resourceId: `${plane}.${resource.name}`,
                    name: resource.name,
                    detail: `closed-world proof that lifecycle.${operation} is structurally unavailable fails: ` +
                        `${reason}; the operation stays enabled (conservative)`,
                    locations: sortLocations(closedWorld.map((s) => s.location)),
                });
            }
            else if (declaredSupported.length > 0) {
                contribute(...declaredSupported);
                lifecycle[operation] = true;
                rules.push(`${RULES.lifecycleDeclaredSupported}(${operation})`);
            }
            else if (declaredUnsupported.length > 0) {
                lifecycle[operation] = true;
                defaultsApplied.push(`${RULES.lifecycleDefault}(${operation})`);
            }
            else {
                lifecycle[operation] = true;
                defaultsApplied.push(`${RULES.lifecycleDefault}(${operation})`);
            }
        }
    // Preserve normalized owner-declared update fields while excluding
    // bookkeeping fields configured as volatile.
    const updateableFields = resource.attributes['updateableFields'];
    if (Array.isArray(updateableFields) &&
        updateableFields.length > 0 &&
        updateableFields.every((field) => typeof field === 'string' && field.length > 0)) {
        const volatile = new Set(ctx.policy.volatileFields);
        lifecycle.updateableFields = [...new Set(updateableFields.filter((field) => !volatile.has(field)))].sort(compareStrings);
    }
    // -- Delete semantics ------------------------------------------------------
    if (lifecycle.delete) {
        const semanticsSignals = signals.filter((s) => s.dimension === 'delete-semantics' &&
            (s.assertion === 'hard' || s.assertion === 'archive'));
        const archiveStateSignals = signals.filter((s) => s.dimension === 'archive-state' &&
            typeof s.assertion === 'object' &&
            !Array.isArray(s.assertion) &&
            Object.keys(s.assertion).length > 0);
        const semanticsValues = new Set();
        for (const signal of semanticsSignals)
            semanticsValues.add(signal.assertion);
        if (semanticsValues.size === 1) {
            const semantics = [...semanticsValues][0];
            contribute(...semanticsSignals);
            if (semantics === 'hard') {
                lifecycle.deleteSemantics = 'hard';
                rules.push(RULES.deleteProvenHard);
            }
            else if (archiveStateSignals.length > 0) {
                contribute(...archiveStateSignals);
                const records = archiveStateSignals.map((s) => s.assertion);
                const merged = {};
                const keys = [...new Set(records.flatMap((r) => Object.keys(r)))].sort(compareStrings);
                let conflicting = false;
                for (const key of keys) {
                    const values = [
                        ...new Set(records
                            .map((record) => record[key])
                            .filter((value) => value !== undefined)),
                    ];
                    if (values.length > 1)
                        conflicting = true;
                    const first = values.sort(compareScalar)[0];
                    if (first !== undefined)
                        merged[key] = first;
                }
                if (conflicting) {
                    blocks.push(deleteSemanticsBlock(resource, plane, 'archive-state signals declare conflicting archived values for the same field; ' +
                        'the owner-owned archived state is never guessed'));
                }
                else {
                    lifecycle.deleteSemantics = 'archive';
                    lifecycle.archiveFields = merged;
                    rules.push(RULES.deleteProvenArchive);
                }
            }
            else {
                blocks.push(deleteSemanticsBlock(resource, plane, 'archive delete semantics require owner-owned archive-state evidence ' +
                    '(the archived field values, e.g. {status: archived}); none was found'));
            }
        }
        else if (semanticsValues.size === 0) {
            blocks.push(deleteSemanticsBlock(resource, plane, 'delete is enabled but its semantics are unresolved: prove a hard delete, ' +
                'prove archive semantics with owner-owned archive state, or close-world-disable delete'));
        }
        else {
            blocks.push(deleteSemanticsBlock(resource, plane, 'conflicting delete-semantics evidence (both hard and archive asserted); ' +
                'the semantics are never guessed'));
        }
    }
    // -- Adapter binding -------------------------------------------------------
    // The reviewed EntityAdapter demand is a BUSINESS-resource requirement,
    // not a universal one (dogfood: 473/746 ADAPTER_MISSING blocks on pure
    // endpoints). An `http.endpoint` resource is witnessed through the
    // claims/witness-proxy lane (`http:frontend-request-observed` etc.);
    // EntityAdapter's contract — read by id, normalize a body, deletion
    // kind — is about business-entity persistence and has no honest meaning
    // for a route, so demanding one for every user-facing endpoint was a
    // category error that red the gate on evidence no route can carry.
    // Endpoints therefore classify user-facing WITHOUT an adapter (the
    // claims lane, recorded as `evidenceLane: 'claims'` so the schema and
    // every downstream consumer see WHY no adapter is present). The demand
    // is unchanged for business kinds: a user-facing table without a
    // reviewed adapter still blocks (ADAPTER_MISSING).
    const businessResource = resource.kind !== HTTP_ENDPOINT_RESOURCE_KIND;
    let evidenceAdapter;
    if (exposure === 'user-facing' && businessResource) {
        const bound = bindAdapter(ctx.adapters, resource, signals);
        if (bound !== null) {
            evidenceAdapter = bound;
            rules.push(RULES.adapterNameMatch);
        }
        else {
            blocks.push({
                code: 'ADAPTER_MISSING',
                resourceId: `${plane}.${resource.name}`,
                name: resource.name,
                detail: `user-facing resource '${plane}.${resource.name}' has no reviewed evidence adapter ` +
                    `(looked for '${resource.id ?? resource.name}' and '${resource.name}' in the adapters ` +
                    'directory); implement the adapter to resolve',
                locations: [resource.location],
            });
        }
    }
    // -- Assemble --------------------------------------------------------------
    const classification = {
        exposure,
        plane,
        lifecycle,
        primaryKey,
        ...(exposure === 'user-facing' && !businessResource ? { evidenceLane: 'claims' } : {}),
        ...(evidenceAdapter !== undefined ? { evidenceAdapter } : {}),
    };
    const signalIds = [...new Set(contributing.map((s) => signalId(s)))].sort(compareStrings);
    const contributingDetectors = [
        ...new Set(contributing.map((s) => `${s.detector.id}@${s.detector.version}`)),
    ].sort(compareStrings);
    const sortedRules = [...new Set(rules)].sort(compareStrings);
    const sortedDefaults = [...new Set(defaultsApplied)].sort(compareStrings);
    const sortedContradictions = sortContradictions(contradictions);
    const fingerprint = decisionFingerprint({
        resourceId: resource.id,
        name: resource.name,
        kind: resource.kind,
        classification,
        rules: sortedRules,
        defaultsApplied: sortedDefaults,
        signalIds,
        detectors: contributingDetectors,
        contradictions: sortedContradictions,
    });
    const trace = {
        rules: sortedRules,
        defaultsApplied: sortedDefaults,
        contributingSignalIds: signalIds,
        contributingDetectors,
        contradictions: sortedContradictions,
        unresolvedDimensions: [
            ...new Set(blocks.map((block) => BLOCK_DIMENSIONS[block.code] ?? block.code)),
        ].sort(compareStrings),
        decisionFingerprint: fingerprint,
    };
    // The classification must always be a VALID Classification (the same
    // schema policy/verdict code consumes). Definitional blocks — delete
    // semantics unresolved, missing adapter — make it invalid; those keep
    // only the typed blocks. Contradiction/incomplete-proof blocks carry a
    // valid conservative classification (obligations still accrue).
    const valid = ClassificationSchema.safeParse(classification);
    if (!valid.success) {
        return {
            resourceId: resource.id,
            name: resource.name,
            kind: resource.kind,
            source: resource.source,
            location: resource.location,
            classification: null,
            blocks: sortBlocks(blocks),
        };
    }
    return {
        resourceId: resource.id,
        name: resource.name,
        kind: resource.kind,
        source: resource.source,
        location: resource.location,
        blocks: sortBlocks(blocks),
        classification: { ...valid.data, ...trace },
    };
}
/** Adapter binding: an explicit adapter-binding signal first, then id, then bare name. */
function bindAdapter(adapters, resource, signals) {
    const exists = (name) => name.length > 0 && adapters.includes(name);
    for (const signal of signals) {
        if (signal.dimension === 'adapter-binding' && typeof signal.assertion === 'string') {
            if (exists(signal.assertion))
                return signal.assertion;
        }
    }
    if (resource.id !== null && exists(resource.id))
        return resource.id;
    if (exists(resource.name))
        return resource.name;
    return null;
}
/** Terminal helper: a resource whose lattice run produced only blocks. */
function blocked(resource, blocks) {
    return {
        resourceId: resource.id,
        name: resource.name,
        kind: resource.kind,
        source: resource.source,
        location: resource.location,
        classification: null,
        blocks: sortBlocks(blocks),
    };
}
function planeUnresolvedBlock(resource, cause) {
    return {
        code: 'PLANE_UNRESOLVED',
        resourceId: resource.id,
        name: resource.name,
        detail: `resource '${resource.name}' has no derivable plane: ${cause}`,
        locations: [resource.location],
    };
}
function identityUnresolvedBlock(resource, cause) {
    return {
        code: 'IDENTITY_UNRESOLVED',
        resourceId: resource.id,
        name: resource.name,
        detail: `resource '${resource.name}' has no derivable primary key: ${cause}`,
        locations: [resource.location],
    };
}
function deleteSemanticsBlock(resource, plane, cause) {
    return {
        code: 'DELETE_SEMANTICS_UNRESOLVED',
        resourceId: `${plane}.${resource.name}`,
        name: resource.name,
        detail: `resource '${plane}.${resource.name}': ${cause}`,
        locations: [resource.location],
    };
}
function joinKeys(columns) {
    return JSON.stringify(columns);
}
/**
 * Deterministic total order over archive-field scalar values (fixed
 * type-first ordering: boolean < number < string, then by value). Used
 * only to pick a representative when detecting conflicts — conflicting
 * values block regardless; the order keeps output byte-stable.
 */
function compareScalar(a, b) {
    const rank = (value) => typeof value === 'boolean' ? 0 : typeof value === 'number' ? 1 : 2;
    const byRank = rank(a) - rank(b);
    if (byRank !== 0)
        return byRank;
    if (typeof a === 'string' && typeof b === 'string')
        return compareStrings(a, b);
    if (typeof a === 'number' && typeof b === 'number')
        return a - b;
    return a === b ? 0 : (a === true ? 1 : 0) - (b === true ? 1 : 0);
}
function splitKeys(joined) {
    const parsed = JSON.parse(joined);
    return Array.isArray(parsed) ? parsed.map(String) : [];
}
//# sourceMappingURL=classify.js.map