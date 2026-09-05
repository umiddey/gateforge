import type { Location } from '../schemas/common.js';
import { type Classification } from '../schemas/classification.js';
import type { ClassificationPolicy } from '../schemas/classification-policy.js';
import { type ClassificationSignal } from '../schemas/classification-signal.js';
import { type ClassifierBlock, type ClassificationDecisionTrace } from './schema.js';
/** The resources the classifier classifies (graph resources, pre-binding). */
export interface ClassifierResourceRef {
    /** Bare resource name (the `resourceName` attribute). */
    name: string;
    /** Plane-qualified id when already derivable, else `null`. */
    id: string | null;
    /** Detector framework kind. */
    kind: string;
    /** Repo-root-relative source path. */
    source: string;
    /** Exact declaration location. */
    location: Location;
    /** Detector provenance. */
    detector: {
        id: string;
        version: string;
    };
    /** Detector attributes (read for `classQname`/`symbol`/`plane` facts). */
    attributes: Record<string, unknown>;
}
/** Per-detector reported coverage (red-team round 3). */
export interface DetectorCoverage {
    /** Plugin id of the reporting detector. */
    detector: string;
    /** Repo-root-relative files the detector examined successfully. */
    scannedPaths: string[];
}
/** Scan knowledge used to validate closed-world proofs. */
export interface ClassifierScanInput {
    requestedPaths?: string[];
    /** Paths successfully covered by the detector run (union floor). */
    scannedPaths?: string[];
    /** Per-detector coverage reports; policy coverage rules are judged
     * against THESE, never against a flattened union. */
    coverage?: DetectorCoverage[];
    /** Number of configured detectors that completed successfully. */
    configuredDetectors?: number;
    /** Number of detector contributions received by the host. */
    successfulDetectors?: number;
    /** Detector/graph findings; any in-scope finding invalidates negative proofs. */
    findings: Array<{
        code: string;
        locations: Location[];
    }>;
    /** Unresolved entries; any in-scope entry invalidates negative proofs. */
    unresolved: Array<{
        location: Location;
    }>;
}
/** Everything one classification pass needs. */
export interface ClassifyResourcesInput {
    /** Resources to classify (any order; output is deterministic). */
    resources: ClassifierResourceRef[];
    /**
     * DETECTOR-channel signals (plugin output, any order). Structurally
     * NON-authoritative for suppressive dimensions: a suppressive-shaped
     * signal here is rejected with `UNAUTHORIZED_SUPPRESSIVE_SIGNAL`
     * whatever detector identity it claims — the channel, not an
     * identity string, is the trust boundary (ADR 0003 D2).
     */
    signals: ClassificationSignal[];
    /**
     * HOST-ISSUED authority channel: declarations and closed-world proofs
     * minted by the engine itself (never forwarded plugin output). This is
     * the ONLY channel that can carry suppressive intent. Direct callers
     * control both arguments in-process — the boundary the API enforces is
     * the pipeline: plugin output flows exclusively into `signals`.
     */
    authority?: ClassificationSignal[];
    /** The validated classification policy (scan roots, categories, rules). */
    policy: ClassificationPolicy;
    /** Reviewed adapter names available for binding. */
    adapters: readonly string[];
    /** Findings/unresolved entries the complete-scan attestation is judged against. */
    scan: ClassifierScanInput;
}
/** One per-resource classifier outcome. */
export interface ClassificationDecision {
    /** Plane-qualified id when derivable, else `null`. */
    resourceId: string | null;
    /** Bare resource name. */
    name: string;
    /** Detector framework kind. */
    kind: string;
    /** Repo-root-relative source path (binding key; matches the graph). */
    source: string;
    /** Exact declaration location (binding key; matches the graph). */
    location: Location;
    /**
     * The effective classification (plain `Classification` fields plus
     * trace metadata), or `null` when a definitional block prevents
     * constructing one (no plane/identity, unresolved delete semantics,
     * missing adapter). Contradiction and unprovable-intent blocks KEEP
     * the conservative decision — obligations still accrue — while the
     * blocks keep the gate red.
     */
    classification: (Classification & ClassificationDecisionTrace) | null;
    /** Typed machine-actionable blocks (empty for a clean decision). */
    blocks: ClassifierBlock[];
}
/** The complete classifier result: deterministic, fully sorted. */
export interface ClassificationResult {
    schemaVersion: 1;
    /** One decision per input resource, sorted like graph resources. */
    decisions: ClassificationDecision[];
    /** Signals whose target matched no resource (stale), sorted. */
    staleTargets: ClassifierBlock[];
    /** Signals whose assertion shape contradicts their dimension, sorted. */
    invalidSignals: ClassifierBlock[];
    /**
     * Detector-channel signals with a suppressive shape, rejected by
     * CHANNEL (not by claimed identity): suppressive authority is
     * host-issued, so a plugin can never carry it, whatever `detector`
     * string it claims. Sorted; each entry blocks the gate.
     */
    unauthorizedSuppressive: ClassifierBlock[];
}
/** Stable rule ids rendered in decision traces (ADR 0003 D2). */
export declare const RULES: {
    readonly exposurePositive: "EXPOSURE_POSITIVE_SIGNAL";
    readonly exposureInternalCertificate: "EXPOSURE_INTERNAL_CERTIFICATE";
    readonly exposureDefault: "EXPOSURE_DEFAULT_USER_FACING";
    readonly exposureOperationalProbe: "EXPOSURE_OPERATIONAL_PROBE";
    readonly lifecyclePositive: "LIFECYCLE_POSITIVE_SIGNAL";
    readonly lifecycleDeclaredSupported: "LIFECYCLE_DECLARED_SUPPORTED";
    readonly lifecycleClosedWorldDisabled: "LIFECYCLE_CLOSED_WORLD_DISABLED";
    readonly lifecycleDefault: "LIFECYCLE_DEFAULT_ENABLED";
    readonly deleteProvenHard: "DELETE_SEMANTICS_PROVEN_HARD";
    readonly deleteProvenArchive: "DELETE_SEMANTICS_PROVEN_ARCHIVE";
    readonly planeEvidence: "PLANE_DETECTOR_EVIDENCE";
    readonly lifecycleEndpointHttp: "LIFECYCLE_ENDPOINT_HTTP";
    readonly identityEvidence: "IDENTITY_DETECTOR_EVIDENCE";
    readonly adapterNameMatch: "ADAPTER_NAME_MATCH";
    readonly orgInternalRule: "ORGANIZATION_INTERNAL_RULE";
};
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
export declare function classifyResources(input: ClassifyResourcesInput): ClassificationResult;
//# sourceMappingURL=classify.d.ts.map