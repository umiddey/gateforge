import { compareLocations, compareStrings } from '../graph/util.js';
import { classifyResources, } from './classify.js';
/** Projects one graph resource into the classifier's resource reference. */
export function resourceRef(resource) {
    return {
        name: resource.name,
        id: resource.id,
        kind: resource.kind,
        source: resource.source,
        location: resource.location,
        detector: resource.detector,
        attributes: resource.attributes,
    };
}
/**
 * The binding key of a resource or decision: the exact (name, kind,
 * source, location) tuple — unique per resource declaration and stable
 * across the sort the classifier applies to its decisions.
 */
function bindingKey(part) {
    return (`${part.name}\u0000${part.kind}\u0000${part.source}\u0000` +
        `${part.location.file}\u0000${part.location.line}\u0000${part.location.col}`);
}
/** Sorts bound resources exactly like the graph builder does. */
function sortResources(resources) {
    return [...resources].sort((a, b) => {
        if (a.id !== null && b.id !== null) {
            const byId = compareStrings(a.id, b.id);
            if (byId !== 0)
                return byId;
        }
        if (a.id !== null)
            return -1;
        if (b.id !== null)
            return 1;
        return (compareStrings(a.name, b.name) ||
            compareStrings(a.source, b.source) ||
            compareLocations(a.location, b.location));
    });
}
/** Binds one decision's classification onto one graph resource. */
function bindDecision(resource, decision) {
    if (decision === undefined || decision.classification === null)
        return resource;
    const bound = decision.classification;
    const { exposure, plane, primaryKey, evidenceAdapter } = bound;
    return {
        ...resource,
        id: `${plane}.${resource.name}`,
        plane,
        exposure,
        classification: {
            exposure,
            plane,
            lifecycle: bound.lifecycle,
            primaryKey,
            ...(evidenceAdapter !== undefined ? { evidenceAdapter } : {}),
        },
        classificationTrace: {
            rules: [...bound.rules],
            defaultsApplied: [...bound.defaultsApplied],
            contributingSignalIds: [...bound.contributingSignalIds],
            contributingDetectors: [...bound.contributingDetectors],
            contradictions: bound.contradictions.map((entry) => ({ ...entry })),
            unresolvedDimensions: [...bound.unresolvedDimensions],
            decisionFingerprint: bound.decisionFingerprint,
        },
    };
}
/**
 * Runs the deterministic classifier over the graph and rebinds its
 * decisions. See the module doc for the contract.
 *
 * Args:
 *   input: graph, detector signals, classification policy, adapters.
 *
 * Returns:
 *   GraphClassification: bound graph, raw result, blocking entries.
 */
export function runClassification(input) {
    const refs = input.graph.resources.map(resourceRef);
    const result = classifyResources({
        resources: refs,
        signals: [...input.signals],
        authority: input.authority ? [...input.authority] : [],
        policy: input.policy,
        adapters: input.adapters,
        scan: {
            requestedPaths: input.scan?.requestedPaths ?? [],
            scannedPaths: input.scan?.scannedPaths ?? [],
            coverage: input.scan?.coverage,
            configuredDetectors: input.scan?.configuredDetectors ?? 1,
            successfulDetectors: input.scan?.successfulDetectors ?? 1,
            findings: input.graph.findings.map((finding) => ({
                code: finding.code,
                locations: finding.locations,
            })),
            unresolved: input.graph.unresolved.map((entry) => ({ location: entry.reason.location })),
        },
    });
    const byKey = new Map();
    for (const decision of result.decisions)
        byKey.set(bindingKey(decision), decision);
    const resources = input.graph.resources.map((resource) => bindDecision(resource, byKey.get(bindingKey(resource))));
    const postBindingFindings = [...input.graph.findings];
    const byId = new Map();
    for (const resource of resources) {
        if (resource.id === null)
            continue;
        const group = byId.get(resource.id) ?? [];
        group.push(resource);
        byId.set(resource.id, group);
    }
    for (const [id, group] of byId) {
        if (group.length < 2)
            continue;
        postBindingFindings.push({
            code: 'DUPLICATE_BOUND_RESOURCE_ID',
            detail: `resources ${group.map((resource) => resource.name).join(', ')} bind to duplicate id '${id}'`,
            locations: group.map((resource) => resource.location),
            detectorId: 'gateforge.classifier',
        });
    }
    return {
        graph: { ...input.graph, findings: postBindingFindings, resources: sortResources(resources) },
        classification: result,
        blocking: classifierBlocking(result, { ...input.graph, findings: postBindingFindings }),
    };
}
/**
 * Projects classifier blocks into policy-engine blocking entries:
 * per-decision blocks (contradictions, incomplete proofs, unresolved
 * delete semantics, missing adapters) plus document-level stale targets
 * and invalid signals. Every entry names its typed code so an AI can
 * resolve it in code — never by obtaining human approval.
 */
export function classifierBlocking(result, graph) {
    const locations = new Map();
    for (const resource of graph.resources) {
        locations.set(bindingKey(resource), resource.location);
    }
    const entries = [];
    for (const decision of result.decisions) {
        const fallback = locations.get(bindingKey(decision)) ?? null;
        for (const block of decision.blocks) {
            entries.push({
                kind: 'classification',
                resourceId: block.resourceId ?? decision.resourceId,
                name: decision.name,
                detail: `[${block.code}] ${block.detail}`,
                location: block.locations[0] ?? fallback,
            });
        }
    }
    for (const stale of result.staleTargets) {
        entries.push({
            kind: 'classification',
            resourceId: null,
            name: null,
            detail: `[${stale.code}] ${stale.detail}`,
            location: stale.locations[0] ?? null,
        });
    }
    for (const invalid of result.invalidSignals) {
        entries.push({
            kind: 'classification',
            resourceId: null,
            name: null,
            detail: `[${invalid.code}] ${invalid.detail}`,
            location: invalid.locations[0] ?? null,
        });
    }
    for (const unauthorized of result.unauthorizedSuppressive) {
        entries.push({
            kind: 'classification',
            resourceId: null,
            name: null,
            detail: `[${unauthorized.code}] ${unauthorized.detail}`,
            location: unauthorized.locations[0] ?? null,
        });
    }
    return entries;
}
//# sourceMappingURL=bind.js.map