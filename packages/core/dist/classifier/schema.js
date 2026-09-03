/**
 * Classifier result schemas (ADR 0003 D1/D2): the decision trace, the
 * effective classification, and the typed machine-actionable blocks.
 *
 * `EffectiveClassification` carries the existing `Classification` fields
 * policy/verdict code consumes PLUS explainability metadata (fingerprint,
 * contributing signals, defaults, contradictions, rule ids). On graph
 * resources the classification fields bind `GraphResource.classification`
 * and the explainability rides the sibling `classificationTrace` field —
 * never detector attributes.
 */
import { z } from 'zod';
import { LocationSchema } from '../schemas/common.js';
import { ClassificationSchema } from '../schemas/classification.js';
/** Why the classifier blocked one resource (each code is machine-actionable). */
export const CLASSIFIER_BLOCK_CODES = [
    /** Internal declaration/org-rule contradicted by positive code evidence. */
    'CLASSIFICATION_CONTRADICTION',
    /** Conflicting lifecycle evidence: enabled (conservative) plus blocking contradiction. */
    'LIFECYCLE_CONTRADICTION',
    /** Conflicting plane evidence; identity normalization never guesses. */
    'PLANE_CONTRADICTION',
    /** Conflicting primary-key evidence. */
    'IDENTITY_CONTRADICTION',
    /** An internal intent exists but its closed-world certificate cannot be completed. */
    'INCOMPLETE_PROOF_SCOPE',
    /** No plane evidence at all; do not guess across tenant/master/global. */
    'PLANE_UNRESOLVED',
    /** Missing or conflicting primary key; never defaults to `id`. */
    'IDENTITY_UNRESOLVED',
    /** Delete enabled but semantics not provable; never guesses `hard` or `archive`. */
    'DELETE_SEMANTICS_UNRESOLVED',
    /** User-facing resource with no reviewed adapter in the adapters directory. */
    'ADAPTER_MISSING',
    /** A signal whose target matches no discovered resource. */
    'STALE_SIGNAL_TARGET',
    /** A signal whose assertion shape contradicts its dimension. */
    'INVALID_SIGNAL',
    /**
     * A DETECTOR-channel signal with a suppressive shape (internality
     * declaration/org rule, or a closed-world lifecycle disable). Suppressive
     * authority is HOST-ISSUED only (ADR 0003 D2: the authority channel is a
     * separate, engine-owned input) — a plugin can never carry it, whatever
     * detector identity the signal claims.
     */
    'UNAUTHORIZED_SUPPRESSIVE_SIGNAL',
];
export const ClassifierBlockCodeSchema = z.enum(CLASSIFIER_BLOCK_CODES);
/** Also expose the block dimension mapping for report/block consumers. */
export const BLOCK_DIMENSIONS = {
    CLASSIFICATION_CONTRADICTION: 'exposure',
    LIFECYCLE_CONTRADICTION: 'lifecycle',
    INCOMPLETE_PROOF_SCOPE: 'internality',
    PLANE_CONTRADICTION: 'plane',
    PLANE_UNRESOLVED: 'plane',
    IDENTITY_CONTRADICTION: 'identity',
    IDENTITY_UNRESOLVED: 'identity',
    DELETE_SEMANTICS_UNRESOLVED: 'delete-semantics',
    ADAPTER_MISSING: 'adapter-binding',
    STALE_SIGNAL_TARGET: 'target',
    INVALID_SIGNAL: 'assertion',
    UNAUTHORIZED_SUPPRESSIVE_SIGNAL: 'provenance',
};
/** One typed classifier block: fail-closed, explainable, resolvable in code. */
export const ClassifierBlockSchema = z
    .object({
    code: ClassifierBlockCodeSchema,
    /** Plane-qualified id when derivable, else `null`. */
    resourceId: z.string().min(1).nullable(),
    /** Bare resource name when known, else `null`. */
    name: z.string().min(1).nullable(),
    /** Single-cause human explanation naming the failing requirement. */
    detail: z.string().min(1),
    /** Evidence locations (sorted deterministically). */
    locations: z.array(LocationSchema),
})
    .strict();
/** One contradiction between two pieces of evidence (rendered in traces). */
export const ClassifierContradictionSchema = z
    .object({
    /** The dimension the evidence conflicts on. */
    dimension: z.string().min(1),
    /** Human explanation naming both sides and their locations. */
    detail: z.string().min(1),
    /** Locations of the conflicting evidence (sorted). */
    locations: z.array(LocationSchema),
})
    .strict();
/**
 * The explainability trace of one classification decision (ADR 0003 D1):
 * rule ids that selected each value, the conservative defaults applied,
 * the sorted contributing-signal identities, contradictions, and the
 * dimensions the classifier could not decide.
 */
export const ClassificationDecisionTraceSchema = z
    .object({
    /** Stable rule ids explaining each selected value (sorted). */
    rules: z.array(z.string().min(1)),
    /** Rule ids of every conservative default applied (sorted). */
    defaultsApplied: z.array(z.string().min(1)),
    /** Sorted canonical signal ids of every contributing signal. */
    contributingSignalIds: z.array(z.string().min(1)),
    /** Detector identities of contributing signals, sorted, `id@version`. */
    contributingDetectors: z.array(z.string().min(1)),
    /** Contradictions surfaced while deciding (sorted). */
    contradictions: z.array(ClassifierContradictionSchema),
    /** Dimensions left undecided (sorted) — each corresponds to a block. */
    unresolvedDimensions: z.array(z.string().min(1)),
    /**
     * sha256 over the canonical decision inputs (target, decision,
     * rules, defaults, signal ids, detector versions). Any change in
     * contributing signals changes this value (stale-awareness).
     */
    decisionFingerprint: z.string().min(1),
})
    .strict();
/**
 * The classifier's complete decision for one resource: the plain
 * `Classification` fields (what policy/verdict code consumes) plus the
 * explainability metadata. Produced only when the resource has NO
 * blocking classifier finding.
 */
export const EffectiveClassificationSchema = ClassificationSchema.extend({
    /** Stable rule ids explaining each selected value (sorted). */
    rules: z.array(z.string().min(1)),
    /** Rule ids of every conservative default applied (sorted). */
    defaultsApplied: z.array(z.string().min(1)),
    /** Sorted canonical signal ids of every contributing signal. */
    contributingSignalIds: z.array(z.string().min(1)),
    /** Detector identities of contributing signals, sorted, `id@version`. */
    contributingDetectors: z.array(z.string().min(1)),
    /** Contradictions surfaced while deciding (sorted). */
    contradictions: z.array(ClassifierContradictionSchema),
    /** Dimensions left undecided (sorted) — always empty on a decision. */
    unresolvedDimensions: z.array(z.string().min(1)),
    /** sha256 over the canonical decision inputs (stale-aware identity). */
    decisionFingerprint: z.string().min(1),
});
//# sourceMappingURL=schema.js.map