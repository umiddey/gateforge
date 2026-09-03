import type { GraphResource, ResourceGraph } from '../graph/schema.js';
import type { BlockingEntry } from '../policy/index.js';
import type { ClassificationSignal } from '../schemas/classification-signal.js';
import type { ClassificationPolicy } from '../schemas/classification-policy.js';
import { type ClassificationResult, type ClassifierResourceRef } from './classify.js';
/** Everything one classification pass over a graph needs. */
export interface RunClassificationInput {
    /** The built resource graph (pre-binding). */
    graph: ResourceGraph;
    /** Every detector contribution's `classificationSignals`, config order. */
    signals: readonly ClassificationSignal[];
    /**
     * HOST-ISSUED authority signals (declarations / closed-world proofs
     * minted by the engine, e.g. from configured source-declaration
     * markers). Never forwarded plugin output.
     */
    authority?: readonly ClassificationSignal[];
    /** The validated classification policy. */
    policy: ClassificationPolicy;
    /** Reviewed adapter names available for binding. */
    adapters: readonly string[];
    scan?: {
        requestedPaths: string[];
        scannedPaths: string[];
        /** Per-detector coverage reports (judged against policy.coverage). */
        coverage?: Array<{
            detector: string;
            scannedPaths: string[];
        }>;
        configuredDetectors: number;
        successfulDetectors: number;
    };
}
/** The result of one classification pass over a graph. */
export interface GraphClassification {
    /** The graph with decisions bound (deterministically re-sorted). */
    graph: ResourceGraph;
    /** The raw classifier result (decisions, stale/invalid signals). */
    classification: ClassificationResult;
    /** Classifier blocks projected as policy-engine blocking entries. */
    blocking: BlockingEntry[];
}
/** Projects one graph resource into the classifier's resource reference. */
export declare function resourceRef(resource: GraphResource): ClassifierResourceRef;
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
export declare function runClassification(input: RunClassificationInput): GraphClassification;
/**
 * Projects classifier blocks into policy-engine blocking entries:
 * per-decision blocks (contradictions, incomplete proofs, unresolved
 * delete semantics, missing adapters) plus document-level stale targets
 * and invalid signals. Every entry names its typed code so an AI can
 * resolve it in code — never by obtaining human approval.
 */
export declare function classifierBlocking(result: ClassificationResult, graph: ResourceGraph): BlockingEntry[];
//# sourceMappingURL=bind.d.ts.map